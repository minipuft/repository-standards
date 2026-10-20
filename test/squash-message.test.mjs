import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  vendoredParserSource,
  VENDORED_PARSER_PATH,
} from "../scripts/vendor-conventional-commits-parser.mjs";
import { MIRRORED_CI_STEPS } from "../templates/delivery-contract/scripts/pr-check.mjs";
import {
  checkSquashMessage,
  loadParser,
  releasePleaseEntries,
  squashMessage,
} from "../templates/delivery-contract/scripts/validate-squash-message.mjs";

// Real pull requests from minipuft/claude-prompts-mcp, merged 2026-10-19. #501 and #503 passed every
// PR Conventions check and release-please still dropped both; #502 released normally. The squash
// files are the commit messages GitHub wrote on main, fetched with `gh api …/git/commits/<sha>`.
const FIXTURES = fileURLToPath(
  new URL("./fixtures/squash-message/", import.meta.url),
);
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/validate-squash-message.mjs",
    import.meta.url,
  ),
);
const TEMPLATE = fileURLToPath(
  new URL("../templates/delivery-contract/", import.meta.url),
);

const PR_501 = {
  title:
    "refactor!: exported type names are unique; resource_manager checks the shapes it publishes",
  body: fixture("body-501.md"),
  prNumber: 501,
};
const PR_503 = {
  title: "fix(mcp-tools): a prompt update changes only what the caller sent",
  body: fixture("body-503.md"),
  prNumber: 503,
};
const PR_502 = {
  title:
    "fix(server): the JSON files the server writes match the repository's formatter",
  body: fixture("body-502.md"),
  prNumber: 502,
};
const CALL_501 =
  '`resource_manager(resource_type:"gate", action:"create", …, retry_config:{improvement_hints: 5})`, from a live server run:';

const messageOf = (pr) =>
  squashMessage(pr)
    .map((line) => line.text)
    .join("\n");
const onlyFailure = (verdict) => {
  assert.equal(verdict.failures.length, 1, JSON.stringify(verdict.failures));
  return verdict.failures[0];
};

function runScript(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_ACTIONS: "", ...env },
  });
}

function bodyFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squash-message-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "body.md");
  fs.writeFileSync(file, text);
  return file;
}

// ------------------------------------------------------------------ the message GitHub writes

test("the squash message is rebuilt byte-for-byte as GitHub wrote #501 and #503", () => {
  assert.equal(messageOf(PR_501), fixture("squash-501.txt").trimEnd());
  assert.equal(messageOf(PR_503), fixture("squash-503.txt").trimEnd());
});

test("each body parses as written, so the check must judge the re-flowed message instead", () => {
  // The positive control for the re-flow model: a check that parsed `title + body` would pass the
  // two pull requests release-please dropped.
  const parse = loadParser();
  for (const pr of [PR_501, PR_503]) {
    assert.doesNotThrow(() => parse(`${pr.title}\n\n${pr.body}`));
  }
});

// ------------------------------------------------------------------ the two dropped pull requests

test("#501 is refused at the line where GitHub's re-flow left a parenthesis open", () => {
  const verdict = checkSquashMessage(PR_501);
  assert.equal(verdict.source, "squash");
  const failure = onlyFailure(verdict);
  assert.equal(failure.messageLine, 29);
  assert.equal(failure.bodyLine, 13);
  assert.equal(
    failure.text,
    '`resource_manager(resource_type:"gate", action:"create", …,',
  );
  assert.match(failure.parserMessage, /at 29:60, valid tokens \[\)\]/);
});

test("#503 is refused at the line where GitHub's re-flow left a parenthesis open", () => {
  const failure = onlyFailure(checkSquashMessage(PR_503));
  assert.equal(failure.messageLine, 30);
  assert.equal(failure.bodyLine, 12);
  assert.equal(
    failure.text,
    '`resource_manager(resource_type:"prompt", action:"update",',
  );
  assert.match(failure.parserMessage, /at 30:59, valid tokens \[\)\]/);
});

// ------------------------------------------------------------------ bodies that release normally

test("a real merged body that released normally passes", () => {
  const verdict = checkSquashMessage(PR_502);
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(
    verdict.entries.map((entry) => entry.header),
    [`${PR_502.title} (#502)`],
  );
});

test("the seeded pull-request template passes as a body, comments and all", () => {
  const template = fs.readFileSync(
    path.join(TEMPLATE, ".github", "pull_request_template.md"),
    "utf8",
  );
  for (const title of ["feat(scope): x", "fix!: y", "docs: z"]) {
    assert.deepEqual(
      checkSquashMessage({ title, body: template, prNumber: 1 }).failures,
      [],
    );
  }
});

test("an empty body leaves the title as the whole message", () => {
  const verdict = checkSquashMessage({
    title: "docs: x",
    body: "",
    prNumber: 7,
  });
  assert.equal(verdict.message, "docs: x (#7)");
  assert.deepEqual(verdict.failures, []);
});

// ------------------------------------------------------------------ what fixes it

test("the call on one line inside a fence parses; split over fence lines it is still refused", () => {
  const call = CALL_501.slice(1, CALL_501.indexOf("`,"));
  const fenced = PR_501.body.replace(
    CALL_501,
    `From a live server run:\n\n\`\`\`\n${call}\n\`\`\``,
  );
  assert.notEqual(fenced, PR_501.body);
  assert.deepEqual(
    checkSquashMessage({ ...PR_501, body: fenced }).failures,
    [],
  );

  const split = call.replace(" retry_config", "\n  retry_config");
  const fencedSplit = PR_501.body.replace(
    CALL_501,
    `From a live server run:\n\n\`\`\`\n${split}\n\`\`\``,
  );
  const failure = onlyFailure(
    checkSquashMessage({ ...PR_501, body: fencedSplit }),
  );
  assert.equal(failure.bodyLine, 16);
  assert.match(failure.text, /^resource_manager\(resource_type:"gate"/);
});

test("an override block that parses is what release-please reads, and passes", () => {
  const verdict = checkSquashMessage({
    ...PR_501,
    body: fixture("body-501-with-override.md"),
  });
  assert.equal(verdict.source, "override");
  assert.deepEqual(verdict.failures, []);
  assert.deepEqual(
    verdict.entries.map((entry) => entry.header),
    [`${PR_501.title} (#501)`],
  );
});

test("an override block that does not parse is refused at its own line", () => {
  const body = `${PR_502.body}\nBEGIN_COMMIT_OVERRIDE\nfix(server: the scope never closes\nEND_COMMIT_OVERRIDE\n`;
  const verdict = checkSquashMessage({ ...PR_502, body });
  assert.equal(verdict.source, "override");
  const failure = onlyFailure(verdict);
  assert.equal(failure.messageLine, 1);
  assert.equal(
    failure.bodyLine,
    body.split("\n").indexOf("fix(server: the scope never closes") + 1,
  );
});

test("an empty override block leaves the squash message to be judged", () => {
  const body = `${PR_501.body}\nBEGIN_COMMIT_OVERRIDE\n\nEND_COMMIT_OVERRIDE\n`;
  const verdict = checkSquashMessage({ ...PR_501, body });
  assert.equal(verdict.source, "squash");
  assert.equal(onlyFailure(verdict).bodyLine, 13);
});

// ------------------------------------------------------------------ line endings and entries

test("a CRLF body is judged exactly as its LF twin", () => {
  const crlf = (pr) => ({ ...pr, body: pr.body.replace(/\n/g, "\r\n") });
  assert.equal(onlyFailure(checkSquashMessage(PR_501)).bodyLine, 13);
  assert.deepEqual(
    checkSquashMessage(crlf(PR_501)).failures,
    checkSquashMessage(PR_501).failures,
  );
  assert.deepEqual(checkSquashMessage(crlf(PR_502)).failures, []);
});

test("a paragraph opening with a conventional type is its own entry, located on its own line", () => {
  const body = "## Summary\n\nx\n\nfix: a second entry\n\n`call(open\n";
  assert.equal(
    releasePleaseEntries(`docs: x\n\n${body}`).length,
    2,
    "release-please splits before `fix: `",
  );
  const verdict = checkSquashMessage({ title: "docs: x", body, prNumber: 1 });
  assert.deepEqual(
    verdict.entries.map((entry) => [entry.header, entry.ok]),
    [
      ["docs: x (#1)", true],
      ["fix: a second entry", false],
    ],
  );
  const failure = onlyFailure(verdict);
  assert.equal(failure.messageLine, 9);
  assert.equal(failure.bodyLine, 7);
});

// ------------------------------------------------------------------ the command

test("the command exits 1 naming the line, the parser's message and the fixes", (t) => {
  const result = runScript([
    "--body-file",
    bodyFile(t, PR_501.body),
    "--title",
    PR_501.title,
    "--pr-number",
    "501",
  ]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^error: release-please cannot parse/m);
  assert.match(result.stdout, /squash message line 29, from PR body line 13:/);
  assert.match(result.stdout, /parser: unexpected token '\\n' at 29:60/);
  assert.match(result.stdout, /fenced code block/);
  assert.match(result.stdout, /BEGIN_COMMIT_OVERRIDE/);
});

test("the command reads PR_BODY / PR_TITLE / PR_NUMBER and annotates under Actions", () => {
  const result = runScript([], {
    PR_BODY: PR_503.body,
    PR_TITLE: PR_503.title,
    PR_NUMBER: "503",
    GITHUB_ACTIONS: "true",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^::error::release-please cannot parse/m);
  assert.match(result.stdout, /squash message line 30, from PR body line 12:/);
});

test("the command exits 0 on a body that releases", (t) => {
  const result = runScript([
    "--body-file",
    bodyFile(t, PR_502.body),
    "--title",
    PR_502.title,
  ]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /it reads 1 entry/);
});

test("--self-test exits 0 and reports each case", () => {
  const result = runScript(["--self-test"]);
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /^FAIL/m);
  assert.equal((result.stdout.match(/^PASS/gm) ?? []).length, 6);
});

test("a missing vendored parser fails loudly and names the remedy; it never passes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squash-no-parser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, "validate-squash-message.mjs");
  fs.copyFileSync(SCRIPT, copy);
  const body = path.join(dir, "body.md");
  fs.writeFileSync(body, PR_502.body);

  for (const args of [
    ["--body-file", body, "--title", PR_502.title],
    ["--self-test"],
  ]) {
    const result = spawnSync(process.execPath, [copy, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /NOT checked/);
    assert.match(result.stdout, /delivery-contract update/);
  }
});

// ------------------------------------------------------------------ the vendored parser

test("the vendored parser is exactly what the pinned @conventional-commits/parser generates", async () => {
  assert.equal(
    fs.readFileSync(VENDORED_PARSER_PATH, "utf8"),
    await vendoredParserSource(),
  );
});

test("the vendored parser answers as the package does, ASTs and errors alike", () => {
  const upstream = createRequire(import.meta.url)(
    "@conventional-commits/parser",
  );
  const vendored = loadParser();
  const outcome = (parse, text) => {
    try {
      return JSON.stringify(parse(text));
    } catch (error) {
      return `throws ${error.message}`;
    }
  };
  const messages = [
    messageOf(PR_501),
    messageOf(PR_502),
    messageOf(PR_503),
    "feat(scope)!: x\n\nbody\n\nBREAKING CHANGE: y\nRefs #1",
    "not conventional",
  ];
  for (const text of messages) {
    assert.equal(outcome(vendored, text), outcome(upstream.parser, text));
  }
  assert.match(outcome(vendored, messageOf(PR_501)), /^throws /);
});

// ------------------------------------------------------------------ CI parity, upstream side

test("pr-check mirrors exactly the guarded run steps of the template workflow", () => {
  const workflow = parseYaml(
    fs.readFileSync(
      path.join(TEMPLATE, ".github", "workflows", "pr-conventions.yml"),
      "utf8",
    ),
  );
  const guarded = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter(
      (step) =>
        typeof step.run === "string" &&
        (step.if ?? "").includes(
          "github.event.pull_request.user.type != 'Bot'",
        ),
    )
    .map((step) => step.name)
    .sort();
  // Positive control: the selector sees the six authored-PR steps, so equality below is not two
  // empty lists agreeing.
  assert.equal(guarded.length, 6);
  assert.deepEqual(
    MIRRORED_CI_STEPS.map((step) => step.ciStepName).sort(),
    guarded,
  );
});
