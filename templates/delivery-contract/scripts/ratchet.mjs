#!/usr/bin/env node
/**
 * Ratchet
 *
 * A debt backlog too large to fix in one change cannot be a pass/fail gate on day one, and
 * left ungated it grows. A ratchet records the backlog PER KEY in a committed baseline and
 * refuses every run that moves a key's count without a deliberate baseline change:
 *
 *   - UP (a regression): the change added debt. Fix it, or raise the ceiling on purpose with
 *     `update-baseline --allow-increase <key> "<reason>"`; the reason lands in the baseline's
 *     `overrideLog`, in the same diff a reviewer reads.
 *   - DOWN (a decrease): the debt was paid but the ceiling was not lowered. A ratchet that
 *     only watches for increases is a floor once debt is paid down: a later change can add the
 *     same amount back and still pass. Lowering is always free: `update-baseline`, no override.
 *   - GONE (vanished): a key the baseline tracked produced no report at all. Zero is not
 *     greater than N, so a rule that stopped loading, a file that left the compiler's view or a
 *     reporter that renamed a category reads as progress unless something names it. Counts
 *     cannot separate "fixed" from "stopped being measured", so both readings are printed.
 *
 * Keys, never totals: a total lets a new finding in one place hide behind a fix in another.
 *
 * ADAPTERS. One core, three built-in tools; an adapter is the binary, its arguments, the
 * output parser and the counting key:
 *
 *   eslint  JSON formatter, keyed by rule id, counting errors and warnings separately. A
 *           message with no rule id (an unused disable directive, a parse error) counts under
 *           `__unknown__`, which gets no special case. `--target <path>` (repeatable, default
 *           `.`) names what is linted and is recorded as `eslintTarget`.
 *   tsc     `--noEmit --pretty false --project <tsconfig>` text output, keyed by file.
 *           `--scope <prefix>` counts only files under it (recorded as `scope`). `--pretty
 *           false` is passed AND `FORCE_COLOR` is scrubbed: pretty output changes the line
 *           format, the parser then matches nothing, and an empty parse would record a dead
 *           parser as a cleared backlog. Any ANSI escape in the output is a parse failure. A
 *           diagnostic with no file position (`error TS5058: ...`) means tsc stopped before
 *           type-checking, so it fails the run rather than counting as a result.
 *   knip    `--reporter json --no-progress`, keyed by issue category. Categories are read from
 *           the report, not from a list, so one a knip upgrade adds is counted (and named).
 *           One element of a category array is one finding; a duplicates GROUP is one finding.
 *
 * BASELINE FILE (schemaVersion 1). The layout of the three original per-tool scripts is kept,
 * so their committed baselines load unchanged: `generatedAt`, the adapter's identity fields
 * (`eslintTarget`; `project` + `scope`), `totals` (written for readers, never compared), the
 * count map (`byRule` | `byCode` + `byFile` | `byCategory`, keys sorted) and `overrideLog`.
 * Three optional fields are added on write: `adapter`; `params`, a fingerprint of the spawn
 * arguments and counting options, so a baseline recorded under different arguments refuses to
 * compare instead of reading as debt moving; and `toolVersion`, which only warns on mismatch.
 *
 * Library use: `compareCounts`, `findUnauthorizedIncreases`, `buildOverrideLog` and
 * `parseAllowIncreaseArgs` take a `{ keyName, metrics }` shape, so a repository-specific
 * ratchet with its own counter reuses the same refusal rules.
 *
 * Usage:
 *   node scripts/ratchet.mjs <eslint|knip|tsc> <check|update-baseline> [--root <dir>]
 *     [--dir <subdir>] [--baseline <path>] [adapter flags]
 *     [--allow-increase <key> <reason>]... [-- <tool args>]
 *   node scripts/ratchet.mjs --self-test
 *
 * `--root` defaults to the repository the script sits in; `--dir` (relative to it) is where the
 * tool runs and where the baseline lives; `--baseline` is relative to that directory. The
 * binary is found in `node_modules/.bin` from `--dir` up to `--root`.
 *
 * Exit: 0 = no key moved, or no baseline yet (the ratchet is opt-in: `update-baseline` records
 * one); 1 = a refusal (regression, vanished key, decrease, unauthorized increase, baseline not
 * comparable) or a baseline whose tool is not installed (`npm ci`); 2 = invalid usage, an
 * unreadable baseline, a tool that crashed, or output the parser could not read.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SCHEMA_VERSION = 1;
const MODES = Object.freeze(["check", "update-baseline"]);
const MAX_BUFFER = 256 * 1024 * 1024;
const QUOTED_LINES = 10;
const USAGE = [
  "Usage: ratchet.mjs <eslint|knip|tsc> <check|update-baseline> [--root <dir>] [--dir <subdir>]",
  "         [--baseline <path>] [adapter flags] [--allow-increase <key> <reason>]... [-- <tool args>]",
  "       ratchet.mjs --self-test",
  "Adapter flags: eslint --target <path> (repeatable, default .);",
  "               tsc --project <tsconfig> (default tsconfig.json), --scope <path prefix>;",
  "               knip none.",
].join("\n");

/** A run that must stop with a specific exit code and message. */
export class RatchetExit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Invalid usage: exit 2, followed by the usage text. */
class UsageError extends RatchetExit {
  constructor(message) {
    super(2, message);
  }
}

// ---------------------------------------------------------------------------------------------
// Core: per-key comparison. Pure. A shape names the key field in findings (`ruleId`, `file`)
// and the metrics a key carries: `null` for a plain number, or a list (`errors`, `warnings`)
// for an object of numbers, each compared on its own.
// ---------------------------------------------------------------------------------------------

const DEFAULT_SHAPE = Object.freeze({ keyName: "key", metrics: null });

function metricList(shape) {
  return shape.metrics ?? [null];
}

function read(counts, metric) {
  const value = metric === null ? counts : counts?.[metric];
  return typeof value === "number" ? value : 0;
}

function zero(shape) {
  return shape.metrics
    ? Object.fromEntries(shape.metrics.map((metric) => [metric, 0]))
    : 0;
}

function rose(before, after, shape) {
  return metricList(shape).some(
    (metric) => read(after, metric) > read(before, metric),
  );
}

function hasFindings(counts, shape) {
  return metricList(shape).some((metric) => read(counts, metric) > 0);
}

function ordinal(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function unionKeys(a, b) {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort(
    ordinal,
  );
}

/** A copy of `record` with its keys in code-unit order, so a rewrite is stable on any locale. */
export function sortKeys(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).sort(([a], [b]) => ordinal(a, b)),
  );
}

/**
 * Compare a baseline count map against the current one.
 *
 * `regressions`: a key's count rose (a key the baseline never saw compares against 0).
 * `vanished`: a key the baseline tracked with findings is absent from this run. Reported once,
 *   as vanished, never doubled as a decrease.
 * `decreases`: a key's count fell while the key still reports (possibly at 0 on one metric).
 */
export function compareCounts(baselineMap, currentMap, shape = DEFAULT_SHAPE) {
  const findings = { regressions: [], vanished: [], decreases: [] };
  const baseline = baselineMap ?? {};
  const current = currentMap ?? {};

  for (const key of unionKeys(baseline, current)) {
    const before = baseline[key] ?? zero(shape);
    const after = current[key] ?? zero(shape);
    const gone =
      Object.hasOwn(baseline, key) &&
      !Object.hasOwn(current, key) &&
      hasFindings(before, shape);
    if (gone) {
      findings.vanished.push(vanishedFinding(key, before, shape));
      continue;
    }
    for (const finding of metricFindings(key, before, after, shape)) {
      if (finding.current > finding.baseline)
        findings.regressions.push(finding);
      else findings.decreases.push(finding);
    }
  }
  return findings;
}

/** A vanished key, carrying what the baseline counted for it. */
function vanishedFinding(key, before, shape) {
  if (!shape.metrics)
    return { [shape.keyName]: key, baseline: read(before, null) };
  return {
    [shape.keyName]: key,
    ...Object.fromEntries(
      shape.metrics.map((metric) => [metric, read(before, metric)]),
    ),
  };
}

/** One finding per metric whose count moved, in either direction. */
function metricFindings(key, before, after, shape) {
  return metricList(shape)
    .filter((metric) => read(before, metric) !== read(after, metric))
    .map((metric) => ({
      [shape.keyName]: key,
      ...(metric === null ? {} : { type: metric }),
      baseline: read(before, metric),
      current: read(after, metric),
    }));
}

/**
 * Keys whose ceiling would rise without an `--allow-increase` naming them. Any metric rising is
 * enough; a key new to the baseline rises from 0; a key that disappears never needs one.
 */
export function findUnauthorizedIncreases(
  baselineMap,
  currentMap,
  overrides,
  shape = DEFAULT_SHAPE,
) {
  const increases = [];
  for (const key of unionKeys(baselineMap, currentMap)) {
    const before = baselineMap?.[key] ?? zero(shape);
    const after = currentMap?.[key] ?? zero(shape);
    if (rose(before, after, shape) && !overrides?.has(key)) {
      increases.push({ [shape.keyName]: key, before, after });
    }
  }
  return increases;
}

/**
 * The overrideLog to persist: the previous entries plus one per override that was NEEDED (its
 * key rose). An override for a key that did not rise is returned in `unused`, never logged.
 */
export function buildOverrideLog(
  previousOverrideLog,
  overrides,
  baselineMap,
  currentMap,
  generatedAt,
  shape = DEFAULT_SHAPE,
) {
  const overrideLog = [...(previousOverrideLog ?? [])];
  const unused = [];
  for (const [key, reason] of overrides ?? []) {
    const before = baselineMap?.[key] ?? zero(shape);
    const after = currentMap?.[key] ?? zero(shape);
    if (rose(before, after, shape)) {
      overrideLog.push({
        date: generatedAt,
        [shape.keyName]: key,
        reason,
        before,
        after,
      });
    } else {
      unused.push(key);
    }
  }
  return { overrideLog, unused };
}

function readAllowIncrease(argv, index, shape) {
  const key = argv[index + 1];
  const reason = argv[index + 2];
  if (!key || !reason || key.startsWith("--") || reason.startsWith("--")) {
    throw new UsageError(
      `--allow-increase requires two arguments: <${shape.keyName}> "<reason>". ` +
        `Got: ${JSON.stringify(argv.slice(index, index + 3))}`,
    );
  }
  return [key, reason];
}

/** Every `--allow-increase <key> <reason>` pair in `argv`, as a Map. Throws on a broken pair. */
export function parseAllowIncreaseArgs(argv, shape = DEFAULT_SHAPE) {
  const overrides = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--allow-increase") continue;
    const [key, reason] = readAllowIncrease(argv, index, shape);
    overrides.set(key, reason);
    index += 2;
  }
  return overrides;
}

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

function parseFailure(tag, message, text) {
  const first = (text ?? "").split("\n").find((line) => line.trim().length > 0);
  return new RatchetExit(
    2,
    `${tag} ${message} Refusing to read that as a result.` +
      (first === undefined ? "" : `\nFirst line was: ${JSON.stringify(first)}`),
  );
}

function parseJson(tag, text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw parseFailure(tag, `${what} did not parse as JSON.`, text);
  }
}

/** Sum errors and warnings per rule id across ESLint's JSON formatter output. */
export function summarizeEslint(results) {
  const byRule = {};
  for (const fileResult of results) {
    for (const message of fileResult.messages ?? []) {
      const ruleId = message.ruleId ?? "__unknown__";
      byRule[ruleId] ??= { errors: 0, warnings: 0 };
      if (message.severity === 2) byRule[ruleId].errors += 1;
      else if (message.severity === 1) byRule[ruleId].warnings += 1;
    }
  }
  return byRule;
}

/** knip's issue categories as of knip 6; anything else is counted and named. */
export const KNOWN_KNIP_CATEGORIES = Object.freeze([
  "binaries",
  "catalog",
  "catalogReferences",
  "classMembers",
  "dependencies",
  "devDependencies",
  "duplicates",
  "enumMembers",
  "exports",
  "files",
  "namespaceMembers",
  "nsExports",
  "nsTypes",
  "optionalPeerDependencies",
  "types",
  "unlisted",
  "unresolved",
]);

/** Sum findings per category: one array element is one finding, every array key but `file`. */
export function summarizeKnip(issues) {
  const byCategory = {};
  for (const entry of issues) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === "file" || !Array.isArray(value)) continue;
      byCategory[key] = (byCategory[key] ?? 0) + value.length;
    }
  }
  return byCategory;
}

/** `path/to/file.ts(12,34): error TS1234: message` */
const TSC_DIAGNOSTIC = /^(?<file>[^(]+)\((\d+),(\d+)\): error (?<code>TS\d+): /;
/** A diagnostic with no file position: tsc stopped before type-checking. */
const TSC_FATAL = /^error (?<code>TS\d+): /;
/** ESC followed by `[`: the start of every ANSI color sequence. */
const ANSI_ESCAPE = `${String.fromCharCode(27)}[`;

/**
 * Bucket tsc diagnostics by file (and, for readers only, by code). Throws on an ANSI line, a
 * fatal diagnostic, or a non-zero exit whose output matched nothing.
 */
export function summarizeTsc(output, { exitCode = 0, scope } = {}) {
  const tag = ADAPTERS.tsc.tag;
  const byFile = {};
  const byCode = {};
  const fatals = [];
  let matched = 0;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    const diagnostic = readTscLine(line, tag);
    if (diagnostic === null) {
      if (TSC_FATAL.test(line)) fatals.push(line);
      continue;
    }
    matched += 1;
    const file = diagnostic.groups.file.split(path.sep).join("/");
    if (scope && !file.startsWith(scope)) continue;
    byFile[file] = (byFile[file] ?? 0) + 1;
    byCode[diagnostic.groups.code] = (byCode[diagnostic.groups.code] ?? 0) + 1;
  }
  assertTscRead(tag, { fatals, matched, exitCode, output });
  return { byFile, byCode };
}

/** The diagnostic match for one tsc output line, or null; an ANSI line throws. */
function readTscLine(line, tag) {
  if (line.includes(ANSI_ESCAPE)) {
    throw parseFailure(
      tag,
      "tsc output carries ANSI escapes, so pretty output was forced (FORCE_COLOR, or " +
        "`--pretty` in the tool arguments) and the per-file parser cannot read it.",
      line,
    );
  }
  return TSC_DIAGNOSTIC.exec(line);
}

/** A fatal line, or a non-zero exit whose output matched nothing, is not a measurement. */
function assertTscRead(tag, { fatals, matched, exitCode, output }) {
  if (fatals.length > 0) {
    throw new RatchetExit(
      2,
      [
        `${tag} tsc reported ${fatals.length} configuration error(s) and did not finish ` +
          "type-checking; its per-file counts would record a dead compiler as a cleared backlog.",
        ...fatals.slice(0, QUOTED_LINES).map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
  if (matched === 0 && exitCode !== 0 && output.trim().length > 0) {
    throw parseFailure(
      tag,
      `tsc exited ${exitCode} with output, but no line matched the diagnostic parser.`,
      output,
    );
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

const ESLINT = Object.freeze({
  name: "eslint",
  tag: "[eslint-ratchet]",
  bin: "eslint",
  pkg: "eslint",
  shape: Object.freeze({ keyName: "ruleId", metrics: ["errors", "warnings"] }),
  mapField: "byRule",
  defaultBaseline: ".eslint-ratchet-baseline.json",
  nouns: ["rule", "rules"],
  okExits: [0, 1],
  flags: { "--target": { option: "targets", repeat: true } },
  identityFields: ["eslintTarget"],
  defaults: () => ({ targets: [] }),
  targets: (options) => (options.targets.length > 0 ? options.targets : ["."]),
  invocation(options, toolArgs, scratch) {
    const stable = [...this.targets(options), "--format", "json", ...toolArgs];
    const reportFile = path.join(scratch(), "eslint-report.json");
    return {
      args: [...stable, "--output-file", reportFile],
      stable,
      reportFile,
    };
  },
  identity(options) {
    return { eslintTarget: this.targets(options).join(",") };
  },
  summarize({ report }) {
    const results = parseJson(this.tag, report, "The ESLint report");
    if (!Array.isArray(results)) {
      throw parseFailure(
        this.tag,
        "The ESLint report is not an array.",
        report,
      );
    }
    return { counts: summarizeEslint(results), notes: [] };
  },
  layout(summary) {
    const counts = Object.values(summary.counts);
    return {
      totals: {
        errors: sum(counts.map((c) => c.errors)),
        warnings: sum(counts.map((c) => c.warnings)),
      },
      byRule: sortKeys(summary.counts),
    };
  },
  okLine: (body) =>
    `${body.totals.errors} errors, ${body.totals.warnings} warnings`,
  vanishedHelp: [
    "Two readings, and the counts cannot tell them apart:",
    "  1. The violations were fixed. Run update-baseline to lock it in.",
    "  2. The rule stopped running (plugin renamed, removed, or failed to load). The debt is",
    "     still in the code and nothing is watching it. Restore the rule before re-baselining.",
    "Renaming a plugin is case 2 even though it looks like case 1: rename the baseline keys",
    "in place so the counts carry over, rather than regenerating.",
  ],
});

const TSC = Object.freeze({
  name: "tsc",
  tag: "[tsc-ratchet]",
  bin: "tsc",
  pkg: "typescript",
  shape: Object.freeze({ keyName: "file", metrics: null }),
  mapField: "byFile",
  defaultBaseline: ".tsc-ratchet-baseline.json",
  nouns: ["file", "files"],
  // tsc exits 2 for ordinary type errors under --noEmit (measured, TypeScript 6.0.3) and 1 for
  // some configuration errors, so only 3+ and a signal are crashes; the fatal-line and
  // nothing-matched guards in summarizeTsc cover the rest.
  okExits: [0, 1, 2],
  flags: {
    "--project": { option: "project" },
    "--scope": { option: "scope" },
  },
  identityFields: ["project", "scope"],
  defaults: () => ({ project: "tsconfig.json", scope: undefined }),
  env() {
    const env = { ...process.env };
    delete env.FORCE_COLOR;
    return env;
  },
  invocation(options, toolArgs) {
    const stable = [
      "--noEmit",
      "--pretty",
      "false",
      "--project",
      options.project,
      ...toolArgs,
    ];
    return { args: stable, stable };
  },
  identity(options) {
    return {
      project: options.project,
      ...(options.scope ? { scope: options.scope } : {}),
    };
  },
  summarize({ stdout, stderr, status }, options) {
    const { byFile, byCode } = summarizeTsc(`${stdout}${stderr}`, {
      exitCode: status,
      scope: options.scope,
    });
    return { counts: byFile, byCode, notes: [] };
  },
  layout(summary) {
    return {
      totals: { errors: sum(Object.values(summary.counts)) },
      byCode: sortKeys(summary.byCode),
      byFile: sortKeys(summary.counts),
    };
  },
  okLine(body, options) {
    return `${body.totals.errors} errors in ${options.scope ?? options.project}`;
  },
  vanishedHelp: [
    "Two readings, and the counts cannot tell them apart:",
    "  1. The errors were fixed, or the file was deleted. Run update-baseline to lock it in.",
    "  2. The file left the compiler's view (renamed, or dropped from the project's include",
    "     globs). Its type debt is still there and nothing is watching it.",
    "A rename is case 2 even though it looks like case 1: move the baseline key rather than",
    "regenerating, so the count carries over to the new path.",
  ],
});

const KNIP = Object.freeze({
  name: "knip",
  tag: "[knip-ratchet]",
  bin: "knip",
  pkg: "knip",
  shape: Object.freeze({ keyName: "category", metrics: null }),
  mapField: "byCategory",
  defaultBaseline: ".knip-ratchet-baseline.json",
  nouns: ["category", "categories"],
  okExits: [0, 1],
  flags: {},
  identityFields: [],
  defaults: () => ({}),
  invocation(_options, toolArgs) {
    const stable = ["--reporter", "json", "--no-progress", ...toolArgs];
    return { args: stable, stable };
  },
  identity: () => ({}),
  summarize({ stdout }) {
    const report = parseJson(this.tag, stdout, "knip's stdout");
    if (!Array.isArray(report?.issues)) {
      throw parseFailure(
        this.tag,
        'knip\'s JSON report has no "issues" array; the reporter shape changed.',
        stdout,
      );
    }
    const counts = summarizeKnip(report.issues);
    const unknown = Object.keys(counts)
      .filter((category) => !KNOWN_KNIP_CATEGORIES.includes(category))
      .sort(ordinal);
    const notes =
      unknown.length === 0
        ? []
        : [
            `${this.tag} Note: knip reported ${unknown.length === 1 ? "a category" : "categories"} ` +
              `this adapter does not know (${unknown.join(", ")}); counted like any other.`,
          ];
    return { counts, notes };
  },
  layout(summary) {
    return {
      totals: { findings: sum(Object.values(summary.counts)) },
      byCategory: sortKeys(summary.counts),
    };
  },
  okLine: (body) => `${body.totals.findings} findings`,
  vanishedHelp: [
    "knip's categories are a fixed vocabulary, so a tracked category reporting nothing at all",
    "usually means the reporter shape changed (a category renamed or removed), not that the",
    "debt reached zero. Verify before trusting a clean read; rename the baseline key in place",
    "if knip renamed it.",
  ],
});

export const ADAPTERS = Object.freeze({ eslint: ESLINT, knip: KNIP, tsc: TSC });

// ---------------------------------------------------------------------------------------------
// Baseline file
// ---------------------------------------------------------------------------------------------

/** A sha256 prefix over what the adapter spawns and how it counts. */
export function paramsFingerprint(adapter, stableArgs, options) {
  const counting =
    adapter.name === "tsc" ? { scope: options.scope ?? null } : {};
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        adapter: adapter.name,
        bin: adapter.bin,
        args: stableArgs,
        counting,
      }),
    )
    .digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

/**
 * Read a baseline for `adapter`: `null` when the file does not exist, a RatchetExit(2) when it
 * exists but cannot be used. Only a missing file is "no baseline": an unreadable one must never
 * read as the opt-out.
 */
export function loadBaseline(file, adapter) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new RatchetExit(
      2,
      `${adapter.tag} Cannot read baseline ${file}: ${error.message}`,
    );
  }
  const baseline = parseJson(adapter.tag, text, `Baseline ${file}`);
  const problem =
    (baseline === null ||
    typeof baseline !== "object" ||
    Array.isArray(baseline)
      ? "is not a JSON object"
      : undefined) ??
    (baseline.schemaVersion !== undefined &&
    baseline.schemaVersion !== SCHEMA_VERSION
      ? `has schemaVersion ${JSON.stringify(baseline.schemaVersion)}; this script reads ${SCHEMA_VERSION}`
      : undefined) ??
    (baseline.adapter !== undefined && baseline.adapter !== adapter.name
      ? `was recorded by the ${JSON.stringify(baseline.adapter)} adapter, not ${adapter.name}`
      : undefined) ??
    (typeof baseline[adapter.mapField] !== "object" ||
    baseline[adapter.mapField] === null
      ? `has no "${adapter.mapField}" object`
      : undefined);
  if (problem) {
    throw new RatchetExit(2, `${adapter.tag} Baseline ${file} ${problem}.`);
  }
  return baseline;
}

/** The baseline object to write, in the original scripts' field order plus the new fields. */
export function renderBaseline(
  adapter,
  { generatedAt, summary, identity, params, toolVersion, overrideLog },
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    adapter: adapter.name,
    ...(toolVersion ? { toolVersion } : {}),
    params,
    ...identity,
    ...adapter.layout(summary),
    ...(overrideLog?.length > 0 ? { overrideLog } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseOptions(adapter, mode, rest) {
  const options = {
    root: ROOT_DIR,
    dir: ".",
    baseline: adapter.defaultBaseline,
    overrides: new Map(),
    toolArgs: [],
    ...adapter.defaults(),
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--") {
      options.toolArgs = rest.slice(index + 1);
      break;
    }
    if (arg === "--allow-increase") {
      if (mode !== "update-baseline") {
        throw new UsageError(
          "--allow-increase applies to update-baseline only; check never raises a ceiling",
        );
      }
      const [key, reason] = readAllowIncrease(rest, index, adapter.shape);
      options.overrides.set(key, reason);
      index += 2;
      continue;
    }
    const common = {
      "--root": "root",
      "--dir": "dir",
      "--baseline": "baseline",
    };
    const flag = adapter.flags[arg];
    if (common[arg]) {
      options[common[arg]] = takeValue(rest, index, arg);
    } else if (flag?.repeat) {
      options[flag.option].push(takeValue(rest, index, arg));
    } else if (flag) {
      options[flag.option] = takeValue(rest, index, arg);
    } else {
      throw new UsageError(
        `unknown option ${arg} for the ${adapter.name} adapter`,
      );
    }
    index += 1;
  }
  options.root = path.resolve(options.root);
  options.cwd = path.resolve(options.root, options.dir);
  options.baselinePath = path.resolve(options.cwd, options.baseline);
  return options;
}

/** `{ adapter, mode, options }` for argv, or a RatchetExit(2). */
export function parseArguments(argv) {
  const [adapterName, mode, ...rest] = argv;
  const adapter = Object.hasOwn(ADAPTERS, adapterName ?? "")
    ? ADAPTERS[adapterName]
    : undefined;
  if (!adapter) {
    throw new UsageError(
      `unknown adapter ${JSON.stringify(adapterName ?? "")}; expected one of ${Object.keys(ADAPTERS).join(", ")}`,
    );
  }
  if (!MODES.includes(mode)) {
    throw new UsageError(
      `unknown mode ${JSON.stringify(mode ?? "")}; expected ${MODES.join(" or ")}`,
    );
  }
  return { adapter, mode, options: parseOptions(adapter, mode, rest) };
}

function quote(arg) {
  return /^[\w./:@,=+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

/** The command that records a new baseline under the same arguments as this run. */
function updateCommand(argv, options) {
  const kept = [];
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--allow-increase") {
      index += 2;
      continue;
    }
    kept.push(argv[index]);
  }
  const relative = path.relative(options.root, SCRIPT_PATH);
  const script =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : SCRIPT_PATH;
  return ["node", script, argv[0], "update-baseline", ...kept]
    .map(quote)
    .join(" ");
}

// ---------------------------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------------------------

function locateBin(adapter, options) {
  const name =
    process.platform === "win32" ? `${adapter.bin}.cmd` : adapter.bin;
  const searched = [];
  let directory = options.cwd;
  for (;;) {
    const candidate = path.join(directory, "node_modules", ".bin", name);
    searched.push(candidate);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (directory === options.root || parent === directory) break;
    directory = parent;
  }
  throw binaryAbsent(adapter, options, searched);
}

function binaryAbsent(adapter, options, searched) {
  const where = path.relative(options.root, options.cwd) || ".";
  return new RatchetExit(
    1,
    `${adapter.tag} ${adapter.bin} is not installed (looked for ${searched.join(", ")}). ` +
      `Run \`npm ci\` in ${where}: a ratchet with a baseline cannot pass without measuring.`,
  );
}

function toolVersionAt(adapter, binPath) {
  try {
    const manifest = path.join(
      path.dirname(path.dirname(binPath)),
      adapter.pkg,
      "package.json",
    );
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return undefined;
  }
}

function quotedOutput(result) {
  const lines = `${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const source =
    lines.length > 0
      ? lines
      : `${result.stdout ?? ""}`.split("\n").filter((l) => l.trim());
  return source.slice(0, QUOTED_LINES).map((line) => `  ${line}`);
}

/** Spawn the adapter's tool and summarize its output; `spawn` is spawnSync-shaped. */
function measure(adapter, options, spawn) {
  const binPath = locateBin(adapter, options);
  let scratchDir;
  const scratch = () => {
    scratchDir ??= mkdtempSync(path.join(tmpdir(), `ratchet-${adapter.name}-`));
    return scratchDir;
  };
  try {
    const invocation = adapter.invocation(options, options.toolArgs, scratch);
    const result = spawn(binPath, invocation.args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: adapter.env ? adapter.env() : process.env,
    });
    if (result.error?.code === "ENOENT") {
      throw binaryAbsent(adapter, options, [binPath]);
    }
    if (result.error || !adapter.okExits.includes(result.status)) {
      const detail = result.error
        ? result.error.message
        : result.status === null
          ? `killed by ${result.signal}`
          : `exit code ${result.status}`;
      throw new RatchetExit(
        2,
        [
          `${adapter.tag} ${adapter.bin} failed to run (${detail}); its output is not a measurement.`,
          ...quotedOutput(result),
        ].join("\n"),
      );
    }
    let report;
    if (invocation.reportFile) {
      if (!existsSync(invocation.reportFile)) {
        throw new RatchetExit(
          2,
          [
            `${adapter.tag} ${adapter.bin} exited ${result.status} but wrote no report.`,
            ...quotedOutput(result),
          ].join("\n"),
        );
      }
      report = readFileSync(invocation.reportFile, "utf8");
    }
    const summary = adapter.summarize(
      {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
        report,
      },
      options,
    );
    return {
      summary,
      params: paramsFingerprint(adapter, invocation.stable, options),
      stable: invocation.stable,
      toolVersion: toolVersionAt(adapter, binPath),
    };
  } finally {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

function plural(adapter, count) {
  return count === 1 ? adapter.nouns[0] : adapter.nouns[1];
}

function describeCounts(adapter, counts) {
  if (!adapter.shape.metrics) return `${read(counts, null)}`;
  return adapter.shape.metrics
    .map((metric) => `${read(counts, metric)} ${metric}`)
    .join(", ");
}

function findingLine(adapter, finding, sign) {
  const key = finding[adapter.shape.keyName];
  const type = finding.type ? ` (${finding.type})` : "";
  const delta = Math.abs(finding.current - finding.baseline);
  return `- ${key}${type}: baseline=${finding.baseline} current=${finding.current} (${sign}${delta})`;
}

function notComparable(adapter, baseline, identity, params, stable, command) {
  const reasons = [];
  for (const field of adapter.identityFields) {
    if (Object.hasOwn(baseline, field) && baseline[field] !== identity[field]) {
      reasons.push(
        `${field}: baseline ${JSON.stringify(baseline[field])}, this run ${JSON.stringify(identity[field] ?? null)}`,
      );
    }
  }
  if (
    params !== undefined &&
    baseline.params !== undefined &&
    baseline.params !== params
  ) {
    reasons.push(
      `params: baseline ${baseline.params}, this run ${params} (${adapter.bin} ${stable.join(" ")})`,
    );
  }
  if (reasons.length === 0) return undefined;
  return new RatchetExit(
    1,
    [
      `${adapter.tag} The baseline was recorded under different arguments, so the two counts are`,
      "not comparable: a wider run reads pre-existing debt as regressions, a narrower one hides",
      "real findings as vanished.",
      ...reasons.map((reason) => `  ${reason}`),
      `If the change is intended, run: ${command}`,
    ].join("\n"),
  );
}

function failureReport(adapter, findings, command) {
  const { regressions, vanished, decreases } = findings;
  const problems = regressions.length + vanished.length + decreases.length;
  const lines = [
    `${adapter.tag} FAIL: ${problems} ${adapter.nouns[0]} problem(s) detected.`,
  ];
  if (regressions.length > 0) {
    lines.push(
      "",
      `${adapter.nouns[1]} that increased (fix these, or raise the ceiling deliberately with`,
      `update-baseline --allow-increase <${adapter.shape.keyName}> "<reason>"):`,
      ...regressions.map((finding) => findingLine(adapter, finding, "+")),
    );
  }
  if (vanished.length > 0) {
    lines.push(
      "",
      `${adapter.nouns[1]} the baseline tracked that reported nothing this run:`,
      ...vanished.map(
        (finding) =>
          `- ${finding[adapter.shape.keyName]}: baseline=${describeCounts(
            adapter,
            adapter.shape.metrics ? finding : finding.baseline,
          )} -> absent`,
      ),
      "",
      ...adapter.vanishedHelp,
    );
  }
  if (decreases.length > 0) {
    lines.push(
      "",
      `${adapter.nouns[1]} that decreased (the ceiling is stale; lowering it is always free and`,
      "never needs --allow-increase):",
      ...decreases.map((finding) => findingLine(adapter, finding, "-")),
    );
  }
  lines.push("", `To record the new counts: ${command}`);
  return lines.join("\n");
}

function refusal(adapter, increases, command) {
  const key = adapter.shape.keyName;
  return [
    `${adapter.tag} Refusing to update baseline: ${increases.length} ${plural(adapter, increases.length)} ` +
      "would increase without an explicit override.",
    "",
    `Lowering a ceiling is always free. Raising one requires naming the ${adapter.nouns[0]}:`,
    ...increases.map(
      (increase) =>
        `- ${increase[key]}: ${describeCounts(adapter, increase.before)} -> ${describeCounts(adapter, increase.after)}`,
    ),
    "",
    `To accept one intentionally, pass --allow-increase <${key}> "<reason>" for EACH one listed`,
    "(repeatable flag), e.g.:",
    `  ${command} --allow-increase ${quote(increases[0][key])} "reason for the increase"`,
    "",
    "The reason is written into the committed baseline (overrideLog), where a reviewer sees it",
    "in the same diff as the ceiling change.",
  ].join("\n");
}

function relativeToRoot(options, file) {
  return path.relative(options.root, file) || file;
}

function runCheck(adapter, options, argv, { spawn, io }) {
  const command = updateCommand(argv, options);
  const baseline = loadBaseline(options.baselinePath, adapter);
  if (baseline === null) {
    io.log(
      `${adapter.tag} OK: no baseline at ${relativeToRoot(options, options.baselinePath)}, ` +
        `nothing to compare. The ratchet is opt-in; record one with: ${command}`,
    );
    return 0;
  }

  const identity = adapter.identity(options);
  const legacyMismatch = notComparable(
    adapter,
    baseline,
    identity,
    undefined,
    [],
    command,
  );
  if (legacyMismatch) throw legacyMismatch;

  const measured = measure(adapter, options, spawn);
  const paramsMismatch = notComparable(
    adapter,
    baseline,
    identity,
    measured.params,
    measured.stable,
    command,
  );
  if (paramsMismatch) throw paramsMismatch;

  for (const note of measured.summary.notes) io.log(note);
  if (
    baseline.toolVersion &&
    measured.toolVersion &&
    baseline.toolVersion !== measured.toolVersion
  ) {
    io.error(
      `${adapter.tag} Warning: the baseline was recorded with ${adapter.pkg} ${baseline.toolVersion}, ` +
        `this run uses ${measured.toolVersion}; a count can move for that reason alone (not a failure).`,
    );
  }

  const findings = compareCounts(
    baseline[adapter.mapField],
    measured.summary.counts,
    adapter.shape,
  );
  const body = adapter.layout(measured.summary);
  if (
    findings.regressions.length === 0 &&
    findings.vanished.length === 0 &&
    findings.decreases.length === 0
  ) {
    io.log(
      `${adapter.tag} OK: ${adapter.okLine(body, options)} (no regressions)`,
    );
    return 0;
  }
  io.error(failureReport(adapter, findings, command));
  return 1;
}

function runUpdate(adapter, options, argv, { spawn, io, now }) {
  const command = updateCommand(argv, options);
  const previous = loadBaseline(options.baselinePath, adapter);
  const measured = measure(adapter, options, spawn);
  const counts = measured.summary.counts;
  for (const note of measured.summary.notes) io.log(note);

  if (previous) {
    const unauthorized = findUnauthorizedIncreases(
      previous[adapter.mapField],
      counts,
      options.overrides,
      adapter.shape,
    );
    if (unauthorized.length > 0) {
      throw new RatchetExit(1, refusal(adapter, unauthorized, command));
    }
  }

  const generatedAt = now().toISOString();
  const { overrideLog, unused } = buildOverrideLog(
    previous?.overrideLog,
    options.overrides,
    previous?.[adapter.mapField],
    counts,
    generatedAt,
    adapter.shape,
  );
  for (const key of unused) {
    io.log(
      `${adapter.tag} Note: --allow-increase ${key} was passed but ${key} did not increase this run; ignored.`,
    );
  }

  const baseline = renderBaseline(adapter, {
    generatedAt,
    summary: measured.summary,
    identity: adapter.identity(options),
    params: measured.params,
    toolVersion: measured.toolVersion,
    overrideLog,
  });
  mkdirSync(path.dirname(options.baselinePath), { recursive: true });
  writeFileSync(
    options.baselinePath,
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
  io.log(
    `${adapter.tag} Baseline updated (${relativeToRoot(options, options.baselinePath)}): ` +
      `${adapter.okLine(baseline, options)} across ${Object.keys(counts).length} ${plural(adapter, Object.keys(counts).length)}`,
  );
  return 0;
}

/**
 * Run one ratchet invocation and return its exit code. `spawn` (spawnSync-shaped), `io`
 * (`log`/`error`) and `now` are injectable so tests and the self-test never start a real tool.
 */
export function runRatchet(
  argv,
  { spawn = spawnSync, io = console, now = () => new Date() } = {},
) {
  try {
    const { adapter, mode, options } = parseArguments(argv);
    if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
      throw new UsageError(
        `--dir ${options.dir} is not a directory under ${options.root}`,
      );
    }
    const run = mode === "check" ? runCheck : runUpdate;
    return run(adapter, options, argv, { spawn, io, now });
  } catch (error) {
    if (!(error instanceof RatchetExit)) throw error;
    io.error(error.message);
    if (error instanceof UsageError) io.error(USAGE);
    return error.code;
  }
}

// ---------------------------------------------------------------------------------------------
// Self-test: hermetic. Every case runs in a fresh temporary directory with a placeholder binary
// and a stubbed spawn returning canned tool output; no real tool starts.
// ---------------------------------------------------------------------------------------------

function knipOutput(byCategory) {
  return JSON.stringify({
    issues: [
      {
        file: "a.ts",
        ...Object.fromEntries(
          Object.entries(byCategory).map(([category, count]) => [
            category,
            Array.from({ length: count }, (_, i) => ({ name: `s${i}` })),
          ]),
        ),
      },
    ],
  });
}

function selfTestRoot(base, name, baseline) {
  const root = path.join(base, name);
  mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".bin", "knip"), "");
  if (baseline) {
    writeFileSync(
      path.join(root, KNIP.defaultBaseline),
      `${JSON.stringify({ schemaVersion: 1, byCategory: baseline }, null, 2)}\n`,
    );
  }
  return root;
}

function runSelfTest() {
  const base = mkdtempSync(path.join(tmpdir(), "ratchet-selftest-"));
  const silent = { log() {}, error() {} };
  const stub = (byCategory) => () => ({
    status: 1,
    stdout: knipOutput(byCategory),
    stderr: "",
  });
  const cases = [
    ["an equal count passes", { exports: 2 }, { exports: 2 }, ["check"], 0],
    ["a regression fails", { exports: 2 }, { exports: 3 }, ["check"], 1],
    ["a decrease fails", { exports: 2 }, { exports: 1 }, ["check"], 1],
    [
      "a vanished category fails",
      { exports: 2, files: 1 },
      { exports: 2 },
      ["check"],
      1,
    ],
    ["no baseline passes (opt-in)", null, { exports: 2 }, ["check"], 0],
    [
      "an increase without an override is refused",
      { exports: 2 },
      { exports: 3 },
      ["update-baseline"],
      1,
    ],
    [
      "an increase with an override is recorded",
      { exports: 2 },
      { exports: 3 },
      ["update-baseline", "--allow-increase", "exports", "self-test reason"],
      0,
    ],
  ];
  let failures = 0;
  const report = (name, ok) => {
    if (ok) console.log(`✔ self-test: ${name}`);
    else {
      console.error(`✖ self-test: ${name}`);
      failures += 1;
    }
  };
  try {
    cases.forEach(
      ([name, baseline, current, [mode, ...extra], expected], i) => {
        const root = selfTestRoot(base, `case-${i}`, baseline);
        const code = runRatchet(["knip", mode, "--root", root, ...extra], {
          spawn: stub(current),
          io: silent,
        });
        let ok = code === expected;
        if (ok && extra.includes("--allow-increase")) {
          const written = JSON.parse(
            readFileSync(path.join(root, KNIP.defaultBaseline), "utf8"),
          );
          ok =
            written.byCategory.exports === 3 &&
            written.overrideLog?.[0]?.reason === "self-test reason";
        }
        report(`${name} (exit ${code}, expected ${expected})`, ok);
      },
    );
    const unknown = runRatchet(["nope", "check"], { io: silent });
    report(
      `an unknown adapter is a usage error (exit ${unknown}, expected 2)`,
      unknown === 2,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (failures > 0) return 1;
  console.log("PASSED: ratchet self-test");
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) {
    if (argv.length === 1) return runSelfTest();
    console.error("--self-test takes no other arguments");
    console.error(USAGE);
    return 2;
  }
  if (argv.length === 0) {
    console.error(USAGE);
    return 2;
  }
  return runRatchet(argv);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  process.exitCode = main(process.argv.slice(2));
}
