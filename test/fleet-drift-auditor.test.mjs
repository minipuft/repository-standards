import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import { auditFleet, formatFleetReport } from "../lib/fleet-drift-auditor.mjs";

const fleet = JSON.parse(readFileSync("fleet.json", "utf8"));
const schema = JSON.parse(readFileSync("contracts/fleet.schema.json", "utf8"));

function healthySnapshots() {
  const repositories = {};
  for (const entry of fleet.repositories) {
    repositories[entry.repository] = {
      contract: {
        profile: entry.profile,
        upstreamWriter: entry.claudePromptsWriter,
      },
      caller: `uses: owner/workflow@${entry.standardsRef}\nstandards-ref: ${entry.standardsRef}\n`,
      protectionChecks: [...entry.requiredChecks],
      mergeMode: entry.mergeMode,
      nodeVersion: entry.nodeMajor,
      lockVersion: "3.1.1",
      renovate: entry.renovatePresetVersion
        ? {
            extends: [
              `github>minipuft/repository-standards//renovate/downstream.json#${entry.renovatePresetVersion}`,
            ],
          }
        : undefined,
      dependabotPresent: entry.dependencyAutomation === "migrating",
    };
  }
  return { upstreamVersion: "3.1.1", repositories };
}

function mutatedAudit(repository, mutate) {
  const snapshots = healthySnapshots();
  mutate(snapshots.repositories[repository]);
  return auditFleet(fleet, snapshots);
}

test("fleet inventory satisfies its schema", () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  assert.equal(validate(fleet), true, JSON.stringify(validate.errors));
});

test("healthy snapshots contain no unexplained drift", () => {
  const audit = auditFleet(fleet, healthySnapshots());
  assert.equal(audit.violationCount, 0);
  assert.match(formatFleetReport(audit), /Total unexplained drift: 0/);
});

for (const [name, repository, mutate, expected] of [
  [
    "stale standards SHA",
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.caller = "uses: owner/workflow@bad"),
    /workflow/,
  ],
  [
    "wrong Node",
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.nodeVersion = "22"),
    /Node major/,
  ],
  [
    "missing check",
    "minipuft/opencode-prompts",
    (snapshot) => snapshot.protectionChecks.pop(),
    /required check/,
  ],
  [
    "stale lock",
    "minipuft/opencode-prompts",
    (snapshot) => (snapshot.lockVersion = "3.1.0"),
    /lock is/,
  ],
  [
    "wrong writer",
    "minipuft/minipuft-plugins",
    (snapshot) => (snapshot.contract.upstreamWriter = "dependabot"),
    /writer/,
  ],
  [
    "direct merge",
    "minipuft/minipuft-plugins",
    (snapshot) => (snapshot.mergeMode = "direct"),
    /merge mode/,
  ],
  [
    "stale Renovate preset",
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.renovate.extends = ["github>owner/old#v0.1.0"]),
    /Renovate preset/,
  ],
]) {
  test(name, () => {
    const audit = mutatedAudit(repository, mutate);
    assert.ok(audit.violationCount > 0);
    assert.match(formatFleetReport(audit), expected);
  });
}

test("canonical Renovate rejects a remaining Dependabot config", () => {
  const snapshots = healthySnapshots();
  snapshots.repositories["minipuft/gemini-prompts"].dependabotPresent = true;
  const audit = auditFleet(fleet, snapshots);
  assert.match(formatFleetReport(audit), /legacy Dependabot config remains/);
});
