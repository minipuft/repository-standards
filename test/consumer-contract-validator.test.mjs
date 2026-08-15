import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  registeredProfiles,
  validateConsumerContract,
  validateContractShape,
} from "../lib/consumer-contract-validator.mjs";

function write(root, path, value) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
}

function nodeFixture(profile = "node-consumer") {
  const root = mkdtempSync(join(tmpdir(), "consumer-contract-"));
  const contract = {
    schemaVersion: 1,
    profile,
    nodeVersionFile: ".node-version",
    packageManager: "npm",
    upstreamPackage: "claude-prompts",
    upstreamWriter: "claude-prompts-release-sync",
    requiredPaths: [
      "node_modules/claude-prompts/dist",
      "node_modules/claude-prompts/hooks",
    ],
    requiredChecks: ["Consumer Contract"],
    localValidationWorkflow: ".github/workflows/ci.yml",
  };
  if (profile === "npm-publisher") {
    contract.publish = {
      packageName: "opencode-prompts",
      requiresTrustedPublisher: true,
      packedSizeBudgetBytes: 1000,
      unpackedSizeBudgetBytes: 5000,
    };
  }
  write(root, "downstream-contract.json", contract);
  write(root, ".node-version", "24\n");
  write(root, ".github/workflows/ci.yml", "name: CI\n");
  write(root, "package.json", {
    name: profile === "npm-publisher" ? "opencode-prompts" : "consumer",
    dependencies: { "claude-prompts": "^3.0.0" },
  });
  write(root, "package-lock.json", {
    lockfileVersion: 3,
    packages: { "node_modules/claude-prompts": { version: "3.1.1" } },
  });
  write(root, "node_modules/claude-prompts/package.json", {
    name: "claude-prompts",
    version: "3.1.1",
  });
  write(root, "node_modules/claude-prompts/dist/index.js", "export {};\n");
  write(root, "node_modules/claude-prompts/hooks/.keep", "fixture\n");
  return { root, contract };
}

function violations(root, profile) {
  return validateConsumerContract({
    workspace: root,
    contractPath: "downstream-contract.json",
    selectedProfile: profile,
  });
}

test("profile registry exposes exactly the three v1 profiles", () => {
  assert.deepEqual(Object.keys(registeredProfiles().profiles).sort(), [
    "marketplace",
    "node-consumer",
    "npm-publisher",
  ]);
});

test("valid node consumer passes", () => {
  const { root } = nodeFixture();
  assert.deepEqual(violations(root, "node-consumer"), []);
});

test("schema rejects each guarded contract field", () => {
  const { contract } = nodeFixture();
  for (const field of [
    "schemaVersion",
    "profile",
    "upstreamPackage",
    "upstreamWriter",
    "requiredPaths",
    "requiredChecks",
    "localValidationWorkflow",
    "nodeVersionFile",
    "packageManager",
  ]) {
    const candidate = structuredClone(contract);
    delete candidate[field];
    assert.equal(
      validateContractShape(candidate).valid,
      false,
      `${field} was optional`,
    );
  }
});

test("schema rejects path traversal and unknown properties", () => {
  const { contract } = nodeFixture();
  assert.equal(
    validateContractShape({ ...contract, requiredPaths: ["../secret"] }).valid,
    false,
  );
  assert.equal(
    validateContractShape({ ...contract, waiver: true }).valid,
    false,
  );
});

test("writer, check, Node, paths, and installed version fail independently", () => {
  const writer = nodeFixture();
  writer.contract.upstreamWriter = "dependabot";
  write(writer.root, "downstream-contract.json", writer.contract);
  assert.match(violations(writer.root, "node-consumer").join("\n"), /schema/);

  const check = nodeFixture();
  check.contract.requiredChecks = ["validate"];
  write(check.root, "downstream-contract.json", check.contract);
  assert.match(
    violations(check.root, "node-consumer").join("\n"),
    /required check/,
  );

  const node = nodeFixture();
  write(node.root, ".node-version", "22\n");
  assert.match(violations(node.root, "node-consumer").join("\n"), /Node major/);

  const missing = nodeFixture();
  missing.contract.requiredPaths.push("missing/path");
  write(missing.root, "downstream-contract.json", missing.contract);
  assert.match(
    violations(missing.root, "node-consumer").join("\n"),
    /required path/,
  );

  const stale = nodeFixture();
  write(stale.root, "node_modules/claude-prompts/package.json", {
    name: "claude-prompts",
    version: "3.0.0",
  });
  assert.match(
    violations(stale.root, "node-consumer").join("\n"),
    /does not match lock/,
  );
});

test("npm publisher validates package identity and budget ordering", () => {
  const { root, contract } = nodeFixture("npm-publisher");
  assert.deepEqual(violations(root, "npm-publisher"), []);
  contract.publish.packedSizeBudgetBytes =
    contract.publish.unpackedSizeBudgetBytes;
  write(root, "downstream-contract.json", contract);
  assert.match(
    violations(root, "npm-publisher").join("\n"),
    /packed size budget/,
  );
});

test("marketplace validates plugin version, license, and source", () => {
  const root = mkdtempSync(join(tmpdir(), "marketplace-contract-"));
  const contract = {
    schemaVersion: 1,
    profile: "marketplace",
    upstreamPackage: "claude-prompts",
    upstreamWriter: "claude-prompts-release-sync",
    requiredPaths: [".claude-plugin/marketplace.json"],
    requiredChecks: ["Consumer Contract"],
    localValidationWorkflow: ".github/workflows/consumer-contract.yml",
    marketplace: {
      manifestPath: ".claude-plugin/marketplace.json",
      pluginName: "claude-prompts",
      sourceUrl: "https://github.com/minipuft/claude-prompts-mcp.git",
      sourceRef: "dist",
      license: "MIT",
    },
  };
  write(root, "downstream-contract.json", contract);
  write(root, ".github/workflows/consumer-contract.yml", "name: Contract\n");
  write(root, ".claude-plugin/marketplace.json", {
    plugins: [
      {
        name: "claude-prompts",
        version: "3.1.1",
        license: "MIT",
        source: { url: contract.marketplace.sourceUrl, ref: "dist" },
      },
    ],
  });
  assert.deepEqual(violations(root, "marketplace"), []);
  const manifest = JSON.parse(
    readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"),
  );
  manifest.plugins[0].source.ref = "main";
  write(root, ".claude-plugin/marketplace.json", manifest);
  assert.match(
    violations(root, "marketplace").join("\n"),
    /marketplace source/,
  );
});

test("an index listing several plugins validates every declared entry", () => {
  // A single-entry contract silently exempts every other plugin in the same index: a PR
  // touching only the undeclared one passes the required check without it being read.
  const root = mkdtempSync(join(tmpdir(), "marketplace-multi-"));
  const contract = {
    schemaVersion: 1,
    profile: "marketplace",
    upstreamPackage: "claude-prompts",
    upstreamWriter: "claude-prompts-release-sync",
    requiredPaths: [".claude-plugin/marketplace.json"],
    requiredChecks: ["Consumer Contract"],
    localValidationWorkflow: ".github/workflows/consumer-contract.yml",
    marketplace: [
      {
        manifestPath: ".claude-plugin/marketplace.json",
        pluginName: "claude-prompts",
        sourceUrl: "https://github.com/minipuft/claude-prompts-mcp.git",
        sourceRef: "dist",
        license: "MIT",
      },
      {
        manifestPath: ".claude-plugin/marketplace.json",
        pluginName: "codex-prompts",
        sourceUrl: "https://github.com/minipuft/codex-prompts.git",
        sourceRef: "dist",
        license: "MIT",
        versionSource: "ref",
      },
    ],
  };
  write(root, "downstream-contract.json", contract);
  write(root, ".github/workflows/consumer-contract.yml", "name: Contract\n");

  const manifest = {
    plugins: [
      {
        name: "claude-prompts",
        version: "4.0.0",
        license: "MIT",
        source: {
          url: "https://github.com/minipuft/claude-prompts-mcp.git",
          ref: "dist",
        },
      },
      {
        name: "codex-prompts",
        license: "MIT",
        source: {
          url: "https://github.com/minipuft/codex-prompts.git",
          ref: "dist",
        },
      },
    ],
  };
  write(root, ".claude-plugin/marketplace.json", manifest);
  assert.deepEqual(violations(root, "marketplace"), []);

  // The second entry is genuinely read: breaking only it must fail.
  const drifted = structuredClone(manifest);
  drifted.plugins[1].source.ref = "main";
  write(root, ".claude-plugin/marketplace.json", drifted);
  assert.match(violations(root, "marketplace").join("\n"), /codex-prompts/);
});

test("versionSource ref requires the version field to be ABSENT", () => {
  // The invariant is "no field without a writer". A version on a ref-tracking entry has nobody
  // to update it, and Claude Code keys its install directory on the listing version when
  // present — so a stale one lands two different published trees in a single cache directory.
  // Only an absence check can enforce that, so this asserts the opposite of the usual case.
  const root = mkdtempSync(join(tmpdir(), "marketplace-refver-"));
  const contract = {
    schemaVersion: 1,
    profile: "marketplace",
    upstreamPackage: "claude-prompts",
    upstreamWriter: "claude-prompts-release-sync",
    requiredPaths: [".claude-plugin/marketplace.json"],
    requiredChecks: ["Consumer Contract"],
    localValidationWorkflow: ".github/workflows/consumer-contract.yml",
    marketplace: {
      manifestPath: ".claude-plugin/marketplace.json",
      pluginName: "codex-prompts",
      sourceUrl: "https://github.com/minipuft/codex-prompts.git",
      sourceRef: "dist",
      license: "MIT",
      versionSource: "ref",
    },
  };
  write(root, "downstream-contract.json", contract);
  write(root, ".github/workflows/consumer-contract.yml", "name: Contract\n");

  const entry = {
    name: "codex-prompts",
    license: "MIT",
    source: {
      url: "https://github.com/minipuft/codex-prompts.git",
      ref: "dist",
    },
  };
  write(root, ".claude-plugin/marketplace.json", { plugins: [entry] });
  assert.deepEqual(violations(root, "marketplace"), []);

  // A perfectly well-formed SemVer is still a violation here — that is the whole point.
  write(root, ".claude-plugin/marketplace.json", {
    plugins: [{ ...entry, version: "0.1.3" }],
  });
  assert.match(
    violations(root, "marketplace").join("\n"),
    /carries a version field/,
  );
});

test("local symlink paths may be required without following outside the workspace", () => {
  const { root, contract } = nodeFixture();
  mkdirSync(join(root, "hooks"), { recursive: true });
  symlinkSync("../node_modules/claude-prompts/hooks", join(root, "hooks/lib"));
  contract.requiredPaths.push("hooks/lib");
  write(root, "downstream-contract.json", contract);
  assert.deepEqual(violations(root, "node-consumer"), []);
});
