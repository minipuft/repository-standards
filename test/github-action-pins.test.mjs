import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateRepository,
  validateUsesLine,
} from "../templates/delivery-contract/scripts/validate-github-action-pins.mjs";

const script = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/validate-github-action-pins.mjs",
    import.meta.url,
  ),
);
const fixture = (name) =>
  fileURLToPath(
    new URL(`./fixtures/github-action-pins/${name}`, import.meta.url),
  );

test("a pinned, commented tree passes, composite actions included", () => {
  const result = validateRepository(fixture("clean"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.externalCount, 2);
  assert.equal(result.fileCount, 2);
});

test("an unpinned ref fails with the SHA message and its location", () => {
  const { errors } = validateRepository(fixture("unpinned"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ci\.yml:6: external ref must be a 40-character/);
});

test("a ref without a same-line release comment fails", () => {
  const { errors } = validateRepository(fixture("no-comment"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /same-line release comment/);
});

test("a docker:// ref pinned by sha256 digest passes", () => {
  assert.deepEqual(validateRepository(fixture("docker-pinned")).errors, []);
});

test("a docker:// tag is rejected with a message naming the sha256 form", () => {
  const { errors } = validateRepository(fixture("docker-tag"));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /docker:\/\/<image>@sha256:<64 hex/);
});

test("a ./local action is skipped, not counted as external", () => {
  const result = validateRepository(fixture("local-only"));
  assert.deepEqual(result.errors, []);
  assert.equal(result.externalCount, 0);
});

test("malformed and non-uses lines are classified", () => {
  assert.deepEqual(validateUsesLine("      run: echo hi"), {
    external: false,
    errors: [],
  });
  assert.deepEqual(validateUsesLine("      uses: owner/action extra").errors, [
    "malformed uses reference",
  ]);
  assert.notEqual(
    validateUsesLine('      uses: "unterminated').errors.length,
    0,
  );
});

test("the managed delivery-contract workflow template is itself pinned", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--root",
      fileURLToPath(new URL("../templates/delivery-contract", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASSED: [1-9]\d* external Action references/);
});

test("--root on an unpinned tree exits non-zero (CLI positive control)", () => {
  const result = spawnSync(
    process.execPath,
    [script, "--root", fixture("unpinned")],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR:/);
});

test("--self-test passes", () => {
  const result = spawnSync(process.execPath, [script, "--self-test"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
