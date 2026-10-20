import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assessHooks,
  parseArgs,
  trackedHooks,
} from "../templates/delivery-contract/scripts/validate-git-hooks-active.mjs";

const script = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/validate-git-hooks-active.mjs",
    import.meta.url,
  ),
);

// Every repository below lives under one scratch HOME. The user's global git config, and any
// GIT_DIR or GIT_INDEX_FILE inherited from a hook environment, must not reach these repos:
// a hook-run test that inherits GIT_DIR would operate on the real repository instead.
const scratch = realpathSync(
  mkdtempSync(path.join(tmpdir(), "git-hooks-active-")),
);
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_") || key === "HUSKY") delete process.env[key];
}
writeFileSync(path.join(scratch, ".gitconfig"), "");
Object.assign(process.env, {
  HOME: scratch,
  XDG_CONFIG_HOME: path.join(scratch, ".config"),
  GIT_CONFIG_GLOBAL: path.join(scratch, ".gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A committed repository holding `files`, with husky's relative hooksPath unless told not to. */
function makeRepo(name, files, { hooksPath = ".husky/_" } = {}) {
  const root = path.join(scratch, name);
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content, { mode: 0o755 });
  }
  git(scratch, "init", "-q", "-b", "main", root);
  if (hooksPath) git(root, "config", "core.hooksPath", hooksPath);
  git(root, "add", "-A", "-f");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

function addWorktree(root) {
  const worktree = `${root}-wt`;
  git(root, "worktree", "add", "-q", "-b", "feat", worktree);
  return worktree;
}

const validate = (root) =>
  spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });

const HOOKED = { ".husky/commit-msg": "#!/bin/sh\n", "README.md": "x\n" };

test("a linked worktree without .husky/_ is red, naming the hook and the remedy", () => {
  const worktree = addWorktree(makeRepo("unwired", HOOKED));
  const result = validate(worktree);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /silently skip commit-msg/);
  assert.match(
    result.stderr,
    /node scripts\/create-worktree\.mjs <path> <branch> \[--from <ref>\]/,
  );
});

test("a linked worktree with an executable .husky/_/commit-msg is green", () => {
  const worktree = addWorktree(makeRepo("wired", HOOKED));
  mkdirSync(path.join(worktree, ".husky", "_"));
  writeFileSync(
    path.join(worktree, ".husky", "_", "commit-msg"),
    "#!/bin/sh\n",
    {
      mode: 0o755,
    },
  );
  const result = validate(worktree);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /active in this linked worktree \(commit-msg\)/);
});

test("a plain clone is skipped although its hooks are unwired", () => {
  const origin = makeRepo("origin", HOOKED);
  const clone = path.join(scratch, "clone");
  git(scratch, "clone", "-q", origin, clone);
  git(clone, "config", "core.hooksPath", ".husky/_");
  const result = validate(clone);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped \(not a linked worktree/);
});

test("a linked worktree of a repository tracking no hook is skipped with that reason", () => {
  const worktree = addWorktree(
    makeRepo("hookless", { "README.md": "x\n" }, { hooksPath: null }),
  );
  const result = validate(worktree);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /skipped \(no hook is tracked under \.husky\//);
});

test("the derivation keeps tracked hooks and drops .husky/_/, .gitignore and helpers", () => {
  const root = makeRepo("derivation", {
    ".husky/commit-msg": "#!/bin/sh\n",
    ".husky/pre-push": "#!/bin/sh\n",
    ".husky/.gitignore": "_\n",
    ".husky/helper.sh": "#!/bin/sh\n",
    ".husky/_/pre-commit": "#!/bin/sh\n",
  });
  assert.deepEqual(trackedHooks(root), ["commit-msg", "pre-push"]);
  assert.deepEqual(trackedHooks(path.join(scratch, "not-a-repo")), []);
});

test("assessHooks keeps every case of the original self-test with the list passed in", () => {
  const required = ["commit-msg", "pre-commit", "pre-push"];
  const linked = (presentHooks, hooksPath = ".husky/_") => ({
    isLinkedWorktree: true,
    hooksPath,
    presentHooks,
  });

  assert.deepEqual(assessHooks(linked(required), required).problems, []);
  const bare = assessHooks(linked([]), required);
  assert.equal(bare.problems.length, 1);
  for (const hook of required) assert.match(bare.problems[0], new RegExp(hook));
  const partial = assessHooks(linked(["pre-commit"]), required);
  assert.equal(partial.problems.length, 1);
  assert.doesNotMatch(partial.problems[0], /pre-commit/);
  assert.equal(
    assessHooks(
      { isLinkedWorktree: false, hooksPath: null, presentHooks: [] },
      required,
    ).skipped,
    true,
  );
  assert.equal(assessHooks(linked([], null), required).problems.length, 1);
  assert.equal(
    assessHooks(
      { isLinkedWorktree: false, hooksPath: ".husky/_", presentHooks: [] },
      required,
    ).skipped,
    true,
  );
  assert.equal(assessHooks(linked([]), required).skipped, false);

  const none = assessHooks(linked([], null), []);
  assert.equal(none.skipped, true);
  assert.deepEqual(none.problems, []);
  assert.match(none.reason, /no hook is tracked/);
});

test("parseArgs takes --root, --self-test or nothing, and refuses the rest", () => {
  assert.deepEqual(parseArgs([], "/default"), {
    root: "/default",
    selfTest: false,
  });
  assert.deepEqual(parseArgs(["--root", "/x"], "/default"), {
    root: "/x",
    selfTest: false,
  });
  assert.equal(parseArgs(["--self-test"], "/default").selfTest, true);
  assert.match(parseArgs(["--root"], "/default").error, /Usage/);
  assert.match(parseArgs(["--bogus"], "/default").error, /Usage/);
});

test("--self-test passes", () => {
  const result = spawnSync(process.execPath, [script, "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
