import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { slugify } from "../templates/delivery-contract/scripts/adr.mjs";

const adrPath = fileURLToPath(
  new URL("../templates/delivery-contract/scripts/adr.mjs", import.meta.url),
);
const cloudySkyAdr = "/home/minipuft/Applications/cloudySky/docs/adr";

const STYLE_A = (number, title, fields = {}) =>
  [
    "---",
    `number: ${number}`,
    `title: "${title}"`,
    `status: ${fields.status ?? "accepted"}`,
    `date: ${fields.date ?? "2026-09-01"}`,
    `initiative: ${fields.initiative ?? ""}`.trimEnd(),
    `supersedes: ${fields.supersedes ?? ""}`.trimEnd(),
    `superseded_by: ${fields.superseded_by ?? ""}`.trimEnd(),
    "---",
    "",
    `# ADR ${number}: ${title}`,
    "",
    "## Context",
    "",
    "Style A.",
    "",
  ].join("\n");
const STYLE_B =
  "# 2. Numbered Heading Decision\n\nDate: 2026-07-11\n\n## Status\n\nAccepted\n\n## Context\n\nStyle B.\n";
const STYLE_C =
  "# ADR 0003: List Metadata Decision\n\n- Status: accepted (amended 2026-08-02 — see § Amendment)\n- Date: 2026-07-29\n- Owners: @minipuft\n\n## Context\n\nStyle C.\n";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr-test-"));
  for (const [name, text] of Object.entries(files))
    fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function threeStyles() {
  return fixture({
    "0001-front-matter-decision.md": STYLE_A("0001", "Front matter decision", {
      initiative: "delivery-contract",
    }),
    "0002-numbered-heading-decision.md": STYLE_B,
    "0003-list-metadata-decision.md": STYLE_C,
  });
}

function run(dir, ...args) {
  return spawnSync(process.execPath, [adrPath, ...args, "--dir", dir], {
    encoding: "utf8",
  });
}

const read = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
const tableRows = (readme) =>
  readme.split("\n").filter((l) => /^\| \d{4} /.test(l));

const cells = (row) =>
  row
    .slice(1, -1)
    .split(" | ")
    .map((c) => c.trim());

function changedLineCount(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length, "line count must not change");
  return a.filter((line, i) => line !== b[i]).length;
}

test("slugify leaves a short title unchanged", () => {
  assert.equal(
    slugify("Use Widgets for Everything"),
    "use-widgets-for-everything",
  );
});

test("slugify cuts a 90-character title on a whole word from the title, at or under 60 chars", () => {
  const title =
    "Git trailers are the join keys between a PR, its initiative and its decisions";
  const longTitle = `${title} plus extra words to push past ninety characters total length`;
  assert.ok(longTitle.length >= 90, longTitle.length);
  const slug = slugify(longTitle);
  assert.ok(slug.length <= 60, slug);
  assert.ok(!slug.endsWith("-"), slug);
  const words = longTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-");
  let prefix = "";
  for (const word of words) {
    const next = prefix ? `${prefix}-${word}` : word;
    if (next.length > 60) break;
    prefix = next;
  }
  assert.equal(slug, prefix);
});

test("index lists all three file styles with parsed fields", () => {
  const dir = threeStyles();
  assert.equal(run(dir, "index").status, 0);
  const rows = tableRows(read(dir, "README.md"));
  assert.equal(rows.length, 3);
  assert.deepEqual(cells(rows[0]), [
    "0001",
    "[Front matter decision](0001-front-matter-decision.md)",
    "accepted",
    "2026-09-01",
    "",
    "",
    "delivery-contract",
  ]);
  assert.deepEqual(cells(rows[1]).slice(0, 4), [
    "0002",
    "[Numbered Heading Decision](0002-numbered-heading-decision.md)",
    "accepted",
    "2026-07-11",
  ]);
  assert.deepEqual(cells(rows[2]).slice(0, 4), [
    "0003",
    "[List Metadata Decision](0003-list-metadata-decision.md)",
    "accepted",
    "2026-07-29",
  ]);
  assert.equal(run(dir, "check").status, 0);
});

test("index is idempotent", () => {
  const dir = threeStyles();
  run(dir, "index");
  const first = read(dir, "README.md");
  run(dir, "index");
  assert.equal(read(dir, "README.md"), first);
});

test("index preserves prose outside the markers", () => {
  const dir = threeStyles();
  const prose =
    "# Decisions\n\nHand-written intro.\n\n<!-- adr-index:start -->\nold\n<!-- adr-index:end -->\n\n## Lifecycle\n\nHand-written outro.\n";
  fs.writeFileSync(path.join(dir, "README.md"), prose);
  run(dir, "index");
  const readme = read(dir, "README.md");
  assert.ok(readme.startsWith("# Decisions\n\nHand-written intro.\n\n"));
  assert.ok(readme.endsWith("\n\n## Lifecycle\n\nHand-written outro.\n"));
  assert.ok(!readme.includes("\nold\n"));
  assert.equal(tableRows(readme).length, 3);
});

test("new numbers from the max existing ADR and skips the template", () => {
  const dir = threeStyles();
  fs.writeFileSync(
    path.join(dir, "0007-late-decision.md"),
    STYLE_A("0007", "Late"),
  );
  fs.writeFileSync(
    path.join(dir, "0000-template.md"),
    "# ADR NNNN: Title\n\n- Status: proposed\n- Date: YYYY-MM-DD\n- Owners: @handle\n\n## Context\n\nWhy.\n",
  );
  const result = run(
    dir,
    "new",
    "Use  Widgets!! for Everything",
    "--initiative",
    "widgets",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0008-use-widgets-for-everything\.md/);
  const created = read(dir, "0008-use-widgets-for-everything.md");
  assert.match(
    created,
    /^---\nnumber: 0008\ntitle: "Use {2}Widgets!! for Everything"\nstatus: proposed\n/,
  );
  assert.match(created, /initiative: widgets\n/);
  assert.match(
    created,
    /# ADR 0008: Use {2}Widgets!! for Everything\n\n- Owners: @handle\n\n## Context\n\nWhy\.\n/,
  );
  assert.ok(!created.includes("- Status:"));
  const rows = tableRows(read(dir, "README.md"));
  assert.ok(!rows.some((r) => r.startsWith("| 0000 ")));
  assert.ok(rows.some((r) => r.startsWith("| 0008 ")));
});

test("supersede links both ends and changes one line of a style-B file", () => {
  const dir = threeStyles();
  const before = read(dir, "0002-numbered-heading-decision.md");
  const result = run(dir, "supersede", "0002", "Replacement");
  assert.equal(result.status, 0, result.stderr);
  const after = read(dir, "0002-numbered-heading-decision.md");
  assert.equal(changedLineCount(before, after), 1);
  assert.match(after, /## Status\n\nSuperseded by ADR-0004\n/);
  const created = read(dir, "0004-replacement.md");
  assert.match(created, /status: accepted\n/);
  assert.match(created, /supersedes: 0002\n/);
  const row = tableRows(read(dir, "README.md")).find((r) =>
    r.startsWith("| 0002 "),
  );
  assert.equal(cells(row)[2], "superseded");
  assert.equal(cells(row)[5], "0004");
  assert.equal(run(dir, "check").status, 0);
});

test("supersede changes exactly one line of a style-C file", () => {
  const dir = threeStyles();
  const before = read(dir, "0003-list-metadata-decision.md");
  assert.equal(run(dir, "supersede", "3", "Replacement").status, 0);
  const after = read(dir, "0003-list-metadata-decision.md");
  assert.equal(changedLineCount(before, after), 1);
  assert.match(after, /^- Status: superseded by ADR-0004$/m);
  assert.equal(
    read(dir, "0001-front-matter-decision.md"),
    STYLE_A("0001", "Front matter decision", {
      initiative: "delivery-contract",
    }),
  );
  assert.equal(run(dir, "check").status, 0);
});

test("check fails on an asymmetric supersession link", () => {
  const dir = fixture({
    "0001-old.md": STYLE_A("0001", "Old", {
      status: "superseded",
      superseded_by: "0002",
    }),
    "0002-new.md": STYLE_A("0002", "New"),
  });
  run(dir, "index");
  const result = run(dir, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /0001: asymmetric supersession/);
});

test("check fails when a proposed ADR supersedes an accepted one", () => {
  const dir = fixture({
    "0001-old.md": STYLE_A("0001", "Old"),
    "0002-new.md": STYLE_A("0002", "New", {
      status: "proposed",
      supersedes: "0001",
    }),
  });
  run(dir, "index");
  const result = run(dir, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /0002: proposed ADR supersedes 0001/);
});

test("check fails on a numbering gap unless the index carries a (deleted) row", () => {
  const dir = fixture({
    "0001-a.md": STYLE_A("0001", "A"),
    "0003-c.md": STYLE_A("0003", "C"),
  });
  run(dir, "index");
  const gap = run(dir, "check");
  assert.equal(gap.status, 1);
  assert.match(gap.stdout, /0002: numbering gap/);

  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# ADRs\n\n<!-- adr-index:start -->\n| 0002 | (deleted) |\n<!-- adr-index:end -->\n",
  );
  run(dir, "index");
  assert.match(read(dir, "README.md"), /^\| 0002 \| \(deleted\) /m);
  const ok = run(dir, "check");
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^ok 2 ADRs$/m);
  assert.match(
    run(dir, "new", "D").stdout,
    /0004-d\.md/,
    "a deleted number is never reused",
  );
});

test("check fails on unknown status, dangling successor, and a stale index, and never writes", () => {
  const dir = fixture({
    "0001-a.md": STYLE_A("0001", "A", {
      status: "superseded",
      superseded_by: "0009",
    }),
    "0002-b.md": STYLE_A("0002", "B", { status: "pondering" }),
  });
  const result = run(dir, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /0001: superseded_by 0009, which does not exist/);
  assert.match(result.stdout, /0002: unknown status "pondering"/);
  assert.match(result.stdout, /README\.md: missing/);
  assert.ok(!fs.existsSync(path.join(dir, "README.md")));
});

test("--self-test exits 0", () => {
  const result = spawnSync(process.execPath, [adrPath, "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.stdout.includes("FAIL"));
});

test(
  "index over a copy of the real cloudySky ADR set leaves every ADR file untouched",
  { skip: !fs.existsSync(cloudySkyAdr) && "cloudySky checkout not present" },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "adr-cloudysky-"));
    const dir = path.join(root, "adr");
    fs.cpSync(cloudySkyAdr, dir, { recursive: true });
    const adrFiles = fs
      .readdirSync(dir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f));
    const before = new Map(adrFiles.map((f) => [f, read(dir, f)]));
    assert.equal(run(dir, "index").status, 0);
    const rows = tableRows(read(dir, "README.md"));
    assert.equal(rows.length, 13);
    for (const row of rows)
      assert.match(cells(row)[2], /^(accepted|superseded)$/, row);
    for (const [name, text] of before)
      assert.equal(read(dir, name), text, name);
  },
);
