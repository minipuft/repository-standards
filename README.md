# Repository Standards

Versioned consumer contracts, reusable validation, dependency policy, and read-only fleet drift reporting for first-party `minipuft` repositories.

## Lifecycle

- `contracts/downstream-contract.schema.json`: canonical contract v1 schema.
- `profiles.json`: canonical profile registry.
- `actions/verify-consumer`: canonical executable verifier.
- `.github/workflows/consumer-contract.yml`: canonical read-only reusable workflow.
- `renovate/*.json`: canonical shareable Renovate presets.
- `fleet.json` and `scripts/audit-fleet.mjs`: canonical read-only drift inventory and audit.
- `conventions/plan-frontmatter.md`: canonical plan frontmatter schema, status vocabulary, and retirement contract.
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

## Contract boundaries

The shared verifier performs a frozen, script-disabled npm install and validates installed package inventory. It does not execute contract-supplied commands. Local workflows retain product-specific tests.

The `claude-prompts` product version has one writer: `claude-prompts-release-sync`. Downstream Renovate configurations extend the tagged `downstream` preset, which ignores that dependency.

## Versioning and rollback

Tags are immutable. Contract-breaking changes require a new major. Compatible validation additions require a minor; fixes require a patch. If a release is defective, publish a new tag and update each caller by PR rather than moving an existing tag.

Remove a required context before reverting the workflow that emits it. Do not restore competing product-version writers as rollback.

The scheduled fleet audit may read public files without a secret. Reading branch-protection metadata across repositories typically requires a fine-grained `FLEET_AUDIT_TOKEN` with read-only Administration access to the registered repositories. The audit token is never used for mutation; the repository-scoped `github.token` updates only the standards dashboard issue.
