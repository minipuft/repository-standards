import {
  compareReleaseVersions,
  describeReleaseLag,
} from "../templates/delivery-contract/scripts/warn-contract-lag.mjs";

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

// Whether a repo is expected to carry `.delivery-contract.json` is a fleet.json declaration
// (`deliveryContract`), independent of profile — a repo can adopt the delivery contract on its
// own schedule. Only the `expected && !present` direction is drift: a repo that was never
// declared to carry the contract but has adopted it anyway is informational, not a violation,
// because "carries it early" is not a defect the way "was supposed to and doesn't" is.
//
// `snapshot.unexplained` is a THIRD outcome, distinct from both. A 404 from the contents API is a
// real "not present" answer. A 401/403 (private repo, unreadable token scope, or the default
// branch itself could not be resolved) answers a different question — the probe never reached the
// file — and grading it as "missing" would report a private repository as non-compliant for a
// reason that has nothing to do with compliance. It is an unverified note, matching
// auditRepositoryIdentity and auditCheckOutcomes: an unresolved probe announces itself.
export function auditDeliveryContract(entry, snapshot, violations, notes) {
  const expected = Boolean(entry.deliveryContract);
  if (snapshot?.unexplained) {
    notes.push(
      `delivery contract presence could not be verified: ${snapshot.unexplained}`,
    );
    return {
      expected,
      present: false,
      templateVersion: null,
      unverified: true,
    };
  }
  const present = Boolean(snapshot?.present);
  const templateVersion = present ? (snapshot?.templateVersion ?? null) : null;
  if (expected && !present) {
    violations.push(
      "delivery contract is expected but `.delivery-contract.json` is absent",
    );
  } else if (!expected && present) {
    notes.push(
      `delivery contract is present at template version ${templateVersion ?? "unknown"} though this repository is not declared to carry one`,
    );
  }
  return { expected, present, templateVersion };
}

// Lag against the latest repository-standards release. Measured 2026-10-20: six members sat at
// delivery-contract template 1.7.0 and three consumer callers still pinned v1.0.0 while this
// repository had released 1.10.1, and the audit passed them all — it recorded `templateVersion`
// and compared it to nothing, and it compared the caller pin only to fleet.json's `standardsRef`,
// which falls behind exactly as quietly as the caller does.
//
// `release` is `{ version, commit, tagsByCommit, tags, surfaceChanged }`, resolved by
// scripts/audit-fleet.mjs from this checkout. A missing `version` or `commit` is announced ONCE, at
// fleet level, by auditFleet; the per-member checks below then skip the comparison they cannot make
// rather than guess.
//
// Behind is "older than the latest release", never "different from it": a member already on a
// newer template (an adoption from an unreleased commit) is not lag.
//
// Older is not enough on its own (owner ruling Q1, 2026-10-20): a release that does not change
// what a member uses is not lag. Before it, a release that touched only the audit, CI, docs or the
// CLI flagged every member, and the fix it asked for changed nothing the member runs. So each kind
// of lag names the files the member actually consumes, and a member lags only when those files
// differ between what it pins and the latest release.
export const RELEASE_SURFACES = {
  // Everything `delivery-contract update` copies into a member.
  template: {
    describe: "the delivery-contract template",
    paths: ["templates/delivery-contract"],
  },
  // What a caller of the reusable workflow executes: the workflow checks out this repository at
  // `standards-ref` and runs actions/verify-consumer, whose script imports the validator, which
  // reads the profile registry and the contract schema. `package.json` and `package-lock.json` are
  // installed by the action too, and deliberately left out: Release Please bumps `package.json` in
  // every release, so including it would restore exactly the every-release lag this rule removes.
  consumer: {
    describe: "the consumer-contract workflow or its verifier",
    paths: [
      ".github/workflows/consumer-contract.yml",
      "actions/verify-consumer",
      "lib/consumer-contract-validator.mjs",
      "profiles.json",
      "contracts/downstream-contract.schema.json",
    ],
  },
  // The preset a member's Renovate config extends. It extends `renovate/default.json` at a fixed
  // tag of its own, so a change to default.json reaches a member only through a change here.
  preset: {
    describe: "the downstream Renovate preset",
    paths: ["renovate/downstream.json"],
  },
};

// The release tags at or below the latest release, oldest first.
function releaseTags(release) {
  return (release.tags ?? [])
    .filter(
      ({ version }) =>
        (compareReleaseVersions(version, release.version) ?? 1) <= 0,
    )
    .sort((left, right) => compareReleaseVersions(left.version, right.version));
}

// The release a pin names, when it names one: a `v<version>` tag, or a commit a release tag sits on.
function pinnedReleaseVersion(ref, release) {
  if (/^v\d+\.\d+\.\d+$/.test(ref)) return ref.slice(1);
  if (!/^[0-9a-f]{7,40}$/.test(ref)) return null;
  const commit = Object.keys(release.tagsByCommit ?? {}).find((candidate) =>
    candidate.startsWith(ref),
  );
  return commit ? release.tagsByCommit[commit].replace(/^v/, "") : null;
}

/**
 * Whether `ref` (a tag or commit) is behind the latest release on one surface.
 *
 * `{ behind: false }` when the surface is identical at `ref` and at the latest tag, `{ unverified }`
 * when the comparison could not be made (a ref missing from this checkout), and otherwise
 * `{ behind: true, changedIn, releases }`: the newest release after `ref` that changed the surface,
 * and how many releases separate `ref` from the latest. Both are null when `ref` names no release.
 */
export function surfaceLag(ref, release, surface) {
  const latestTag = `v${release.version}`;
  const changed = release.surfaceChanged?.(ref, latestTag, surface.paths);
  if (changed === false) return { behind: false };
  if (changed !== true) return { unverified: true };
  const pinned = pinnedReleaseVersion(ref, release);
  const tags = releaseTags(release);
  const newer = pinned
    ? tags.filter(
        ({ version }) => (compareReleaseVersions(version, pinned) ?? 0) > 0,
      )
    : tags;
  let changedIn = null;
  for (let index = tags.length - 1; index > 0 && !changedIn; index -= 1) {
    const { tag } = tags[index];
    if (!newer.some((candidate) => candidate.tag === tag)) break;
    if (release.surfaceChanged(tags[index - 1].tag, tag, surface.paths))
      changedIn = tag;
  }
  return {
    behind: true,
    changedIn,
    releases: pinned ? newer.length : null,
  };
}

function describeSurfaceChange(surface, lag) {
  const releases =
    lag.releases === null
      ? ""
      : `, ${lag.releases} release${lag.releases === 1 ? "" : "s"} behind`;
  return lag.changedIn
    ? `${surface.describe} last changed in ${lag.changedIn}${releases}`
    : `${surface.describe} differs from the latest release${releases}`;
}

function hasReleaseTag(release, version) {
  return (release.tags ?? []).some(({ tag }) => tag === `v${version}`);
}

// Without the latest tag in this checkout no file comparison can run; auditFleet announces that
// once for the fleet.
export function auditDeliveryContractLag(delivery, release, violations, notes) {
  if (!release?.version || !release.commit) return;
  if (!delivery.expected || !delivery.present) return;
  if (delivery.unverified) return;
  if (!delivery.templateVersion) {
    notes.push(
      `delivery contract carries no templateVersion; lag against ${release.version} is unverified`,
    );
    return;
  }
  const order = compareReleaseVersions(
    delivery.templateVersion,
    release.version,
  );
  if (order === null) {
    notes.push(
      `delivery contract templateVersion ${delivery.templateVersion} is not a version; lag against ${release.version} is unverified`,
    );
    return;
  }
  if (order >= 0) return;
  // An installed version this checkout has no tag for cannot be compared file by file. That is a
  // probe that did not run, not evidence of lag.
  if (!hasReleaseTag(release, delivery.templateVersion)) {
    notes.push(
      `delivery contract template ${delivery.templateVersion} has no v${delivery.templateVersion} tag in this checkout; whether the template changed since is unverified`,
    );
    return;
  }
  const surface = RELEASE_SURFACES.template;
  const lag = surfaceLag(`v${delivery.templateVersion}`, release, surface);
  if (lag.unverified) {
    notes.push(
      `delivery contract template ${delivery.templateVersion} could not be compared with ${release.version}; template lag is unverified`,
    );
  } else if (lag.behind) {
    violations.push(
      `delivery contract template is ${delivery.templateVersion}, latest repository-standards release is ${release.version} (${describeReleaseLag(delivery.templateVersion, release.version)}); ${describeSurfaceChange(surface, lag)} — adopt it with \`delivery-contract update\``,
    );
  }
}

/** The `consumer-contract.yml@<ref>` pin and the `standards-ref:` input, as the caller wrote them. */
export function callerStandardsPins(caller) {
  const pins = {};
  const uses = /uses:\s*\S*consumer-contract\.yml@([^\s#]+)/.exec(
    caller ?? "",
  )?.[1];
  const standardsRef = /standards-ref:\s*([^\s#]+)/.exec(caller ?? "")?.[1];
  if (uses) pins.uses = uses;
  if (standardsRef) pins["standards-ref"] = standardsRef;
  return pins;
}

function pinIsRelease(pin, release) {
  if (pin === `v${release.version}`) return true;
  return /^[0-9a-f]{7,40}$/.test(pin) && release.commit.startsWith(pin);
}

// A commit pin is shown short and named by the release tag on that commit, which is what says how
// far behind it is. A pin that is not a commit (a tag or branch name) already names itself.
function describePin(pin, release) {
  if (!/^[0-9a-f]{7,40}$/.test(pin)) return pin;
  const commit = Object.keys(release.tagsByCommit ?? {}).find((candidate) =>
    candidate.startsWith(pin),
  );
  const tag = commit ? release.tagsByCommit[commit] : "not a release tag";
  return `${pin.slice(0, 7)} (${tag})`;
}

// Grades each pin on one surface and reports the ones behind as a single violation.
function gradePins(pins, release, surface, notes) {
  const behind = [];
  let latestChange = null;
  for (const [field, pin] of pins) {
    if (pinIsRelease(pin, release)) continue;
    const lag = surfaceLag(pin, release, surface);
    if (lag.unverified) {
      notes.push(
        `${field} ${describePin(pin, release)} could not be compared with v${release.version} in this checkout; whether ${surface.describe} changed since is unverified`,
      );
    } else if (lag.behind) {
      behind.push(`${field} ${describePin(pin, release)}`);
      if (
        lag.changedIn &&
        (!latestChange ||
          compareReleaseVersions(
            lag.changedIn.slice(1),
            latestChange.slice(1),
          ) > 0)
      )
        latestChange = lag.changedIn;
    }
  }
  return { behind, latestChange };
}

// R4: a consumer pin is behind when the commit it names is not the latest release tag's commit
// AND the files the reusable workflow executes differ between the two (Q1). Both the `uses:` pin
// and the `standards-ref:` input are read, because the verifier checks out the second while GitHub
// runs the first, and either can be left behind alone. Whether they agree with fleet.json's
// `standardsRef` stays the separate check in auditRepository.
export function auditConsumerPinLag(caller, release, violations, notes) {
  if (!release?.version || !release.commit) return;
  const pins = callerStandardsPins(caller);
  if (!Object.keys(pins).length) {
    notes.push(
      "consumer-contract caller names no repository-standards pin; pin lag is unverified",
    );
    return;
  }
  const surface = RELEASE_SURFACES.consumer;
  const { behind, latestChange } = gradePins(
    Object.entries(pins),
    release,
    surface,
    notes,
  );
  if (!behind.length) return;
  const change = latestChange
    ? `; ${surface.describe} last changed in ${latestChange}`
    : `; ${surface.describe} differs`;
  violations.push(
    `consumer-contract caller pins repository-standards at ${behind.join(", ")}, latest release is v${release.version} (${release.commit.slice(0, 7)})${change}`,
  );
}

const PRESET_EXTENDS =
  /^github>minipuft\/repository-standards\/\/renovate\/downstream\.json#(.+)$/;

/** Every `…//renovate/downstream.json#<ref>` a Renovate config extends, as written. */
export function renovatePresetPins(renovate) {
  return (renovate?.extends ?? [])
    .map((value) => PRESET_EXTENDS.exec(value)?.[1])
    .filter(Boolean);
}

// Row 14: the Renovate preset pin lags by the same rule. opencode-prompts merged `#v1.0.1` while the
// fleet sat on 1.10.x and nothing graded it: `delivery-contract update` does not touch renovate.json
// and the audit compared it only to fleet.json. A member with no Renovate config, or one that does
// not extend the downstream preset, contributes nothing here.
export function auditRenovatePresetLag(
  snapshot,
  entry,
  release,
  violations,
  notes,
) {
  if (snapshot.renovateUnexplained) {
    notes.push(
      `Renovate config could not be read (${snapshot.renovateUnexplained}); preset lag is unverified`,
    );
    return;
  }
  const pins = renovatePresetPins(snapshot.renovate);
  if (pins.length && !entry.renovatePresetVersion) {
    notes.push(
      `Renovate extends the downstream preset at ${pins.join(", ")} though fleet.json declares no renovatePresetVersion`,
    );
  }
  if (!pins.length || !release?.version || !release.commit) return;
  const surface = RELEASE_SURFACES.preset;
  const { behind, latestChange } = gradePins(
    pins.map((pin) => ["preset", pin]),
    release,
    surface,
    notes,
  );
  if (!behind.length) return;
  const change = latestChange
    ? `; ${surface.describe} last changed in ${latestChange}`
    : `; ${surface.describe} differs`;
  violations.push(
    `Renovate extends repository-standards//renovate/downstream.json at ${behind.map((pin) => pin.replace(/^preset /, "")).join(", ")}, latest release is v${release.version}${change} — extend #v${release.version}`,
  );
}

function deliveryColumn(delivery) {
  if (!delivery.expected) return "-";
  if (delivery.unverified) return "unverified";
  if (!delivery.present) return "missing";
  return delivery.templateVersion ?? "present, version unknown";
}

function auditRepository(entry, snapshot, upstreamVersion, release) {
  const violations = [];
  const notes = [];
  if (!snapshot)
    return {
      violations: ["repository snapshot is missing"],
      notes,
      delivery: {
        expected: Boolean(entry.deliveryContract),
        present: false,
        templateVersion: null,
      },
    };

  // `consumerContract` defaults to true (unset = a consumer). Set to `false` for a fleet member
  // that is audited solely for the delivery contract and never claimed to carry
  // `downstream-contract.json`, a claude-prompts caller workflow, or a Renovate/Dependabot
  // posture — grading it against those checks would report it drifted for a contract it never
  // signed up for.
  const isConsumer = entry.consumerContract !== false;

  if (isConsumer) {
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
    auditConsumerPinLag(snapshot.caller, release, violations, notes);
  } else {
    notes.push(
      "consumer contract checks skipped: this repository is not declared to carry a claude-prompts consumer contract",
    );
  }
  auditRepositoryIdentity(entry, snapshot.identity, violations, notes);
  const delivery = auditDeliveryContract(
    entry,
    snapshot.delivery,
    violations,
    notes,
  );
  auditDeliveryContractLag(delivery, release, violations, notes);
  auditRenovatePresetLag(snapshot, entry, release, violations, notes);

  if (!isConsumer) return { violations, notes, delivery };

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

  // fleet.json's declaration and the member's pin must agree; whether that pin is behind the
  // latest release is auditRenovatePresetLag's separate question.
  if (entry.renovatePresetVersion) {
    const pins = renovatePresetPins(snapshot.renovate);
    if (!pins.includes(entry.renovatePresetVersion)) {
      violations.push(
        `Renovate preset is ${pins.length ? pins.join(", ") : "not extended"}, fleet.json declares ${entry.renovatePresetVersion}`,
      );
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
  return { violations, notes, delivery };
}

export function auditFleet(fleet, snapshots) {
  const results = fleet.repositories.map((entry) => {
    const result = auditRepository(
      entry,
      snapshots.repositories?.[entry.repository],
      snapshots.upstreamVersion,
      snapshots.standardsRelease,
    );
    return { repository: entry.repository, ...result };
  });
  // The latest repository-standards release is one fact for the whole fleet, so failing to
  // resolve it is announced once here rather than as a note on every member. Neither half is
  // drift: an unresolved release is a probe that did not run, and the lag rules it feeds are
  // reported unverified instead of passing silently.
  const standards = { notes: [] };
  const release = snapshots.standardsRelease;
  if (!release?.version) {
    standards.notes.push(
      `latest repository-standards release was not determined${release?.unexplained ? ` (${release.unexplained})` : ""}; delivery-contract, consumer-pin and Renovate preset lag are unverified`,
    );
  } else if (!release.commit) {
    standards.notes.push(
      `release tag v${release.version} is not resolvable in this checkout${release.unexplained ? ` (${release.unexplained})` : ""}; delivery-contract, consumer-pin and Renovate preset lag are unverified`,
    );
  }
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
    standardsRelease: release,
    standards,
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
  const release = audit.standardsRelease;
  lines.push(
    `Latest repository-standards release: ${release?.version ? `v${release.version}${release.commit ? ` (${release.commit.slice(0, 7)})` : ""}` : "unavailable"}`,
    "",
  );
  for (const note of audit.standards?.notes ?? [])
    lines.push(`- Note: ${note}`);
  if (audit.standards?.notes.length) lines.push("");
  for (const result of audit.results) {
    const marker = result.violations.length ? "FAIL" : "PASS";
    lines.push(`## ${marker} — ${result.repository}`, "");
    lines.push(`- Delivery: ${deliveryColumn(result.delivery)}`);
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
