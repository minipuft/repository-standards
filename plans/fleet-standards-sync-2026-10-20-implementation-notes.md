# Implementation notes: fleet standards sync

## Rulings

- **R1 (owner, 2026-10-20)** Wave 1 = gemini-prompts, opencode-prompts, codex-prompts, minipuft-plugins. Wave 2 = cloudySky, t3code.
- **R2 (owner, 2026-10-20)** The fleet audit (weekly and on release) fails on lag; a downstream PR only warns. A new upstream release must not turn every open downstream PR red.
- **R3 (owner, 2026-10-20)** Wave 1 PRs auto-merge once CI passes; wave 2 PRs are opened and left for owner review.
- **R4 (planner)** Lag is measured against the latest published release tag, not `main`. Behind = `templateVersion` semver-less-than that tag, or a consumer-contract `uses:` pin whose commit is not that tag's commit.
- **R5 (planner)** Row 1 ships and is released before any adoption row, so the adoptions carry the PR-time warning and target that release rather than 1.10.1.
- **R6 (planner)** Adoption rows never touch a repository's own clone; each uses a fresh worktree or a fresh clone under `~/.cache/fleet-sync/<repo>`.

- **R7 (planner, owner to confirm)** Release 6.0.0 (#473) waits for rows 10, 12 and 13. Without row 10 its downstream sync fails again; with row 10 but without 12/13, the sync PRs auto-merge 6.0 into gemini and opencode, which still send or read the string `gate_verdict` 6.0 refuses (gemini `hooks/gate-enforce.py:67` runs `re.search` on it).
- **R8 (planner)** No re-dispatch of the 5.1.1 sync: a dispatch from `main` builds dist from unreleased 6.0 commits; a dispatch at `v5.1.1` carries the guard defect. 6.0.0 is the recovery.
- **R9 (planner)** Row 10 lands in claude-prompts-mcp under the owner's "auto-merge in our prompt servers" ruling.

- **Q1 (RULED, owner 2026-10-20: a release that does not change the template is not lag)** A member lags only when its installed `templateVersion` is older than the newest release whose `templates/delivery-contract/**` differs from the template at the installed version. Releases that change only the audit, CI, docs or the CLI flag nobody. Consumer-pin lag follows the same rule for `.github/workflows/consumer-contract.yml` and its inputs, and preset lag for `renovate/downstream.json` (row 14). Rows 14–16 proceed.
- **R10 (planner)** The local adoption skill (claude-prompts-mcp `.claude/skills/adopt-repository-standards/`, gitignored) carries Phase A (release), B (claude-prompts-mcp) and C (members), built from the six adoption step logs.

- **R11 (planner)** t3code #14 cannot merge: `custom/main` requires `Check` with `enforce_admins: true`, and `Check` fails on `custom/main` itself (run 39213759315: Lint = knip "Unused dependencies (3)", Test Web). The PR adds no failure (same three jobs on both). Owner decides how `custom/main` goes green.

- **R12 (planner)** Consumer-pin lag excludes `package.json`/`package-lock.json`: Release Please changes them in every release, so counting them would restore the every-release lag Q1 removed. Cost: a verifier dependency bump alone does not flag consumers.

## Measured inputs (2026-10-20)

- Delivery contract: 6 members at 1.7.0; claude-prompts-mcp at 1.10.1.
- Consumer-contract pin: gemini/opencode/codex at `bb7c4fa` (v1.0.0); minipuft-plugins at `860df1a`.
- Release Please runs in gemini-prompts and opencode-prompts (exposed to the unparseable-squash drop); not in codex-prompts, minipuft-plugins, cloudySky.
- The weekly fleet audit fails today on `claude-prompts lock is 4.0.1, upstream is 5.1.1` (row 2) and on cloudySky identity not resolving.

## Deviations

- **DEV-1-1** Row 1 put grading in `lib/fleet-drift-auditor.mjs` (the script only collects) and imports the version comparison from the managed `warn-contract-lag.mjs` so one definition serves both. Accepted.

- **DEV-4-1** The planner made the opencode Renovate preset pin change (#60) directly: one line, the preset file byte-identical between v1.0.1 and v1.11.0.

## Findings

- **Live audit after wave 1 (run 39397405628, real token)** 6 unexplained drifts: claude-prompts lock 4.0.1 ×3 and marketplace listing 4.0.1 (row 11), t3code template 1.7.0 (row 8), claude-prompts-mcp template 1.10.1 (row 17); cloudySky identity unresolved (the audit token cannot read the private repository).

- **Adoptions (rows 3–6)** None of the four members carries a standards dependency; the CLI runs from a detached v1.11.0 checkout (`bin/delivery-contract.cjs`, needs `npm ci` there first). The consumer-contract reusable workflow's inputs did not change between v1.0.0 and v1.11.0, so only the two SHAs move. `update` never touches seeded files (the PR template still required the retired `Initiative:` trailer in every member) or `renovate.json` (gemini and opencode pinned the preset at v1.0.1) → rows 14–15. `pr-check` fails plan progress until a commit exists, and it does not catch a malformed table row.

- **Row 1** `audit-fleet.mjs` still aborts on a failed consumer read (`raw()` and the protection read throw), so a missing token aborts the audit instead of producing notes; outside this plan's scope.
- **Row 12** gemini-prompts had no tests; the row added `hooks/tests` and a CI step to run them (gemini-prompts #50).

- **Row 2** The one writer of downstream `claude-prompts` versions is claude-prompts-mcp `extension-publish.yml` `sync-downstream`; Renovate's shared preset excludes `claude-prompts`. It failed red on 2026-10-06 for 5.1.0 and 5.1.1 and nothing surfaced it until the weekly audit on 10-12. `docs/guides/release-process.md` and the `npm-publish.yml` comment name Renovate and Dependabot as owners; neither is. The marketplace listing may decide where Claude Code installs the plugin, so marketplace users may still run 4.0.1 (unverified).
