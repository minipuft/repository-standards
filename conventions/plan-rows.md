# Plan Row Convention

A plan's work lives in markdown table rows, and each row carries a status glyph. A glyph is a
claim about the row, so every claim except ✓ carries a stamp that makes it re-checkable: a date,
and what would change it. This document is the grammar. The parser and vocabulary are one module,
`scripts/plan-rows.mjs`, installed by the delivery contract; `scripts/validate-plan-rows.mjs`
enforces the rules below, and `scripts/validate-pr-body.mjs` reads the same parser for the
`Plan:` footer check. Frontmatter (`status:` and the other fields) is
[`plan-frontmatter.md`](plan-frontmatter.md).

## Status glyphs

| glyph | name              | lifecycle | asserts                                                          |
| ----- | ----------------- | --------- | ---------------------------------------------------------------- |
| `☐`   | open              | open      | Measured and still open; names what would close it               |
| `⚠`  | premise falsified | open      | Still open, but its premise was falsified and it needs rewriting |
| `✓`   | done              | terminal  | Done; the artifact it names is in the repository                 |
| `⊘`   | closed, no change | terminal  | Investigated and settled, and no change was required             |
| `✗`   | killed            | terminal  | Judged not worth its cost; names what would revive it            |

Nothing else is a status glyph. `⊘` is not a kill: it closes a row whose investigation found
nothing to change, which neither ✓ (claims an edit) nor ☐ (claims pending work) describes
honestly. A caller that reduces a row to "finished or not" reads the lifecycle column; a row whose
status cell opens with no glyph at all (a word such as `RULED`) is unmarked and counts as
unfinished.

## Stamps

| glyph | stamp, anywhere in the row                                         |
| ----- | ------------------------------------------------------------------ |
| `☐`   | `(as of YYYY-MM-DD · flips when <observation>)`                    |
| `⚠`  | `(as of YYYY-MM-DD · flips when <observation>)`                    |
| `⊘`   | `(verified YYYY-MM-DD · <reason>)`                                 |
| `✗`   | `✗ KILLED (YYYY-MM-DD · <reason> · revives if <observation>)`      |
| `✓`   | none here; whether its artifact is committed is a repository check |

Both halves of every stamp are required: a date alone cannot say what would change the row, and
a reason alone cannot be aged. The `·` separator may also be written `-`. `revives-if` is accepted
for `revives if`.

## Reading a table

- **Status column.** The header cell `St` or `Status`, any case. `State` is not a status column.
- **One glyph per cell.** A status cell is read by its first character. A ✓ cell that quotes `⊘`
  or `☐` in its own text is a ✓ row.
- **No status column.** A row in a table whose header names no status column, or that has no
  header at all, is read by the first status glyph anywhere in the row, so an open row in an
  unusual table is still seen. Only the ☐ and ⊘ stamp rules read such rows; the ⚠, ✗ and
  unknown-glyph rules read a declared status column only, because a comparison matrix uses ✗ to
  mean "not supported".
- **Separator row.** Every cell is three or more dashes, optionally colon-aligned (`---`,
  `:---:`). A one-dash separator does not open a table, and the contiguity rule reports the block
  it fails to open.
- **Escaped pipes.** `\|` inside a cell is text, never a column boundary.
- **Fenced code.** Lines inside a ` ``` ` fence, delimiters included, are not table structure.
  A fence ends a table the same way a blank line does.
- **Row id.** The first cell, with `*` and backticks removed. A row with an empty id cell is not
  gradable by a reader that matches rows across two versions of a plan.
- **Contiguity.** Every run of consecutive table lines must open with its own header and
  separator. A blank line, a heading or prose inserted mid-table orphans every row after it.

## Which files

The plans directory is `plansDirectory` in `plan-retirement.config.json` when that file exists,
otherwise `plans/`; a repository with no plans directory has nothing to check. Every `*.md` under
it is read, skipping `archive/` and `future/` subtrees (out of the working set, and usually
untracked) and `*.validation-log.md` machine sidecars. Explicit paths replace the walk: a
consumer that grades only committed plans passes its own `git ls-files` list.

`*-implementation-notes.md` files are exempt from every row rule whatever their `status:`. Row
rules other than contiguity grade `status: active` plans only: a reference plan is a record and a
backlog plan is speculative, so stamping either is work with no reader.

## Rules (`validate-plan-rows.mjs`)

| rule                | fires when                                                                           | plans  |
| ------------------- | ------------------------------------------------------------------------------------ | ------ |
| `open-stamp`        | a ☐ row carries no `as of · flips when` stamp                                        | active |
| `closed-stamp`      | a ⊘ row carries no `verified · reason` stamp                                         | active |
| `warning-stamp`     | a ⚠ row carries no `as of · flips when` stamp (`--strict-stamps`)                   | active |
| `killed-stamp`      | a ✗ row carries no `KILLED (date · reason · revives if …)` stamp (`--strict-stamps`) | active |
| `unknown-glyph`     | a status cell opens with a symbol outside the five glyphs                            | active |
| `table-contiguity`  | a run of table lines does not open with a header and separator                       | any    |
| `status-vocabulary` | frontmatter `status:` is outside `active`, `backlog`, `done`, `reference`            | any    |

`--strict-stamps` turns on the ⚠ and ✗ stamp rules. They are opt-in because the stamps were a
convention before they were a rule: rows written before it exist (five in claude-prompts-mcp's
active plans when the rule landed), and a consumer turns them on once its plans carry them.

`node scripts/validate-plan-rows.mjs [--root <dir>] [--json] [--strict-stamps] [paths...]` exits
0 when clean, 1 with findings and 2 on a usage or I/O error. `--json` prints
`{"findings":[{rule,file,line,rowId?,message}]}` and nothing else. `--self-test` plants one
defect per rule in a temporary directory and proves each one fails.

What stays with a consumer's own gate, because it reads more than the plan files: whether the
paths a ✓ row names are committed (the git index), and any list of accepted exceptions.
