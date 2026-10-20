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
  contractLag,
  describeReleaseLag,
} from "../templates/delivery-contract/scripts/warn-contract-lag.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/warn-contract-lag.mjs",
    import.meta.url,
  ),
);
const run = promisify(execFile);

// Tree SHAs of templates/delivery-contract per tag. Differing SHAs mean the template changed.
const CHANGED_TREES = { "v1.7.0": "tree-old", "v1.10.1": "tree-new" };

// A stand-in for the two GitHub endpoints the script reads: releases/latest and
// contents/templates?ref=<tag>. A tag absent from `trees` answers 404. The script runs as a child
// process, so the server has to answer while the parent awaits it — hence async execFile.
async function releaseServer(
  t,
  { status = 200, tagName = "v1.10.1", trees = CHANGED_TREES } = {},
) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/releases/latest") {
      response.writeHead(status);
      response.end(JSON.stringify({ tag_name: tagName }));
    } else if (url.pathname === "/contents/templates") {
      const sha = trees[url.searchParams.get("ref")];
      response.writeHead(sha ? 200 : 404);
      response.end(
        JSON.stringify(
          sha
            ? [
                { name: "other", sha: "x" },
                { name: "delivery-contract", sha },
              ]
            : {},
        ),
      );
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

// A port that was bound and released: nothing listens there, so the request is refused.
async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// A fetch that records its calls. `trees` maps tag -> template tree SHA; an absent tag answers 404;
// `failure` makes every call throw, as a dropped connection does.
function fakeFetch({
  latest = "v1.10.1",
  trees = CHANGED_TREES,
  failure,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, authorization: options.headers?.Authorization });
    if (failure) throw new Error(failure);
    const parsed = new URL(url);
    const answer = (status, body) => ({
      ok: status < 400,
      status,
      statusText: status === 404 ? "Not Found" : "OK",
      json: async () => body,
    });
    if (parsed.pathname.endsWith("/releases/latest")) {
      return answer(200, { tag_name: latest });
    }
    const sha = trees[parsed.searchParams.get("ref")];
    return sha
      ? answer(200, [{ name: "delivery-contract", sha }])
      : answer(404, {});
  };
  return { fetchImpl, calls };
}

function contractFile(t, templateVersion = "1.7.0") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contract-lag-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".delivery-contract.json");
  fs.writeFileSync(file, JSON.stringify({ templateVersion, answers: {} }));
  return file;
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
async function warn(cwd, apiUrl, { actions = true } = {}) {
  const env = {
    ...process.env,
    REPOSITORY_STANDARDS_API_URL: apiUrl,
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
    /^::warning title=Delivery contract is behind the latest release::This repository's delivery contract is template 1\.7\.0; the latest minipuft\/repository-standards release is 1\.10\.1 \(3 minor versions behind\)[,.]/,
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

test("a newer release that left the template unchanged is silent and exits 0", async (t) => {
  const trees = { "v1.7.0": "same", "v1.10.1": "same" };
  const result = await warn(consumer(t), await releaseServer(t, { trees }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("a template that changed after the installed version warns and exits 0", async (t) => {
  const result = await warn(consumer(t), await releaseServer(t));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^::warning title=/);
  assert.match(result.stdout, /and the template changed between them/);
});

test("an installed tag that does not exist is not compared, and exits 0", async (t) => {
  const trees = { "v1.10.1": "tree-new" };
  const result = await warn(consumer(t), await releaseServer(t, { trees }));
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /warning/);
  assert.match(
    result.stdout,
    /^Delivery contract lag not compared: release tag v1\.7\.0 was not found/,
  );
});

test("contractLag with an injected fetch: unchanged tree is silent in 3 calls", async (t) => {
  const { fetchImpl, calls } = fakeFetch({
    trees: { "v1.7.0": "same", "v1.10.1": "same" },
  });
  const outcome = await contractLag({
    contractPath: contractFile(t),
    apiUrl: "https://api.test/repo",
    token: "tok",
    fetchImpl,
  });
  assert.deepEqual(outcome, {});
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.test/repo/releases/latest",
      "https://api.test/repo/contents/templates?ref=v1.7.0",
      "https://api.test/repo/contents/templates?ref=v1.10.1",
    ],
  );
  assert.ok(calls.every((call) => call.authorization === "Bearer tok"));
});

test("contractLag with an injected fetch: a changed tree warns", async (t) => {
  const { fetchImpl } = fakeFetch();
  const outcome = await contractLag({
    contractPath: contractFile(t),
    apiUrl: "https://api.test/repo",
    fetchImpl,
  });
  assert.match(outcome.warning, /template 1\.7\.0; the latest .* is 1\.10\.1/);
  assert.equal(outcome.skipped, undefined);
});

test("contractLag with an injected fetch: a missing installed tag is not compared", async (t) => {
  const { fetchImpl } = fakeFetch({ trees: { "v1.10.1": "tree-new" } });
  const outcome = await contractLag({
    contractPath: contractFile(t),
    apiUrl: "https://api.test/repo",
    fetchImpl,
  });
  assert.match(outcome.skipped, /release tag v1\.7\.0 was not found/);
  assert.equal(outcome.warning, undefined);
});

test("contractLag with an injected fetch: a network error is not compared", async (t) => {
  const { fetchImpl } = fakeFetch({ failure: "socket hang up" });
  const outcome = await contractLag({
    contractPath: contractFile(t),
    apiUrl: "https://api.test/repo",
    fetchImpl,
  });
  assert.match(
    outcome.skipped,
    /latest release request failed: socket hang up/,
  );
});

test("an installed version at or past the latest release costs one call", async (t) => {
  const { fetchImpl, calls } = fakeFetch();
  const outcome = await contractLag({
    contractPath: contractFile(t, "1.10.1"),
    apiUrl: "https://api.test/repo",
    fetchImpl,
  });
  assert.deepEqual(outcome, {});
  assert.equal(calls.length, 1);
});
