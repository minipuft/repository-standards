import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADAPTERS,
  buildOverrideLog,
  compareCounts,
  findUnauthorizedIncreases,
  loadBaseline,
  parseAllowIncreaseArgs,
  parseArguments,
  renderBaseline,
  runRatchet,
  summarizeEslint,
  summarizeKnip,
  summarizeTsc,
} from "../templates/delivery-contract/scripts/ratchet.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/ratchet.mjs",
    import.meta.url,
  ),
);
const ESLINT = ADAPTERS.eslint.shape;
const KNIP = ADAPTERS.knip.shape;
const TSC = ADAPTERS.tsc.shape;
const DATE = "2026-09-16T00:00:00.000Z";

// Every run below is in-process with a stubbed spawn: no real eslint, knip or tsc starts. The
// root holds a placeholder file where the binary would be, so the lookup finds something.
function makeRoot({ bin, baseline, baselineName, toolVersion, dir = "." }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-test-"));
  const cwd = path.join(root, dir);
  fs.mkdirSync(path.join(cwd, "node_modules", ".bin"), { recursive: true });
  if (bin) {
    const adapter = ADAPTERS[bin];
    fs.writeFileSync(path.join(cwd, "node_modules", ".bin", adapter.bin), "");
    if (toolVersion) {
      fs.mkdirSync(path.join(cwd, "node_modules", adapter.pkg), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(cwd, "node_modules", adapter.pkg, "package.json"),
        JSON.stringify({ name: adapter.pkg, version: toolVersion }),
      );
    }
  }
  if (baseline !== undefined) {
    fs.writeFileSync(
      path.join(cwd, baselineName),
      typeof baseline === "string"
        ? baseline
        : `${JSON.stringify(baseline, null, 2)}\n`,
    );
  }
  return root;
}

function capture() {
  const lines = [];
  return {
    io: {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    },
    text: () => lines.join("\n"),
  };
}

function knipStdout(byCategory) {
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

function stubSpawn(result) {
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    return { status: 1, stdout: "", stderr: "", ...result };
  };
  return { spawn, calls };
}

/** An eslint stub writes its JSON report where --output-file points, as eslint does. */
function eslintSpawn(results, status = 1) {
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    const file = args[args.indexOf("--output-file") + 1];
    fs.writeFileSync(file, JSON.stringify(results));
    return { status, stdout: "", stderr: "" };
  };
  return { spawn, calls };
}

function readBaseline(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

// ---------------------------------------------------------------------------------------------
// Ported from claude-prompts-mcp server/tests/unit/scripts/eslint-ratchet.test.ts
// ---------------------------------------------------------------------------------------------

test("eslint: an increase is refused and names the rule", () => {
  assert.deepEqual(
    findUnauthorizedIncreases(
      { "no-useless-assignment": { errors: 0, warnings: 0 } },
      { "no-useless-assignment": { errors: 1, warnings: 0 } },
      new Map(),
      ESLINT,
    ),
    [
      {
        ruleId: "no-useless-assignment",
        before: { errors: 0, warnings: 0 },
        after: { errors: 1, warnings: 0 },
      },
    ],
  );
});

test("eslint: a rule missing from the baseline rises from an implicit zero", () => {
  const increases = findUnauthorizedIncreases(
    {},
    { "brand-new-rule": { errors: 2, warnings: 0 } },
    new Map(),
    ESLINT,
  );
  assert.ok(increases.some((i) => i.ruleId === "brand-new-rule"));
});

test("eslint: an override naming the rule clears the refusal", () => {
  assert.deepEqual(
    findUnauthorizedIncreases(
      { "no-useless-assignment": { errors: 0, warnings: 0 } },
      { "no-useless-assignment": { errors: 1, warnings: 0 } },
      new Map([["no-useless-assignment", "reason"]]),
      ESLINT,
    ),
    [],
  );
});

test("eslint: an override for one rule does not clear another", () => {
  const increases = findUnauthorizedIncreases(
    { a: { errors: 1, warnings: 0 }, b: { errors: 1, warnings: 0 } },
    { a: { errors: 2, warnings: 0 }, b: { errors: 1, warnings: 0 } },
    new Map([["b", "unrelated reason"]]),
    ESLINT,
  );
  assert.deepEqual(
    increases.map((i) => i.ruleId),
    ["a"],
  );
});

test("eslint: a decrease and a disappearing rule need no override", () => {
  assert.deepEqual(
    findUnauthorizedIncreases(
      { "strict-boolean-expressions": { errors: 10, warnings: 0 } },
      { "strict-boolean-expressions": { errors: 5, warnings: 0 } },
      new Map(),
      ESLINT,
    ),
    [],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      { retiring: { errors: 3, warnings: 0 } },
      {},
      new Map(),
      ESLINT,
    ),
    [],
  );
});

test("eslint: __unknown__ is refused and overridden like any rule", () => {
  const before = { __unknown__: { errors: 0, warnings: 5 } };
  const after = { __unknown__: { errors: 0, warnings: 6 } };
  assert.deepEqual(
    findUnauthorizedIncreases(before, after, new Map(), ESLINT).map(
      (i) => i.ruleId,
    ),
    ["__unknown__"],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      before,
      after,
      new Map([["__unknown__", "reason"]]),
      ESLINT,
    ),
    [],
  );
});

test("eslint: the override log records a needed override", () => {
  const { overrideLog, unused } = buildOverrideLog(
    undefined,
    new Map([["no-useless-assignment", "planted for the demo"]]),
    { "no-useless-assignment": { errors: 0, warnings: 0 } },
    { "no-useless-assignment": { errors: 1, warnings: 0 } },
    DATE,
    ESLINT,
  );
  assert.deepEqual(overrideLog, [
    {
      date: DATE,
      ruleId: "no-useless-assignment",
      reason: "planted for the demo",
      before: { errors: 0, warnings: 0 },
      after: { errors: 1, warnings: 0 },
    },
  ]);
  assert.deepEqual(unused, []);
});

test("eslint: the override log appends to the previous one", () => {
  const previous = [
    {
      date: "2026-09-01T00:00:00.000Z",
      ruleId: "no-explicit-any",
      reason: "earlier override",
      before: { errors: 100, warnings: 0 },
      after: { errors: 101, warnings: 0 },
    },
  ];
  const { overrideLog } = buildOverrideLog(
    previous,
    new Map([["no-useless-assignment", "new override"]]),
    { "no-useless-assignment": { errors: 0, warnings: 0 } },
    { "no-useless-assignment": { errors: 1, warnings: 0 } },
    DATE,
    ESLINT,
  );
  assert.equal(overrideLog.length, 2);
  assert.deepEqual(overrideLog[0], previous[0]);
  assert.equal(overrideLog[1].ruleId, "no-useless-assignment");
});

test("eslint: an override for a rule that did not rise is unused and not logged", () => {
  const { overrideLog, unused } = buildOverrideLog(
    undefined,
    new Map([["strict-boolean-expressions", "not actually needed"]]),
    { "strict-boolean-expressions": { errors: 10, warnings: 0 } },
    { "strict-boolean-expressions": { errors: 5, warnings: 0 } },
    DATE,
    ESLINT,
  );
  assert.deepEqual(overrideLog, []);
  assert.deepEqual(unused, ["strict-boolean-expressions"]);
});

test("parseAllowIncreaseArgs reads repeatable pairs and throws on a broken one", () => {
  const overrides = parseAllowIncreaseArgs(
    [
      "--allow-increase",
      "rule-a",
      "reason a",
      "--allow-increase",
      "rule-b",
      "reason b",
    ],
    ESLINT,
  );
  assert.equal(overrides.get("rule-a"), "reason a");
  assert.equal(overrides.get("rule-b"), "reason b");
  assert.throws(
    () => parseAllowIncreaseArgs(["--allow-increase", "rule-a"], ESLINT),
    /--allow-increase requires two arguments: <ruleId>/,
  );
  assert.throws(
    () =>
      parseAllowIncreaseArgs(["--allow-increase", "rule-a", "--dir"], ESLINT),
    /--allow-increase/,
  );
});

test("eslint: a regression is reported distinctly from a vanished rule", () => {
  const { regressions, vanished } = compareCounts(
    {
      "rule-up": { errors: 1, warnings: 0 },
      "rule-gone": { errors: 2, warnings: 0 },
    },
    { "rule-up": { errors: 2, warnings: 0 } },
    ESLINT,
  );
  assert.deepEqual(regressions, [
    { ruleId: "rule-up", type: "errors", baseline: 1, current: 2 },
  ]);
  assert.deepEqual(vanished, [{ ruleId: "rule-gone", errors: 2, warnings: 0 }]);
});

test("eslint: a decrease names the rule and the metric that dropped", () => {
  const findings = compareCounts(
    { "rule-down": { errors: 5, warnings: 0 } },
    { "rule-down": { errors: 2, warnings: 0 } },
    ESLINT,
  );
  assert.deepEqual(findings, {
    regressions: [],
    vanished: [],
    decreases: [
      { ruleId: "rule-down", type: "errors", baseline: 5, current: 2 },
    ],
  });
});

test("eslint: an equal count produces no finding at all", () => {
  assert.deepEqual(
    compareCounts(
      { "rule-steady": { errors: 3, warnings: 1 } },
      { "rule-steady": { errors: 3, warnings: 1 } },
      ESLINT,
    ),
    { regressions: [], vanished: [], decreases: [] },
  );
});

test("eslint: an increase still fails alongside an unrelated decrease", () => {
  const { regressions, decreases } = compareCounts(
    {
      "rule-up": { errors: 1, warnings: 0 },
      "rule-down": { errors: 5, warnings: 0 },
    },
    {
      "rule-up": { errors: 2, warnings: 0 },
      "rule-down": { errors: 2, warnings: 0 },
    },
    ESLINT,
  );
  assert.deepEqual(regressions, [
    { ruleId: "rule-up", type: "errors", baseline: 1, current: 2 },
  ]);
  assert.deepEqual(decreases, [
    { ruleId: "rule-down", type: "errors", baseline: 5, current: 2 },
  ]);
});

test("eslint: a rule gone entirely is vanished, never doubled as a decrease", () => {
  const { vanished, decreases } = compareCounts(
    { "rule-fixed": { errors: 3, warnings: 0 } },
    {},
    ESLINT,
  );
  assert.deepEqual(vanished, [
    { ruleId: "rule-fixed", errors: 3, warnings: 0 },
  ]);
  assert.deepEqual(decreases, []);
});

test("eslint: errors falling to 0 while warnings stay is a decrease, not vanished", () => {
  const { vanished, decreases } = compareCounts(
    { "rule-mixed": { errors: 3, warnings: 2 } },
    { "rule-mixed": { errors: 0, warnings: 2 } },
    ESLINT,
  );
  assert.deepEqual(vanished, []);
  assert.deepEqual(decreases, [
    { ruleId: "rule-mixed", type: "errors", baseline: 3, current: 0 },
  ]);
});

test("eslint: the __unknown__ bucket is decrease-checked like any rule", () => {
  assert.deepEqual(
    compareCounts(
      { __unknown__: { errors: 0, warnings: 5 } },
      { __unknown__: { errors: 0, warnings: 2 } },
      ESLINT,
    ).decreases,
    [{ ruleId: "__unknown__", type: "warnings", baseline: 5, current: 2 }],
  );
});

// ---------------------------------------------------------------------------------------------
// Ported from knip-ratchet.test.ts and the knip-ratchet.js --self-test cases
// ---------------------------------------------------------------------------------------------

test("knip: increases are refused per category, overrides clear only their own", () => {
  assert.deepEqual(
    findUnauthorizedIncreases(
      { exports: 10 },
      { exports: 12 },
      new Map(),
      KNIP,
    ),
    [{ category: "exports", before: 10, after: 12 }],
  );
  assert.deepEqual(
    findUnauthorizedIncreases({}, { files: 1 }, new Map(), KNIP),
    [{ category: "files", before: 0, after: 1 }],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      { exports: 10 },
      { exports: 12 },
      new Map([["exports", "reason"]]),
      KNIP,
    ),
    [],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      { exports: 10, types: 5 },
      { exports: 12, types: 5 },
      new Map([["types", "reason"]]),
      KNIP,
    ).map((i) => i.category),
    ["exports"],
  );
  assert.deepEqual(
    findUnauthorizedIncreases({ types: 678 }, { types: 670 }, new Map(), KNIP),
    [],
  );
  assert.deepEqual(
    findUnauthorizedIncreases({ retiring: 3 }, {}, new Map(), KNIP),
    [],
  );
});

test("knip: the override log records, appends and skips unused overrides", () => {
  const { overrideLog, unused } = buildOverrideLog(
    undefined,
    new Map([["files", "planted for the demo"]]),
    { files: 11 },
    { files: 12 },
    DATE,
    KNIP,
  );
  assert.deepEqual(overrideLog, [
    {
      date: DATE,
      category: "files",
      reason: "planted for the demo",
      before: 11,
      after: 12,
    },
  ]);
  assert.deepEqual(unused, []);

  const previous = [
    {
      date: "2026-09-01T00:00:00.000Z",
      category: "exports",
      reason: "earlier override",
      before: 480,
      after: 485,
    },
  ];
  const appended = buildOverrideLog(
    previous,
    new Map([["files", "new override"]]),
    { files: 11 },
    { files: 12 },
    DATE,
    KNIP,
  ).overrideLog;
  assert.equal(appended.length, 2);
  assert.deepEqual(appended[0], previous[0]);
  assert.equal(appended[1].category, "files");

  const skipped = buildOverrideLog(
    undefined,
    new Map([["types", "not actually needed"]]),
    { types: 678 },
    { types: 670 },
    DATE,
    KNIP,
  );
  assert.deepEqual(skipped, { overrideLog: [], unused: ["types"] });
});

test("knip: regression, vanished and decrease are three distinct findings", () => {
  assert.deepEqual(
    compareCounts(
      { exports: 10, types: 5, files: 2, duplicates: 1, retiring: 3 },
      { exports: 12, types: 5, files: 1, duplicates: 1 },
      KNIP,
    ),
    {
      regressions: [{ category: "exports", baseline: 10, current: 12 }],
      vanished: [{ category: "retiring", baseline: 3 }],
      decreases: [{ category: "files", baseline: 2, current: 1 }],
    },
  );
  assert.deepEqual(compareCounts({}, { brandNew: 4 }, KNIP).regressions, [
    { category: "brandNew", baseline: 0, current: 4 },
  ]);
  assert.deepEqual(compareCounts({ files: 3 }, {}, KNIP), {
    regressions: [],
    vanished: [{ category: "files", baseline: 3 }],
    decreases: [],
  });
});

test("knip: counts symbols not files, a duplicate group as one, and unnamed categories", () => {
  const counts = summarizeKnip([
    {
      file: "a.ts",
      exports: [{ name: "x" }, { name: "y" }],
      types: [],
      duplicates: [],
      files: [],
    },
    {
      file: "b.ts",
      exports: [{ name: "z" }],
      types: [{ name: "T" }],
      duplicates: [[{ name: "p" }, { name: "q" }]],
      files: [],
      owners: "not an array",
    },
    { file: "c.ts", files: [{ name: "c.ts" }], futureCategory: [{}] },
  ]);
  assert.deepEqual(counts, {
    exports: 3,
    types: 1,
    duplicates: 1,
    files: 1,
    futureCategory: 1,
  });
});

// ---------------------------------------------------------------------------------------------
// Ported from typecheck-tests-ratchet.test.ts
// ---------------------------------------------------------------------------------------------

test("tsc: increases are refused per file and overrides clear them", () => {
  const file = "tests/unit/example.test.ts";
  assert.deepEqual(
    findUnauthorizedIncreases({ [file]: 1 }, { [file]: 2 }, new Map(), TSC),
    [{ file, before: 1, after: 2 }],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      {},
      { "tests/unit/new-file.test.ts": 1 },
      new Map(),
      TSC,
    ),
    [{ file: "tests/unit/new-file.test.ts", before: 0, after: 1 }],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      { [file]: 1 },
      { [file]: 2 },
      new Map([[file, "reason"]]),
      TSC,
    ),
    [],
  );
  assert.deepEqual(
    findUnauthorizedIncreases({ [file]: 5 }, { [file]: 2 }, new Map(), TSC),
    [],
  );
  assert.deepEqual(
    findUnauthorizedIncreases(
      { "tests/unit/deleted.test.ts": 3 },
      {},
      new Map(),
      TSC,
    ),
    [],
  );
});

test("tsc: the override log records, appends and skips unused overrides", () => {
  const file = "tests/unit/example.test.ts";
  assert.deepEqual(
    buildOverrideLog(
      undefined,
      new Map([[file, "planted for the demo"]]),
      { [file]: 1 },
      { [file]: 2 },
      DATE,
      TSC,
    ),
    {
      overrideLog: [
        {
          date: DATE,
          file,
          reason: "planted for the demo",
          before: 1,
          after: 2,
        },
      ],
      unused: [],
    },
  );
  const previous = [
    {
      date: "2026-09-01T00:00:00.000Z",
      file: "tests/unit/other.test.ts",
      reason: "earlier override",
      before: 3,
      after: 4,
    },
  ];
  const { overrideLog } = buildOverrideLog(
    previous,
    new Map([[file, "new override"]]),
    { [file]: 1 },
    { [file]: 2 },
    DATE,
    TSC,
  );
  assert.equal(overrideLog.length, 2);
  assert.deepEqual(overrideLog[0], previous[0]);
  assert.deepEqual(
    buildOverrideLog(
      undefined,
      new Map([[file, "not actually needed"]]),
      { [file]: 5 },
      { [file]: 2 },
      DATE,
      TSC,
    ),
    { overrideLog: [], unused: [file] },
  );
});

test("tsc: compare reads files only, with regression, vanished and decrease apart", () => {
  assert.deepEqual(
    compareCounts(
      {
        "tests/unit/up.test.ts": 1,
        "tests/unit/gone.test.ts": 2,
        "tests/unit/down.test.ts": 5,
        "tests/unit/steady.test.ts": 3,
      },
      {
        "tests/unit/up.test.ts": 2,
        "tests/unit/down.test.ts": 2,
        "tests/unit/steady.test.ts": 3,
      },
      TSC,
    ),
    {
      regressions: [{ file: "tests/unit/up.test.ts", baseline: 1, current: 2 }],
      vanished: [{ file: "tests/unit/gone.test.ts", baseline: 2 }],
      decreases: [{ file: "tests/unit/down.test.ts", baseline: 5, current: 2 }],
    },
  );
});

test("tsc: per-file counts, codes for readers, scope filter, and the parse guards", () => {
  const output = [
    "tests/a.test.ts(1,2): error TS2322: Type 'string' is not assignable.",
    "  continuation line of the message above",
    "tests/a.test.ts(3,4): error TS2345: Argument mismatch.",
    "src/b.ts(5,6): error TS2322: Out of scope.",
  ].join("\n");
  assert.deepEqual(summarizeTsc(output, { exitCode: 2, scope: "tests/" }), {
    byFile: { "tests/a.test.ts": 2 },
    byCode: { TS2322: 1, TS2345: 1 },
  });
  assert.deepEqual(summarizeTsc(output, { exitCode: 2 }).byFile, {
    "tests/a.test.ts": 2,
    "src/b.ts": 1,
  });
  assert.deepEqual(
    summarizeTsc("src/b.ts(5,6): error TS2322: x", {
      exitCode: 2,
      scope: "tests/",
    }).byFile,
    {},
    "a diagnostic outside the scope is parsed, so it is not a parse failure",
  );
  assert.throws(
    () =>
      summarizeTsc("\u001b[96mtests/a.ts\u001b[0m:1:2 - error TS2322: x", {
        exitCode: 2,
      }),
    (error) => error.code === 2 && /ANSI/.test(error.message),
  );
  assert.throws(
    () => summarizeTsc("error TS5058: The specified path does not exist."),
    (error) => error.code === 2 && /configuration error/.test(error.message),
  );
  assert.throws(
    () => summarizeTsc("something tsc never prints", { exitCode: 2 }),
    (error) => error.code === 2 && /no line matched/.test(error.message),
  );
  assert.deepEqual(summarizeTsc("", { exitCode: 0 }).byFile, {});
});

test("eslint: severity 2 and 1 count apart and a missing rule id is __unknown__", () => {
  assert.deepEqual(
    summarizeEslint([
      {
        messages: [
          { ruleId: "no-x", severity: 2 },
          { ruleId: "no-x", severity: 1 },
          { ruleId: null, severity: 1 },
          { severity: 2, fatal: true },
        ],
      },
      { messages: [] },
    ]),
    {
      "no-x": { errors: 1, warnings: 1 },
      __unknown__: { errors: 1, warnings: 1 },
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

test("arguments: adapter, mode and flags are required to be known", () => {
  for (const [argv, pattern] of [
    [["nope", "check"], /unknown adapter "nope"/],
    [[], /unknown adapter ""/],
    [["eslint"], /unknown mode ""/],
    [["eslint", "verify"], /unknown mode "verify"/],
    [["knip", "check", "--target", "src"], /unknown option --target/],
    [["tsc", "check", "--scope"], /--scope requires a value/],
    [
      ["eslint", "check", "--allow-increase", "a", "b"],
      /applies to update-baseline only/,
    ],
  ]) {
    assert.throws(
      () => parseArguments(argv),
      (error) => error.code === 2 && pattern.test(error.message),
      argv.join(" "),
    );
  }
});

test("arguments: paths resolve from --root, not from the working directory", () => {
  const { adapter, mode, options } = parseArguments([
    "tsc",
    "update-baseline",
    "--root",
    "/repo",
    "--dir",
    "server",
    "--project",
    "tsconfig.test.json",
    "--scope",
    "tests/",
    "--baseline",
    ".typecheck-tests-ratchet-baseline.json",
    "--allow-increase",
    "tests/a.ts",
    "why",
    "--",
    "--extendedDiagnostics",
  ]);
  assert.equal(adapter.name, "tsc");
  assert.equal(mode, "update-baseline");
  assert.equal(options.cwd, path.resolve("/repo/server"));
  assert.equal(
    options.baselinePath,
    path.resolve("/repo/server/.typecheck-tests-ratchet-baseline.json"),
  );
  assert.equal(options.project, "tsconfig.test.json");
  assert.equal(options.scope, "tests/");
  assert.equal(options.overrides.get("tests/a.ts"), "why");
  assert.deepEqual(options.toolArgs, ["--extendedDiagnostics"]);
});

// ---------------------------------------------------------------------------------------------
// Whole runs with a stubbed spawn
// ---------------------------------------------------------------------------------------------

test("no baseline: check exits 0, names the opt-in and starts no tool", () => {
  const root = makeRoot({ bin: "knip" });
  const { spawn, calls } = stubSpawn({ stdout: knipStdout({ exports: 1 }) });
  const out = capture();
  assert.equal(
    runRatchet(["knip", "check", "--root", root], { spawn, io: out.io }),
    0,
  );
  assert.equal(calls.length, 0);
  assert.match(out.text(), /no baseline at \.knip-ratchet-baseline\.json/);
  assert.match(out.text(), /opt-in.*knip update-baseline --root/);
});

test("a baseline whose tool is not installed exits 1 naming npm ci", () => {
  const root = makeRoot({
    baseline: { schemaVersion: 1, byCategory: { exports: 1 } },
    baselineName: ".knip-ratchet-baseline.json",
  });
  const out = capture();
  const { spawn, calls } = stubSpawn({});
  assert.equal(
    runRatchet(["knip", "check", "--root", root], { spawn, io: out.io }),
    1,
  );
  assert.equal(calls.length, 0);
  assert.match(out.text(), /knip is not installed/);
  assert.match(out.text(), /npm ci/);
});

test("a spawn ENOENT is the same named refusal", () => {
  const root = makeRoot({
    bin: "knip",
    baseline: { schemaVersion: 1, byCategory: { exports: 1 } },
    baselineName: ".knip-ratchet-baseline.json",
  });
  const out = capture();
  const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  const { spawn } = stubSpawn({ error, status: null });
  assert.equal(
    runRatchet(["knip", "check", "--root", root], { spawn, io: out.io }),
    1,
  );
  assert.match(out.text(), /npm ci/);
});

test("a tool crash exits 2 quoting the first lines of stderr", () => {
  const root = makeRoot({
    bin: "eslint",
    baseline: { schemaVersion: 1, eslintTarget: ".", byRule: {} },
    baselineName: ".eslint-ratchet-baseline.json",
  });
  const out = capture();
  const { spawn } = stubSpawn({
    status: 2,
    stderr: "Oops! Something went wrong!\nESLint couldn't find a config.\n",
  });
  assert.equal(
    runRatchet(["eslint", "check", "--root", root], { spawn, io: out.io }),
    2,
  );
  assert.match(out.text(), /eslint failed to run \(exit code 2\)/);
  assert.match(out.text(), /Oops! Something went wrong!/);
});

test("tsc exit 2 with diagnostics is a measurement; exit 3 is a crash", () => {
  const baselineName = ".tsc-ratchet-baseline.json";
  const root = makeRoot({
    bin: "tsc",
    baseline: {
      schemaVersion: 1,
      project: "tsconfig.json",
      byFile: { "a.ts": 1 },
    },
    baselineName,
  });
  const out = capture();
  const ok = stubSpawn({ status: 2, stdout: "a.ts(1,1): error TS2322: x\n" });
  assert.equal(
    runRatchet(["tsc", "check", "--root", root], {
      spawn: ok.spawn,
      io: out.io,
    }),
    0,
    out.text(),
  );
  assert.match(out.text(), /OK: 1 errors in tsconfig\.json/);
  assert.deepEqual(ok.calls[0].args, [
    "--noEmit",
    "--pretty",
    "false",
    "--project",
    "tsconfig.json",
  ]);
  assert.equal(ok.calls[0].options.env.FORCE_COLOR, undefined);
  const crash = stubSpawn({ status: 3, stdout: "" });
  assert.equal(
    runRatchet(["tsc", "check", "--root", root], {
      spawn: crash.spawn,
      io: capture().io,
    }),
    2,
  );
});

test("unparseable knip output exits 2 rather than reading as clean", () => {
  const root = makeRoot({
    bin: "knip",
    baseline: { schemaVersion: 1, byCategory: { exports: 1 } },
    baselineName: ".knip-ratchet-baseline.json",
  });
  for (const stdout of ["not json", JSON.stringify({ files: [] })]) {
    const out = capture();
    assert.equal(
      runRatchet(["knip", "check", "--root", root], {
        spawn: stubSpawn({ stdout }).spawn,
        io: out.io,
      }),
      2,
    );
    assert.match(out.text(), /Refusing to read that as a result/);
  }
});

test("check fails on a regression, a vanished key and a decrease, and passes when equal", () => {
  const baselineName = ".knip-ratchet-baseline.json";
  const baseline = {
    schemaVersion: 1,
    byCategory: { exports: 10, files: 2, retiring: 3, types: 5 },
  };
  const root = makeRoot({ bin: "knip", baseline, baselineName });
  const run = (byCategory) => {
    const out = capture();
    const code = runRatchet(["knip", "check", "--root", root], {
      spawn: stubSpawn({ stdout: knipStdout(byCategory) }).spawn,
      io: out.io,
    });
    return { code, text: out.text() };
  };
  const equal = run({ exports: 10, files: 2, retiring: 3, types: 5 });
  assert.equal(equal.code, 0, equal.text);
  assert.match(equal.text, /OK: 20 findings \(no regressions\)/);

  const moved = run({ exports: 12, files: 1, types: 5 });
  assert.equal(moved.code, 1);
  assert.match(moved.text, /FAIL: 3 category problem/);
  assert.match(moved.text, /- exports: baseline=10 current=12 \(\+2\)/);
  assert.match(moved.text, /- retiring: baseline=3 -> absent/);
  assert.match(moved.text, /- files: baseline=2 current=1 \(-1\)/);
  assert.match(moved.text, /knip update-baseline --root/);

  assert.equal(run({ exports: 10, files: 1, retiring: 3, types: 5 }).code, 1);
  assert.equal(run({ exports: 10, files: 2, types: 5 }).code, 1);
});

test("update-baseline refuses an unnamed increase and records a named one", () => {
  const baselineName = ".eslint-ratchet-baseline.json";
  const root = makeRoot({
    bin: "eslint",
    toolVersion: "10.12.0",
    baseline: {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      eslintTarget: "src",
      totals: { errors: 1, warnings: 0 },
      byRule: { "z-rule": { errors: 1, warnings: 0 } },
    },
    baselineName,
  });
  const results = [
    {
      messages: [
        { ruleId: "z-rule", severity: 2 },
        { ruleId: "z-rule", severity: 2 },
        { ruleId: "a-rule", severity: 1 },
        { ruleId: null, severity: 1 },
      ],
    },
  ];
  const refused = capture();
  const before = fs.readFileSync(path.join(root, baselineName), "utf8");
  assert.equal(
    runRatchet(
      ["eslint", "update-baseline", "--root", root, "--target", "src"],
      { spawn: eslintSpawn(results).spawn, io: refused.io },
    ),
    1,
  );
  assert.match(refused.text(), /Refusing to update baseline: 3 rules/);
  assert.match(
    refused.text(),
    /- z-rule: 1 errors, 0 warnings -> 2 errors, 0 warnings/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, baselineName), "utf8"),
    before,
    "a refused update writes nothing",
  );

  const accepted = capture();
  const { spawn, calls } = eslintSpawn(results);
  assert.equal(
    runRatchet(
      [
        "eslint",
        "update-baseline",
        "--root",
        root,
        "--target",
        "src",
        "--allow-increase",
        "z-rule",
        "one more on purpose",
        "--allow-increase",
        "a-rule",
        "new rule",
        "--allow-increase",
        "__unknown__",
        "directive",
        "--allow-increase",
        "never-rose",
        "unused",
      ],
      { spawn, io: accepted.io, now: () => new Date(DATE) },
    ),
    0,
    accepted.text(),
  );
  assert.deepEqual(calls[0].args.slice(0, 3), ["src", "--format", "json"]);
  assert.match(
    accepted.text(),
    /never-rose was passed but never-rose did not increase/,
  );
  const written = fs.readFileSync(path.join(root, baselineName), "utf8");
  const parsed = JSON.parse(written);
  assert.deepEqual(Object.keys(parsed), [
    "schemaVersion",
    "generatedAt",
    "adapter",
    "toolVersion",
    "params",
    "eslintTarget",
    "totals",
    "byRule",
    "overrideLog",
  ]);
  assert.equal(parsed.adapter, "eslint");
  assert.equal(parsed.toolVersion, "10.12.0");
  assert.match(parsed.params, /^sha256:[0-9a-f]{16}$/);
  assert.equal(parsed.generatedAt, DATE);
  assert.deepEqual(Object.keys(parsed.byRule), [
    "__unknown__",
    "a-rule",
    "z-rule",
  ]);
  assert.deepEqual(parsed.totals, { errors: 2, warnings: 2 });
  assert.deepEqual(
    parsed.overrideLog.map((entry) => [entry.ruleId, entry.reason]),
    [
      ["z-rule", "one more on purpose"],
      ["a-rule", "new rule"],
      ["__unknown__", "directive"],
    ],
  );
  assert.ok(written.endsWith("}\n"));
});

test("check refuses a baseline recorded under different arguments", () => {
  const baselineName = ".eslint-ratchet-baseline.json";
  const legacy = makeRoot({
    bin: "eslint",
    baseline: {
      schemaVersion: 1,
      eslintTarget: "src,scripts",
      byRule: {},
    },
    baselineName,
  });
  const target = capture();
  const { spawn, calls } = eslintSpawn([]);
  assert.equal(
    runRatchet(["eslint", "check", "--root", legacy, "--target", "src"], {
      spawn,
      io: target.io,
    }),
    1,
  );
  assert.equal(
    calls.length,
    0,
    "the target mismatch is caught before spawning",
  );
  assert.match(
    target.text(),
    /eslintTarget: baseline "src,scripts", this run "src"/,
  );

  const root = makeRoot({ bin: "knip" });
  const knipBaseline = path.join(root, ".knip-ratchet-baseline.json");
  const stdout = knipStdout({ exports: 1 });
  assert.equal(
    runRatchet(["knip", "update-baseline", "--root", root], {
      spawn: stubSpawn({ stdout }).spawn,
      io: capture().io,
    }),
    0,
  );
  const params = capture();
  assert.equal(
    runRatchet(["knip", "check", "--root", root, "--", "--production"], {
      spawn: stubSpawn({ stdout }).spawn,
      io: params.io,
    }),
    1,
  );
  assert.match(
    params.text(),
    /params: baseline sha256:\w+, this run sha256:\w+/,
  );
  assert.match(params.text(), /--production/);
  assert.equal(
    runRatchet(["knip", "check", "--root", root], {
      spawn: stubSpawn({ stdout }).spawn,
      io: capture().io,
    }),
    0,
    `the same arguments compare (${fs.readFileSync(knipBaseline, "utf8")})`,
  );
});

test("a different tool version warns and never fails", () => {
  const root = makeRoot({
    bin: "knip",
    toolVersion: "6.40.0",
    baseline: {
      schemaVersion: 1,
      toolVersion: "6.32.2",
      byCategory: { exports: 1 },
    },
    baselineName: ".knip-ratchet-baseline.json",
  });
  const out = capture();
  assert.equal(
    runRatchet(["knip", "check", "--root", root], {
      spawn: stubSpawn({ stdout: knipStdout({ exports: 1 }) }).spawn,
      io: out.io,
    }),
    0,
  );
  assert.match(
    out.text(),
    /recorded with knip 6\.32\.2, this run uses 6\.40\.0/,
  );
});

test("an unknown knip category is counted and named", () => {
  const root = makeRoot({
    bin: "knip",
    baseline: { schemaVersion: 1, byCategory: { exports: 1, newKind: 2 } },
    baselineName: ".knip-ratchet-baseline.json",
  });
  const out = capture();
  assert.equal(
    runRatchet(["knip", "check", "--root", root], {
      spawn: stubSpawn({ stdout: knipStdout({ exports: 1, newKind: 2 }) })
        .spawn,
      io: out.io,
    }),
    0,
  );
  assert.match(out.text(), /does not know \(newKind\); counted like any other/);
});

test("an unreadable or foreign baseline exits 2, never reads as the opt-out", () => {
  const name = ".knip-ratchet-baseline.json";
  for (const [baseline, pattern] of [
    ["{ not json", /did not parse as JSON/],
    [{ schemaVersion: 2, byCategory: {} }, /schemaVersion 2/],
    [{ adapter: "eslint", byRule: {} }, /recorded by the "eslint" adapter/],
    [{ schemaVersion: 1 }, /no "byCategory" object/],
  ]) {
    const root = makeRoot({ bin: "knip", baseline, baselineName: name });
    const out = capture();
    const { spawn, calls } = stubSpawn({ stdout: knipStdout({}) });
    assert.equal(
      runRatchet(["knip", "check", "--root", root], { spawn, io: out.io }),
      2,
    );
    assert.equal(calls.length, 0);
    assert.match(out.text(), pattern);
  }
});

test("--dir runs the tool there and finds a binary hoisted to the root", () => {
  const root = makeRoot({ bin: "tsc", dir: "." });
  fs.mkdirSync(path.join(root, "server"));
  const { spawn, calls } = stubSpawn({ status: 0, stdout: "" });
  assert.equal(
    runRatchet(
      [
        "tsc",
        "update-baseline",
        "--root",
        root,
        "--dir",
        "server",
        "--scope",
        "tests/",
      ],
      { spawn, io: capture().io, now: () => new Date(DATE) },
    ),
    0,
  );
  assert.equal(calls[0].options.cwd, path.join(root, "server"));
  assert.equal(calls[0].bin, path.join(root, "node_modules", ".bin", "tsc"));
  const written = readBaseline(
    path.join(root, "server"),
    ".tsc-ratchet-baseline.json",
  );
  assert.equal(written.project, "tsconfig.json");
  assert.equal(written.scope, "tests/");
  assert.equal(
    runRatchet(["tsc", "check", "--root", root, "--dir", "missing"], {
      io: capture().io,
    }),
    2,
  );
});

// ---------------------------------------------------------------------------------------------
// Baseline compatibility with the three per-tool scripts' files
// ---------------------------------------------------------------------------------------------

const LEGACY = {
  tsc: {
    schemaVersion: 1,
    generatedAt: "2026-10-14T03:41:54.575Z",
    project: "tsconfig.test.json",
    scope: "tests/",
    totals: { errors: 3 },
    byCode: { TS2322: 2, TS2345: 1 },
    byFile: { "tests/e2e/a.test.ts": 2, "tests/unit/b.test.ts": 1 },
  },
  knip: {
    schemaVersion: 1,
    generatedAt: "2026-10-19T20:45:57.603Z",
    totals: { findings: 9 },
    byCategory: { binaries: 1, exports: 4, types: 4 },
    overrideLog: [
      {
        date: "2026-09-18T02:45:58.843Z",
        category: "exports",
        reason: "merge of two branches",
        before: 3,
        after: 4,
      },
    ],
  },
  eslint: {
    schemaVersion: 1,
    generatedAt: "2026-10-19T20:45:21.856Z",
    eslintTarget: "src,scripts,eslint-rules",
    totals: { errors: 3, warnings: 1 },
    byRule: {
      "sonarjs/cognitive-complexity": { errors: 0, warnings: 1 },
      "@typescript-eslint/strict-boolean-expressions": {
        errors: 3,
        warnings: 0,
      },
    },
  },
};

function stripNewFields(baseline) {
  const { adapter, params, toolVersion, ...rest } = baseline;
  assert.equal(typeof adapter, "string");
  assert.equal(typeof params, "string");
  assert.equal(toolVersion, undefined);
  return rest;
}

test("a per-tool baseline loads unchanged and re-renders to the same bytes", () => {
  for (const [name, legacy] of Object.entries(LEGACY)) {
    const adapter = ADAPTERS[name];
    const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
    const root = makeRoot({ baseline: bytes, baselineName: "b.json" });
    const loaded = loadBaseline(path.join(root, "b.json"), adapter);
    assert.equal(`${JSON.stringify(loaded, null, 2)}\n`, bytes, name);

    const rendered = stripNewFields(
      renderBaseline(adapter, {
        generatedAt: legacy.generatedAt,
        summary: { counts: legacy[adapter.mapField], byCode: legacy.byCode },
        identity: Object.fromEntries(
          adapter.identityFields
            .filter((field) => field in legacy)
            .map((field) => [field, legacy[field]]),
        ),
        params: "sha256:0000000000000000",
        overrideLog: legacy.overrideLog,
      }),
    );
    const expected =
      name === "eslint"
        ? {
            ...legacy,
            byRule: Object.fromEntries(Object.entries(legacy.byRule).sort()),
          }
        : legacy;
    assert.equal(
      `${JSON.stringify(rendered, null, 2)}\n`,
      `${JSON.stringify(expected, null, 2)}\n`,
      `${name}: only eslint's unsorted rule keys move, once`,
    );
  }
});

test("a per-tool baseline is checked as-is, with no new field required", () => {
  const root = makeRoot({
    bin: "tsc",
    baseline: LEGACY.tsc,
    baselineName: ".typecheck-tests-ratchet-baseline.json",
  });
  const out = capture();
  const stdout = [
    "tests/e2e/a.test.ts(1,1): error TS2322: x",
    "tests/e2e/a.test.ts(2,1): error TS2322: x",
    "tests/unit/b.test.ts(1,1): error TS2345: y",
    "src/c.ts(1,1): error TS2322: out of scope",
  ].join("\n");
  assert.equal(
    runRatchet(
      [
        "tsc",
        "check",
        "--root",
        root,
        "--project",
        "tsconfig.test.json",
        "--scope",
        "tests/",
        "--baseline",
        ".typecheck-tests-ratchet-baseline.json",
      ],
      { spawn: stubSpawn({ status: 2, stdout }).spawn, io: out.io },
    ),
    0,
    out.text(),
  );
  assert.match(
    out.text(),
    /\[tsc-ratchet\] OK: 3 errors in tests\/ \(no regressions\)/,
  );
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function cli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("--self-test passes and proves each refusal path", () => {
  const result = cli("--self-test");
  assert.equal(result.status, 0, result.output);
  for (const name of [
    "a regression fails",
    "a decrease fails",
    "a vanished category fails",
    "an increase without an override is refused",
    "an increase with an override is recorded",
    "an unknown adapter is a usage error",
  ]) {
    assert.match(result.output, new RegExp(`✔ self-test: ${name}`));
  }
});

test("bad usage exits 2 with the usage text", () => {
  for (const args of [[], ["nope", "check"], ["--self-test", "extra"]]) {
    const result = cli(...args);
    assert.equal(result.status, 2, result.output);
    assert.match(result.output, /Usage: ratchet\.mjs/);
  }
});
