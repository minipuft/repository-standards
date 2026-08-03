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

function validateMarketplace(workspace, contract, violations) {
  const expected = contract.marketplace;
  const manifest = readJson(
    repositoryPath(workspace, expected.manifestPath),
    expected.manifestPath,
    violations,
  );
  if (!manifest) return;
  const plugin = manifest.plugins?.find(
    (candidate) => candidate.name === expected.pluginName,
  );
  if (!plugin) {
    violations.push(`marketplace plugin is missing: ${expected.pluginName}`);
    return;
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plugin.version ?? "")) {
    violations.push(
      `marketplace plugin version is not SemVer: ${plugin.version ?? "missing"}`,
    );
  }
  if (plugin.license !== expected.license) {
    violations.push(
      `marketplace license must be ${expected.license}, found ${plugin.license}`,
    );
  }
  if (
    plugin.source?.url !== expected.sourceUrl ||
    plugin.source?.ref !== expected.sourceRef
  ) {
    violations.push(
      `marketplace source must be ${expected.sourceUrl}#${expected.sourceRef}`,
    );
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
