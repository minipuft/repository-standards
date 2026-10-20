# Implementation notes: fleet standards sync

## Rulings

- **R1 (owner, 2026-10-20)** Wave 1 = gemini-prompts, opencode-prompts, codex-prompts, minipuft-plugins. Wave 2 = cloudySky, t3code.
- **R2 (owner, 2026-10-20)** The fleet audit (weekly and on release) fails on lag; a downstream PR only warns. A new upstream release must not turn every open downstream PR red.
- **R3 (owner, 2026-10-20)** Wave 1 PRs auto-merge once CI passes; wave 2 PRs are opened and left for owner review.
- **R4 (planner)** Lag is measured against the latest published release tag, not `main`. Behind = `templateVersion` semver-less-than that tag, or a consumer-contract `uses:` pin whose commit is not that tag's commit.
- **R5 (planner)** Row 1 ships and is released before any adoption row, so the adoptions carry the PR-time warning and target that release rather than 1.10.1.
- **R6 (planner)** Adoption rows never touch a repository's own clone; each uses a fresh worktree or a fresh clone under `~/.cache/fleet-sync/<repo>`.

## Measured inputs (2026-10-20)

- Delivery contract: 6 members at 1.7.0; claude-prompts-mcp at 1.10.1.
- Consumer-contract pin: gemini/opencode/codex at `bb7c4fa` (v1.0.0); minipuft-plugins at `860df1a`.
- Release Please runs in gemini-prompts and opencode-prompts (exposed to the unparseable-squash drop); not in codex-prompts, minipuft-plugins, cloudySky.
- The weekly fleet audit fails today on `claude-prompts lock is 4.0.1, upstream is 5.1.1` (row 2) and on cloudySky identity not resolving.

## Deviations

## Findings
