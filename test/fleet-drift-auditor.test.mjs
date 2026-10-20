import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import {
  auditFleet,
  formatFleetReport,
  RELEASE_SURFACES,
  VERSION_SOURCES,
} from "../lib/fleet-drift-auditor.mjs";
import { latestStandardsRelease } from "../scripts/audit-fleet.mjs";

const TEMPLATE = "templates/delivery-contract/scripts/check.mjs";
const WORKFLOW = ".github/workflows/consumer-contract.yml";
const PRESET = "renovate/downstream.json";
const AUDIT_ONLY = "scripts/audit-fleet.mjs";

/**
 * A release fixture whose `surfaceChanged` answers from a declared history instead of git, so no
 * test depends on this repository's real tags. `history` lists each release tag, oldest first, with
 * the paths that release changed; a commit is resolved through `tagsByCommit`, and a ref the
 * history does not hold answers null, the way `git diff` refuses an unknown ref.
 */
function releaseFixture(version, history, tagsByCommit = {}) {
  const order = history.map(([tag]) => tag);
  const indexOf = (ref) => {
    const commit = Object.keys(tagsByCommit).find((candidate) =>
      candidate.startsWith(ref),
    );
    const index = order.indexOf(commit ? tagsByCommit[commit] : ref);
    return index === -1 ? null : index;
  };
  const commit = Object.keys(tagsByCommit).find(
    (candidate) => tagsByCommit[candidate] === `v${version}`,
  );
  return {
    version,
    commit,
    tagsByCommit,
    tags: order.map((tag) => ({ tag, version: tag.slice(1) })),
    surfaceChanged(from, to, paths) {
      const [low, high] = [indexOf(from), indexOf(to)].sort((a, b) => a - b);
      if (low === null || high === null) return null;
      return history
        .slice(low + 1, high + 1)
        .some(([, changed]) =>
          changed.some((path) =>
            paths.some(
              (surface) => path === surface || path.startsWith(`${surface}/`),
            ),
          ),
        );
    },
  };
}

// The latest repository-standards release every healthy fixture is measured against. Every
// release in it changes the template and the consumer workflow, so any older pin is behind.
const LATEST = releaseFixture(
  "1.4.0",
  [
    ["v0.9.0", [TEMPLATE, WORKFLOW, PRESET]],
    ["v1.3.0", [TEMPLATE, WORKFLOW, PRESET]],
    ["v1.3.9", [TEMPLATE, WORKFLOW]],
    ["v1.4.0", [TEMPLATE, WORKFLOW, PRESET]],
    ["v1.4.1", [AUDIT_ONLY]],
    ["v1.4.2", [TEMPLATE]],
  ],
  { ["a".repeat(40)]: "v1.4.0", ["b".repeat(40)]: "v1.3.0" },
);
const OLD_PIN = "b".repeat(40);

// The real inventory is what the schema and identity tests read. Every audit below runs against
// a copy whose consumer pins are the fixture's latest release: the real `standardsRef` values are
// whatever the fleet is pinned to today, and a healthy fixture has to be current.
const inventory = JSON.parse(readFileSync("fleet.json", "utf8"));
const fleet = {
  ...inventory,
  repositories: inventory.repositories.map((entry) =>
    entry.consumerContract === false
      ? entry
      : {
          ...entry,
          standardsRef: LATEST.commit,
          renovatePresetVersion:
            entry.renovatePresetVersion && `v${LATEST.version}`,
        },
  ),
};
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
      // The shape downstream callers carry: the reusable workflow pinned by commit, plus the
      // `standards-ref` input the verifier checks out.
      caller: `uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@${entry.standardsRef} # v1.4.0\nwith:\n  standards-ref: ${entry.standardsRef}\n`,
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
    standardsRelease: { ...LATEST },
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
  assert.equal(validate(inventory), true, JSON.stringify(validate.errors));
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

// ------------------------------------------------------- lag against the latest standards release

// One member a minor behind on its delivery contract, one consumer whose caller (and fleet.json)
// still pin an older release. Measured 2026-10-20: six members at 1.7.0 and three callers at
// v1.0.0 under a 1.10.1 release, and the audit passed every one of them.
test("a delivery contract one minor behind and an old consumer pin are both drift, by name", () => {
  const behindPin = {
    ...fleet,
    repositories: fleet.repositories.map((entry) =>
      entry.repository === "minipuft/gemini-prompts"
        ? { ...entry, standardsRef: OLD_PIN }
        : entry,
    ),
  };
  const snapshots = healthySnapshots();
  snapshots.repositories["minipuft/t3code"].delivery.templateVersion = "1.3.0";
  snapshots.repositories["minipuft/gemini-prompts"].caller =
    `uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@${OLD_PIN} # v1.3.0\n` +
    `with:\n  standards-ref: ${OLD_PIN}\n`;
  const audit = auditFleet(behindPin, snapshots);
  const report = formatFleetReport(audit);

  assert.equal(audit.violationCount, 2, report);
  const failing = audit.results
    .filter((result) => result.violations.length)
    .map((result) => result.repository)
    .sort();
  assert.deepEqual(failing, ["minipuft/gemini-prompts", "minipuft/t3code"]);
  assert.match(
    report,
    /## FAIL — minipuft\/t3code\n\n- Delivery: 1\.3\.0\n- Drift: delivery contract template is 1\.3\.0, latest repository-standards release is 1\.4\.0 \(1 minor version behind\)/,
  );
  assert.match(
    report,
    /Drift: consumer-contract caller pins repository-standards at uses bbbbbbb \(v1\.3\.0\), standards-ref bbbbbbb \(v1\.3\.0\), latest release is v1\.4\.0 \(aaaaaaa\)/,
  );
  assert.match(
    report,
    /Latest repository-standards release: v1\.4\.0 \(aaaaaaa\)/,
  );
});

for (const [name, latest, found, expected] of [
  [
    "a minor behind across a patch boundary is drift",
    "1.4.0",
    "1.3.9",
    /1 minor version behind/,
  ],
  [
    "a patch release behind is drift",
    "1.4.2",
    "1.4.0",
    /2 patch versions behind/,
  ],
  ["a major behind is drift", "1.4.0", "0.9.0", /1 major version behind/],
]) {
  test(name, () => {
    const snapshots = healthySnapshots();
    snapshots.standardsRelease.version = latest;
    snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
      found;
    const audit = auditFleet(fleet, snapshots);
    const cloudySky = audit.results.find(
      (entry) => entry.repository === "minipuft/cloudySky",
    );
    assert.equal(cloudySky.violations.length, 1);
    assert.match(formatFleetReport(audit), expected);
  });
}

test("a member on the latest release, or ahead of it, contributes no lag", () => {
  for (const templateVersion of ["1.4.0", "1.5.0"]) {
    const audit = mutatedAudit("minipuft/cloudySky", (snapshot) => {
      snapshot.delivery.templateVersion = templateVersion;
    });
    const result = audit.results.find(
      (entry) => entry.repository === "minipuft/cloudySky",
    );
    assert.deepEqual(result.violations, [], templateVersion);
  }
  const consumer = auditFleet(fleet, healthySnapshots()).results.find(
    (entry) => entry.repository === "minipuft/gemini-prompts",
  );
  assert.deepEqual(consumer.violations, []);
  assert.deepEqual(consumer.notes, []);
});

test("a caller pinned by the release tag name is current", () => {
  const byTag = {
    ...fleet,
    repositories: fleet.repositories.map((entry) =>
      entry.repository === "minipuft/gemini-prompts"
        ? { ...entry, standardsRef: "v1.4.0" }
        : entry,
    ),
  };
  const snapshots = healthySnapshots();
  snapshots.repositories["minipuft/gemini-prompts"].caller =
    "uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@v1.4.0\n" +
    "with:\n  standards-ref: v1.4.0\n";
  assert.equal(auditFleet(byTag, snapshots).violationCount, 0);
});

test("an unreadable delivery contract is an unverified note, not lag", () => {
  const audit = mutatedAudit("minipuft/cloudySky", (snapshot) => {
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
  assert.doesNotMatch(
    formatFleetReport(audit),
    /latest repository-standards release is/,
  );
});

test("a delivery contract with no templateVersion is an unverified note, not lag", () => {
  const audit = mutatedAudit("minipuft/cloudySky", (snapshot) => {
    snapshot.delivery = { present: true, templateVersion: null };
  });
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Note: delivery contract carries no templateVersion; lag against 1\.4\.0 is unverified/,
  );
});

test("an unresolved latest release is one fleet-level note, and no member fails on it", () => {
  const snapshots = healthySnapshots();
  snapshots.standardsRelease = {
    unexplained: ".release-please-manifest.json: ENOENT",
  };
  for (const snapshot of Object.values(snapshots.repositories))
    if (snapshot.delivery.present) snapshot.delivery.templateVersion = "0.1.0";
  const audit = auditFleet(fleet, snapshots);
  const report = formatFleetReport(audit);
  assert.equal(audit.violationCount, 0, report);
  assert.match(report, /Latest repository-standards release: unavailable/);
  assert.match(
    report,
    /Note: latest repository-standards release was not determined \(\.release-please-manifest\.json: ENOENT\); delivery-contract, consumer-pin and Renovate preset lag are unverified/,
  );
});

test("an unresolvable release tag leaves every lag kind unverified, once", () => {
  const snapshots = healthySnapshots();
  snapshots.standardsRelease = { ...LATEST, commit: undefined };
  snapshots.repositories["minipuft/gemini-prompts"].caller =
    `uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@${OLD_PIN}\n`;
  snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
    "1.3.0";
  const report = formatFleetReport(auditFleet(fleet, snapshots));
  assert.match(
    report,
    /Note: release tag v1\.4\.0 is not resolvable in this checkout; delivery-contract, consumer-pin and Renovate preset lag are unverified/,
  );
  assert.doesNotMatch(report, /consumer-contract caller pins/);
  assert.doesNotMatch(report, /delivery contract template is/);
});

// ------------------------------------- owner ruling Q1: a release that changes nothing used is not lag

// v1.3.0 and v1.4.0 change only the audit and the README, which no member runs. v1.2.0 is the last
// release that changed anything a member consumes: the template, the verifier the reusable workflow
// runs, and the downstream Renovate preset.
const C_PIN = "c".repeat(40);
const AUDIT_ONLY_RELEASES = releaseFixture(
  "1.4.0",
  [
    ["v1.1.0", [TEMPLATE, WORKFLOW, PRESET]],
    [
      "v1.2.0",
      [
        "templates/delivery-contract/.github/workflows/pr-conventions.yml",
        "actions/verify-consumer/verify-consumer.mjs",
        PRESET,
      ],
    ],
    ["v1.3.0", [AUDIT_ONLY]],
    ["v1.4.0", [AUDIT_ONLY, "README.md"]],
  ],
  {
    ["a".repeat(40)]: "v1.4.0",
    ["b".repeat(40)]: "v1.3.0",
    [C_PIN]: "v1.1.0",
  },
);

function auditOnlySnapshots() {
  const snapshots = healthySnapshots();
  snapshots.standardsRelease = AUDIT_ONLY_RELEASES;
  return snapshots;
}

function resultFor(audit, repository) {
  return audit.results.find((entry) => entry.repository === repository);
}

// A fleet whose gemini-prompts entry declares `pin` as both its standards ref and its preset, so
// the fleet.json agreement checks stay quiet and only lag is measured.
function fleetPinning(pin, preset = `v${LATEST.version}`) {
  return {
    ...fleet,
    repositories: fleet.repositories.map((entry) =>
      entry.repository === "minipuft/gemini-prompts"
        ? { ...entry, standardsRef: pin, renovatePresetVersion: preset }
        : entry,
    ),
  };
}

function pinCaller(pin) {
  return (
    `uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@${pin}\n` +
    `with:\n  standards-ref: ${pin}\n`
  );
}

test("a template unchanged since the installed version is not lag, however many releases followed", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
    "1.2.0";
  const audit = auditFleet(fleet, snapshots);
  const cloudySky = resultFor(audit, "minipuft/cloudySky");
  assert.deepEqual(cloudySky.violations, []);
  assert.doesNotMatch(cloudySky.notes.join("\n"), /template/);
  assert.equal(audit.violationCount, 0, formatFleetReport(audit));
});

test("a template changed in a later release is drift naming that release", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
    "1.1.0";
  const audit = auditFleet(fleet, snapshots);
  assert.equal(audit.violationCount, 1);
  assert.match(
    formatFleetReport(audit),
    /Drift: delivery contract template is 1\.1\.0, latest repository-standards release is 1\.4\.0 \(3 minor versions behind\); the delivery-contract template last changed in v1\.2\.0, 3 releases behind — adopt it with `delivery-contract update`/,
  );
});

test("a consumer pin whose workflow and verifier are unchanged since is not lag", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/gemini-prompts"].caller = pinCaller(OLD_PIN);
  const audit = auditFleet(fleetPinning(OLD_PIN), snapshots);
  const gemini = resultFor(audit, "minipuft/gemini-prompts");
  assert.deepEqual(gemini.violations, []);
  assert.deepEqual(gemini.notes, []);
});

test("a consumer pin behind a release that changed the verifier is drift naming that release", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/gemini-prompts"].caller = pinCaller(C_PIN);
  const audit = auditFleet(fleetPinning(C_PIN), snapshots);
  assert.deepEqual(resultFor(audit, "minipuft/gemini-prompts").violations, [
    "consumer-contract caller pins repository-standards at uses ccccccc (v1.1.0), standards-ref ccccccc (v1.1.0), latest release is v1.4.0 (aaaaaaa); the consumer-contract workflow or its verifier last changed in v1.2.0",
  ]);
});

test("the consumer surface is what the reusable workflow executes", () => {
  assert.deepEqual(RELEASE_SURFACES.consumer.paths, [
    ".github/workflows/consumer-contract.yml",
    "actions/verify-consumer",
    "lib/consumer-contract-validator.mjs",
    "profiles.json",
    "contracts/downstream-contract.schema.json",
  ]);
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /uses: \.\/standards\/actions\/verify-consumer/);
  const verifier = readFileSync(
    "actions/verify-consumer/verify-consumer.mjs",
    "utf8",
  );
  assert.match(verifier, /lib\/consumer-contract-validator\.mjs/);
  const validator = readFileSync("lib/consumer-contract-validator.mjs", "utf8");
  assert.match(validator, /contracts\/downstream-contract\.schema\.json/);
  assert.match(validator, /profiles\.json/);
});

function presetSnapshots(preset) {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/gemini-prompts"].renovate = {
    extends: [
      `github>minipuft/repository-standards//renovate/downstream.json#${preset}`,
    ],
  };
  return snapshots;
}

test("a Renovate preset pinned before the preset last changed is drift", () => {
  const audit = auditFleet(
    fleetPinning(LATEST.commit, "v1.1.0"),
    presetSnapshots("v1.1.0"),
  );
  assert.deepEqual(resultFor(audit, "minipuft/gemini-prompts").violations, [
    "Renovate extends repository-standards//renovate/downstream.json at v1.1.0, latest release is v1.4.0; the downstream Renovate preset last changed in v1.2.0 — extend #v1.4.0",
  ]);
});

test("an old Renovate preset pin whose preset is identical since is not lag", () => {
  for (const preset of ["v1.2.0", "v1.3.0"]) {
    const audit = auditFleet(
      fleetPinning(LATEST.commit, preset),
      presetSnapshots(preset),
    );
    const gemini = resultFor(audit, "minipuft/gemini-prompts");
    assert.deepEqual(gemini.violations, [], preset);
    assert.deepEqual(gemini.notes, [], preset);
  }
});

test("a preset pin that disagrees with fleet.json is drift even when it is not lag", () => {
  const audit = auditFleet(fleet, presetSnapshots("v1.2.0"));
  assert.deepEqual(resultFor(audit, "minipuft/gemini-prompts").violations, [
    "Renovate preset is v1.2.0, fleet.json declares v1.4.0",
  ]);
});

test("every member's preset pin is graded, and one with no Renovate config contributes nothing", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/t3code"].renovate = {
    extends: [
      "config:recommended",
      "github>minipuft/repository-standards//renovate/downstream.json#v1.1.0",
    ],
  };
  const audit = auditFleet(fleet, snapshots);
  const t3code = resultFor(audit, "minipuft/t3code");
  assert.equal(t3code.violations.length, 1);
  assert.match(t3code.violations[0], /downstream\.json at v1\.1\.0/);
  assert.match(
    t3code.notes.join("\n"),
    /fleet\.json declares no renovatePresetVersion/,
  );
  // claude-prompts-mcp carries no Renovate config in the fixture.
  assert.deepEqual(
    resultFor(audit, "minipuft/claude-prompts-mcp").violations,
    [],
  );
});

test("an unreadable Renovate config is an unverified note, not lag", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/cloudySky"].renovateUnexplained =
    "renovate.json: 403 Forbidden";
  const audit = auditFleet(fleet, snapshots);
  assert.equal(audit.violationCount, 0);
  assert.match(
    formatFleetReport(audit),
    /Note: Renovate config could not be read \(renovate\.json: 403 Forbidden\); preset lag is unverified/,
  );
});

test("a version or pin missing from this checkout's tags is an unverified note, never drift", () => {
  const snapshots = auditOnlySnapshots();
  snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
    "1.1.5";
  const unknown = "d".repeat(40);
  snapshots.repositories["minipuft/gemini-prompts"].caller = pinCaller(unknown);
  snapshots.repositories["minipuft/gemini-prompts"].renovate = {
    extends: [
      "github>minipuft/repository-standards//renovate/downstream.json#v0.5.0",
    ],
  };
  const audit = auditFleet(fleetPinning(unknown, "v0.5.0"), snapshots);
  const report = formatFleetReport(audit);
  assert.equal(audit.violationCount, 0, report);
  assert.match(
    report,
    /Note: delivery contract template 1\.1\.5 has no v1\.1\.5 tag in this checkout; whether the template changed since is unverified/,
  );
  assert.match(
    report,
    /Note: uses ddddddd \(not a release tag\) could not be compared with v1\.4\.0 in this checkout; whether the consumer-contract workflow or its verifier changed since is unverified/,
  );
  assert.match(
    report,
    /Note: preset v0\.5\.0 could not be compared with v1\.4\.0 in this checkout/,
  );
});

// The fixtures above answer `surfaceChanged` from a declared history. This one drives the real
// implementation, `git diff --quiet` over local tags, in a scratch repository.
test("the checkout's release reader compares surfaces between real tags", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-release-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.invalid",
      ].concat(args),
      { cwd: dir, env, encoding: "utf8" },
    ).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const release = (version, annotated) => {
    write(".release-please-manifest.json", JSON.stringify({ ".": version }));
    git("add", "-A");
    git("commit", "-q", "-m", `release ${version}`);
    if (annotated) git("tag", "-a", `v${version}`, "-m", `v${version}`);
    else git("tag", `v${version}`);
  };
  git("init", "-q");
  write(TEMPLATE, "one");
  release("1.0.0");
  write(AUDIT_ONLY, "audit");
  release("1.1.0");
  write(TEMPLATE, "two");
  release("1.2.0", true);
  const head = git("rev-parse", "HEAD");

  const observed = latestStandardsRelease(dir);
  assert.equal(observed.version, "1.2.0");
  assert.equal(observed.commit, head, "an annotated tag peels to its commit");
  assert.deepEqual(observed.tags.map(({ tag }) => tag).sort(), [
    "v1.0.0",
    "v1.1.0",
    "v1.2.0",
  ]);
  const template = RELEASE_SURFACES.template.paths;
  assert.equal(observed.surfaceChanged("v1.0.0", "v1.1.0", template), false);
  assert.equal(observed.surfaceChanged("v1.1.0", "v1.2.0", template), true);
  assert.equal(observed.surfaceChanged("v0.1.0", "v1.2.0", template), null);
  // A pin is member-written text. Spelled as an option it must stay a ref, not write a file.
  const injected = join(dir, "injected");
  assert.equal(
    observed.surfaceChanged(`--output=${injected}`, "v1.2.0", template),
    null,
  );
  assert.equal(existsSync(injected), false);

  const snapshots = healthySnapshots();
  snapshots.standardsRelease = observed;
  snapshots.repositories["minipuft/cloudySky"].delivery.templateVersion =
    "1.0.0";
  const audit = auditFleet(fleet, snapshots);
  assert.match(
    resultFor(audit, "minipuft/cloudySky").violations.join("\n"),
    /template last changed in v1\.2\.0, 2 releases behind/,
  );
});
