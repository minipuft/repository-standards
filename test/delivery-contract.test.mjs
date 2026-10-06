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

// -------------------------------------------------------------------------------------------
// omit: a fork that can't carry a given managed file (e.g. a `.husky/` hook when the fork's
// hooks live elsewhere) tells the contract to never write, never delete, and never flag it.

test("install --omit writes no such file, prints omit, and check is clean", (t) => {
  const f = fixture(t);
  const result = run(f, "install", "--scopes", "api", "--omit", HOOK);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^omit   ${HOOK}$`, "m"));
  assert.equal(fs.existsSync(path.join(f.consumer, HOOK)), false);

  const answers = JSON.parse(read(f.consumer, ".delivery-contract.json"));
  assert.deepEqual(answers.omit, [HOOK]);

  assert.equal(run(f, "check").status, 0);
});

test("update never writes an omitted file, even after the template's copy changed", (t) => {
  const f = fixture(t);
  run(f, "install", "--omit", HOOK);
  assert.equal(fs.existsSync(path.join(f.consumer, HOOK)), false);

  fs.writeFileSync(path.join(f.template, HOOK), "#!/bin/sh\nexit 1\n");
  const result = run(f, "update");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(`^update ${HOOK}$`, "m"));
  assert.match(result.stdout, new RegExp(`^omit   ${HOOK}$`, "m"));
  assert.equal(fs.existsSync(path.join(f.consumer, HOOK)), false);
  assert.equal(run(f, "check").status, 0);
});

test("omit naming a path that isn't a managed manifest entry exits 2", (t) => {
  const f = fixture(t);
  const result = run(f, "install", "--omit", SEEDED);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /does not name a managed file/);
  assert.equal(fs.existsSync(path.join(f.consumer, MANAGED)), false);
});

test("--self-test exits 0", () => {
  const result = spawnSync(process.execPath, [executable, "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^FAIL/m);
});

// -------------------------------------------------------------------------------------------
// packageManager: these cases run against the REAL default template (no --template override),
// because the fixture template above is synthetic and never touches the actual pnpm/bun-aware
// workflow or commit-msg hook. They are the ones a consumer's `install --package-manager pnpm`
// actually exercises.

const WORKFLOW_PATH = ".github/workflows/pr-conventions.yml";

// Captured from templates/delivery-contract/.github/workflows/pr-conventions.yml BEFORE this
// change added {{pmInstall}}/{{pmExec}}/{{pmSetup}} — a `render: true` managed file re-renders
// per consumer, so "byte-identical for the npm default" is the only way to prove this change
// left every existing (npm) consumer's rendered file untouched. A copy read at test time instead
// would just compare the template against itself and could never catch a regression here.
const NPM_DEFAULT_WORKFLOW = fs.readFileSync(
  fileURLToPath(
    new URL("./fixtures/pr-conventions.npm-default.yml", import.meta.url),
  ),
);

function realConsumer(t) {
  const consumer = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-contract-real-template-"),
  );
  t.after(() => fs.rmSync(consumer, { recursive: true, force: true }));
  return consumer;
}

function runReal(consumer, ...args) {
  return spawnSync(
    process.execPath,
    [executable, ...args, "--repo", consumer],
    { encoding: "utf8" },
  );
}

test("pnpm install renders the real workflow with pnpm's exec/setup and zero npm-only tokens", (t) => {
  const consumer = realConsumer(t);
  const install = runReal(
    consumer,
    "install",
    "--package-manager",
    "pnpm",
    "--scopes",
    "web,server",
  );
  assert.equal(install.status, 0, install.stderr);

  const workflow = fs.readFileSync(path.join(consumer, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /pnpm exec commitlint --verbose/);
  // SHA-pinned like every other `uses:` in this workflow — a bare `@v4` would be a
  // floating tag, which claude-prompts-mcp (a consumer) enforces against.
  assert.match(
    workflow,
    /^\s*- uses: pnpm\/action-setup@[0-9a-f]{40} # v4\.\d+\.\d+$/m,
  );
  // The pnpm/action-setup step must land before Setup Node.js, not after.
  assert.ok(
    workflow.indexOf("pnpm/action-setup@") <
      workflow.indexOf("name: Setup Node.js"),
  );
  assert.doesNotMatch(workflow, /npm ci/);
  assert.doesNotMatch(workflow, /npx --no --/);

  const hook = fs.readFileSync(
    path.join(consumer, ".husky/commit-msg"),
    "utf8",
  );
  assert.match(hook, /pnpm exec commitlint --edit "\$COMMIT_MSG_FILE"/);
});

test("npm default renders the real workflow byte-identical to today's committed template", (t) => {
  const consumer = realConsumer(t);
  const install = runReal(consumer, "install");
  assert.equal(install.status, 0, install.stderr);

  const rendered = fs.readFileSync(path.join(consumer, WORKFLOW_PATH));
  assert.deepEqual(rendered, NPM_DEFAULT_WORKFLOW);
});

test("check passes after a pnpm install, and fails after the rendered workflow is mutated", (t) => {
  const consumer = realConsumer(t);
  assert.equal(
    runReal(consumer, "install", "--package-manager", "pnpm").status,
    0,
  );
  assert.equal(runReal(consumer, "check").status, 0);

  fs.appendFileSync(path.join(consumer, WORKFLOW_PATH), "# locally mutated\n");
  const mutated = runReal(consumer, "check");
  assert.equal(mutated.status, 1);
  assert.match(mutated.stderr, new RegExp(`drift  ${WORKFLOW_PATH}`));
});

// A fork (e.g. t3code) declares Node in package.json `engines` instead of carrying a
// `.node-version` file; measured 2026-09-28 (t3code PR #11 CI): setup-node failed because the
// hardcoded `node-version-file: .node-version` names a file that does not exist there.
test("--node-version-file renders the requested path into setup-node", (t) => {
  const consumer = realConsumer(t);
  const install = runReal(
    consumer,
    "install",
    "--node-version-file",
    "package.json",
    "--scopes",
    "a",
  );
  assert.equal(install.status, 0, install.stderr);

  const workflow = fs.readFileSync(path.join(consumer, WORKFLOW_PATH), "utf8");
  assert.match(workflow, /node-version-file: package\.json/);
  assert.doesNotMatch(workflow, /node-version-file: \.node-version/);

  assert.equal(runReal(consumer, "check").status, 0);
});

// release-please opens its release PR with the repository owner's token, so the author is a
// human and `user.type != 'Bot'` never exempts it; the branch name is the only stable marker.
// Measured 2026-10-06 (claude-prompts-mcp): the body check ran against the "This release is too
// large to preview" stub and failed the first release PR. Every step the Bot guard covers must
// carry the branch-name exemption too, or a consumer's release PR meets a gate meant for authors.
const BOT_GUARD = "github.event.pull_request.user.type != 'Bot'";
const RELEASE_PLEASE_EXEMPTION =
  "!startsWith(github.head_ref, 'release-please--')";

function botGuardedStepsLackingExemption(workflow) {
  const lacking = [];
  let guarded = 0;
  for (const step of workflow.split(/^ {6}- /m).slice(1)) {
    const condition = step.match(/^ {8}if: (.+)$/m)?.[1];
    if (!condition?.includes(BOT_GUARD)) continue;
    guarded += 1;
    if (!condition.includes(RELEASE_PLEASE_EXEMPTION)) {
      lacking.push(step.split("\n", 1)[0]);
    }
  }
  return { guarded, lacking };
}

test("every Bot-guarded step of the rendered workflow also exempts a release-please pull request", (t) => {
  const consumer = realConsumer(t);
  assert.equal(runReal(consumer, "install").status, 0);
  const rendered = fs.readFileSync(path.join(consumer, WORKFLOW_PATH), "utf8");

  const { guarded, lacking } = botGuardedStepsLackingExemption(rendered);
  // Positive control: the probe sees the four authored-body steps, so an empty `lacking` is not
  // the result of matching nothing.
  assert.equal(guarded, 4);
  assert.deepEqual(lacking, []);

  // A twin differing in one step only: the exemption removed from the last guarded step must
  // be reported by name.
  const exemption = ` && ${RELEASE_PLEASE_EXEMPTION}`;
  const at = rendered.lastIndexOf(exemption);
  assert.notEqual(at, -1);
  const mutated = rendered.slice(0, at) + rendered.slice(at + exemption.length);
  assert.notEqual(mutated, rendered);
  const result = botGuardedStepsLackingExemption(mutated);
  assert.equal(result.lacking.length, 1);
  assert.match(result.lacking[0], /^name: Lint the title/);
});
