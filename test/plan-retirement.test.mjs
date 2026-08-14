import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const executable = fileURLToPath(
  new URL("../bin/retire-done-plans.cjs", import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL("../contracts/plan-retirement.schema.json", import.meta.url),
);

function frontmatter(status, title = "Example") {
  return `---\ntitle: "${title}"\ndate: 2026-08-13\nstatus: ${status}\ntags: []\n---\n\n# ${title}\n`;
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-retirement-test-"));
  fs.mkdirSync(path.join(root, "plans"));
  fs.mkdirSync(path.join(root, "docs"));
  if (options.config !== false) {
    fs.writeFileSync(
      path.join(root, "plan-retirement.config.json"),
      JSON.stringify(options.config ?? { linkSources: ["plans", "docs"] }),
    );
  }
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [executable, "--repo", root, ...args], {
    encoding: "utf8",
  });
}

function initializeGit(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=plan-retirement-test",
      "-c",
      "user.email=plan-retirement@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
}

test("the published schema requires the same fail-closed source contract", () => {
  const validate = new Ajv2020({ strict: true }).compile(
    JSON.parse(fs.readFileSync(schemaPath, "utf8")),
  );
  assert.equal(validate({ linkSources: ["plans", "docs"] }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ linkSources: [] }), false);
  assert.equal(validate({ linkSources: ["plans"], unknown: true }), false);
});

test("configuration is required and never defaults to an empty scan", (t) => {
  const root = fixture({ config: false });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /missing required configuration key `linkSources`/,
  );
});

test("linkSources is a required non-empty key", (t) => {
  const root = fixture({ config: {} });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /missing required configuration key `linkSources`/,
  );
});

test("a missing configured source fails before the plan scan", (t) => {
  const root = fixture({ config: { linkSources: ["plans", "missing"] } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /configured link source does not exist on disk: missing/,
  );
});

test("a source cannot escape the consuming repository", (t) => {
  const root = fixture({ config: { linkSources: ["plans", "../outside"] } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /escapes the consumer repository/);
});

test("a done plan with an inbound citation is a hard failure", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "plans", "finished.md"),
    frontmatter("done"),
  );
  fs.writeFileSync(
    path.join(root, "docs", "guide.md"),
    "See finished for context.\n",
  );

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /`status: done` but still referenced/);
  assert.match(result.stderr, /cited by docs\/guide\.md/);
});

test("apply refuses an archive destination that is not gitignored", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, "plans", "finished.md");
  fs.writeFileSync(plan, frontmatter("done"));
  initializeGit(root);

  const result = run(root, "--apply");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /plans[/\\]archive[/\\] must be gitignored/);
  assert.equal(fs.existsSync(plan), true);
});

test("apply archives a committed plan when the destination is ignored", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = path.join(root, "plans", "finished.md");
  fs.writeFileSync(plan, frontmatter("done"));
  fs.writeFileSync(path.join(root, ".gitignore"), "/plans/archive/\n");
  initializeGit(root);

  const result = run(root, "--apply");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(plan), false);
  assert.equal(
    fs.existsSync(path.join(root, "plans", "archive", "finished.md")),
    true,
  );
});

test("the extracted self-test runs against a real consumer corpus", (t) => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "plans", "active.md"),
    frontmatter("active"),
  );
  initializeGit(root);

  const result = run(root, "--self-test");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every resolvable link across 1 tracked plan/);
  assert.match(result.stdout, /self-test OK/);
});
