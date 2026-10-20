import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  packageDirectories,
  parseArgs,
} from "../templates/delivery-contract/scripts/create-worktree.mjs";

const scriptsDir = fileURLToPath(
  new URL("../templates/delivery-contract/scripts/", import.meta.url),
);

// One scratch HOME for every repository. The user's global git config, and any GIT_DIR or
// GIT_INDEX_FILE inherited from a hook environment, must not reach these repos.
const scratch = realpathSync(
  mkdtempSync(path.join(tmpdir(), "create-worktree-")),
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

// A stand-in for husky 9's bin: writes an executable `.husky/_/<hook>` for every hook file in
// `.husky/`, as the real one does for its fixed list.
const WRITING_HUSKY = `const fs = require("node:fs");
fs.mkdirSync(".husky/_", { recursive: true });
fs.writeFileSync(".husky/_/.gitignore", "*");
for (const name of fs.readdirSync(".husky")) {
  if (name === "_" || name.startsWith(".")) continue;
  fs.writeFileSync(".husky/_/" + name, "#!/bin/sh\\n", { mode: 0o755 });
}
`;
const SILENT_HUSKY = "// writes nothing, exits 0\n";

/**
 * A main worktree holding three package directories: root and `pkg/` are installed, `other/` is
 * not. The two managed scripts are copied into its `scripts/`, the shape a consumer receives.
 */
function makeMain(
  name,
  { husky = WRITING_HUSKY, gitignore = "node_modules\n" } = {},
) {
  const root = path.join(scratch, name);
  const files = {
    ".gitignore": gitignore,
    "package.json": "{}\n",
    "pkg/package.json": "{}\n",
    "other/package.json": "{}\n",
    ".husky/commit-msg": "#!/bin/sh\n",
    ".husky/pre-push": "#!/bin/sh\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  }
  git(scratch, "init", "-q", "-b", "main", root);
  git(root, "config", "core.hooksPath", ".husky/_");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");

  mkdirSync(path.join(root, "pkg", "node_modules"), { recursive: true });
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  if (husky !== null) {
    mkdirSync(path.join(root, "node_modules", "husky"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "husky", "bin.js"), husky);
  }
  mkdirSync(path.join(root, "scripts"));
  for (const file of ["create-worktree.mjs", "validate-git-hooks-active.mjs"]) {
    copyFileSync(path.join(scriptsDir, file), path.join(root, "scripts", file));
  }
  return root;
}

const create = (main, target, ...extra) =>
  spawnSync(
    process.execPath,
    [
      path.join(main, "scripts", "create-worktree.mjs"),
      target,
      "feat/x",
      ...extra,
    ],
    { cwd: main, encoding: "utf8" },
  );

test("a bootstrapped worktree links every installed package directory and has live hooks", () => {
  const main = makeMain("happy");
  const target = path.join(scratch, "happy-wt");
  const result = create(main, target);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  for (const relative of ["node_modules", path.join("pkg", "node_modules")]) {
    const link = path.join(target, relative);
    assert.ok(lstatSync(link).isSymbolicLink(), `${relative} is a symlink`);
    assert.equal(readlinkSync(link), path.join(main, relative));
  }
  assert.equal(existsSync(path.join(target, "other", "node_modules")), false);
  for (const hook of ["commit-msg", "pre-push"]) {
    accessSync(path.join(target, ".husky", "_", hook), constants.X_OK);
  }
  assert.match(result.stdout, /Hooks verified live .*commit-msg, pre-push/);

  // The sibling validator, run from the copied scripts against the new worktree, agrees.
  const validated = spawnSync(
    process.execPath,
    [
      path.join(main, "scripts", "validate-git-hooks-active.mjs"),
      "--root",
      target,
    ],
    { encoding: "utf8" },
  );
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  assert.match(
    validated.stdout,
    /active in this linked worktree \(commit-msg, pre-push\)/,
  );
});

test("packageDirectories returns installed package directories only", () => {
  const main = makeMain("dirs");
  assert.deepEqual(packageDirectories(main), [".", "pkg"]);
});

test("a husky that writes no wrappers fails the bootstrap, naming the remedy", () => {
  const main = makeMain("silent", { husky: SILENT_HUSKY });
  const result = create(main, path.join(scratch, "silent-wt"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(
    result.stderr,
    /hooks are still not wired: .*\.husky\/_\/commit-msg does not exist/,
  );
  assert.match(
    result.stderr,
    /node <main-worktree>\/node_modules\/husky\/bin\.js/,
  );
});

test("an absent husky bin fails before anything is created, naming the path", () => {
  const main = makeMain("nohusky", { husky: null });
  const target = path.join(scratch, "nohusky-wt");
  const result = create(main, target);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(
    result.stderr.includes(path.join(main, "node_modules", "husky", "bin.js")),
    result.stderr,
  );
  assert.match(
    result.stderr,
    /node scripts\/create-worktree\.mjs <path> <branch>/,
  );
  assert.equal(existsSync(target), false);
});

test("a trailing-slash node_modules ignore fails, naming the .gitignore fix", () => {
  const main = makeMain("slash", { gitignore: "node_modules/\n" });
  const result = create(main, path.join(scratch, "slash-wt"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\?\? node_modules/);
  assert.match(result.stderr, /WITHOUT a trailing slash/);
});

test("parseArgs reads <path> <branch> [--from <ref>] and refuses the rest", () => {
  assert.deepEqual(parseArgs(["../wt", "feat/x"]), {
    target: "../wt",
    branch: "feat/x",
    from: "HEAD",
  });
  assert.deepEqual(parseArgs(["../wt", "feat/x", "--from", "origin/main"]), {
    target: "../wt",
    branch: "feat/x",
    from: "origin/main",
  });
  assert.throws(
    () => parseArgs(["../wt"]),
    /usage: node scripts\/create-worktree\.mjs/,
  );
  assert.throws(
    () => parseArgs(["../wt", "feat/x", "--from"]),
    /--from needs a value/,
  );
  assert.throws(() => parseArgs(["a", "b", "c"]), /usage/);
});
