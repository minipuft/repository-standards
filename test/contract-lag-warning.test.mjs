import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compareReleaseVersions,
  describeReleaseLag,
} from "../templates/delivery-contract/scripts/warn-contract-lag.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/warn-contract-lag.mjs",
    import.meta.url,
  ),
);
const run = promisify(execFile);

// A stand-in for GET /repos/minipuft/repository-standards/releases/latest. The script runs as a
// child process, so the server has to answer while the parent awaits it — hence async execFile.
async function releaseServer(t, { status = 200, tagName = "v1.10.1" } = {}) {
  const server = http.createServer((request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ tag_name: tagName }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/releases/latest`;
}

// A port that was bound and released: nothing listens there, so the request is refused.
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/releases/latest`;
}

function consumer(t, document = { templateVersion: "1.7.0", answers: {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-lag-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (document !== null) {
    fs.writeFileSync(
      path.join(root, ".delivery-contract.json"),
      JSON.stringify(document),
    );
  }
  return root;
}

// Never rejects on a non-zero exit: the exit status is what these tests assert.
async function warn(cwd, releaseUrl, { actions = true } = {}) {
  const env = {
    ...process.env,
    REPOSITORY_STANDARDS_RELEASE_URL: releaseUrl,
    GITHUB_TOKEN: "",
    GITHUB_ACTIONS: actions ? "true" : "",
  };
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT], {
      cwd,
      env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("versions compare by number, not by string", () => {
  assert.ok(compareReleaseVersions("1.7.0", "1.10.1") < 0);
  assert.ok(compareReleaseVersions("v1.10.1", "1.10.1") === 0);
  assert.ok(compareReleaseVersions("2.0.0", "1.10.1") > 0);
  assert.equal(compareReleaseVersions("next", "1.10.1"), null);
  assert.equal(
    describeReleaseLag("1.7.0", "1.10.1"),
    "3 minor versions behind",
  );
  assert.equal(describeReleaseLag("1.10.1", "1.10.1"), null);
});

test("a contract behind the latest release warns with both versions and the remedy, and exits 0", async (t) => {
  const result = await warn(consumer(t), await releaseServer(t));
  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /^::warning title=Delivery contract is behind the latest release::This repository's delivery contract is template 1\.7\.0; the latest minipuft\/repository-standards release is 1\.10\.1 \(3 minor versions behind\)\./,
  );
  assert.match(result.stdout, /`delivery-contract update`/);
  assert.match(result.stdout, /checkout at v1\.10\.1/);
  // One annotation line: GitHub ends an annotation at the first newline.
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
});

test("outside GitHub Actions the same warning is a plain `warning:` line", async (t) => {
  const result = await warn(consumer(t), await releaseServer(t), {
    actions: false,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^warning: This repository's delivery contract/);
});

test("a current contract is silent and exits 0", async (t) => {
  const url = await releaseServer(t);
  for (const templateVersion of ["1.10.1", "1.11.0"]) {
    const result = await warn(
      consumer(t, { templateVersion, answers: {} }),
      url,
    );
    assert.equal(result.code, 0, templateVersion);
    assert.equal(result.stdout, "", templateVersion);
  }
});

test("a refused connection exits 0 without a warning", async (t) => {
  const result = await warn(consumer(t), await closedPort());
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /warning/);
  assert.match(result.stdout, /^Delivery contract lag not compared: /);
});

test("an API error status exits 0 without a warning", async (t) => {
  const result = await warn(
    consumer(t),
    await releaseServer(t, { status: 403 }),
  );
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /warning/);
  assert.match(result.stdout, /answered 403/);
});

test("a missing or versionless contract file exits 0 without a warning", async (t) => {
  const url = await releaseServer(t);
  for (const document of [null, { answers: {} }]) {
    const result = await warn(consumer(t, document), url);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stdout, /warning/);
    assert.match(result.stdout, /^Delivery contract lag not compared: /);
  }
});
