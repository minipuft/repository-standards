import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { extractJobNames } from "../templates/delivery-contract/scripts/validate-required-contexts.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/validate-required-contexts.mjs",
    import.meta.url,
  ),
);
const FIXTURES = fileURLToPath(
  new URL("./fixtures/required-contexts/", import.meta.url),
);

function fixture(name) {
  return path.join(FIXTURES, name);
}

function workflow(name, file) {
  return fs.readFileSync(
    path.join(fixture(name), ".github", "workflows", file),
    "utf8",
  );
}

function namesIn(name, file) {
  return extractJobNames(workflow(name, file), file).map((job) => job.name);
}

function validate(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], {
    encoding: "utf8",
  });
}

/** A scratch copy of a fixture, so a test can change one byte of it. */
function scratchCopy(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "required-contexts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(fixture(name), dir, { recursive: true });
  return dir;
}

test("claude-prompts-mcp's workflows satisfy its required contexts", () => {
  const result = validate(fixture("claude-prompts-mcp"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /all resolve to a job name \(5 checked\)/);
  assert.deepEqual(namesIn("claude-prompts-mcp", "ci.yml"), [
    "Classify validation scope",
    "Lint & Validate",
    "CLI",
    "Build",
    "Test (Node ${{ matrix.node }})",
    "E2E (Node ${{ matrix.node }})",
    "Test Suite",
    "PR Summary",
  ]);
});

test("renaming a required job's name: turns the check red", (t) => {
  const root = scratchCopy(t, "claude-prompts-mcp");
  const ciPath = path.join(root, ".github", "workflows", "ci.yml");
  const before = fs.readFileSync(ciPath, "utf8");
  const after = before.replace("    name: Build\n", "    name: Build & Pack\n");
  assert.notEqual(after, before, "the rename must change the workflow");
  fs.writeFileSync(ciPath, after);

  const result = validate(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /required context "Build" matches no job/);
  assert.doesNotMatch(result.stderr, /required context "CLI"/);
});

test("double- and single-quoted names are unquoted", () => {
  const names = namesIn("quoted-names", "ci.yml");

  assert.equal(names[0], "Double Quoted");
  assert.equal(names[1], "Single 'Quoted'");
  assert.equal(validate(fixture("quoted-names")).status, 0);
});

test("a trailing comment is not part of a name, a # inside quotes is", () => {
  const names = namesIn("quoted-names", "ci.yml");

  assert.equal(names[2], "Commented");
  assert.equal(names[3], "Quoted # not a comment");
});

test("a matrix-interpolated required context is rejected", () => {
  const result = validate(fixture("interpolated"));

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is interpolated, so its name changes/);
});

test("a job without name: is matched by its id", () => {
  assert.deepEqual(
    extractJobNames(workflow("id-only", "ci.yml"), "ci.yml").map(
      ({ jobId, name }) => [jobId, name],
    ),
    [
      ["lint", "lint"],
      ["build", "Build"],
    ],
  );
  assert.equal(validate(fixture("id-only")).status, 0);
});

test("step names, a nested environment name and the workflow name are not jobs", () => {
  assert.deepEqual(namesIn("not-jobs", "publish.yml"), ["publish", "compact"]);

  const result = validate(fixture("not-jobs"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required context "Checkout" matches no job/);
  assert.doesNotMatch(result.stderr, /required context "(publish|compact)"/);
});

test("jobs indented four spaces are read at that indentation", () => {
  assert.deepEqual(namesIn("four-space", "ci.yml"), ["Build", "lint"]);
  assert.equal(validate(fixture("four-space")).status, 0);
});

test("a repository without required-contexts.json passes and is told how to opt in", () => {
  const result = validate(fixture("no-json"));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /required-contexts\.json is absent/);
  assert.match(result.stdout, /"branch" and "contexts" opts in/);
});

test("a flow-style jobs: fails, naming the file", () => {
  const result = validate(fixture("flow-jobs"));

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /ci\.yml:5: `jobs: \{\}` is written in flow style/,
  );
});

test("a malformed required-contexts.json fails", (t) => {
  const root = scratchCopy(t, "id-only");
  fs.writeFileSync(
    path.join(root, ".github", "required-contexts.json"),
    '{ "contexts": ["Build",] }\n',
  );

  const result = validate(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not valid JSON/);
});

test("shapes the reader cannot resolve with certainty are refused", () => {
  const refused = {
    "multi-line name": "jobs:\n  a:\n    name: Build\n      and test\n",
    "block-scalar name": "jobs:\n  a:\n    name: >-\n      Build\n",
    "merge key": "jobs:\n  a:\n    <<: *defaults\n",
    "flow-style job": "jobs:\n  a: { name: Build }\n",
    "empty jobs block": "jobs:\nname: CI\n",
  };

  for (const [shape, text] of Object.entries(refused)) {
    assert.throws(() => extractJobNames(text, "x.yml"), /x\.yml:\d+/, shape);
  }
});

test("every readable fixture workflow agrees with a YAML parser", () => {
  const roots = fs
    .readdirSync(FIXTURES)
    .filter((name) => name !== "flow-jobs")
    .map((name) => path.join(fixture(name), ".github", "workflows"));
  let compared = 0;

  for (const dir of roots) {
    for (const file of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      const expected = Object.entries(YAML.parse(text).jobs).map(
        ([jobId, job]) => String(job?.name ?? jobId),
      );
      assert.deepEqual(
        extractJobNames(text, file).map((job) => job.name),
        expected,
        `${dir}/${file}`,
      );
      compared += 1;
    }
  }

  assert.ok(compared >= 12, `compared only ${compared} workflows`);
});
