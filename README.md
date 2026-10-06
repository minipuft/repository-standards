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
squash-merge, `Initiative:`/`Decision:` trailers carried onto that squash commit, and an
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

Commit right after `install` — it writes `.delivery-contract.json` alongside the scaffolding, and
an uncommitted managed file is exactly what `update` later refuses to overwrite.

| Managed (template owns it; drift fails `check`) | Seeded (written once; yours after that) |
| ----------------------------------------------- | --------------------------------------- |
| `commitlint.rules.mjs`                          | `commitlint.config.mjs`                 |
| `.husky/commit-msg`                             | `.github/pull_request_template.md`      |
| `.github/workflows/pr-conventions.yml`          | `docs/adr/0000-template.md`             |
| `scripts/pr-check.mjs`                          |                                         |
| `scripts/pr-body.mjs`                           |                                         |
| `scripts/validate-pr-body.mjs`                  |                                         |
| `scripts/adr.mjs`                               |                                         |

Every commit on an initiative carries an `Initiative:` trailer; a decision commit also carries
`Decision:`. Query an arc, or find commits missing the trailer, with:

```bash
git log --format='%h %(trailers:key=Initiative,valueonly) %s' | grep -v '^\S\+  '
```

ADRs are numbered, never renumbered or reused, and only their status changes after acceptance:

```bash
node scripts/adr.mjs new "title" --initiative x
node scripts/adr.mjs supersede NNNN "title"
node scripts/adr.mjs index
node scripts/adr.mjs check
```

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
