import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv";
import {
  auditFleet,
  formatFleetReport,
  VERSION_SOURCES,
} from "../lib/fleet-drift-auditor.mjs";

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
      checkOutcomes: Object.fromEntries(
        entry.requiredChecks.map((check) => [check, "success"]),
      ),
      mergeMode: entry.mergeMode,
      nodeVersion: entry.nodeMajor,
      // A healthy repository answers to its own name AND its pinned id. Defaulting both to the
      // declared values keeps the fixture honest: every case below sets its divergence explicitly.
      identity: { id: entry.repositoryId, fullName: entry.repository },
      // Keyed by the profile's declared version source, not hardcoded to `lockVersion`. A fixture
      // that always set `lockVersion` would keep passing for a marketplace member whose real
      // version lives in its listing — the fixture would be asserting the defect.
      [VERSION_SOURCES[entry.profile].field]: "3.1.1",
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
  return {
    upstreamVersion: "3.1.1",
    upstreamIdentity: {
      id: fleet.upstream.repositoryId,
      fullName: fleet.upstream.repository,
    },
    repositories,
  };
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
  [
    // The motivating instance: minipuft-plugins passed this audit on 2026-08-05 while its
    // required Consumer Contract was red on main.
    "failing required check",
    "minipuft/minipuft-plugins",
    (snapshot) =>
      (snapshot.checkOutcomes["Consumer Contract / Consumer Contract"] =
        "failure"),
    /required check is failing: Consumer Contract \/ Consumer Contract is failure on main/,
  ],
  [
    "required check timed out",
    "minipuft/opencode-prompts",
    (snapshot) => (snapshot.checkOutcomes.validate = "timed_out"),
    /required check is failing: validate is timed_out on main/,
  ],
  [
    "required check demands action",
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.checkOutcomes.validate = "action_required"),
    /required check is failing/,
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

// The defect these cover: version comparison used to sit inside `if (entry.nodeMajor !== null)`,
// so a member with no Node floor was never compared to upstream at all. A test that only checked
// the node-consumer path passed throughout — the marketplace member was invisible to it.
test("a marketplace listing behind upstream is drift", () => {
  const audit = mutatedAudit(
    "minipuft/minipuft-plugins",
    (snapshot) => (snapshot.listingVersion = "3.0.0"),
  );
  assert.ok(audit.violationCount > 0);
  assert.match(formatFleetReport(audit), /marketplace listing is 3\.0\.0/);
});

test("a marketplace member with no listing version is drift, not a silent pass", () => {
  const audit = mutatedAudit(
    "minipuft/minipuft-plugins",
    (snapshot) => delete snapshot.listingVersion,
  );
  assert.ok(audit.violationCount > 0);
  assert.match(formatFleetReport(audit), /marketplace listing is missing/);
});

test("a lockfile on a marketplace member does not satisfy its version check", () => {
  const audit = mutatedAudit("minipuft/minipuft-plugins", (snapshot) => {
    delete snapshot.listingVersion;
    snapshot.lockVersion = "3.1.1";
  });
  assert.match(formatFleetReport(audit), /marketplace listing is missing/);
});

test("a node-consumer lock behind upstream is still drift", () => {
  const audit = mutatedAudit(
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.lockVersion = "3.0.0"),
  );
  assert.match(formatFleetReport(audit), /claude-prompts lock is 3\.0\.0/);
});

test("a profile with no declared version source is reported, never skipped", () => {
  const snapshots = healthySnapshots();
  const inventedProfile = {
    ...fleet,
    repositories: fleet.repositories.map((entry, index) =>
      index === 0 ? { ...entry, profile: "not-a-profile" } : entry,
    ),
  };
  const audit = auditFleet(inventedProfile, snapshots);
  assert.match(formatFleetReport(audit), /declares no version source/);
});

test("every profile in the registry declares a version source", () => {
  const profiles = JSON.parse(readFileSync("profiles.json", "utf8")).profiles;
  for (const name of Object.keys(profiles)) {
    assert.ok(
      VERSION_SOURCES[name],
      `profile ${name} has no VERSION_SOURCES entry, so a fleet member using it would be unaudited`,
    );
  }
});

// A red check that protection does not require cannot block a merge, so it must be visible
// without failing the audit. gemini-prompts' release-please has failed on main since
// 2026-08-01 and was invisible to this report.
test("a failing non-required check is reported without counting as drift", () => {
  const audit = mutatedAudit(
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.checkOutcomes["release-please"] = "failure"),
  );
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Note: Non-required check is failing: release-please is failure on main/,
  );
});

// Counting an in-flight run as drift would leave the audit red during any ordinary push.
for (const [name, conclusion, expected] of [
  ["a pending required check", null, /still running on main/],
  ["a cancelled required check", "cancelled", /is cancelled on main/],
  ["a stale required check", "stale", /is stale on main/],
]) {
  test(`${name} is inconclusive, not drift`, () => {
    const audit = mutatedAudit(
      "minipuft/opencode-prompts",
      (snapshot) => (snapshot.checkOutcomes.validate = conclusion),
    );
    assert.equal(audit.violationCount, 0);
    assert.match(
      formatFleetReport(audit),
      /Note: Check outcome is inconclusive/,
    );
    assert.match(formatFleetReport(audit), expected);
  });
}

for (const conclusion of ["neutral", "skipped"]) {
  test(`a ${conclusion} required check is treated as passing`, () => {
    const audit = mutatedAudit(
      "minipuft/opencode-prompts",
      (snapshot) => (snapshot.checkOutcomes.validate = conclusion),
    );
    assert.equal(audit.violationCount, 0);
    assert.doesNotMatch(formatFleetReport(audit), /validate/);
  });
}

test("a required check that never ran on main HEAD is reported", () => {
  const audit = mutatedAudit(
    "minipuft/opencode-prompts",
    (snapshot) => delete snapshot.checkOutcomes["validate-plugin"],
  );
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Required check has not run on main HEAD: validate-plugin/,
  );
});

// An absent probe must announce itself. Silently skipping the rule would restore the exact
// blind spot this check exists to close.
test("an uncollected outcome probe is reported, not silently skipped", () => {
  const audit = mutatedAudit(
    "minipuft/minipuft-plugins",
    (snapshot) => delete snapshot.checkOutcomes,
  );
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Check outcomes were not collected; required-check health is unverified/,
  );
});

test("the declared upstream is the post-rename name", () => {
  assert.equal(fleet.upstream.repository, "minipuft/claude-prompts-mcp");
});

// A repository's NAME is a mutable label; its id is the identity. These cover both directions,
// and the SECOND is the one a name-only comparison silently passes.
test("a renamed member is drift — the declared name is a redirect", () => {
  const audit = mutatedAudit(
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.identity.fullName = "minipuft/gemini-prompts-v2"),
  );
  assert.ok(audit.violationCount > 0);
  assert.match(
    formatFleetReport(audit),
    /repository was renamed: declared minipuft\/gemini-prompts is a redirect/,
  );
});

// The case that motivated pinning ids. Someone claims an abandoned name: the API returns THEIR
// repository, whose full_name equals the declared string exactly. A name comparison passes; the
// id does not. This test fails against the name-only implementation that preceded it.
test("a member name taken over by a different repository is drift", () => {
  const audit = mutatedAudit(
    "minipuft/gemini-prompts",
    (snapshot) => (snapshot.identity.id = 999999999),
  );
  assert.ok(audit.violationCount > 0);
  assert.match(formatFleetReport(audit), /repository identity changed/);
  assert.match(formatFleetReport(audit), /may now belong to someone else/);
});

test("an unresolved member identity is an unverified note, not drift", () => {
  const audit = mutatedAudit(
    "minipuft/gemini-prompts",
    (snapshot) => delete snapshot.identity,
  );
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /rename and takeover exposure is unverified/,
  );
});

// The upstream is not a fleet member and is the one whose name actually rotted, so it is graded
// separately — a per-member-only check would have missed the motivating instance.
test("a renamed upstream is drift", () => {
  const snapshots = healthySnapshots();
  snapshots.upstreamIdentity.fullName = "minipuft/claude-prompts-engine";
  const audit = auditFleet(fleet, snapshots);
  assert.ok(audit.violationCount > 0);
  assert.match(formatFleetReport(audit), /repository was renamed/);
});

test("an upstream name taken over by a different repository is drift", () => {
  const snapshots = healthySnapshots();
  snapshots.upstreamIdentity.id = 111111111;
  const audit = auditFleet(fleet, snapshots);
  assert.ok(audit.violationCount > 0);
  assert.match(formatFleetReport(audit), /repository identity changed/);
});

test("an unresolved upstream identity is an unverified note, not drift", () => {
  const snapshots = healthySnapshots();
  delete snapshots.upstreamIdentity;
  const audit = auditFleet(fleet, snapshots);
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /rename and takeover exposure is unverified/,
  );
});

test("every fleet entry pins an immutable repository id", () => {
  assert.ok(Number.isInteger(fleet.upstream.repositoryId));
  for (const entry of fleet.repositories) {
    assert.ok(
      Number.isInteger(entry.repositoryId),
      `${entry.repository} has no pinned repositoryId, so its name cannot be verified as identity`,
    );
  }
});
