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
    // A healthy repository answers to its own name AND its pinned id. Defaulting both to the
    // declared values keeps the fixture honest: every case below sets its divergence explicitly.
    const identity = { id: entry.repositoryId, fullName: entry.repository };
    // A healthy fixture answers the `deliveryContract` expectation it was declared with:
    // present when expected, absent otherwise. Every divergence below sets this explicitly,
    // the same discipline the identity and version fixtures above already follow.
    const delivery = entry.deliveryContract
      ? { present: true, templateVersion: "1.4.0" }
      : { present: false, templateVersion: null };
    if (entry.consumerContract === false) {
      repositories[entry.repository] = { identity, delivery, mergeMode: null };
      continue;
    }
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
      identity,
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
      delivery,
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

// `deliveryContract` is a fleet.json expectation, not derived from profile, so these three cases
// override the fleet inventory itself (the same pattern as the "invented profile" test above)
// rather than only mutating a snapshot.
function withDeliveryExpectation(repository, expected) {
  return {
    ...fleet,
    repositories: fleet.repositories.map((entry) =>
      entry.repository === repository
        ? { ...entry, deliveryContract: expected }
        : entry,
    ),
  };
}

test("a delivery contract present when expected is reported, not drift", () => {
  const target = fleet.repositories[0].repository;
  const snapshots = healthySnapshots();
  snapshots.repositories[target].delivery = {
    present: true,
    templateVersion: "1.4.0",
  };
  const audit = auditFleet(withDeliveryExpectation(target, true), snapshots);
  assert.equal(audit.violationCount, 0);
  assert.match(formatFleetReport(audit), /Delivery: 1\.4\.0/);
});

test("a delivery contract expected but missing is drift", () => {
  const target = fleet.repositories[0].repository;
  const snapshots = healthySnapshots();
  snapshots.repositories[target].delivery = {
    present: false,
    templateVersion: null,
  };
  const audit = auditFleet(withDeliveryExpectation(target, true), snapshots);
  assert.ok(audit.violationCount > 0);
  assert.match(
    formatFleetReport(audit),
    /delivery contract is expected but `\.delivery-contract\.json` is absent/,
  );
  assert.match(formatFleetReport(audit), /Delivery: missing/);
});

test("a delivery contract present when not expected is a note, not drift", () => {
  const target = fleet.repositories[0].repository;
  const snapshots = healthySnapshots();
  const withoutDelivery = withDeliveryExpectation(target, false);
  snapshots.repositories[target].delivery = {
    present: true,
    templateVersion: "1.4.0",
  };
  const audit = auditFleet(withoutDelivery, snapshots);
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /delivery contract is present at template version 1\.4\.0 though this repository is not declared to carry one/,
  );
  assert.match(formatFleetReport(audit), /Delivery: -/);
});

// The motivating defect: a private repo (or any 401/403/unreadable response) answers "the probe
// never reached the file", not "the file is absent". Grading it as missing would report a
// private repository as out of compliance for a reason that has nothing to do with compliance.
test("an unreadable delivery-contract probe (private repo) is a note, not drift", () => {
  const target = fleet.repositories.find(
    (entry) => entry.consumerContract === false,
  ).repository;
  const audit = mutatedAudit(target, (snapshot) => {
    snapshot.delivery = {
      present: false,
      templateVersion: null,
      unexplained: "403 Forbidden",
    };
  });
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Note: delivery contract presence could not be verified: 403 Forbidden/,
  );
  assert.match(formatFleetReport(audit), /Delivery: unverified/);
});

// t3code's default branch is `custom/main`, not `main`. The fixture asserts the auditor grades
// whatever the snapshot reports as present — the branch-resolution work itself lives in
// scripts/audit-fleet.mjs (identity.defaultBranch feeds the delivery-contract fetch ref), so this
// is the auditor-side half: a delivery contract read from a non-`main` default branch is graded
// exactly like one read from `main`, not silently dropped.
test("a delivery contract read from a non-main default branch is graded normally", () => {
  const target = "minipuft/t3code";
  const entryExists = fleet.repositories.some(
    (entry) => entry.repository === target,
  );
  assert.ok(entryExists, "fixture expects minipuft/t3code in fleet.json");
  const audit = mutatedAudit(target, (snapshot) => {
    snapshot.delivery = { present: true, templateVersion: "1.7.0" };
  });
  const target_ = audit.results.find((result) => result.repository === target);
  assert.equal(
    target_.violations.length,
    0,
    JSON.stringify(target_.violations),
  );
  assert.match(formatFleetReport(audit), /Delivery: 1\.7\.0/);
});

// `consumerContract: false` marks a member audited for the delivery contract only. It must not
// be reported as drifted for lacking `downstream-contract.json`, a caller workflow, required
// checks, or a Renovate/Dependabot posture it never claimed to carry.
test("a fleet entry with consumerContract: false skips consumer-contract checks", () => {
  const target = fleet.repositories.find(
    (entry) => entry.consumerContract === false,
  ).repository;
  const audit = auditFleet(fleet, healthySnapshots());
  const result = audit.results.find((entry) => entry.repository === target);
  assert.equal(result.violations.length, 0, JSON.stringify(result.violations));
  assert.match(result.notes.join("\n"), /consumer contract checks skipped/);
});
