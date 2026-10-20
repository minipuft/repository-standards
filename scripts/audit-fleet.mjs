#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditFleet,
  formatFleetReport,
  VERSION_SOURCES,
} from "../lib/fleet-drift-auditor.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const fleet = JSON.parse(readFileSync(resolve(root, "fleet.json"), "utf8"));
const token = process.env.FLEET_AUDIT_TOKEN || process.env.GITHUB_TOKEN;

function authHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request(url, { optional = false } = {}) {
  const response = await fetch(url, { headers: authHeaders() });
  if (optional && response.status === 404) return null;
  if (!response.ok)
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

async function raw(repository, path) {
  return request(
    `https://raw.githubusercontent.com/${repository}/main/${path}`,
  );
}

function mergeModes(source, repositories) {
  const modes = Object.fromEntries(
    repositories.map((repository) => [repository, null]),
  );
  let current;
  for (const line of source.split(/\r?\n/)) {
    const repo = line.match(/^\s+- repo:\s*(\S+)\s*$/)?.[1];
    if (repo) current = repo;
    const mode = line.match(/^\s+merge_mode:\s*(\S+)\s*$/)?.[1];
    if (mode && current in modes) modes[current] = mode;
  }
  if (!source.includes("direct)") && source.includes("--auto")) {
    for (const repository of repositories) modes[repository] ??= "auto";
  }
  return modes;
}

// The check-runs endpoint accepts a branch ref and defaults to filter=latest, which collapses
// re-runs to one entry per check name — the same state branch protection gates on. Check-run
// names match protection contexts exactly (e.g. "Consumer Contract / Consumer Contract"), so
// the result joins directly against fleet.json requiredChecks with no name mapping.
async function checkOutcomes(repository) {
  const payload = JSON.parse(
    await request(
      `https://api.github.com/repos/${repository}/commits/main/check-runs?per_page=100`,
    ),
  );
  return Object.fromEntries(
    (payload.check_runs ?? []).map((run) => [run.name, run.conclusion]),
  );
}

// Resolve the DECLARED name and return what it actually points at: GitHub's immutable numeric id
// plus the canonical full_name. One request answers both questions auditRepositoryIdentity grades
// — whether the name still belongs to the pinned repository, and whether that repository has been
// renamed out from under the declared string.
//
// Deliberately fetched BY NAME, not by id. `GET /repositories/{id}` would return the canonical
// name and catch a rename, but it can never observe a takeover: it resolves our own repository by
// construction and would report healthy while the declared name pointed at a stranger. The
// direction of the lookup IS the check.
//
// Every failure resolves to undefined, which grades as an unverified note rather than as drift. A
// genuinely missing repository cannot reach here quietly: `raw()` for its contract runs first in
// repositorySnapshot and throws, and the upstream's package fetch runs first in main(). Swallowing
// here therefore covers a token or transport problem, which is a reason to announce the rule
// unverified, not a reason to fail the fleet.
async function repositoryIdentity(repository) {
  try {
    const payload = JSON.parse(
      await request(`https://api.github.com/repos/${repository}`),
    );
    return {
      id: payload.id,
      fullName: payload.full_name,
      defaultBranch: payload.default_branch,
    };
  } catch {
    return undefined;
  }
}

// `.delivery-contract.json` is optional per-repo (fleet.json's `deliveryContract` flag says
// whether it is EXPECTED, not whether it exists). It used to be read unauthenticated off
// `raw.githubusercontent.com/<repo>/main/...`, which is wrong on two axes at once: `raw`
// serves only public repos (a private member 404s — indistinguishable from "the file does not
// exist" — and is reported "missing" though the probe never actually looked), and `main` is a
// literal, not every repo's default branch (t3code's is `custom/main`). Both defects share one
// fix: read through the authenticated `contents` API, at the DEFAULT branch `repositoryIdentity`
// already resolved, the same way every other authenticated probe in this file works.
//
// The three outcomes are graded differently on purpose:
//   404              -> the file genuinely is not there. A normal "not present" answer.
//   401/403/other    -> the probe never reached the file (no read access, or the default branch
//                       is unknown because identity itself failed to resolve). Reporting this as
//                       "missing" would tell a private repository it is out of compliance for a
//                       reason that has nothing to do with compliance — `unexplained` carries
//                       the detail so the auditor grades it as an unverified note instead.
async function deliveryContractSnapshot(repository, ref) {
  if (!ref) {
    return {
      present: false,
      templateVersion: null,
      unexplained:
        "default branch unresolved (repository identity did not resolve)",
    };
  }
  let response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${repository}/contents/.delivery-contract.json?ref=${encodeURIComponent(ref)}`,
      { headers: authHeaders() },
    );
  } catch (error) {
    return {
      present: false,
      templateVersion: null,
      unexplained: error.message,
    };
  }
  if (response.status === 404) return { present: false, templateVersion: null };
  if (!response.ok) {
    return {
      present: false,
      templateVersion: null,
      unexplained: `${response.status} ${response.statusText}`,
    };
  }
  try {
    const payload = await response.json();
    const text = Buffer.from(
      payload.content,
      payload.encoding ?? "base64",
    ).toString("utf8");
    const parsed = JSON.parse(text);
    return { present: true, templateVersion: parsed.templateVersion ?? null };
  } catch (error) {
    return {
      present: false,
      templateVersion: null,
      unexplained: error.message,
    };
  }
}

// Whether any of `paths` differs between two refs of `checkout`: true, false, or null when git
// could not compare them (a ref missing from the checkout). `git diff --quiet` exits 1 on a
// difference and 128 on an unknown ref, so the exit status alone carries all three answers.
// `from` is whatever a member wrote as its pin; `--end-of-options` keeps a pin spelled like an
// option (`--output=…`) a ref, which git then refuses as unknown.
function surfaceChangedIn(checkout) {
  return (from, to, paths) => {
    const result = spawnSync(
      "git",
      ["diff", "--quiet", "--end-of-options", from, to, "--", ...paths],
      { cwd: checkout, stdio: "ignore" },
    );
    if (result.status === 0) return false;
    if (result.status === 1) return true;
    return null;
  };
}

// The latest repository-standards release, read from THIS checkout rather than the releases API.
//
// The version is `.release-please-manifest.json`'s `"."` entry: Release Please's own record of the
// last version it released, and the version it names the tag from (`v` + version, per
// release-please-config.json). It changes only in the merge of a release PR, and that merge is
// the commit the tag lands on, so on `main` (cron, dispatch) and on the tag itself (`release:
// published`) it IS the latest release. It needs no request, so a flaky or rate-limited API can
// never turn into a false lag failure, and it cannot be stale against the run that reads it.
//
// The tag's commit comes from local tags, which the workflow's checkout fetches
// (`fetch-depth: 0`). The same listing names the release a downstream pin points at, which is how
// the report says how far behind it is. A tag not yet created (the seconds between a release PR's
// merge and its tag) or a checkout without tags leaves `commit` unset, and the auditor reports pin
// lag as unverified rather than failing.
//
// `tags` and `surfaceChanged` answer owner ruling Q1: a member is behind only when the files it uses
// differ between its pin and the latest tag, so the auditor needs every release tag in order and a
// way to compare two of them. Both come from the same local tags.
export function latestStandardsRelease(checkout = root) {
  let version;
  try {
    version = JSON.parse(
      readFileSync(resolve(checkout, ".release-please-manifest.json"), "utf8"),
    )["."];
  } catch (error) {
    return { unexplained: `.release-please-manifest.json: ${error.message}` };
  }
  if (!version) {
    return { unexplained: '.release-please-manifest.json has no "." entry' };
  }
  let listing;
  try {
    listing = execFileSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname:short) %(objectname) %(*objectname)",
        "refs/tags",
      ],
      { cwd: checkout, encoding: "utf8" },
    );
  } catch (error) {
    return { version, unexplained: `git tags unreadable: ${error.message}` };
  }
  const tagsByCommit = {};
  const tags = [];
  let commit;
  for (const line of listing.split("\n").filter(Boolean)) {
    // An annotated tag's own object is not a commit; `*objectname` is the commit it peels to.
    const [tag, object, peeled] = line.split(" ");
    tagsByCommit[peeled || object] ??= tag;
    if (/^v\d+\.\d+\.\d+$/.test(tag)) tags.push({ tag, version: tag.slice(1) });
    if (tag === `v${version}`) commit = peeled || object;
  }
  return {
    version,
    commit,
    tagsByCommit,
    tags,
    surfaceChanged: surfaceChangedIn(checkout),
  };
}

// The member's Renovate config, at its default branch, from `renovate.json` or
// `.github/renovate.json`. Absent from both is a normal answer (`{}`): a member that does not use
// Renovate contributes nothing to preset lag. A read that never reached the file is `unexplained`,
// graded as an unverified note, for the same reason as deliveryContractSnapshot.
async function renovateSnapshot(repository, ref) {
  if (!ref) {
    return {
      renovateUnexplained:
        "default branch unresolved (repository identity did not resolve)",
    };
  }
  for (const path of ["renovate.json", ".github/renovate.json"]) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        { headers: authHeaders() },
      );
      if (response.status === 404) continue;
      if (!response.ok) {
        return {
          renovateUnexplained: `${path}: ${response.status} ${response.statusText}`,
        };
      }
      const payload = await response.json();
      return {
        renovate: JSON.parse(
          Buffer.from(payload.content, payload.encoding ?? "base64").toString(
            "utf8",
          ),
        ),
      };
    } catch (error) {
      return { renovateUnexplained: `${path}: ${error.message}` };
    }
  }
  return {};
}

async function repositorySnapshot(entry, mergeMode) {
  const identity = await repositoryIdentity(entry.repository);
  const delivery = await deliveryContractSnapshot(
    entry.repository,
    identity?.defaultBranch,
  );
  const renovate = await renovateSnapshot(
    entry.repository,
    identity?.defaultBranch,
  );
  // `consumerContract: false` marks a fleet member that never claimed to carry
  // `downstream-contract.json`, a claude-prompts caller workflow, branch-protection required
  // checks, or a Renovate/Dependabot posture — it is audited for the delivery contract only.
  // Fetching those files for it would throw on the first missing one (`raw()` is unconditional)
  // for a repo that was never supposed to have them.
  if (entry.consumerContract === false) {
    return { identity, delivery, mergeMode, ...renovate };
  }
  const contract = JSON.parse(
    await raw(entry.repository, "downstream-contract.json"),
  );
  const caller = await raw(
    entry.repository,
    ".github/workflows/consumer-contract.yml",
  );
  const protection = JSON.parse(
    await request(
      `https://api.github.com/repos/${entry.repository}/branches/main/protection`,
    ),
  );
  const snapshot = {
    contract,
    caller,
    protectionChecks: protection.required_status_checks?.contexts ?? [],
    checkOutcomes: await checkOutcomes(entry.repository),
    identity,
    delivery,
    mergeMode,
    ...renovate,
    dependabotPresent:
      (await request(
        `https://raw.githubusercontent.com/${entry.repository}/main/.github/dependabot.yml`,
        { optional: true },
      )) !== null,
  };
  if (entry.nodeMajor !== null) {
    snapshot.nodeVersion = (
      await raw(entry.repository, ".node-version")
    ).trim();
  }
  // The version probe is chosen by PROFILE, not by whether the member has a Node floor. A
  // marketplace listing carries no lockfile, and reading one for it found nothing while the
  // audit reported green. auditRepository() reports an unmapped profile rather than skipping it,
  // so a new profile cannot reach production unaudited by omission here.
  const versionSource = VERSION_SOURCES[entry.profile];
  if (versionSource) {
    snapshot[versionSource.field] = versionSource.extract(
      await raw(entry.repository, versionSource.path),
    );
  }
  return snapshot;
}

async function main() {
  const upstreamPackage = JSON.parse(
    await raw(fleet.upstream.repository, fleet.upstream.packagePath),
  );
  const workflow = await raw(
    fleet.upstream.repository,
    fleet.upstream.releaseWorkflowPath,
  );
  const repositories = fleet.repositories.map(({ repository }) => repository);
  const modes = mergeModes(workflow, repositories);
  const snapshots = {
    upstreamVersion: upstreamPackage.version,
    // The upstream is not a fleet member, so its name is resolved here rather than in
    // repositorySnapshot — and it is the one that actually rotted.
    upstreamIdentity: await repositoryIdentity(fleet.upstream.repository),
    standardsRelease: latestStandardsRelease(),
    repositories: {},
  };
  for (const entry of fleet.repositories) {
    snapshots.repositories[entry.repository] = await repositorySnapshot(
      entry,
      modes[entry.repository],
    );
  }
  const audit = auditFleet(fleet, snapshots);
  const report = formatFleetReport(audit);
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex !== -1) {
    const output = process.argv[outputIndex + 1];
    if (!output) throw new Error("--output requires a path");
    writeFileSync(resolve(output), report);
  }
  console.log(report);
  if (audit.violationCount) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((error) => {
    console.error(`FLEET AUDIT: ${error.message}`);
    process.exitCode = 1;
  });
}
