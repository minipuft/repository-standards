import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { ADAPTERS } from "../templates/delivery-contract/scripts/ratchet.mjs";

// The in-process tests in ratchet.test.mjs stub spawn, so they never run the spawn path. Here the
// script runs as a real child process against a temporary repository whose node_modules/.bin holds
// a fake executable replaying captured tool output (test/fixtures/ratchet). No real eslint, knip
// or tsc starts; the upstream repository does not install them.
const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/ratchet.mjs",
    import.meta.url,
  ),
);
const FIXTURES = fileURLToPath(new URL("./fixtures/ratchet/", import.meta.url));
const fixture = (name) => path.join(FIXTURES, name);

const roots = [];
after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A repository with `fake` (a file in fixtures/ratchet/bin) installed as the adapter's binary. */
function makeRepo(adapterName, { fake, baseline }) {
  const adapter = ADAPTERS[adapterName];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-adapters-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  if (fake) {
    const installed = path.join(root, "node_modules", ".bin", adapter.bin);
    fs.copyFileSync(path.join(FIXTURES, "bin", fake), installed);
    fs.chmodSync(installed, 0o755);
  }
  if (baseline) {
    fs.writeFileSync(
      path.join(root, adapter.defaultBaseline),
      `${JSON.stringify({ schemaVersion: 1, [adapter.mapField]: baseline }, null, 2)}\n`,
    );
  }
  return root;
}

function drive(adapterName, root, { fixtureFile, exit = 0, env = {} } = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, adapterName, "check", "--root", root],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(fixtureFile ? { FAKE_FIXTURE: fixture(fixtureFile) } : {}),
        FAKE_EXIT: String(exit),
        ...env,
      },
    },
  );
  assert.equal(result.error, undefined, "the ratchet itself must start");
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const counts = (errors, warnings) => ({ errors, warnings });

// ---------------------------------------------------------------------------------------------
// eslint: parser on captured output
// ---------------------------------------------------------------------------------------------

test("eslint: a live report is counted per rule, errors and warnings apart", () => {
  const root = makeRepo("eslint", {
    fake: "emit-fixture",
    baseline: {
      "@typescript-eslint/no-non-null-assertion": counts(0, 1),
      "@typescript-eslint/no-unnecessary-condition": counts(3, 0),
      "@typescript-eslint/strict-boolean-expressions": counts(1, 0),
    },
  });
  const run = drive("eslint", root, {
    fixtureFile: "eslint-live.json",
    exit: 1,
  });
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /OK: 4 errors, 1 warnings \(no regressions\)/);
});

test("eslint: a rule that rose past its baseline is refused by name", () => {
  const root = makeRepo("eslint", {
    fake: "emit-fixture",
    baseline: {
      "@typescript-eslint/no-non-null-assertion": counts(0, 1),
      "@typescript-eslint/no-unnecessary-condition": counts(2, 0),
      "@typescript-eslint/strict-boolean-expressions": counts(1, 0),
    },
  });
  const run = drive("eslint", root, {
    fixtureFile: "eslint-live.json",
    exit: 1,
  });
  assert.equal(run.status, 1, run.output);
  assert.match(
    run.stderr,
    /- @typescript-eslint\/no-unnecessary-condition \(errors\): baseline=2 current=3 \(\+1\)/,
  );
});

test("eslint: messages with no rule id count under __unknown__", () => {
  const baseline = {
    __unknown__: counts(1, 1),
    "no-unused-vars": counts(1, 0),
  };
  const matching = drive(
    "eslint",
    makeRepo("eslint", { fake: "emit-fixture", baseline }),
    { fixtureFile: "eslint-unknown-rule.json", exit: 1 },
  );
  assert.equal(matching.status, 0, matching.output);
  assert.match(matching.stdout, /OK: 2 errors, 1 warnings/);

  const unbaselined = drive(
    "eslint",
    makeRepo("eslint", {
      fake: "emit-fixture",
      baseline: { "no-unused-vars": counts(1, 0) },
    }),
    { fixtureFile: "eslint-unknown-rule.json", exit: 1 },
  );
  assert.equal(unbaselined.status, 1, unbaselined.output);
  assert.match(
    unbaselined.stderr,
    /- __unknown__ \(errors\): baseline=0 current=1 \(\+1\)/,
  );
  assert.match(
    unbaselined.stderr,
    /- __unknown__ \(warnings\): baseline=0 current=1 \(\+1\)/,
  );
});

test("eslint: an exit with no report file is refused, not read as zero findings", () => {
  const root = makeRepo("eslint", {
    fake: "emit-fixture",
    baseline: { "no-unused-vars": counts(1, 0) },
  });
  const run = drive("eslint", root, { exit: 0 });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /eslint exited 0 but wrote no report/);
});

// ---------------------------------------------------------------------------------------------
// tsc: parser on captured output
// ---------------------------------------------------------------------------------------------

const TSC_BASELINE = {
  "tests/e2e/helpers/http-mcp-client.ts": 2,
  "tests/e2e/plugin-validation.test.ts": 3,
  "tests/e2e/shell-verify-e2e.test.ts": 5,
  "tests/helpers/test-helpers.ts": 1,
};

test("tsc: ordinary type errors (exit 2) are counted per file, continuation lines ignored", () => {
  const root = makeRepo("tsc", {
    fake: "emit-fixture",
    baseline: TSC_BASELINE,
  });
  const run = drive("tsc", root, { fixtureFile: "tsc-errors.txt", exit: 2 });
  assert.equal(run.status, 0, run.output);
  assert.match(
    run.stdout,
    /OK: 11 errors in tsconfig\.json \(no regressions\)/,
  );
});

test("tsc: a file that gained an error is refused by name", () => {
  const root = makeRepo("tsc", {
    fake: "emit-fixture",
    baseline: {
      ...TSC_BASELINE,
      "tests/e2e/shell-verify-e2e.test.ts": 4,
    },
  });
  const run = drive("tsc", root, { fixtureFile: "tsc-errors.txt", exit: 2 });
  assert.equal(run.status, 1, run.output);
  assert.match(
    run.stderr,
    /- tests\/e2e\/shell-verify-e2e\.test\.ts: baseline=4 current=5 \(\+1\)/,
  );
});

test("tsc: a fatal TS5058 line is a parse refusal naming the line", () => {
  const root = makeRepo("tsc", {
    fake: "emit-fixture",
    baseline: TSC_BASELINE,
  });
  const run = drive("tsc", root, { fixtureFile: "tsc-fatal.txt", exit: 1 });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /tsc reported 1 configuration error\(s\)/);
  assert.match(run.stderr, /error TS5058: The specified path does not exist/);
});

test("tsc: ANSI-coloured output is a parse refusal quoting the first line", () => {
  const root = makeRepo("tsc", {
    fake: "emit-fixture",
    baseline: TSC_BASELINE,
  });
  const run = drive("tsc", root, { fixtureFile: "tsc-ansi.txt", exit: 2 });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /tsc output carries ANSI escapes/);
  assert.match(run.stderr, /First line was: "\\u001b\[96ma\.ts/);
});

// ---------------------------------------------------------------------------------------------
// knip: parser on captured output
// ---------------------------------------------------------------------------------------------

test("knip: a live report counts one finding per array element, per category", () => {
  const root = makeRepo("knip", {
    fake: "emit-fixture",
    baseline: { binaries: 3, exports: 6, files: 2, types: 3, unresolved: 1 },
  });
  const run = drive("knip", root, { fixtureFile: "knip-live.json", exit: 1 });
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /OK: 15 findings \(no regressions\)/);
  assert.doesNotMatch(run.output, /does not know/);
});

test("knip: a duplicates group is one finding, not one per member", () => {
  const root = makeRepo("knip", {
    fake: "emit-fixture",
    baseline: { duplicates: 1, exports: 1 },
  });
  const run = drive("knip", root, {
    fixtureFile: "knip-duplicates.json",
    exit: 1,
  });
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /OK: 2 findings \(no regressions\)/);
});

test("knip: an unknown category is counted and named", () => {
  const root = makeRepo("knip", {
    fake: "emit-fixture",
    baseline: { duplicates: 1, exports: 1, futureCategory: 1 },
  });
  const run = drive("knip", root, {
    fixtureFile: "knip-unknown-category.json",
    exit: 1,
  });
  assert.equal(run.status, 0, run.output);
  assert.match(
    run.stdout,
    /Note: knip reported a category this adapter does not know \(futureCategory\)/,
  );
  assert.match(run.stdout, /OK: 3 findings/);

  const unbaselined = drive(
    "knip",
    makeRepo("knip", {
      fake: "emit-fixture",
      baseline: { duplicates: 1, exports: 1 },
    }),
    { fixtureFile: "knip-unknown-category.json", exit: 1 },
  );
  assert.equal(unbaselined.status, 1, unbaselined.output);
  assert.match(
    unbaselined.stderr,
    /- futureCategory: baseline=0 current=1 \(\+1\)/,
  );
});

test("knip: output that is not JSON is a parse refusal quoting the first line", () => {
  const root = makeRepo("knip", {
    fake: "emit-fixture",
    baseline: { exports: 1 },
  });
  const run = drive("knip", root, { fixtureFile: "tsc-fatal.txt", exit: 1 });
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /knip's stdout did not parse as JSON/);
  assert.match(run.stderr, /First line was: "error TS5058/);
});

// ---------------------------------------------------------------------------------------------
// Spawn path, every adapter: a crash, a signal, a binary that is not there
// ---------------------------------------------------------------------------------------------

const BASELINES = {
  eslint: { "no-unused-vars": counts(1, 0) },
  knip: { exports: 1 },
  tsc: { "a.ts": 1 },
};

for (const adapterName of Object.keys(BASELINES)) {
  const bin = ADAPTERS[adapterName].bin;
  const baseline = BASELINES[adapterName];

  test(`${adapterName}: exit 3 is a crash, refused with the first stderr line quoted`, () => {
    const root = makeRepo(adapterName, { fake: "crash", baseline });
    const run = drive(adapterName, root);
    assert.equal(run.status, 2, run.output);
    assert.match(
      run.stderr,
      new RegExp(`${bin} failed to run \\(exit code 3\\)`),
    );
    assert.match(run.stderr, /\n {2}FATAL: fake tool crashed: out of memory/);
  });

  test(`${adapterName}: a signal-killed tool is a crash, not a measurement`, () => {
    const root = makeRepo(adapterName, { fake: "killed", baseline });
    const run = drive(adapterName, root);
    assert.equal(run.status, 2, run.output);
    assert.match(
      run.stderr,
      new RegExp(`${bin} failed to run \\(killed by SIGKILL\\)`),
    );
  });

  test(`${adapterName}: no binary in node_modules/.bin exits 1 naming npm ci`, () => {
    const root = makeRepo(adapterName, { baseline });
    const run = drive(adapterName, root);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, new RegExp(`${bin} is not installed`));
    assert.match(run.stderr, /Run `npm ci` in \./);
  });

  test(`${adapterName}: a binary whose interpreter is missing (spawn ENOENT) exits 1 naming npm ci`, () => {
    const root = makeRepo(adapterName, {
      fake: "dangling-interpreter",
      baseline,
    });
    const run = drive(adapterName, root);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, new RegExp(`${bin} is not installed`));
    assert.match(run.stderr, /Run `npm ci` in \./);
  });

  test(`${adapterName}: with no baseline the missing binary never matters (opt-in control)`, () => {
    const root = makeRepo(adapterName, {});
    const run = drive(adapterName, root);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /OK: no baseline/);
  });
}
