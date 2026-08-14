import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const standardsRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const schema = JSON.parse(
  readFileSync(
    resolve(standardsRoot, "contracts/downstream-contract.schema.json"),
    "utf8",
  ),
);
const profiles = JSON.parse(
  readFileSync(resolve(standardsRoot, "profiles.json"), "utf8"),
);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(
  schema,
);

function repositoryPath(workspace, relativePath) {
  const root = resolve(workspace);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`path escapes workspace: ${relativePath}`);
  }
  return target;
}

function readJson(path, label, violations) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    violations.push(`${label} is not readable JSON: ${error.message}`);
    return null;
  }
}

function validateProfileRegistry(contract, selectedProfile, violations) {
  const profile = profiles.profiles[selectedProfile];
  if (!profile) {
    violations.push(`profile is not registered: ${selectedProfile}`);
    return null;
  }
  if (contract.profile !== selectedProfile) {
    violations.push(
      `contract profile ${contract.profile} does not match requested profile ${selectedProfile}`,
    );
  }
  for (const requiredCheck of profile.requiredChecks) {
    if (!contract.requiredChecks.includes(requiredCheck)) {
      violations.push(`required check is missing: ${requiredCheck}`);
    }
  }
  return profile;
}

function validateRequiredPaths(workspace, contract, violations) {
  for (const relativePath of [
    ...contract.requiredPaths,
    contract.localValidationWorkflow,
  ]) {
    const path = repositoryPath(workspace, relativePath);
    if (!existsSync(path))
      violations.push(`required path is missing: ${relativePath}`);
  }
}

function validateNodeConsumer(workspace, contract, profile, violations) {
  const nodeVersionPath = repositoryPath(workspace, contract.nodeVersionFile);
  if (existsSync(nodeVersionPath)) {
    const nodeVersion = readFileSync(nodeVersionPath, "utf8")
      .trim()
      .replace(/^v/, "");
    if (nodeVersion.split(".")[0] !== profile.nodeMajor) {
      violations.push(
        `Node major must be ${profile.nodeMajor}, found ${nodeVersion}`,
      );
    }
  }

  const manifest = readJson(
    repositoryPath(workspace, "package.json"),
    "package.json",
    violations,
  );
  const lock = readJson(
    repositoryPath(workspace, "package-lock.json"),
    "package-lock.json",
    violations,
  );
  const installed = readJson(
    repositoryPath(
      workspace,
      `node_modules/${contract.upstreamPackage}/package.json`,
    ),
    `installed ${contract.upstreamPackage} package.json`,
    violations,
  );
  if (!manifest || !lock || !installed) return;

  const declared =
    manifest.dependencies?.[contract.upstreamPackage] ??
    manifest.devDependencies?.[contract.upstreamPackage];
  if (!declared)
    violations.push(
      `${contract.upstreamPackage} is not declared in package.json`,
    );

  const locked =
    lock.packages?.[`node_modules/${contract.upstreamPackage}`]?.version;
  if (!locked)
    violations.push(
      `${contract.upstreamPackage} is not present in package-lock.json`,
    );
  if (locked && installed.version !== locked) {
    violations.push(
      `installed ${contract.upstreamPackage} ${installed.version} does not match lock ${locked}`,
    );
  }

  const runtimeEntry = repositoryPath(
    workspace,
    `node_modules/${contract.upstreamPackage}/dist/index.js`,
  );
  if (!existsSync(runtimeEntry)) {
    violations.push(
      `installed runtime entry is missing: ${contract.upstreamPackage}/dist/index.js`,
    );
  }
}

/**
 * Validate every marketplace entry the contract declares.
 *
 * `marketplace` accepts one entry or an array, because an index repository legitimately lists
 * several plugins and a single-entry contract silently exempts the rest: a PR touching only an
 * undeclared entry passes the required check without it being read at all.
 *
 * `versionSource` decides how freshness is proven, and the two cases are opposites rather than
 * strict/lenient variants:
 *
 *   listing — a SemVer `version` must be present. Something writes it (the release sync), so a
 *             missing or malformed value means the writer stopped.
 *   ref     — the `version` field must be ABSENT. The entry tracks a branch that republishes
 *             itself on every push, so the listing is fresh by construction; a version here would
 *             have no writer, and a stale one is worse than none. Claude Code keys its install
 *             directory on the listing version when present, so a stale value lands two different
 *             published trees in one cache directory, while with the field absent it falls back to
 *             the commit SHA and stays correct per push.
 *
 * The `ref` case therefore asserts an absence. That is deliberate: "no field without a writer" is
 * the invariant, and only an absence check can enforce it.
 */
function validateMarketplaceEntry(manifest, expected, violations) {
  const label = expected.pluginName;
  const plugin = manifest.plugins?.find(
    (candidate) => candidate.name === label,
  );
  if (!plugin) {
    violations.push(`marketplace plugin is missing: ${label}`);
    return;
  }

  const versionSource = expected.versionSource ?? "listing";
  if (versionSource === "listing") {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version ?? "")) {
      violations.push(
        `marketplace plugin version is not SemVer: ${label}: ${plugin.version ?? "missing"}`,
      );
    }
  } else if (Object.hasOwn(plugin, "version")) {
    violations.push(
      `marketplace plugin ${label} declares versionSource "ref" but carries a version field ` +
        `(${plugin.version}); nothing writes it, so it goes stale silently`,
    );
  }

  if (plugin.license !== expected.license) {
    violations.push(
      `marketplace license must be ${expected.license} for ${label}, found ${plugin.license}`,
    );
  }
  if (
    plugin.source?.url !== expected.sourceUrl ||
    plugin.source?.ref !== expected.sourceRef
  ) {
    violations.push(
      `marketplace source must be ${expected.sourceUrl}#${expected.sourceRef} for ${label}`,
    );
  }
}

function validateMarketplace(workspace, contract, violations) {
  const declared = Array.isArray(contract.marketplace)
    ? contract.marketplace
    : [contract.marketplace];

  // Every entry in one index shares a manifest path in practice, but each is read from its own
  // declaration rather than the first one's, so a mixed-manifest contract cannot silently
  // validate the wrong file.
  for (const expected of declared) {
    const manifest = readJson(
      repositoryPath(workspace, expected.manifestPath),
      expected.manifestPath,
      violations,
    );
    if (!manifest) continue;
    validateMarketplaceEntry(manifest, expected, violations);
  }
}

function validatePublisher(workspace, contract, violations) {
  const manifest = readJson(
    repositoryPath(workspace, "package.json"),
    "package.json",
    violations,
  );
  if (manifest && manifest.name !== contract.publish.packageName) {
    violations.push(
      `publisher package name must be ${contract.publish.packageName}, found ${manifest.name}`,
    );
  }
  if (
    contract.publish.packedSizeBudgetBytes >=
    contract.publish.unpackedSizeBudgetBytes
  ) {
    violations.push(
      "packed size budget must be less than unpacked size budget",
    );
  }
}

export function validateConsumerContract({
  workspace,
  contractPath,
  selectedProfile,
}) {
  const violations = [];
  const contract = readJson(
    repositoryPath(workspace, contractPath),
    contractPath,
    violations,
  );
  if (!contract) return violations;

  if (!validateSchema(contract)) {
    for (const error of validateSchema.errors ?? []) {
      violations.push(
        `contract schema ${error.instancePath || "/"} ${error.message}`,
      );
    }
    return violations;
  }

  const profile = validateProfileRegistry(
    contract,
    selectedProfile,
    violations,
  );
  validateRequiredPaths(workspace, contract, violations);
  if (!profile) return violations;

  if (profile.packageManager === "npm") {
    validateNodeConsumer(workspace, contract, profile, violations);
  }
  if (contract.profile === "marketplace")
    validateMarketplace(workspace, contract, violations);
  if (contract.profile === "npm-publisher")
    validatePublisher(workspace, contract, violations);
  return violations;
}

export function validateContractShape(contract) {
  const valid = validateSchema(contract);
  return {
    valid,
    errors: valid
      ? []
      : (validateSchema.errors ?? []).map((error) => ({ ...error })),
  };
}

export function registeredProfiles() {
  return structuredClone(profiles);
}
