#!/usr/bin/env node

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

async function request(url, { optional = false } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
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

// GitHub answers a request for a renamed repository with its CANONICAL full_name, so the
// declared path and the returned name diverge exactly when the declared path is a redirect.
//
// Every failure resolves to undefined, which auditCanonicalName reports as an unverified note
// rather than as drift. A genuinely missing repository cannot reach here quietly: `raw()` for its
// contract runs first in repositorySnapshot and throws, and the upstream's package fetch runs
// first in main(). Swallowing here therefore covers a token or transport problem, which is a
// reason to announce the rule as unverified, not a reason to fail the fleet.
async function canonicalName(repository) {
  try {
    const payload = JSON.parse(
      await request(`https://api.github.com/repos/${repository}`),
    );
    return payload.full_name;
  } catch {
    return undefined;
  }
}

async function repositorySnapshot(entry, mergeMode) {
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
    canonicalName: await canonicalName(entry.repository),
    mergeMode,
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
  if (entry.renovatePresetVersion) {
    snapshot.renovate = JSON.parse(
      await raw(entry.repository, "renovate.json"),
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
    upstreamCanonicalName: await canonicalName(fleet.upstream.repository),
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

main().catch((error) => {
  console.error(`FLEET AUDIT: ${error.message}`);
  process.exitCode = 1;
});
