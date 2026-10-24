# Repository Standards

Versioned consumer contracts, reusable validation, dependency policy, and read-only fleet drift reporting for first-party `minipuft` repositories.

## Lifecycle

- `contracts/downstream-contract.schema.json`: canonical contract v1 schema.
- `profiles.json`: canonical profile registry.
- `actions/verify-consumer`: canonical executable verifier.
- `actions/retire-plans`: optional GitHub Actions packaging for the retirement executable.
- `.github/workflows/consumer-contract.yml`: canonical read-only reusable workflow.
- `renovate/*.json`: canonical shareable Renovate presets.
- `fleet.json` and `scripts/audit-fleet.mjs`: canonical read-only drift inventory and audit.
- `conventions/plan-frontmatter.md`: canonical plan frontmatter schema, status vocabulary, and retirement contract.
- `conventions/plan-rows.md`: canonical plan-row glyph set, stamp grammar and table parsing rules, enforced by the managed `scripts/validate-plan-rows.mjs`.
- `bin/retire-done-plans.cjs`: portable plan-retirement executable for local and CI use.
- `contracts/plan-retirement.schema.json`: fail-closed consumer configuration contract.
- `bin/delivery-contract.cjs`: portable commit/ADR/release scaffolding installer and updater.
- `contracts/delivery-contract.schema.json`: canonical `.delivery-contract.json` answers schema.
- `templates/delivery-contract/`: canonical managed and seeded files the contract installs.
- `eslint/`: canonical fleet ESLint preset (`base`, `typed`) and its `fleet/*` rules.
- Product-specific build, symlink, plugin, and release behavior remains local to each consumer.

Consumers pin both the reusable workflow and its `standards-ref` input to the same immutable commit SHA:

```yaml
jobs:
  consumer-contract:
    name: Consumer Contract
    permissions:
      contents: read
    uses: minipuft/repository-standards/.github/workflows/consumer-contract.yml@0123456789abcdef0123456789abcdef01234567
    with:
      profile: node-consumer
      contract-path: downstream-contract.json
      standards-ref: 0123456789abcdef0123456789abcdef01234567
```

Promotion order: shadow check -> observe the emitted check name -> require it in branch protection -> remove duplicated common checks.

## Commands

```bash
npm ci
npm test
npm run validate:workflows
npm run validate:renovate
npm run format:check
npm run validate
npm run audit:fleet
```

## Retire completed plans

Install this repository at an immutable tag or commit, then run `retire-done-plans` from the
consumer repository. The executable works without GitHub Actions and accepts `--repo PATH` when
the consumer is not the current directory.

Each consumer must own `plan-retirement.config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/minipuft/repository-standards/main/contracts/plan-retirement.schema.json",
  "linkSources": ["plans", "docs", "src", ".github"]
}
```

`linkSources` has no default. A missing configuration, empty key, missing source, duplicate source,
or path outside the repository is an error before any plan is scanned or moved. This prevents an
incomplete citation corpus from being mistaken for an unreferenced plan set.

Consumers must also gitignore their configured plan directory's `archive/` child. `--apply`
verifies the ignore rule before moving a `done` plan because git history is the archive.

```bash
retire-done-plans              # inspect the queue and fail on unsafe classification
retire-done-plans --self-test  # exercise safety invariants against the consumer corpus
retire-done-plans --apply      # move committed finished plans and rewrite relative links
```

The plan schema and `done` versus `reference` decision are documented in
[`conventions/plan-frontmatter.md`](conventions/plan-frontmatter.md).

The optional composite action runs the same executable; consumers should pin it to an immutable
commit SHA:

```yaml
- uses: minipuft/repository-standards/actions/retire-plans@0123456789abcdef0123456789abcdef01234567
  with:
    mode: apply
```

## Delivery contract

The delivery contract is the commit, ADR, and release scaffolding a consumer shares with the rest
of the fleet: outcome-named commit titles, a PR body that is checked and lands on `main` via
squash-merge, the `Plan:` footer and `Decision:` trailer carried onto that squash commit, and an
append-only ADR log with a generated index. It installs into a consumer repository from a sibling
checkout of this repository — set `REPOSITORY_STANDARDS_DIR` once, defaulting to
`~/Applications/repository-standards`:

```bash
export REPOSITORY_STANDARDS_DIR=~/Applications/repository-standards
```

```bash
node "$REPOSITORY_STANDARDS_DIR/bin/delivery-contract.cjs" install --scopes a,b --adr-dir docs/adr --package-manager pnpm
```

`--package-manager` (`npm` | `pnpm` | `bun`, default `npm`) picks the install/exec commands
rendered into the CI workflow's title-lint step and `.husky/commit-msg` — `npm ci
--ignore-scripts` / `npx --no --`, `pnpm install --frozen-lockfile --ignore-scripts` / `pnpm
exec`, or `bun install --frozen-lockfile` / `bunx` — and, for pnpm and bun, adds the matching
`actions/setup-*` step before `Setup Node.js`.

`--node-version-file PATH` (default `.node-version`) sets `setup-node`'s `node-version-file` —
point it at `package.json` for a consumer that declares Node in `engines` instead of carrying a
`.node-version` file.

`--omit path,path` (only valid with `install`) names managed files — each must appear as a
`managed` entry in the template manifest — that `install`/`update` must never write and `update`
must never delete; `check` skips them. Use it when a fork can't carry a given managed path itself
(e.g. a fork tracking an upstream that owns `.husky/` puts the same hook content elsewhere and
runs `install --omit .husky/commit-msg`).

```bash
node "$REPOSITORY_STANDARDS_DIR/bin/delivery-contract.cjs" update
```

```bash
node "$REPOSITORY_STANDARDS_DIR/bin/delivery-contract.cjs" check
```

Seeded files (the PR template, `commitlint.config.mjs`, the ADR template) are the repository's own
once written, so `update` never overwrites them and `check` never fails on them. Both commands
print one advisory line per seeded file whose bytes differ from the template at the installed
version, so a rule the template retired (a PR template still asking for an `Initiative:` trailer)
is found without reading the file:

```text
seeded  .github/pull_request_template.md differs from the template; review it (template: …/templates/delivery-contract/.github/pull_request_template.md)
```

A rendered seeded file (`commitlint.config.mjs`) is compared against its render from the answers
in `.delivery-contract.json`, so the repository's own `scopes` are not a difference. The line
changes no exit code; a seeded file the repository deleted is not reported.

Commit right after `install` — it writes `.delivery-contract.json` alongside the scaffolding, and
an uncommitted managed file is exactly what `update` later refuses to overwrite.

| Managed (template owns it; drift fails `check`)  | Seeded (written once; yours after that) |
| ------------------------------------------------ | --------------------------------------- |
| `commitlint.rules.mjs`                           | `commitlint.config.mjs`                 |
| `.husky/commit-msg`                              | `.github/pull_request_template.md`      |
| `.github/workflows/pr-conventions.yml`           | `docs/adr/0000-template.md`             |
| `scripts/pr-check.mjs`                           |                                         |
| `scripts/pr-body.mjs`                            |                                         |
| `scripts/plan-rows.mjs`                          |                                         |
| `scripts/validate-plan-rows.mjs`                 |                                         |
| `scripts/validate-pr-body.mjs`                   |                                         |
| `scripts/validate-squash-message.mjs`            |                                         |
| `scripts/warn-contract-lag.mjs`                  |                                         |
| `scripts/vendor/conventional-commits-parser.cjs` |                                         |
| `scripts/adr.mjs`                                |                                         |
| `scripts/validate-github-action-pins.mjs`        |                                         |
| `scripts/validate-required-contexts.mjs`         |                                         |
| `scripts/validate-lockfile-sync.mjs`             |                                         |
| `scripts/validate-git-hooks-active.mjs`          |                                         |
| `scripts/create-worktree.mjs`                    |                                         |
| `scripts/merge-unreleased-changelog.mjs`         |                                         |
| `scripts/ratchet.mjs`                            |                                         |

The `PR Conventions` workflow checks the PR body against the template, lints the title with the
repo's commitlint config, and checks that release-please can parse the commit the squash merge
will write. The body and squash-commit checks each run a positive control first, and
`scripts/pr-check.mjs` runs the same steps locally before `gh pr create`.

One step warns and never fails: `scripts/warn-contract-lag.mjs` compares `.delivery-contract.json`
`templateVersion` with the latest published release of this repository and annotates the PR with
both versions and the remedy (`delivery-contract update` from a checkout at that release) only when
the contract is behind AND the `templates/delivery-contract` tree differs between the installed tag
and the latest tag (owner ruling Q1, the same rule the fleet audit applies): a release that touched
only the audit, CI, docs or the CLI is silent. It makes at most three GitHub API calls (latest
release, then the template tree at each tag) and prints "not compared" when the installed tag does
not exist. On 2026-10-20 six fleet repositories sat at 1.7.0 under a 1.10.1
release and nothing reported it. The step is a warning because a new release changes nothing a
PR controls: failing would turn every open downstream PR red on release day, and the fix is its
own adoption PR. It exits 0 on a network or API error too, and runs with `continue-on-error`.
`scripts/pr-check.mjs` lists it in `ADVISORY_CI_STEPS` rather than mirroring it, and a test fails
if any unmirrored step is missing from that list or could fail the job. The fleet audit is what
fails on the lag (below).

The squash-commit check exists because release-please leaves out any commit its parser rejects,
and says so only in a debug log: no changelog line, no version bump, no BREAKING CHANGE note. The
squash commit is not the body as written. GitHub re-flows the body at 72 columns, so a long line
can end up starting with `name(` and closing its parenthesis on the next line, which the parser
refuses. On 2026-10-19 that dropped two claude-prompts-mcp PRs from a release, one of them a
breaking change, although both bodies passed every other check.
`scripts/validate-squash-message.mjs` rebuilds the squash message and reads it the way
release-please 17.6.0 does: a commit-override block in the PR body
([release-please's README](https://github.com/googleapis/release-please/tree/v17.6.0#how-can-i-fix-release-notes))
replaces it. On failure it names the squash-message line, the PR-body line it came from, and the
fix: put an example call on one line inside a fenced code block, reword the line, or add an
override block. release-please opens that block at the bare marker word anywhere in the body,
inside a code fence too, so the script prints each marker split in two (`BEGIN_COMMIT_ +
OVERRIDE`) and never whole: a refusal pasted into the Demonstration section stays inert.

The parser is `@conventional-commits/parser` 0.4.1, the version release-please-action v5.0.0
bundles. It is vendored as a managed file, so the check runs before any install, like the body
check. Regenerate it from the pinned devDependency with
`node scripts/vendor-conventional-commits-parser.mjs`; a test fails while the two differ. Move
that devDependency only together with the release-please-action pin the fleet uses.

The `Plan:` footer is the join key: a PR that executes a plan ends with one `Plan:` line naming
the plan file, and a decision commit also carries `Decision: ADR-NNNN`. Query an initiative's PRs
by the plan slug:

```bash
git log --grep='Plan: .*<slug>'
```

ADRs are numbered, never renumbered or reused, and only their status changes after acceptance:

```bash
node scripts/adr.mjs new "title" --initiative x
node scripts/adr.mjs supersede NNNN "title"
node scripts/adr.mjs index
node scripts/adr.mjs check
```

Eight more managed scripts answer questions every member has. None needs a dependency; each takes
`--root <dir>` (default: the repository the script sits in), has a `--self-test`, and is wired by
the member's own `package.json` or workflow, which the contract does not write:

| Script                            | Fails when                                                                                                                                                                                                                                          | Exits 0 and says why when                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `validate-github-action-pins.mjs` | an external `uses:` under `.github/`, or `actions/`, is not a 40-hex SHA with a same-line `# vX.Y.Z` comment, or a `docker://` ref has no `@sha256:` digest                                                                                         | —                                                                                              |
| `validate-required-contexts.mjs`  | a context in `.github/required-contexts.json` matches no job `name:` (or id) in `.github/workflows/`, or names an interpolated `${{ }}` job                                                                                                         | the JSON file is absent (creating it opts in)                                                  |
| `validate-lockfile-sync.mjs`      | a tracked `package-lock.json` disagrees with npm's `node_modules/.package-lock.json` beside it (version mismatch, missing, unexpected), or that tree is not installed                                                                               | the contract answers a package manager other than npm, or no lockfile is tracked               |
| `validate-git-hooks-active.mjs`   | a linked worktree would skip a tracked `.husky/*` hook because `.husky/_` was never generated there (git runs nothing and exits 0 for an unresolvable `core.hooksPath`)                                                                             | the checkout is not a linked worktree, or no hook is tracked                                   |
| `create-worktree.mjs`             | `git worktree add` + husky in the new tree + a `node_modules` symlink per installed package directory cannot prove every tracked hook is live afterwards                                                                                            | —                                                                                              |
| `merge-unreleased-changelog.mjs`  | the changelog it is pointed at does not exist                                                                                                                                                                                                       | `[Unreleased]` is empty (it still keeps that header above the newest version)                  |
| `validate-plan-rows.mjs`          | a plan row breaks `conventions/plan-rows.md`: a ☐/⊘ row with no stamp (⚠/✗ too under `--strict-stamps`), an unknown status glyph, a table split from its header, or a `status:` outside the vocabulary                                             | there is no plans directory (`plansDirectory` in `plan-retirement.config.json`, else `plans/`) |
| `ratchet.mjs`                     | a per-key debt count (eslint rule, knip category, tsc file) rose without `--allow-increase <key> <reason>`, fell without `update-baseline`, or stopped reporting; the baseline was recorded under different arguments; or the tool is not installed | there is no baseline (`<adapter> update-baseline` opts in)                                     |

The hook pair exists because `core.hooksPath` is the relative `.husky/_`, a directory husky
generates and self-ignores, so a plain `git worktree add` yields a worktree where every hook is
silently skipped. `create-worktree.mjs` is the bootstrap that makes them fire;
`validate-git-hooks-active.mjs` is the check that notices when someone used `git worktree add`
instead. This repository runs the pin check on its own tree (`npm run validate:workflows`).

`delivery-contract settings [--apply] [--repo PATH]` prints (or, with `--apply`, runs via `gh`)
the squash-merge and delete-branch-on-merge settings the contract depends on, reading owner/repo
from the target checkout's `origin` remote. It never touches the default branch — changing that
stays an owner act.

## Fleet ESLint preset

The coding standards a lint can check live here as one ESLint flat-config preset, so every
repository reads the same thresholds from one place. Two layers:

- `base` needs no type information. Use it in every repository; it applies to whatever files
  your config already lints, so a TypeScript repository must already parse `.ts` (for example
  with `typescript-eslint`'s parser).
- `typed` needs type information. Add it where your config sets
  `parserOptions.project` or `parserOptions.projectService`. It is a separate entry point, so a
  JavaScript-only repository never installs `typescript-eslint`.

The package is the same pinned tarball the other standards ship in. Its peers are optional, so
a repository that only uses `retire-done-plans` installs nothing extra; a repository that lints
installs them itself:

```bash
npm install --save-dev eslint eslint-plugin-sonarjs typescript-eslint
```

```js
// eslint.config.mjs
import { base } from "@minipuft/repository-standards-validation/eslint";
import { typed } from "@minipuft/repository-standards-validation/eslint/typed";

export default [
  // ...your parser and file setup
  ...base,
  ...typed,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
```

| Rule                                      | Setting          | Standard (source)                                 | Why this threshold                                                                  |
| ----------------------------------------- | ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `sonarjs/cognitive-complexity`            | error, 15        | Complexity limits (`refactoring.md`)              | Cognitive, not cyclomatic: it weights nesting, which is what costs a reader         |
| `complexity`                              | off              | Complexity limits (`refactoring.md`)              | Cyclomatic counts every `??` and `?.` as a branch and blocks idiomatic code         |
| `max-depth`                               | error, 4         | Complexity limits (`refactoring.md`)              | Nesting is what cognitive complexity charges for; 4 is the ceiling                  |
| `max-params`                              | error, 6         | Complexity limits (`refactoring.md`)              | 6, not 4: a constructor taking five injected services is dependency injection       |
| `max-lines`                               | warn, 1000       | Size guidance (`refactoring.md`)                  | A warning only: size asks how many responsibilities a file holds, it does not block |
| `no-empty`                                | error, catch too | Handle errors explicitly (`CLAUDE.md`)            | An empty catch discards the failure                                                 |
| `fleet/no-log-and-swallow`                | warn             | Error and state boundaries (`architecture.md`)    | A catch that only logs reports success to its caller                                |
| `fleet/no-scattered-logging`              | warn             | Wide-event logging (`wide-event-telemetry` skill) | One wide event per unit of work; a console line is the scattered form               |
| `fleet/no-vague-suffix`                   | warn             | Naming standards (`CLAUDE.md`)                    | `Manager`, `Handler`, `Helper`, `Utils` and a domain-less `Service` name a category |
| `@typescript-eslint/no-floating-promises` | error (`typed`)  | Error and state boundaries (`architecture.md`)    | An unawaited promise reports success before persistence returns                     |
| `@typescript-eslint/naming-convention`    | warn (`typed`)   | Naming standards (`CLAUDE.md`)                    | No type decoration: `IUser`, `EStatus` and `strName` repeat what the type says      |

The sources are rule files in the owner's Claude Code configuration; `eslint/index.mjs` exports
the same table as `provenance`, and a test fails when the preset, that export, and this table
disagree.

`fleet/no-vague-suffix` asks the naming table's diagnostic question instead of proposing a
name ("What does managing mean here?"). `Service` passes when a domain word precedes it
(`OrderPricingService`), and `Handler` passes when the word before it names an event
(`AuthRequestHandler`).

**Overrides are declared in the consumer's config, after the preset**, because a later flat
config object replaces an earlier one's setting for the same rule. Say why in a comment, so the
next reader can tell a decision from drift:

```js
export default [
  ...base,
  {
    // Adopted under a lint ratchet: existing functions over 15 are counted, not blocked.
    rules: { "sonarjs/cognitive-complexity": ["warn", 15] },
  },
  {
    // A CLI's output is console text by design.
    files: ["src/cli/**"],
    rules: { "fleet/no-scattered-logging": "off" },
  },
];
```

A single file opts out of the logging rule with a reason, which ESLint reports as unused once
the file stops calling `console`:

```js
/* eslint-disable fleet/no-scattered-logging -- a CLI's output is console text by design */
```

## Contract boundaries

The shared verifier performs a frozen, script-disabled npm install and validates installed package inventory. It does not execute contract-supplied commands. Local workflows retain product-specific tests.

The `claude-prompts` product version has one writer: `claude-prompts-release-sync`. Downstream Renovate configurations extend the tagged `downstream` preset, which ignores that dependency.

## What the fleet audit counts as drift

The audit separates two questions that are easy to conflate. Branch protection answers whether a
check is **required**; the check-runs on `main` answer whether it **passed**. Both are read.

| Observed on `main` HEAD                                                                  | Classification                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Required check concluded `failure`, `timed_out`, `action_required`, or `startup_failure` | **Drift** — the audit fails. A red required check blocks every sync PR                            |
| Non-required check failing                                                               | Note — reported, does not fail the audit; surfaces broken release paths that cannot block a merge |
| Any check pending, `cancelled`, or `stale`                                               | Note — an in-flight run is not evidence of drift                                                  |
| Required check absent from `main` HEAD                                                   | Note — distinct from absent from protection, which is drift                                       |
| Outcome probe did not run                                                                | Note — an unverified rule announces itself rather than passing silently                           |

`success`, `neutral`, and `skipped` are treated as passing.

It also measures each member against the latest repository-standards release, because falling
behind failed nothing: on 2026-10-20 six members sat at delivery-contract template 1.7.0 and three
consumer callers pinned v1.0.0 while this repository had released 1.10.1, and the audit passed
them all. The latest release is read from this checkout — the version from
`.release-please-manifest.json`, its commit from the local `v<version>` tag — so no API request
can turn a flaky network into a false failure. The workflow checks out full history for the tags,
and also runs when a release is published.

**A release that does not change what a member uses is not lag.** Older is not enough: a member is
behind only when the files it consumes differ between what it pins and the latest release tag
(`git diff` between the two local tags). A release that changes only the audit, CI, docs or the
CLI flags nobody. Each kind of pin is compared over its own files:

| Pin                                                                                     | Files compared                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.delivery-contract.json` `templateVersion`                                             | `templates/delivery-contract/**`                                                                                                                                             |
| Consumer caller's `consumer-contract.yml@` pin and `standards-ref`                      | `.github/workflows/consumer-contract.yml`, `actions/verify-consumer/**`, `lib/consumer-contract-validator.mjs`, `profiles.json`, `contracts/downstream-contract.schema.json` |
| `renovate.json` or `.github/renovate.json` `extends` of `…//renovate/downstream.json#v` | `renovate/downstream.json`                                                                                                                                                   |

The consumer files are what the reusable workflow executes. `package.json` and
`package-lock.json`, which its verifier also installs from, are left out: Release Please bumps
`package.json` in every release, so counting them would flag every member on every release again.

| Observed                                                                                                                   | Classification                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A pin older than the latest release, and its files changed since                                                           | **Drift** — named with the pin, the latest release, the release that last changed the files, and the remedy |
| A pin older than the latest release, and its files unchanged since                                                         | No drift                                                                                                    |
| Caller pin differs from `fleet.json` `standardsRef`                                                                        | **Drift** — the existing pin checks                                                                         |
| Renovate preset pin differs from `fleet.json` `renovatePresetVersion`                                                      | **Drift** — declaration and member must agree                                                               |
| A member on, or ahead of, the latest release, or with no Renovate config extending the preset                              | No drift                                                                                                    |
| Contract or Renovate config unreadable, no `templateVersion`, a pinned version or the latest tag missing from the checkout | Note — the lag is reported unverified, never failed                                                         |

## Versioning and rollback

Tags are immutable. Contract-breaking changes require a new major. Compatible validation additions require a minor; fixes require a patch. If a release is defective, publish a new tag and update each caller by PR rather than moving an existing tag.

Releases are cut by Release Please from Conventional Commits: it opens a release PR that
carries the `package.json` bump and the `CHANGELOG.md` entry together, and tags on merge.
Do not hand-edit the version or hand-write a released entry. Releasing was previously a
manual bump whose changelog step was silently optional, and `1.2.1` and `1.3.0` both shipped
undocumented as a result — a consumer pinning a tag could not see what it was adopting.
Their entries were reconstructed from their tag ranges on 2026-08-24 and are marked as such.

Remove a required context before reverting the workflow that emits it. Do not restore competing product-version writers as rollback.

The scheduled fleet audit may read public files without a secret. Reading branch-protection metadata across repositories typically requires a fine-grained `FLEET_AUDIT_TOKEN` with read-only Administration access to the registered repositories. The audit token is never used for mutation; the repository-scoped `github.token` updates only the standards dashboard issue.
