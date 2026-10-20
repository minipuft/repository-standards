## Summary

After this merges, no two exported types in `server/src` share a name, and `resource_manager` refuses a wrongly shaped value for eight parameters it used to accept unchecked, publishing those shapes in `tools/list`.

- **BREAKING:** `tools`, `phases`, `activation`, `retry_config`, `gates`, `tool_descriptions`, `execution_type_enhancements` and `quality_indicators` are checked on arrival and refused with their path. To restrict a gate to frameworks, send `activation.framework_context`. The old description named `activation.frameworks`, which was never read and is now refused.
- `tools/list` publishes those real shapes. The `resource_manager` input schema grows from 36,365 to 38,466 bytes, and its size limit from 37,000 to 39,000.
- The bundled `create_gate`, `create_framework` and `create_prompt` prompts describe what the tool accepts.
- Version history has one resource-type vocabulary across the server and `cpm`. `cpm history`, `compare` and `rollback` refuse `style` by name, and their usage lines list only `prompt|gate|framework`.
- The duplicate type name check now starts from an empty list (37 → 0 names), so any new duplicate fails CI.

## Demonstration

`resource_manager(resource_type:"gate", action:"create", …, retry_config:{improvement_hints: 5})`, from a live server run:

**Before**

```
✅ Gate 'probe-gate-rc_hint' created successfully
[gate.yaml] retry_config:
  improvement_hints: false
```

**After**

```
isError=true
Input validation error: Invalid arguments for tool resource_manager:
retry_config.improvement_hints: Invalid input: expected boolean, received number
```

## How it was verified

| Claim | Probe | Baseline → measured | Mutation that fails it |
| --- | --- | --- | --- |
| Each of the 8 parameters refuses a wrong shape by path | live server, 21 wrongly shaped values plus 3 well-formed controls; `resource-manager-checked-parameters.test.ts` | 21 accepted or silently changed → 21 refused by path; controls write the same YAML | put the loose `.pipe()` back on `activation` → 3 tests fail |
| `tools/list` publishes the shapes it checks | `npm run validate:tool-schemas` against the captured snapshot | 36,365 → 38,466 bytes | ceiling left at 37,000 → exit 1 "over its ceiling" |
| No exported type name is defined twice | `node server/scripts/validate-type-name-homonyms.js` | 37 names → 0 over 1,300 definitions | add `export interface Logger {}` in a new file → exit 1 naming both sites |
| Deletions lowered the debt counts and nothing rose | `lint:ratchet`, knip ratchet, `typecheck:tests:ratchet` | ESLint 2297 → 2280, knip 1039 → 1024, tests typecheck 332 → 332 | any rule count rising fails its ratchet |
| The authoring prompts no longer teach the old shapes | `rg "element shape is not constrained\|activation\.frameworks" server/resources` | 6 sites → 0 | — (text search) |
| The branch passes the local gate | `typecheck`, `lint:ratchet`, `typecheck:tests:ratchet`, `validate:all` on the final tree | all exit 0; `validate:all` 87/87 | — (unit, integration and e2e run in CI) |

## Notes for Reviewers

- `server/src/mcp/tools/schemas/resource-manager.schema.ts`: the eight new shapes are copied from the loader schemas. Tests check that the keys stay in sync, but a wrong field type in a copy would still pass them.
- `server/src/mcp/tools/resource-manager/core/types.ts`: the hand-written input interface is gone. Code that typed fields more strictly than the schema checks now follows the schema, so a few framework input types got wider.
- `server/resources/prompts/examples/*/tools/*/schema.json`: the tool writes these files in a format the formatter rejects, so they were re-formatted after writing. Only formatting changed.

## Still open

- `resource_manager` writes a tool's `schema.json` in a form that fails `validate:format`, so every tool update needs a formatting pass.

Plan: `plans/reference/type-name-homonyms-2026-10-19.md`



BEGIN_COMMIT_OVERRIDE
refactor!: exported type names are unique; resource_manager checks the shapes it publishes (#501)
END_COMMIT_OVERRIDE
