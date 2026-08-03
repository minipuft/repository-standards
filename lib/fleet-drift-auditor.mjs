function missing(values, required) {
  const observed = new Set(values ?? []);
  return required.filter((value) => !observed.has(value));
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
    if (snapshot.lockVersion !== upstreamVersion) {
      violations.push(
        `claude-prompts lock is ${snapshot.lockVersion ?? "missing"}, upstream is ${upstreamVersion}`,
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
  return {
    upstreamVersion: snapshots.upstreamVersion,
    results,
    violationCount: results.reduce(
      (total, result) => total + result.violations.length,
      0,
    ),
  };
}

export function formatFleetReport(audit) {
  const lines = [
    "# Fleet Drift Report",
    "",
    `Upstream claude-prompts: ${audit.upstreamVersion ?? "unavailable"}`,
    "",
  ];
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
