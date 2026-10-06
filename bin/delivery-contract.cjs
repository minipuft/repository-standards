#!/usr/bin/env node
/**
 * Installs and keeps current the delivery contract — the commit, ADR, and release scaffolding a
 * consuming repository shares with every other repository in the fleet.
 *
 * The template is a directory plus a `manifest.json` that classifies each file:
 *
 *   managed → owned by the template. `install` writes it, `update` overwrites it, `check` fails
 *             on any byte drift. A consumer that edits one has forked the contract. `render: true`
 *             on a managed file (the CI workflow, the commit-msg hook) re-renders it from the
 *             consumer's own answers on every `install`/`update`/`check`, so a consumer's answers
 *             — not just the template — decide what "undrifted" means for that file.
 *   seeded  → written once if absent, then the consumer's. `update` and `check` never touch or
 *             judge it. `render: true` substitutes `{{answer}}` placeholders on that one write.
 *
 * The consumer's answers live in `.delivery-contract.json`, validated against
 * contracts/delivery-contract.schema.json on every subcommand.
 *
 * `update` refuses to overwrite a managed file carrying uncommitted changes: it prints the diff
 * and writes nothing in that run, so a local edit is never lost to a template refresh.
 *
 * Usage (run from a consuming repository):
 *   delivery-contract install [--scopes a,b] [--adr-dir DIR] [--default-branch NAME]
 *                             [--package-manager npm|pnpm|bun]
 *   delivery-contract update
 *   delivery-contract check
 *   delivery-contract --self-test
 *   delivery-contract <command> --repo /path/to/consumer --template /path/to/template
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_TEMPLATE = path.join(
  PACKAGE_ROOT,
  "templates",
  "delivery-contract",
);
const SCHEMA_PATH = path.join(
  PACKAGE_ROOT,
  "contracts",
  "delivery-contract.schema.json",
);
/**
 * The answers file's `$schema` names the schema as released with the template version it pins,
 * not whatever `main` carries. release-please tags `v<version>` on the commit that bumps
 * package.json, so the URL resolves from the release on; adopting from an untagged commit is not
 * a supported path.
 */
function schemaUrl() {
  return `https://raw.githubusercontent.com/minipuft/repository-standards/v${templateVersion()}/contracts/delivery-contract.schema.json`;
}
const ANSWERS_FILENAME = ".delivery-contract.json";
const FILE_CLASSES = ["managed", "seeded"];
const COMMANDS = ["install", "update", "check", "settings"];

/** Exit code for a contract violation: bad arguments, manifest, or answers file. */
const EXIT_CONTRACT = 2;

class ContractError extends Error {}

function templateVersion() {
  return JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
  ).version;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

// ---------------------------------------------------------------- manifest + answers

function readManifest(templateDir) {
  const manifestPath = path.join(templateDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new ContractError(`template manifest not found: ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ContractError(`manifest.json is not JSON: ${error.message}`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new ContractError("manifest.json `files` must be an array");
  }
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path)) {
      throw new ContractError(
        `manifest entry path must be relative: ${entry.path}`,
      );
    }
    if (!isWithin(templateDir, path.resolve(templateDir, entry.path))) {
      throw new ContractError(
        `manifest entry escapes the template: ${entry.path}`,
      );
    }
    if (!FILE_CLASSES.includes(entry.class)) {
      throw new ContractError(
        `manifest entry ${entry.path}: class must be one of ${FILE_CLASSES.join(", ")}`,
      );
    }
    if (entry.mode !== undefined && !/^0?[0-7]{3}$/.test(entry.mode)) {
      throw new ContractError(
        `manifest entry ${entry.path}: mode must be an octal string like "0755"`,
      );
    }
    if (!fs.existsSync(path.join(templateDir, entry.path))) {
      throw new ContractError(
        `manifest entry ${entry.path} has no file in the template`,
      );
    }
  }
  return { files: manifest.files, answers: manifest.answers ?? {} };
}

let compiledValidator;
function answersValidator() {
  if (!compiledValidator) {
    const Ajv2020 = require("ajv/dist/2020");
    const Ajv = Ajv2020.default ?? Ajv2020;
    compiledValidator = new Ajv({ allErrors: true, strict: true }).compile(
      JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")),
    );
  }
  return compiledValidator;
}

function validateAnswersDocument(document) {
  const validate = answersValidator();
  if (!validate(document)) {
    const detail = validate.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new ContractError(
      `${ANSWERS_FILENAME} violates the schema: ${detail}`,
    );
  }
}

/** Returns the parsed, validated answers document — or null when the consumer has none. */
function readAnswersFile(repoRoot) {
  const answersPath = path.join(repoRoot, ANSWERS_FILENAME);
  if (!fs.existsSync(answersPath)) return null;
  let document;
  try {
    document = JSON.parse(fs.readFileSync(answersPath, "utf8"));
  } catch (error) {
    throw new ContractError(
      `${ANSWERS_FILENAME} is not JSON: ${error.message}`,
    );
  }
  validateAnswersDocument(document);
  return document;
}

function writeAnswersFile(repoRoot, answers, omit = []) {
  const document = {
    $schema: schemaUrl(),
    templateVersion: templateVersion(),
    answers,
    ...(omit.length > 0 ? { omit } : {}),
  };
  validateAnswersDocument(document);
  const next = `${JSON.stringify(document, null, 2)}\n`;
  const answersPath = path.join(repoRoot, ANSWERS_FILENAME);
  const current = fs.existsSync(answersPath)
    ? fs.readFileSync(answersPath, "utf8")
    : null;
  if (current === next) return false;
  fs.writeFileSync(answersPath, next);
  return true;
}

/**
 * `omit` names managed-file paths install/update must never write and check must skip — the
 * fork-can't-carry-this-file escape hatch (a fork tracking an upstream that owns its own hooks
 * directory can't also carry `.husky/commit-msg`). Every entry must name a `managed` path in
 * THIS manifest; anything else (a seeded path, a typo, a path from a different template version)
 * is a contract violation, not a silent no-op.
 */
function validateOmit(manifest, omit) {
  const managedPaths = new Set(
    manifest.files
      .filter((entry) => entry.class === "managed")
      .map((entry) => entry.path),
  );
  for (const relPath of omit) {
    if (!managedPaths.has(relPath)) {
      throw new ContractError(
        `omit entry ${relPath} does not name a managed file in the manifest`,
      );
    }
  }
}

function resolveAnswers(manifest, flags) {
  const answers = {};
  for (const [name, spec] of Object.entries(manifest.answers)) {
    if (spec.default !== undefined) answers[name] = spec.default;
  }
  for (const [name, value] of Object.entries(flags)) {
    if (value !== undefined) answers[name] = value;
  }
  return answers;
}

/**
 * Fills in the manifest's declared defaults for any answer the consumer's document is missing.
 * A consumer installed before a new answer existed (e.g. `packageManager`) has no key for it in
 * `.delivery-contract.json`; `update` and `check` still need a value to render against, and that
 * value must be the manifest's own default, not a guess made here.
 */
function answersWithDefaults(manifest, answers) {
  const filled = { ...answers };
  for (const [name, spec] of Object.entries(manifest.answers)) {
    if (filled[name] === undefined && spec.default !== undefined) {
      filled[name] = spec.default;
    }
  }
  return filled;
}

/**
 * Package-manager-derived placeholders available to any `render: true` file, on top of the
 * consumer's own answers. Kept out of `.delivery-contract.json` and the schema — they are
 * computed from `answers.packageManager`, never asked for or stored, so there is exactly one
 * place (this function) that knows what each package manager's install/exec/CI-setup shape is.
 */
const PACKAGE_MANAGER_DERIVED = {
  npm: {
    pmInstall: "npm ci --ignore-scripts",
    pmExec: "npx --no --",
    pmSetup: "",
  },
  pnpm: {
    pmInstall: "pnpm install --frozen-lockfile --ignore-scripts",
    pmExec: "pnpm exec",
    // No leading `- ` here — the template already supplies the sequence marker
    // (`- "{{pmSetup}}"`) so the raw template parses as valid YAML unrendered.
    // SHA-pinned like every other `uses:` in the workflow: the tag `v4` on
    // pnpm/action-setup is annotated, so the commit is one hop past the tag object —
    // `gh api repos/pnpm/action-setup/git/ref/tags/v4 -q .object.sha` (the tag object),
    // then `gh api repos/pnpm/action-setup/git/tags/<that sha> -q .object.sha` (the
    // commit). Resolved 2026-09-27 to release v4.3.0.
    pmSetup:
      "uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0",
  },
  bun: {
    pmInstall: "bun install --frozen-lockfile",
    pmExec: "bunx",
    // oven-sh/setup-bun's `v2` tag is lightweight (points straight at the commit, no
    // dereference needed). Resolved 2026-09-27 to release v2.2.0.
    pmSetup:
      "uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
  },
};

function derivedAnswers(answers) {
  const packageManager = answers.packageManager ?? "npm";
  const derived =
    PACKAGE_MANAGER_DERIVED[packageManager] ?? PACKAGE_MANAGER_DERIVED.npm;
  return { ...answers, ...derived };
}

// ---------------------------------------------------------------- rendering + writes

function renderValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => `'${String(item).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;
  }
  return String(value);
}

/**
 * A placeholder that is the ONLY thing on its line — optionally behind a `- ` sequence marker,
 * optionally quoted (quoting keeps the raw template valid, prettier-clean YAML; a bare
 * `{{name}}` flow-mapping-shaped token gets reformatted by prettier's YAML printer) — renders
 * specially when its answer is the empty string: the whole line, sequence marker, quotes, and
 * trailing newline all disappear rather than leaving a blank or dash-only line behind. That is
 * what lets `{{pmSetup}}` add a whole CI step for pnpm/bun and add nothing at all for npm, so the
 * npm-rendered file stays byte-identical to a template that never had the step.
 *
 * A placeholder quoted mid-line (`node-version-file: "{{nodeVersionFile}}"`) gets the same quote
 * treatment for the same reason — the raw template must stay prettier-clean YAML — but always
 * strips the quotes on render rather than special-casing the empty string: unlike a whole-line
 * placeholder, a mid-line one sits next to a key that still needs a value, so there is no "drop
 * the line" case, and the quotes exist only to keep the UNRENDERED template parseable, not because
 * the answers this repo defines (paths, package-manager names) ever need YAML quoting once
 * substituted. Every other placeholder substitutes in place, inline.
 */
function render(content, answers, relPath) {
  const withWholeLines = content.replace(
    /^([ \t]*(?:-[ \t]+)?)"?\{\{(\w+)\}\}"?\r?\n/gm,
    (line, prefix, name) => {
      if (!(name in answers)) {
        throw new ContractError(
          `${relPath}: placeholder {{${name}}} has no answer`,
        );
      }
      const value = answers[name];
      if (value === "") return "";
      return `${prefix}${renderValue(value)}\n`;
    },
  );
  const withInlineQuoted = withWholeLines.replace(
    /"\{\{(\w+)\}\}"/g,
    (placeholder, name) => {
      if (!(name in answers)) {
        throw new ContractError(
          `${relPath}: placeholder ${placeholder} has no answer`,
        );
      }
      return renderValue(answers[name]);
    },
  );
  return withInlineQuoted.replace(/\{\{(\w+)\}\}/g, (placeholder, name) => {
    if (!(name in answers)) {
      throw new ContractError(
        `${relPath}: placeholder ${placeholder} has no answer`,
      );
    }
    return renderValue(answers[name]);
  });
}

/** Template bytes for `entry`, rendered against `answers` (plus derived placeholders) when the
 * manifest marks it `render: true`; raw template bytes otherwise. The one function every command
 * (install/update/check) calls to get "what this file should look like for this consumer". */
function renderedBytes(templateDir, entry, answers) {
  const raw = templateBytes(templateDir, entry);
  if (!entry.render) return raw;
  return Buffer.from(
    render(raw.toString("utf8"), derivedAnswers(answers), entry.path),
  );
}

function writeFile(repoRoot, entry, content) {
  const target = path.join(repoRoot, entry.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (entry.mode) fs.chmodSync(target, parseInt(entry.mode, 8));
}

function templateBytes(templateDir, entry) {
  return fs.readFileSync(path.join(templateDir, entry.path));
}

/**
 * Managed files whose consumer bytes differ from what the template renders for this consumer's
 * `answers` (missing counts as differing). A plain managed file compares against raw template
 * bytes; a `render: true` managed file (the pnpm/bun-aware workflow, the commit-msg hook)
 * compares against ITS RENDER, so a consumer who installed with `packageManager: pnpm` sees no
 * drift once its rendered file matches — the placeholders are gone from both sides.
 *
 * `omitSet` — managed paths this consumer's answers name via `omit` — are excluded entirely:
 * never written, never flagged as drifted or missing, so a fork that can't carry a given managed
 * file (e.g. `.husky/commit-msg`) never fights the contract over it.
 */
function driftedManaged(
  repoRoot,
  templateDir,
  manifest,
  answers,
  omitSet = new Set(),
) {
  return manifest.files.filter((entry) => {
    if (entry.class !== "managed") return false;
    if (omitSet.has(entry.path)) return false;
    const target = path.join(repoRoot, entry.path);
    if (!fs.existsSync(target)) return true;
    return !fs
      .readFileSync(target)
      .equals(renderedBytes(templateDir, entry, answers));
  });
}

// ---------------------------------------------------------------- git

function git(repoRoot, args) {
  return spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function insideWorkTree(repoRoot) {
  const result = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * A tracked file whose working copy differs from what git recorded (modified or staged).
 * Overwriting it would lose an edit that exists nowhere else. An untracked managed file is
 * template bytes the consumer has not committed yet, so it is not guarded; outside a work tree
 * there is no record to consult, so nothing counts as uncommitted.
 */
function hasUncommittedChanges(repoRoot, relPath, inRepo) {
  if (!inRepo || !fs.existsSync(path.join(repoRoot, relPath))) return false;
  const tracked = git(repoRoot, ["ls-files", "--error-unmatch", "--", relPath]);
  if (tracked.status !== 0) return false;
  const diff = git(repoRoot, ["diff", "--quiet", "--", relPath]);
  if (diff.status !== 0) return true;
  const status = git(repoRoot, ["status", "--porcelain", "--", relPath]);
  if (status.status !== 0) {
    throw new Error(`git status failed for ${relPath}: ${status.stderr}`);
  }
  return status.stdout.trim() !== "";
}

/**
 * Diffs the consumer's copy against `expectedBytes` — the rendered template for this consumer's
 * answers, not necessarily the raw template on disk. Writing that content to a scratch file
 * rather than diffing straight against the template path keeps this correct for a `render: true`
 * managed file: diffing against the raw `{{pmInstall}}`-carrying template would show every line
 * as different even when the consumer's file is exactly what its own answers should produce.
 */
function printDiff(repoRoot, relPath, expectedBytes) {
  const scratch = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "delivery-contract-diff-")),
    path.basename(relPath),
  );
  fs.writeFileSync(scratch, expectedBytes);
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--", path.join(repoRoot, relPath), scratch],
    { encoding: "utf8" },
  );
  process.stdout.write(result.stdout);
  fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
}

/**
 * Extracts `{ owner, repo }` from a GitHub origin URL — HTTPS (`https://github.com/o/r(.git)`)
 * or SSH (`git@github.com:o/r(.git)`). Returns null for anything else, including a non-GitHub host.
 */
function parseGitHubRemote(url) {
  const trimmed = url.trim();
  const https = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (https) return { owner: https[1], repo: https[2] };
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  return null;
}

function squashSettingsCommand(owner, repo) {
  return [
    `gh api -X PATCH repos/${owner}/${repo} \\`,
    "  -f squash_merge_commit_title=PR_TITLE \\",
    "  -f squash_merge_commit_message=PR_BODY \\",
    "  -F delete_branch_on_merge=true",
  ].join("\n");
}

/**
 * Repository settings the delivery contract depends on but cannot template: the squash-merge
 * commit defaults and delete-branch-on-merge, applied via `gh api` against the origin remote.
 * Never touches the default branch — changing it is an owner act, not something this tool does
 * on a consumer's behalf.
 */
function commandSettings(repoRoot, apply) {
  const remote = git(repoRoot, ["remote", "get-url", "origin"]);
  if (remote.status !== 0) {
    console.error(
      "[delivery-contract] no origin remote — settings needs a GitHub origin to target",
    );
    return EXIT_CONTRACT;
  }
  const parsed = parseGitHubRemote(remote.stdout);
  if (!parsed) {
    console.error(
      `[delivery-contract] origin is not a GitHub remote: ${remote.stdout.trim()}`,
    );
    return EXIT_CONTRACT;
  }
  const { owner, repo } = parsed;
  console.log(
    "default-branch changes are an owner act — this command never touches it.",
  );
  if (!apply) {
    console.log(squashSettingsCommand(owner, repo));
    return 0;
  }
  const patch = spawnSync(
    "gh",
    [
      "api",
      "-X",
      "PATCH",
      `repos/${owner}/${repo}`,
      "-f",
      "squash_merge_commit_title=PR_TITLE",
      "-f",
      "squash_merge_commit_message=PR_BODY",
      "-F",
      "delete_branch_on_merge=true",
    ],
    { encoding: "utf8" },
  );
  if (patch.status !== 0) {
    console.error(
      `[delivery-contract] gh api PATCH failed: ${(patch.stderr || patch.stdout || "").trim()}`,
    );
    return 1;
  }
  const readBack = spawnSync(
    "gh",
    ["api", `repos/${owner}/${repo}`, "-q", ".squash_merge_commit_message"],
    { encoding: "utf8" },
  );
  if (readBack.status !== 0) {
    console.error(
      `[delivery-contract] gh api readback failed: ${(readBack.stderr || readBack.stdout || "").trim()}`,
    );
    return 1;
  }
  console.log(`squash_merge_commit_message=${readBack.stdout.trim()}`);
  return 0;
}

// ---------------------------------------------------------------- commands

function commandUpdate(repoRoot, templateDir, manifest, document) {
  const answers = answersWithDefaults(manifest, document.answers);
  const omit = document.omit ?? [];
  const omitSet = new Set(omit);
  const drifted = driftedManaged(
    repoRoot,
    templateDir,
    manifest,
    answers,
    omitSet,
  );
  const inRepo = drifted.length > 0 && insideWorkTree(repoRoot);
  const dirty = drifted.filter((entry) =>
    hasUncommittedChanges(repoRoot, entry.path, inRepo),
  );
  if (dirty.length > 0) {
    for (const entry of dirty) {
      printDiff(
        repoRoot,
        entry.path,
        renderedBytes(templateDir, entry, answers),
      );
    }
    console.error(
      `\n[delivery-contract] refusing to update — ${dirty.length} managed file(s) carry uncommitted changes:`,
    );
    for (const entry of dirty) console.error(`  ${entry.path}`);
    console.error(
      "\nCommit or discard them first; the diff above is what update would replace. Nothing was written.",
    );
    return 1;
  }
  for (const entry of drifted) {
    writeFile(repoRoot, entry, renderedBytes(templateDir, entry, answers));
    console.log(`update ${entry.path}`);
  }
  for (const relPath of omit) console.log(`omit   ${relPath}`);
  const versionChanged = writeAnswersFile(repoRoot, document.answers, omit);
  if (drifted.length === 0) {
    console.log(
      versionChanged
        ? `up to date (templateVersion -> ${templateVersion()})`
        : "up to date",
    );
  }
  return 0;
}

function commandInstall(repoRoot, templateDir, manifest, flags, omit = []) {
  const answers = resolveAnswers(manifest, flags);
  // Validate before any write: a bad answer must not leave a half-installed consumer.
  validateAnswersDocument({ templateVersion: templateVersion(), answers });
  validateOmit(manifest, omit);
  const omitSet = new Set(omit);
  for (const entry of manifest.files) {
    const target = path.join(repoRoot, entry.path);
    if (entry.class === "managed" && omitSet.has(entry.path)) {
      console.log(`omit   ${entry.path}`);
    } else if (entry.class === "managed") {
      writeFile(repoRoot, entry, renderedBytes(templateDir, entry, answers));
      console.log(`write  ${entry.path}`);
    } else if (fs.existsSync(target)) {
      console.log(`keep   ${entry.path}`);
    } else {
      const raw = templateBytes(templateDir, entry);
      const content = entry.render
        ? render(raw.toString("utf8"), answers, entry.path)
        : raw;
      writeFile(repoRoot, entry, content);
      console.log(`seed   ${entry.path}`);
    }
  }
  writeAnswersFile(repoRoot, answers, omit);
  console.log(`write  ${ANSWERS_FILENAME}`);
  return 0;
}

function commandCheck(repoRoot, templateDir, manifest, document) {
  if (!document) {
    console.error(
      `not installed — ${ANSWERS_FILENAME} is missing; run \`delivery-contract install\``,
    );
    return 1;
  }
  const answers = answersWithDefaults(manifest, document.answers);
  const omitSet = new Set(document.omit ?? []);
  const drifted = driftedManaged(
    repoRoot,
    templateDir,
    manifest,
    answers,
    omitSet,
  );
  if (drifted.length === 0) {
    console.log("clean");
    return 0;
  }
  for (const entry of drifted) console.error(`drift  ${entry.path}`);
  console.error(
    "\nManaged files are owned by the template. Run `delivery-contract update` to restore them.",
  );
  return 1;
}

function run(args) {
  const repoRoot = path.resolve(args.repo ?? process.cwd());
  const templateDir = path.resolve(args.template ?? DEFAULT_TEMPLATE);
  const manifest = readManifest(templateDir);
  const document = readAnswersFile(repoRoot);
  if (document) validateOmit(manifest, document.omit ?? []);

  if (args.command === "check") {
    return commandCheck(repoRoot, templateDir, manifest, document);
  }
  if (args.command === "install" && !document) {
    return commandInstall(
      repoRoot,
      templateDir,
      manifest,
      args.answers,
      args.omit ?? [],
    );
  }
  if (!document) {
    console.error(
      `not installed — ${ANSWERS_FILENAME} is missing; run \`delivery-contract install\``,
    );
    return 1;
  }
  if (args.command === "install") {
    console.log(
      "already installed — running update (answer flags are ignored; edit .delivery-contract.json to change answers)",
    );
  }
  return commandUpdate(repoRoot, templateDir, manifest, document);
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "delivery-contract-self-test-"),
  );
  const template = path.join(sandbox, "template");
  const consumer = path.join(sandbox, "consumer");
  fs.mkdirSync(path.join(template, "scripts"), { recursive: true });
  fs.mkdirSync(consumer);
  const files = {
    "managed.txt": "managed v1\n",
    "seeded.mjs": "export const scopes = {{scopes}};\n",
    "scripts/hook.sh": "#!/bin/sh\nexit 0\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(template, rel), content);
  }
  fs.writeFileSync(
    path.join(template, "manifest.json"),
    JSON.stringify({
      files: [
        { path: "managed.txt", class: "managed" },
        { path: "seeded.mjs", class: "seeded", render: true },
        { path: "scripts/hook.sh", class: "managed", mode: "0755" },
      ],
      answers: {
        scopes: { type: "array", default: ["core"], description: "scopes" },
      },
    }),
  );

  const invoke = (...argv) =>
    spawnSync(
      process.execPath,
      [__filename, ...argv, "--repo", consumer, "--template", template],
      { encoding: "utf8" },
    );
  const results = [];
  const expect = (name, condition) => {
    results.push(condition);
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  };

  try {
    const install = invoke("install", "--scopes", "api,cli");
    const seeded = fs.readFileSync(path.join(consumer, "seeded.mjs"), "utf8");
    const hookMode =
      fs.statSync(path.join(consumer, "scripts/hook.sh")).mode & 0o777;
    expect(
      "install writes managed, seeded (rendered), and mode-0755 files",
      install.status === 0 &&
        seeded === "export const scopes = ['api', 'cli'];\n" &&
        hookMode === 0o755,
    );
    expect("check after install exits 0", invoke("check").status === 0);

    fs.writeFileSync(path.join(consumer, "managed.txt"), "local edit\n");
    const drift = invoke("check");
    expect(
      "check detects a mutated managed file (positive control)",
      drift.status === 1 && drift.stderr.includes("drift  managed.txt"),
    );

    const update = invoke("update");
    expect(
      "update restores the managed file",
      update.status === 0 && update.stdout.includes("update managed.txt"),
    );
    expect("check after update exits 0", invoke("check").status === 0);

    fs.writeFileSync(
      path.join(consumer, "seeded.mjs"),
      "export const x = 1;\n",
    );
    expect("check ignores a mutated seeded file", invoke("check").status === 0);

    const answersBefore = fs.readFileSync(
      path.join(consumer, ANSWERS_FILENAME),
    );
    const again = invoke("install");
    expect(
      "second install writes 0 files",
      again.status === 0 &&
        !/^(write|seed|update) /m.test(again.stdout) &&
        fs
          .readFileSync(path.join(consumer, ANSWERS_FILENAME))
          .equals(answersBefore),
    );
  } catch (error) {
    expect(`self-test raised: ${error.message}`, false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(
    failed === 0
      ? `delivery-contract self-test OK — ${results.length} case(s)`
      : `delivery-contract self-test FAILED — ${failed} of ${results.length} case(s)`,
  );
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- CLI

function usage() {
  return [
    "Usage: delivery-contract <install | update | check> [--repo PATH] [--template PATH]",
    "       delivery-contract install [--scopes a,b,c] [--adr-dir DIR] [--default-branch NAME]",
    "                                  [--package-manager npm|pnpm|bun] [--node-version-file PATH]",
    "                                  [--omit path,path]",
    "       delivery-contract settings [--apply] [--repo PATH]",
    "       delivery-contract --self-test | --help",
    "",
    "install   write managed files, seed absent seeded files, write .delivery-contract.json;",
    "          behaves as update when .delivery-contract.json already exists",
    "--omit    comma-separated managed-file paths (from the template manifest) that install",
    "          and update must never write; update deletes nothing for them and check skips",
    "          them. Stored in .delivery-contract.json; only valid with install.",
    "update    overwrite drifted managed files; refuses (exit 1) on uncommitted changes",
    "check     exit 1 on any managed-file drift or a missing install; never writes",
    "settings  print (or, with --apply, run via `gh`) the repository settings PATCH the",
    "          contract depends on: squash-merge commit defaults, delete-branch-on-merge.",
    "          Reads owner/repo from the --repo checkout's `origin` remote. Never touches",
    "          the default branch — that stays an owner act.",
    "",
    "--repo defaults to the current working directory; --template to this package's",
    "templates/delivery-contract. Exit 2 on an invalid manifest, answers file, or argument.",
  ].join("\n");
}

const VALUE_FLAGS = {
  "--repo": "repo",
  "--template": "template",
  "--scopes": "scopes",
  "--adr-dir": "adrDir",
  "--default-branch": "defaultBranch",
  "--package-manager": "packageManager",
  "--node-version-file": "nodeVersionFile",
};
const ANSWER_FLAGS = [
  "scopes",
  "adrDir",
  "defaultBranch",
  "packageManager",
  "nodeVersionFile",
];

function parseArguments(argv) {
  const parsed = {
    command: null,
    selfTest: false,
    help: false,
    apply: false,
    answers: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--self-test") parsed.selfTest = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--apply") parsed.apply = true;
    else if (argument === "--omit") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ContractError(`${argument} requires a value`);
      }
      parsed.omit = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      index += 1;
    } else if (argument in VALUE_FLAGS) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ContractError(`${argument} requires a value`);
      }
      const key = VALUE_FLAGS[argument];
      if (ANSWER_FLAGS.includes(key)) {
        parsed.answers[key] =
          key === "scopes"
            ? value
                .split(",")
                .map((scope) => scope.trim())
                .filter(Boolean)
            : value;
      } else {
        parsed[key] = value;
      }
      index += 1;
    } else if (COMMANDS.includes(argument) && parsed.command === null) {
      parsed.command = argument;
    } else {
      throw new ContractError(`unknown argument: ${argument}`);
    }
  }
  if (parsed.help || parsed.selfTest) return parsed;
  if (!parsed.command) throw new ContractError("a command is required");
  if (Object.keys(parsed.answers).length > 0 && parsed.command !== "install") {
    throw new ContractError("answer flags are only valid with install");
  }
  if (parsed.omit !== undefined && parsed.command !== "install") {
    throw new ContractError("--omit is only valid with install");
  }
  if (parsed.apply && parsed.command !== "settings") {
    throw new ContractError("--apply is only valid with settings");
  }
  return parsed;
}

function main() {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`[delivery-contract] ${error.message}`);
    console.error(usage());
    process.exitCode = EXIT_CONTRACT;
    return;
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.selfTest) {
    process.exitCode = selfTest();
    return;
  }
  if (args.command === "settings") {
    process.exitCode = commandSettings(
      path.resolve(args.repo ?? process.cwd()),
      args.apply,
    );
    return;
  }
  try {
    process.exitCode = run(args);
  } catch (error) {
    console.error(`[delivery-contract] ${error.message}`);
    process.exitCode = error instanceof ContractError ? EXIT_CONTRACT : 1;
  }
}

main();
