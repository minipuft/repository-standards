import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveBaseRef } from "../templates/delivery-contract/scripts/validate-pr-body.mjs";

const installer = fileURLToPath(
  new URL("../bin/delivery-contract.cjs", import.meta.url),
);
const DEFAULT_BRANCH = "trunk";

function git(cwd, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=pr-body-test",
      "-c",
      "user.email=pr-body@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

/**
 * A consumer with the real delivery contract installed whose default branch is `trunk`, never
 * `main`: no `origin/main` exists, `origin/HEAD` points at `origin/trunk`, and the branch under
 * test carries one commit on top of it.
 */
function consumer(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pr-body-test-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const origin = path.join(sandbox, "origin.git");
  const repo = path.join(sandbox, "repo");
  git(sandbox, "init", "-q", "--bare", "-b", DEFAULT_BRANCH, origin);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", DEFAULT_BRANCH);
  const install = spawnSync(
    process.execPath,
    [installer, "install", "--default-branch", DEFAULT_BRANCH, "--repo", repo],
    { encoding: "utf8" },
  );
  assert.equal(install.status, 0, install.stderr);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "chore: install the delivery contract");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", DEFAULT_BRANCH);
  git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    `refs/remotes/origin/${DEFAULT_BRANCH}`,
  );
  git(repo, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(repo, "feature.txt"), "a change\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "feat(scope): the branch under test");
  return repo;
}

function prBody(repo, args = [], env = {}) {
  const out = path.join(repo, "body.md");
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "scripts", "pr-body.mjs"), ...args, "--out", out],
    {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_BASE_REF: "", ...env },
    },
  );
  return {
    ...result,
    body: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
  };
}

test("pr-body seeds a body without --base when the default branch is not main", (t) => {
  const repo = consumer(t);
  assert.throws(() => git(repo, "rev-parse", "--verify", "origin/main"));

  const result = prBody(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.body, /- feat\(scope\): the branch under test/);
  assert.doesNotMatch(result.body, /install the delivery contract/);
  assert.match(result.body, /base origin\/HEAD -->/);
});

test("pr-body measures against GITHUB_BASE_REF when CI sets it", (t) => {
  const repo = consumer(t);
  const result = prBody(repo, [], { GITHUB_BASE_REF: DEFAULT_BRANCH });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.body, /base origin\/trunk -->/);
});

test("an explicit --base wins over the resolved default", (t) => {
  const repo = consumer(t);
  const result = prBody(repo, ["--base", `origin/${DEFAULT_BRANCH}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.body, /base origin\/trunk -->/);
});

test("resolveBaseRef is the one definition: GITHUB_BASE_REF, else origin/HEAD", () => {
  assert.equal(resolveBaseRef({}), "origin/HEAD");
  assert.equal(resolveBaseRef({ GITHUB_BASE_REF: "" }), "origin/HEAD");
  assert.equal(
    resolveBaseRef({ GITHUB_BASE_REF: "custom/main" }),
    "origin/custom/main",
  );
});
