import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLANTED,
  RULES,
  auditPlan,
  validatePlans,
} from "../templates/delivery-contract/scripts/validate-plan-rows.mjs";

const SCRIPTS = fileURLToPath(
  new URL("../templates/delivery-contract/scripts/", import.meta.url),
);
const FIXTURES = fileURLToPath(
  new URL("./fixtures/plan-rows/", import.meta.url),
);
const fixture = (name) => path.join(FIXTURES, name);

/**
 * A consumer-shaped copy: the fixture tree with both managed scripts under `<tmp>/scripts/`, so
 * the sibling import and the `scripts/..` root lookup run exactly as they do after install.
 */
function consumer(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-rows-consumer-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixture(name), dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const file of ["plan-rows.mjs", "validate-plan-rows.mjs"]) {
    fs.copyFileSync(path.join(SCRIPTS, file), path.join(dir, "scripts", file));
  }
  return dir;
}

function run(dir, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    [path.join(dir, "scripts", "validate-plan-rows.mjs"), ...args],
    { encoding: "utf8", cwd: dir, env: { ...process.env, ...env } },
  );
}

const RED = [
  "open-stamp",
  "closed-stamp",
  "warning-stamp",
  "killed-stamp",
  "unknown-glyph",
  "table-contiguity",
  "status-vocabulary",
];

test("every rule has a reason line and a planted self-test case", () => {
  assert.deepEqual(Object.keys(RULES).sort(), [...RED].sort());
  assert.deepEqual(Object.keys(PLANTED).sort(), [...RED].sort());
});

test("the green corpus passes, from the consumer's scripts/ directory with no --root", (t) => {
  const result = run(consumer(t, "green"), ["--strict-stamps"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /PASSED: 3 plan\(s\) read; 7 status row\(s\) across 2 active plan\(s\), 4 carrying/,
  );
});

for (const rule of RED) {
  test(`a planted ${rule} defect exits 1 and names only its rule`, (t) => {
    const result = run(consumer(t, rule), ["--json", "--strict-stamps"]);
    assert.equal(result.status, 1, result.stderr);
    const { findings } = JSON.parse(result.stdout);
    assert.deepEqual(
      findings.map((f) => f.rule),
      [rule],
    );
    assert.equal(findings[0].file, path.join("plans", "plan.md"));
    assert.ok(Number.isInteger(findings[0].line) && findings[0].line > 0);
  });
}

test("a ✓ row quoting ⊘ or ☐ in its status cell is accepted (R20, claude-prompts-mcp #509)", (t) => {
  const result = run(consumer(t, "r20"), ["--json", "--strict-stamps"]);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { findings: [] });
});

test("⚠ and ✗ stamps are enforced only under --strict-stamps (R21)", (t) => {
  for (const rule of ["warning-stamp", "killed-stamp"]) {
    const result = run(consumer(t, rule), ["--json"]);
    assert.equal(result.status, 0, `${rule}: ${result.stdout}`);
  }
});

test("human output groups findings by rule with the rule's reason", (t) => {
  const result = run(consumer(t, "open-stamp"));
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /✖ open-stamp \(1\): A ☐ asserts nothing[^\n]*\n {2}- plans\/plan\.md:10 \[1\.1\]: a row marked ☐ carries no stamp/,
  );
});

test("implementation notes are exempt from row rules whatever their status (R22)", () => {
  const text = fs.readFileSync(
    path.join(fixture("green"), "plans", "active-plan-implementation-notes.md"),
    "utf8",
  );
  assert.deepEqual(auditPlan("plans/x-implementation-notes.md", text), []);
  assert.deepEqual(
    auditPlan("plans/x.md", text)
      .map((f) => f.rule)
      .sort(),
    ["open-stamp", "table-contiguity"],
  );
});

test("archive/ and future/ are skipped by the walk, but graded when named", () => {
  const root = fixture("green");
  const named = ["archive/old-plan.md", "future/speculative.md"].map((p) =>
    path.join(root, "plans", p),
  );
  const rules = validatePlans({ root, paths: named })
    .findings.map((f) => f.rule)
    .sort();
  assert.deepEqual(rules, [
    "open-stamp",
    "status-vocabulary",
    "table-contiguity",
  ]);
});

test("a reference plan's rows are not graded, and a status-less comparison ✗ is not a kill", () => {
  const { findings } = validatePlans({
    root: fixture("green"),
    strictStamps: true,
  });
  assert.deepEqual(findings, []);
});

test("plansDirectory from plan-retirement.config.json is the directory read", (t) => {
  const result = run(consumer(t, "plans-directory"), ["--json"]);
  assert.equal(result.status, 1);
  assert.deepEqual(
    JSON.parse(result.stdout).findings.map((f) => f.file),
    [path.join("docs", "plans", "plan.md")],
  );
});

test("a repository with no plans directory has nothing to check", (t) => {
  const dir = consumer(t, "plans-directory");
  fs.rmSync(path.join(dir, "docs"), { recursive: true });
  fs.rmSync(path.join(dir, "plans"), { recursive: true });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASSED: 0 plan\(s\) read/);
});

test("--root points the walk at another repository", () => {
  const result = spawnSync(
    process.execPath,
    [
      path.join(SCRIPTS, "validate-plan-rows.mjs"),
      "--root",
      fixture("open-stamp"),
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).findings[0].rule, "open-stamp");
});

test("usage and I/O errors exit 2", (t) => {
  const dir = consumer(t, "green");
  assert.equal(run(dir, ["--bogus"]).status, 2);
  assert.equal(run(dir, ["--root"]).status, 2);
  assert.equal(run(dir, ["plans/does-not-exist.md"]).status, 2);
  fs.writeFileSync(path.join(dir, "plan-retirement.config.json"), "{ nope");
  assert.equal(run(dir).status, 2);
});

test("the self-test proves every rule fails, and writes nothing outside its own tmpdir", (t) => {
  const dir = consumer(t, "green");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plan-rows-tmp-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const before = fs.readdirSync(dir, { recursive: true }).sort();

  const result = run(dir, ["--self-test"], { TMPDIR: scratch });

  assert.equal(result.status, 0, result.stderr);
  for (const rule of RED) {
    assert.match(result.stdout, new RegExp(`planted ${rule} defect is caught`));
  }
  assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before);
  assert.deepEqual(fs.readdirSync(scratch), []);
});
