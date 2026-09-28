import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(
  new URL("../bin/delivery-contract.cjs", import.meta.url),
);

const MANAGED = "commitlint.rules.mjs";
const SEEDED = "commitlint.config.mjs";
const HOOK = "scripts/verify.sh";

function fixture(t) {
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-contract-test-"),
  );
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const template = path.join(sandbox, "template");
  fs.mkdirSync(path.join(template, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(template, MANAGED),
    "export const rules = { 'type-enum': [2, 'always', ['feat', 'fix']] };\n",
  );
  fs.writeFileSync(
    path.join(template, SEEDED),
    "export default { scopes: {{scopes}}, adr: '{{adrDir}}' };\n",
  );
  fs.writeFileSync(path.join(template, HOOK), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(
    path.join(template, "manifest.json"),
    JSON.stringify({
      files: [
        { path: MANAGED, class: "managed" },
        { path: SEEDED, class: "seeded", render: true },
        { path: HOOK, class: "managed", mode: "0755" },
      ],
      answers: {
        scopes: { type: "array", default: ["repo"], description: "scopes" },
        adrDir: { type: "string", default: "docs/adr", description: "ADRs" },
        defaultBranch: {
          type: "string",
          default: "main",
          description: "branch",
        },
      },
    }),
  );

  const consumer = path.join(sandbox, "consumer");
  fs.mkdirSync(consumer);
  execFileSync("git", ["init", "-q"], { cwd: consumer });
  return { template, consumer };
}

function run({ template, consumer }, ...args) {
  return spawnSync(
    process.execPath,
    [executable, ...args, "--repo", consumer, "--template", template],
    { encoding: "utf8" },
  );
}

function commitAll(consumer, message = "fixture") {
  execFileSync("git", ["add", "-A"], { cwd: consumer });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=delivery-contract-test",
      "-c",
      "user.email=delivery-contract@example.invalid",
      "commit",
      "-qm",
      message,
    ],
    { cwd: consumer },
  );
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel));

test("install writes managed, seeded, and answers files and renders the scopes literal", (t) => {
  const f = fixture(t);
  const result = run(f, "install", "--scopes", "api,cli");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^write  ${MANAGED}$`, "m"));
  assert.match(result.stdout, new RegExp(`^seed   ${SEEDED}$`, "m"));

  assert.deepEqual(read(f.consumer, MANAGED), read(f.template, MANAGED));
  assert.equal(
    read(f.consumer, SEEDED).toString(),
    "export default { scopes: ['api', 'cli'], adr: 'docs/adr' };\n",
  );
  assert.equal(fs.statSync(path.join(f.consumer, HOOK)).mode & 0o777, 0o755);

  const answers = JSON.parse(read(f.consumer, ".delivery-contract.json"));
  assert.deepEqual(answers.answers, {
    scopes: ["api", "cli"],
    adrDir: "docs/adr",
    defaultBranch: "main",
  });
  assert.equal(typeof answers.templateVersion, "string");
});

test("a second install writes nothing and leaves the answers file byte-identical", (t) => {
  const f = fixture(t);
  assert.equal(run(f, "install").status, 0);
  const before = read(f.consumer, ".delivery-contract.json");

  const again = run(f, "install");
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^(write|seed|update) /m);
  assert.match(again.stdout, /up to date/);
  assert.deepEqual(read(f.consumer, ".delivery-contract.json"), before);
});

test("check fails on a mutated managed file and names it", (t) => {
  const f = fixture(t);
  run(f, "install");
  assert.equal(run(f, "check").status, 0);

  fs.appendFileSync(path.join(f.consumer, MANAGED), "// local\n");
  const result = run(f, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`drift  ${MANAGED}`));
});

test("check fails when the contract is not installed", (t) => {
  const f = fixture(t);
  const result = run(f, "check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not installed/);
});

test("update overwrites a committed mutation of a managed file", (t) => {
  const f = fixture(t);
  run(f, "install");
  fs.appendFileSync(path.join(f.consumer, MANAGED), "// local\n");
  commitAll(f.consumer);

  const result = run(f, "update");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^update ${MANAGED}$`, "m"));
  assert.deepEqual(read(f.consumer, MANAGED), read(f.template, MANAGED));
  assert.equal(run(f, "check").status, 0);
});

test("update refuses an uncommitted mutation, prints the diff, and writes nothing", (t) => {
  const f = fixture(t);
  run(f, "install");
  commitAll(f.consumer);
  fs.appendFileSync(path.join(f.consumer, MANAGED), "// uncommitted\n");
  fs.writeFileSync(path.join(f.consumer, HOOK), "#!/bin/sh\nexit 1\n");
  commitAll(f.consumer, "hook drift, committed");
  fs.appendFileSync(path.join(f.consumer, MANAGED), "// still local\n");
  const managedBefore = read(f.consumer, MANAGED);
  const hookBefore = read(f.consumer, HOOK);

  const result = run(f, "update");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^-\/\/ uncommitted$/m);
  assert.match(result.stderr, /refusing to update/);
  assert.deepEqual(read(f.consumer, MANAGED), managedBefore);
  // The committed drift on HOOK is updatable, but a refusal writes nothing in that run.
  assert.deepEqual(read(f.consumer, HOOK), hookBefore);
});

test("update never touches a seeded file, even when the template's copy changed", (t) => {
  const f = fixture(t);
  run(f, "install");
  const seededBefore = read(f.consumer, SEEDED);
  fs.writeFileSync(path.join(f.template, SEEDED), "export default {};\n");
  fs.appendFileSync(path.join(f.template, MANAGED), "// v2\n");

  const result = run(f, "update");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(SEEDED));
  assert.deepEqual(read(f.consumer, SEEDED), seededBefore);
  assert.equal(run(f, "check").status, 0);
});

test("an answers file that violates the schema exits 2 on every subcommand", (t) => {
  const f = fixture(t);
  run(f, "install");
  const answersPath = path.join(f.consumer, ".delivery-contract.json");
  const document = JSON.parse(fs.readFileSync(answersPath, "utf8"));
  document.answers.scopes = [];
  document.answers.unknown = true;
  fs.writeFileSync(answersPath, JSON.stringify(document));

  for (const command of ["install", "update", "check"]) {
    const result = run(f, command);
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
    assert.match(result.stderr, /violates the schema/);
    assert.match(result.stderr, /must NOT have fewer than 1 items/);
  }
});

test("install rejects an empty --scopes before writing anything", (t) => {
  const f = fixture(t);
  const result = run(f, "install", "--scopes", ",");
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(f.consumer, MANAGED)), false);
});

test("--self-test exits 0", () => {
  const result = spawnSync(process.execPath, [executable, "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^FAIL/m);
});
