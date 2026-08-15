function missing(values, required) {
  const observed = new Set(values ?? []);
  return required.filter((value) => !observed.has(value));
}

/**
 * Where each profile's claude-prompts version is observable.
 *
 * The version comparison used to sit inside `if (entry.nodeMajor !== null)`, which coupled two
 * unrelated questions: which Node a consumer runs, and which engine version it has landed. They
 * were only ever correlated — every member with a Node floor also had a lockfile. `marketplace`
 * has neither, so `minipuft/minipuft-plugins` sat in the fleet and was never compared against
 * `upstreamVersion` at all: listed, reported, and silently unaudited for the one thing this audit
 * exists to measure. Its version is not absent, it is somewhere else — the `version` field of the
 * `claude-prompts` entry in `.claude-plugin/marketplace.json`.
 *
 * `path` and `extract` are declared here beside `field` and `describe` on purpose. Splitting the
 * probe (which file to read) from the grading (which snapshot field to compare) across two modules
 * is what allows a profile to be added to one side only — the same shape as the defect above,
 * rebuilt one layer up. `scripts/audit-fleet.mjs` reads this map to decide what to fetch.
 *
 * A profile absent from this map is a VIOLATION, never a skip: an unaudited member reports the
 * same green as a conforming one.
 */
export const VERSION_SOURCES = {
  "node-consumer": {
    field: "lockVersion",
    describe: "claude-prompts lock",
    path: "package-lock.json",
    extract: (text) =>
      JSON.parse(text).packages?.["node_modules/claude-prompts"]?.version,
  },
  "npm-publisher": {
    field: "lockVersion",
    describe: "claude-prompts lock",
    path: "package-lock.json",
    extract: (text) =>
      JSON.parse(text).packages?.["node_modules/claude-prompts"]?.version,
  },
  marketplace: {
    field: "listingVersion",
    describe: "marketplace listing",
    path: ".claude-plugin/marketplace.json",
    extract: (text) =>
      JSON.parse(text).plugins?.find(
        (plugin) => plugin.name === "claude-prompts",
      )?.version,
  },
};

// GitHub check-run conclusions, partitioned by what each means for fleet health.
// A conclusion of null means the run is still in flight, so it belongs to neither set.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

// Branch protection proves a check is REQUIRED. It says nothing about whether that check
// PASSED, and the two were conflated: this audit reported "Total unexplained drift: 0" while
// minipuft-plugins carried a failing required check on main, which blocks every sync PR.
//
// Only a red REQUIRED check is drift. A red non-required check cannot block a merge, so it is
// reported without failing the audit — that is what surfaces a broken release path. Anything
// inconclusive (pending, cancelled, stale) is reported too, but never counted, because treating
// an in-flight run as drift would leave the audit permanently red.
function auditCheckOutcomes(entry, snapshot, violations, notes) {
  if (!snapshot.checkOutcomes) {
    notes.push(
      "Check outcomes were not collected; required-check health is unverified",
    );
    return;
  }
  const required = new Set(entry.requiredChecks);
  for (const [name, conclusion] of Object.entries(snapshot.checkOutcomes)) {
    if (PASSING_CONCLUSIONS.has(conclusion)) continue;
    const detail = `${name} is ${conclusion ?? "still running"} on main`;
    if (!FAILING_CONCLUSIONS.has(conclusion)) {
      notes.push(`Check outcome is inconclusive: ${detail}`);
    } else if (required.has(name)) {
      violations.push(`required check is failing: ${detail}`);
    } else {
      notes.push(`Non-required check is failing: ${detail}`);
    }
  }
  for (const check of missing(
    Object.keys(snapshot.checkOutcomes),
    entry.requiredChecks,
  )) {
    notes.push(`Required check has not run on main HEAD: ${check}`);
  }
}

// A repository's NAME is not its identity. GitHub's identity is the immutable numeric id, which
// survives renames and transfers; the name is a mutable label that anyone can take once it is
// abandoned. Auditing the label is what let `fleet.upstream.repository` sit on
// `minipuft/claude-prompts` for months after the rename to `minipuft/claude-prompts-mcp` — every
// fetch resolved through the redirect and no run mentioned it.
//
// Comparing the API's canonical `full_name` against the declared string was the first fix here and
// it is NOT sufficient, in the precise case that matters. Measured 2026-08-15:
//
//   today            GET repos/minipuft/claude-prompts -> redirect -> full_name is the NEW name
//                    -> differs from the declared string -> reported. Correct, but the exposure
//                    is still only theoretical at this point.
//   after a squat    someone claims the abandoned `minipuft/claude-prompts`. The same request now
//                    returns THEIR repository, whose full_name IS `minipuft/claude-prompts` —
//                    exactly the declared string. A name comparison PASSES.
//
// So the name check fires while the risk is harmless and goes silent the moment it becomes real.
// That is the inverse of a useful gate, and it is the same defect this file already carries a
// scar from: grading a proxy (the label) instead of the property (identity).
//
// `repositoryId` is pinned in fleet.json and compared against the id the declared name resolves
// to. Both failures fall out of one request, and they are graded differently because they are
// different events:
//
//   id differs   -> the declared name now belongs to a DIFFERENT repository. Critical: every
//                   consumer resolving by that name is pointed at someone else's files.
//   id matches,
//   name differs -> our own repository was renamed and the declared name is a redirect. Drift:
//                   fix the string before the old name becomes claimable.
//
// An unresolved probe is a NOTE, matching auditCheckOutcomes — an unverified rule announces itself
// rather than passing silently and restoring the blind spot it replaced.
export function auditRepositoryIdentity(entry, observed, violations, notes) {
  const { repository: declared, repositoryId: expectedId } = entry;
  if (!observed) {
    notes.push(
      `Identity for ${declared} was not resolved; rename and takeover exposure is unverified`,
    );
    return;
  }
  if (observed.id !== expectedId) {
    violations.push(
      `repository identity changed: ${declared} resolves to id ${observed.id} (${observed.fullName}), pinned id is ${expectedId} — the declared name may now belong to someone else`,
    );
    return;
  }
  if (observed.fullName !== declared) {
    violations.push(
      `repository was renamed: declared ${declared} is a redirect to ${observed.fullName} (id ${expectedId})`,
    );
  }
}

function auditRepository(entry, snapshot, upstreamVersion) {
  const violations = [];
  const notes = [];
  if (!snapshot)
    return { violations: ["repository snapshot is missing"], notes };

  if (snapshot.contract?.profile !== entry.profile) {
    violations.push(
      `contract profile is ${snapshot.contract?.profile ?? "missing"}`,
    );
  }
  if (snapshot.contract?.upstreamWriter !== entry.claudePromptsWriter) {
    violations.push(
      `contract writer is ${snapshot.contract?.upstreamWriter ?? "missing"}`,
    );
  }
  if (!snapshot.caller?.includes(`@${entry.standardsRef}`)) {
    violations.push(
      `workflow does not call standards at ${entry.standardsRef}`,
    );
  }
  if (!snapshot.caller?.includes(`standards-ref: ${entry.standardsRef}`)) {
    violations.push(
      `workflow standards-ref does not match ${entry.standardsRef}`,
    );
  }
  for (const check of missing(
    snapshot.protectionChecks,
    entry.requiredChecks,
  )) {
    violations.push(`required check is absent from protection: ${check}`);
  }
  auditCheckOutcomes(entry, snapshot, violations, notes);
  auditRepositoryIdentity(entry, snapshot.identity, violations, notes);
  if (snapshot.mergeMode !== entry.mergeMode) {
    violations.push(
      `upstream merge mode is ${snapshot.mergeMode ?? "missing"}`,
    );
  }

  if (entry.nodeMajor !== null) {
    const observedNode = snapshot.nodeVersion?.replace(/^v/, "").split(".")[0];
    if (observedNode !== entry.nodeMajor) {
      violations.push(`Node major is ${observedNode ?? "missing"}`);
    }
  }

  // Outside the Node gate deliberately — see VERSION_SOURCES. Every fleet member is compared,
  // by whichever probe its profile declares.
  const versionSource = VERSION_SOURCES[entry.profile];
  if (!versionSource) {
    violations.push(
      `profile ${entry.profile} declares no version source — add one to VERSION_SOURCES rather than leaving this member unaudited`,
    );
  } else {
    const observed = snapshot[versionSource.field];
    if (observed !== upstreamVersion) {
      violations.push(
        `${versionSource.describe} is ${observed ?? "missing"}, upstream is ${upstreamVersion}`,
      );
    }
  }

  if (entry.renovatePresetVersion) {
    const expected = `repository-standards//renovate/downstream.json#${entry.renovatePresetVersion}`;
    if (
      !snapshot.renovate?.extends?.some((value) => value.includes(expected))
    ) {
      violations.push(`Renovate preset is not ${entry.renovatePresetVersion}`);
    }
  }
  if (entry.dependencyAutomation === "migrating") {
    if (!snapshot.renovate || !snapshot.dependabotPresent) {
      violations.push(
        "migrating updater state requires both Renovate config and Dependabot",
      );
    } else {
      notes.push(
        "Updater migration is guarded: Dependabot remains until hosted Renovate evidence",
      );
    }
  }
  if (entry.dependencyAutomation === "renovate") {
    if (!snapshot.renovate) violations.push("Renovate config is missing");
    if (snapshot.dependabotPresent)
      violations.push("legacy Dependabot config remains");
  }
  return { violations, notes };
}

export function auditFleet(fleet, snapshots) {
  const results = fleet.repositories.map((entry) => {
    const result = auditRepository(
      entry,
      snapshots.repositories?.[entry.repository],
      snapshots.upstreamVersion,
    );
    return { repository: entry.repository, ...result };
  });
  // The upstream is graded too, and separately: it is not a fleet member, it has no contract,
  // no protection and no Renovate preset — but it is the one repository whose name actually
  // rotted, and a per-member-only check would have missed exactly the instance that motivated it.
  const upstream = { violations: [], notes: [] };
  auditRepositoryIdentity(
    fleet.upstream,
    snapshots.upstreamIdentity,
    upstream.violations,
    upstream.notes,
  );
  return {
    upstreamVersion: snapshots.upstreamVersion,
    upstreamRepository: fleet.upstream.repository,
    upstream,
    results,
    violationCount:
      upstream.violations.length +
      results.reduce((total, result) => total + result.violations.length, 0),
  };
}

export function formatFleetReport(audit) {
  const lines = [
    "# Fleet Drift Report",
    "",
    `Upstream claude-prompts: ${audit.upstreamVersion ?? "unavailable"}`,
    "",
  ];
  for (const violation of audit.upstream?.violations ?? [])
    lines.push(`- Drift: ${violation}`);
  for (const note of audit.upstream?.notes ?? []) lines.push(`- Note: ${note}`);
  if (audit.upstream?.violations.length || audit.upstream?.notes.length)
    lines.push("");
  for (const result of audit.results) {
    const marker = result.violations.length ? "FAIL" : "PASS";
    lines.push(`## ${marker} — ${result.repository}`, "");
    for (const violation of result.violations)
      lines.push(`- Drift: ${violation}`);
    for (const note of result.notes) lines.push(`- Note: ${note}`);
    if (!result.violations.length && !result.notes.length)
      lines.push("- No drift detected");
    lines.push("");
  }
  lines.push(`Total unexplained drift: ${audit.violationCount}`, "");
  return lines.join("\n");
}
