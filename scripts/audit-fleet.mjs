#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { auditFleet, formatFleetReport } from "../lib/fleet-drift-auditor.mjs";

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
    const lock = JSON.parse(await raw(entry.repository, "package-lock.json"));
    snapshot.lockVersion =
      lock.packages?.["node_modules/claude-prompts"]?.version;
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
