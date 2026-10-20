import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkLockfiles,
  checkRepository,
  comparePackages,
  listTrackedLockfiles,
} from "../templates/delivery-contract/scripts/validate-lockfile-sync.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/validate-lockfile-sync.mjs",
    import.meta.url,
  ),
);
const FIXTURES = fileURLToPath(
  new URL("./fixtures/lockfile-sync/", import.meta.url),
);

// A directory named node_modules is ignored by this repository's .gitignore, so a fixture cannot
// carry npm's hidden lockfile under its real name. The fixture holds it as
// `installed.package-lock.json` and staging puts it where npm would have written it.
function stage(
  name,
  destination = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-sync-")),
) {
  fs.cpSync(path.join(FIXTURES, name), destination, { recursive: true });
  const installed = path.join(destination, "installed.package-lock.json");
  if (fs.existsSync(installed)) {
    fs.mkdirSync(path.join(destination, "node_modules"), { recursive: true });
    fs.renameSync(
      installed,
      path.join(destination, "node_modules", ".package-lock.json"),
    );
  }
  return destination;
}

function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("a tree that matches its lockfile passes", () => {
  const root = stage("npm-clean");
  const result = run("--root", root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OK \.: the installed tree matches/);
});

test("a version mismatch fails and names the package and both versions", () => {
  const root = stage("npm-drift");
  const result = run("--root", root);
  assert.equal(result.status, 1, result.output);
  assert.match(
    result.output,
    /VERSION MISMATCH node_modules\/is-odd: lockfile 3\.0\.1, installed 3\.0\.0/,
  );
  assert.match(result.output, /mismatch=1/);
});

test("a non-npm contract exits 0 and says the check is npm-only", () => {
  const result = run("--root", stage("pnpm"));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /packageManager is "pnpm"/);
  assert.match(result.output, /npm-only/);
});

test("a contract that does not declare a package manager is checked as npm", () => {
  const root = stage("npm-drift");
  fs.writeFileSync(
    path.join(root, ".delivery-contract.json"),
    JSON.stringify({ answers: { scopes: ["ci"] } }),
  );
  assert.equal(run("--root", root).status, 1);
});

test("a repository with no lockfile passes and says there was nothing to check", () => {
  const result = run("--root", stage("no-lockfile"));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /no tracked package-lock\.json/);
});

test("a lockfile with no installed tree fails as not installed", () => {
  const result = run("--root", stage("not-installed"));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL \.: not installed/);
});

test("every listed lockfile is checked and findings are reported per directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-sync-"));
  stage("npm-clean", root);
  stage("npm-drift", path.join(root, "server"));
  stage("not-installed", path.join(root, "cli"));

  const logs = [];
  const capture = (...lines) => logs.push(lines.join(" "));
  const log = console.log;
  const error = console.error;
  console.log = capture;
  console.error = capture;
  let code;
  try {
    code = checkLockfiles(root, [
      "package-lock.json",
      "server/package-lock.json",
      "cli/package-lock.json",
    ]);
  } finally {
    console.log = log;
    console.error = error;
  }

  const output = logs.join("\n");
  assert.equal(code, 1);
  assert.match(output, /OK \.: the installed tree matches/);
  assert.match(output, /FAIL server: 1 package\(s\) differ/);
  assert.match(output, /FAIL cli: not installed/);
  assert.match(output, /2 of 3 directories drifted \(server, cli\)/);
});

test("checkRepository enumerates tracked lockfiles from git, in nested directories too", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-sync-"));
  stage("npm-clean", root);
  stage("npm-drift", path.join(root, "server"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  assert.equal(git("init", "--quiet").status, 0);
  // node_modules is deliberately not tracked: only lockfiles are enumerated.
  assert.equal(
    git("add", "package-lock.json", "server/package-lock.json").status,
    0,
  );

  assert.deepEqual(listTrackedLockfiles(root).sort(), [
    "package-lock.json",
    "server/package-lock.json",
  ]);
  const quiet = (fn) => {
    const log = console.log;
    const error = console.error;
    console.log = console.error = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  assert.equal(
    quiet(() => checkRepository(root)),
    1,
    "the drifted server/ directory must fail the run",
  );
});

test("--self-test proves all seven comparison rules", () => {
  const result = run("--self-test");
  assert.equal(result.status, 0, result.output);
  assert.equal((result.stdout.match(/^ {2}ok {2}/gm) ?? []).length, 7);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test("an unknown flag is invalid usage", () => {
  const result = run("--bogus");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test("comparePackages skips the root entry and platform-excluded packages", () => {
  assert.deepEqual(
    comparePackages(
      {
        "": { version: "1.0.0" },
        "node_modules/fsevents": { version: "2.3.3", optional: true },
      },
      { "": { version: "2.0.0" } },
    ),
    [],
  );
});
