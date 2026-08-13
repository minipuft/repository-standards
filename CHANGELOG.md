# Changelog

## 1.2.0

- Add the portable `retire-done-plans` executable and consumer configuration schema.
- Add optional composite-action packaging for CI consumers without duplicating the executable.
- Fail closed when retirement configuration or a configured citation source is missing.
- Preserve plan link rewriting and committed-content protection for repositories without CI.

## 1.1.0

- Add a versioned fleet inventory and deterministic read-only drift audit.
- Add a weekly dashboard workflow with explicit cross-repository read credentials.

## 1.0.1

- Correct the internal Renovate preset reference to the immutable `v1.0.0` tag.

## 1.0.0

- Add downstream contract schema and marketplace, node-consumer, and npm-publisher profiles.
- Add a read-only reusable consumer workflow and exact installed-artifact verification.
- Add shareable base/downstream Renovate presets with sole-writer policy.
