import assert from "node:assert/strict";
import test from "node:test";

import {
  NON_FINAL_STATUSES,
  STATUS_GLYPHS,
  STATUSES,
  cellsOf,
  glyphInfo,
  hasStamp,
  isSeparatorRow,
  orphanTableBlocks,
  parsePlanTables,
  planRowStates,
  readFrontmatter,
} from "../templates/delivery-contract/scripts/plan-rows.mjs";

const FM = "---\ntitle: t\ndate: 2026-10-20\nstatus: active\ntags: []\n---\n\n";
const table = (header, ...rows) =>
  `${header}\n${header.replace(/[^|]+/g, " --- ")}\n${rows.join("\n")}\n`;

test("the vocabulary is exactly ☐ ⚠ ✓ ⊘ ✗, with ⊘ closed-no-change and ✗ killed (R18)", () => {
  assert.deepEqual(
    STATUS_GLYPHS.map((entry) => entry.glyph),
    ["☐", "⚠", "✓", "⊘", "✗"],
  );
  assert.equal(glyphInfo("⊘").name, "closed-no-change");
  assert.equal(glyphInfo("✗").name, "killed");
  assert.equal(glyphInfo("⚠").lifecycle, "open");
  assert.equal(glyphInfo("✅"), undefined);
  assert.ok(Object.isFrozen(STATUS_GLYPHS));
});

test("the status vocabulary matches plan-frontmatter.md and the footer's non-final set is unchanged", () => {
  assert.deepEqual([...STATUSES], ["active", "backlog", "done", "reference"]);
  assert.deepEqual(
    [...NON_FINAL_STATUSES],
    ["active", "backlog", "proposal", "draft", "loaded", "reserved"],
  );
});

test("a cell holding two glyphs is read by its first character (R20)", () => {
  const rows = parsePlanTables(
    table(
      "| # | St | Change |",
      "| 3.0 | ✓ 2026-10-20 · quotes ⊘ | x |",
      "| 3.1 | ✓ glyphs ☐/⊘ | x |",
      "| 3.2 | ☐ (as of 2026-10-20 · flips when ✓) | x |",
    ),
  );
  assert.deepEqual(
    rows.map((row) => [row.rowId, row.status]),
    [
      ["3.0", "✓"],
      ["3.1", "✓"],
      ["3.2", "☐"],
    ],
  );
  assert.deepEqual(
    planRowStates(table("| # | St | Change |", "| 3.0 | ✓ quotes ☐ | x |")).map(
      (row) => row.state,
    ),
    ["terminal"],
  );
});

test("the status column is St or Status, never State (R19)", () => {
  for (const header of ["St", "Status", "status", "ST"]) {
    const [row] = parsePlanTables(
      table(`| # | ${header} | Change |`, "| 1.1 | ☐ | x |"),
    );
    assert.equal(row.statusFromHeader, true, header);
  }
  const [stateRow] = parsePlanTables(
    table("| # | State | Change |", "| 1.1 | ☐ | x |"),
  );
  assert.equal(stateRow.statusFromHeader, false);
  assert.deepEqual(
    planRowStates(table("| # | State | Change |", "| 1.1 | ☐ | x |")),
    [],
  );
});

test("a table with no status column falls back to the first glyph in the row", () => {
  const [row] = parsePlanTables(
    table("| Item | Note |", "| thing | ☐ still pending, not ✓ |"),
  );
  assert.equal(row.status, "☐");
  assert.equal(row.statusFromHeader, false);
});

test("an escaped pipe does not shift the status column", () => {
  const [row] = parsePlanTables(
    table("| # | Verify | St |", "| 1.1 | `rg x \\| wc -l` | ✓ |"),
  );
  assert.equal(row.status, "✓");
  assert.deepEqual(cellsOf("| a \\| b | c |"), ["a \\| b", "c"]);
});

test("a separator needs three dashes per cell; a one-dash separator opens no table", () => {
  assert.equal(isSeparatorRow("| --- | :---: | ---: |"), true);
  assert.equal(isSeparatorRow("|---|---|"), true);
  assert.equal(isSeparatorRow("| - | - |"), false);
  const text = "| # | St |\n| - | - |\n| 1.1 | ☐ |\n";
  assert.equal(parsePlanTables(text)[0].statusFromHeader, false);
  assert.equal(orphanTableBlocks(text).length, 1);
});

test("fenced code is not table structure", () => {
  const text = "```\n| 1.1 | ☐ | in a fence |\n```\n";
  assert.deepEqual(parsePlanTables(text), []);
  assert.deepEqual(orphanTableBlocks(text), []);
});

test("a blank line mid-table orphans the rows after it, reported once per block", () => {
  const text =
    table("| # | St | Change |", "| 1.1 | ✓ | x |") +
    "\n| 1.2 | ☐ | y |\n| 1.3 | ☐ | z |\n";
  assert.deepEqual(orphanTableBlocks(text), [{ line: 5, rowId: "1.2" }]);
  const twoTables =
    table("| # | St |", "| 1.1 | ✓ |") + "\n" + table("| A | B |", "| a | b |");
  assert.deepEqual(orphanTableBlocks(twoTables), []);
  assert.deepEqual(
    [...new Set(parsePlanTables(twoTables).map((row) => row.tableIndex))],
    [0, 1],
  );
});

test("a table missing its header (opens on a separator) is not an orphan block", () => {
  assert.deepEqual(orphanTableBlocks("| --- | --- |\n| a | b |\n"), []);
});

test("stamps need both halves", () => {
  assert.equal(hasStamp("☐", "| ☐ (as of 2026-10-20 · flips when x) |"), true);
  assert.equal(hasStamp("☐", "| ☐ (as of 2026-10-20) |"), false);
  assert.equal(hasStamp("☐", "| ☐ (flips when x) |"), false);
  assert.equal(
    hasStamp("⚠", "| ⚠ (as of 2026-10-20 · flips when x) |"),
    true,
  );
  assert.equal(hasStamp("⊘", "| ⊘ (verified 2026-10-20 · reason) |"), true);
  assert.equal(hasStamp("⊘", "| ⊘ (verified 2026-10-20) |"), false);
  assert.equal(
    hasStamp("✗", "| ✗ KILLED (2026-10-20 · reason · revives if x) |"),
    true,
  );
  assert.equal(
    hasStamp("✗", "| ✗ KILLED (2026-10-20 · reason · revives-if x) |"),
    true,
  );
  assert.equal(hasStamp("✗", "| ✗ KILLED (2026-10-20 · reason) |"), false);
  assert.equal(
    hasStamp("✗", "| ✗ (2026-10-20 · reason · revives if x) |"),
    false,
  );
  assert.equal(hasStamp("✓", "| ✓ |"), true);
});

test("planRowStates keeps the shape validate-pr-body reads", () => {
  const text =
    FM +
    table(
      "| Id | St | Change |",
      "| R1 | ☐ | x |",
      "| R2 | ⚠ | x |",
      "| R3 | ✓ | x |",
      "| R4 | ⊘ | x |",
      "| R5 | ✗ | x |",
      "| R6 | RULED | x |",
      "|    | ☐ | no id, skipped |",
      "| **`R7`** | ✓ | id markup stripped |",
    );
  assert.deepEqual(planRowStates(text), [
    { id: "R1", state: "open", line: 10 },
    { id: "R2", state: "open", line: 11 },
    { id: "R3", state: "terminal", line: 12 },
    { id: "R4", state: "terminal", line: 13 },
    { id: "R5", state: "terminal", line: 14 },
    { id: "R6", state: "unmarked", line: 15 },
    { id: "R7", state: "terminal", line: 17 },
  ]);
});

test("frontmatter reads the key: value subset, quotes dropped", () => {
  assert.deepEqual(
    readFrontmatter(
      "---\ntitle: \"A plan\"\nstatus: active\npublish: 'PRs #1-#3'\ntags: []\n---\nbody",
    ),
    { title: "A plan", status: "active", publish: "PRs #1-#3", tags: "[]" },
  );
  assert.equal(readFrontmatter("no block\n"), null);
  assert.equal(readFrontmatter("---\nstatus: active\n"), null);
  assert.equal(
    readFrontmatter("---\r\nstatus: done\r\n---\r\n").status,
    "done",
  );
});
