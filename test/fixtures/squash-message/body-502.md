## Summary

After this merges, a JSON file the server writes for someone to keep (a tool's `schema.json`, an exported skill's `tool.json` or `gates/index.json`) is already in the layout the repository's formatter checks, so updating a bundled tool through `resource_manager` no longer leaves a file `validate:format` refuses.

- `resource_manager` writes a tool's `schema.json` ending in a newline, with short arrays on one line, as Prettier prints it.
- Skills-sync exports `schema.json`, `tool.json` and `gates/index.json` the same way. Skills exported before this show as modified in `skills-sync diff` until exported again.
- No formatter runs at runtime, and nothing rewrites a file after it is written: one small writer prints the formatter's layout itself.

## Demonstration

A tool schema with `"required": ["id", "name"]`, written by `resource_manager`:

**Before** (`npx prettier --check` exit 1)

```
  "required": [
    "id",
    "name"
  ]
}            <- no newline at end of file
```

**After** (`npx prettier --check` exit 0)

```
  "required": ["id", "name"]
}
```

## How it was verified

| Claim | Probe | Baseline → measured | Mutation that fails it |
| --- | --- | --- | --- |
| Every bundled resource JSON file already has the writer's layout | `server/tests/unit/shared/utils/json-document-format.test.ts` parses each formatter-checked file under `server/resources` and rewrites it | old writer: 5 of 5 `schema.json` change → new writer: all byte-identical | drop the trailing newline → 33 of 35 tests fail |
| The writer and Prettier agree shape by shape | same file: synthetic shapes formatted by both, with the config Prettier resolves for `server/resources` | 79/80/81-column arrays, CJK and emoji widths, nested and empty arrays, number fill: all equal | width 100 instead of the JSON override's 80 → 7 fail; width counted in UTF-16 units → 3 fail |
| `resource_manager` plans and writes the new layout | `server/tests/unit/mcp-tools/resource-manager/prompt/tool-schema-file-format.test.ts` | preview text and file on disk both equal the expected text | — (exact-text assertion; the serializer mutations above fail it) |
| Skills-sync exports the new layout | `server/tests/integration/skills-sync/export-agent-skills.test.ts` | `tool.json` and `schema.json` exact text, trailing newline | — (exact-text assertion) |
| A live update produces a file the format check accepts | `resource_manager` prompt `update` of `reference_demo`'s `word_count` tool against `dist/`, then `prettier --check` | old writer's output exit 1 → written file byte-identical to the committed one, exit 0 | — |
| No regression elsewhere | `typecheck`, `lint:ratchet`, `typecheck:tests:ratchet`, `validate:all` | all exit 0; `validate:all` 87/87 | — (unit, integration and e2e run in CI) |

## Notes for Reviewers

- `server/src/shared/utils/json-document-format.ts`: character widths outside the CJK, kana, Hangul and emoji blocks count as one column, so a rare wide symbol near column 80 could still disagree with Prettier. The comparison tests cover the common cases.
- Only file writes changed. Of 23 `JSON.stringify(…, null, 2)` sites, 4 write resource or exported-skill files; the rest build response text or logs. Version-history snapshots, which compare serialized text, are untouched.

## Still open

- `generate-framework-schemas.ts`, `generate-config-schema.ts` and `capture-tool-schemas.mjs` still write the old layout, so their outputs stay in `.prettierignore`.
