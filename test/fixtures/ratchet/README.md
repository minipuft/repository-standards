# Ratchet adapter fixtures

Captured output of the three tools `ratchet.mjs` wraps, replayed by `test/ratchet-adapters.test.mjs` through the fake executables in `bin/`. Versions: eslint 10.8.1, TypeScript 6.0.3, knip 6.32.2 (the `claude-prompts-mcp` `server/` toolchain, 2026-10-23).

| File                         | Source                                                                                    | Trim                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `eslint-live.json`           | `eslint --format json src/shared/utils/process.ts` in `claude-prompts-mcp/server`         | first 5 messages, `suggestions`/`source` dropped, path made relative     |
| `eslint-unknown-rule.json`   | the same eslint binary over a scratch file pair: a parse error and an unused disable      | `source` dropped, paths made relative; both messages have `ruleId: null` |
| `tsc-errors.txt`             | `tsc --noEmit --pretty false --project tsconfig.test.json` in `claude-prompts-mcp/server` | first 16 lines (11 diagnostics, 5 continuation lines)                    |
| `tsc-fatal.txt`              | `tsc --pretty false --project missing.json` (exit 1)                                      | none: the whole output is one `error TS5058` line                        |
| `tsc-ansi.txt`               | `tsc --pretty true` over a scratch file with one type error (exit 2)                      | none; keeps its ESC bytes, so do not reformat it                         |
| `knip-live.json`             | `knip --reporter json --no-progress` in `claude-prompts-mcp/server`                       | one issue entry per category seen (6 entries)                            |
| `knip-duplicates.json`       | knip over a scratch package exporting `a` and `export default a`                          | none: `duplicates` holds one two-member group                            |
| `knip-unknown-category.json` | `knip-duplicates.json` plus a hand-added `futureCategory` array                           | one added key; no knip release emits it, it stands for a future category |

`bin/` holds the stand-ins the tests copy to `node_modules/.bin/<tool>`: `emit-fixture` (replays `FAKE_FIXTURE`, exits `FAKE_EXIT`), `crash` (stderr, exit 3), `killed` (SIGKILL) and `dangling-interpreter` (executable whose interpreter is missing, so spawn reports ENOENT).
