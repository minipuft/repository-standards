import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint, RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { base, plugin, provenance } from "../eslint/index.mjs";
import { typed } from "../eslint/typed.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(ROOT, "test", "fixtures", "eslint-preset");

const typescriptTester = new RuleTester({
  languageOptions: { parser: tseslint.parser },
});

describe("fleet/no-vague-suffix", () => {
  typescriptTester.run("no-vague-suffix", plugin.rules["no-vague-suffix"], {
    valid: [
      "class UserService {}",
      "class OrderPricingService {}",
      "class AuthRequestHandler {}",
      "class SessionStore {}",
      "interface PaletteGenerator {}",
      "function formatHelper() {}", // not exported: a local name is the author's business
      "export const handler = async () => {};", // a platform-required entry point name
      "export const retryLimit = 3;",
    ],
    invalid: [
      ["class SessionManager {}", "Manager"],
      ["interface PromptResourceHandler {}", "Handler"],
      ["class Handler {}", "Handler"],
      ["type StringUtils = {};", "Utils"],
      ["class DateUtil {}", "Util"],
      ["class Service {}", "Service"],
      ["class DataService {}", "Service"],
      ["class BaseService {}", "Service"],
      ["export function formatHelper() {}", "Helper"],
      ["export default function formatHelper() {}", "Helper"],
      ["export const pathUtils = () => {};", "Utils"],
      ["const Wrapper = class CacheManager {};", "Manager"],
    ].map(([code, suffix]) => ({
      code,
      errors: [{ message: new RegExp(`ends in '${suffix}'\\.`) }],
    })),
  });

  it("asks the diagnostic question the naming table pairs with the suffix", () => {
    const messages = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          plugins: { fleet: plugin },
          rules: { "fleet/no-vague-suffix": "warn" },
        },
      ],
    });
    return messages
      .lintText("class SessionManager {}", { filePath: "x.js" })
      .then(([result]) => {
        assert.equal(result.messages.length, 1);
        assert.match(
          result.messages[0].message,
          /What does managing mean here\?/,
        );
      });
  });
});

describe("fleet/no-scattered-logging", () => {
  typescriptTester.run(
    "no-scattered-logging",
    plugin.rules["no-scattered-logging"],
    {
      valid: [
        "logger.emit({ outcome: 'ok' });",
        "const console = { log() {} }; console.log('shadowed');",
        { code: "console.error('x');", options: [{ allow: ["error"] }] },
      ],
      invalid: [
        "console.log('step');",
        "console.error(new Error('x'));",
        "console['info']('x');",
      ].map((code) => ({ code, errors: [{ messageId: "scatteredLog" }] })),
    },
  );
});

describe("fleet/no-log-and-swallow", () => {
  typescriptTester.run(
    "no-log-and-swallow",
    plugin.rules["no-log-and-swallow"],
    {
      valid: [
        "try { a(); } catch (e) { logger.error(e); throw e; }",
        "try { a(); } catch (e) { logger.error(e); return null; }",
        "try { a(); } catch (e) { failed = true; }",
        "try { a(); } catch {}", // empty: no-empty owns it
        "try { a(); } catch (e) { metrics.error(e); }", // not a logger receiver
      ],
      invalid: [
        "try { a(); } catch (e) { console.error(e); }",
        "try { a(); } catch (e) { logger.warn('failed'); logger.error(e); }",
        "try { a(); } catch (e) { this.logger.error(e); }",
        "async function f() { try { await a(); } catch (e) { await log.error(e); } }",
        "try { a(); } catch (e) { logger?.error(e); }",
      ].map((code) => ({ code, errors: [{ messageId: "logAndSwallow" }] })),
    },
  );
});

// Every rule the preset sets, linted through the preset itself: once on code that must be
// reported and once on code that must not. The rule must appear exactly once on the first and
// never on the second, so a threshold moved by one in either direction fails here.
const longFile = (lines) =>
  Array.from(
    { length: lines },
    (_, index) => `export const v${index} = ${index};`,
  ).join("\n");
const nested = (depth) =>
  `export function f(a: number): number {\n${"if (a) {\n".repeat(depth)}return a;\n${"}\n".repeat(depth)}return 0;\n}`;
const params = (count) =>
  `export function f(${Array.from({ length: count }, (_, i) => `p${i}: number`).join(", ")}): number { return p0; }`;
const conditions = (count) =>
  `export function f(a: number): number {\n${Array.from({ length: count }, (_, i) => `if (a === ${i}) { return ${i}; }`).join("\n")}\nreturn 0;\n}`;

const PER_RULE = {
  "sonarjs/cognitive-complexity": {
    flags: conditions(16),
    passes: conditions(15),
  },
  "max-depth": { flags: nested(5), passes: nested(4) },
  "max-params": { flags: params(7), passes: params(6) },
  "max-lines": { flags: longFile(1001), passes: longFile(1000) },
  "no-empty": {
    flags: "try { a(); } catch {}",
    passes: "try { a(); } catch { b(); }",
  },
  "fleet/no-log-and-swallow": {
    flags: "try { a(); } catch (e) { logger.error(e); }",
    passes: "try { a(); } catch (e) { logger.error(e); throw e; }",
  },
  "fleet/no-scattered-logging": {
    flags: "console.log('x');",
    passes:
      "/* eslint-disable fleet/no-scattered-logging -- CLI output */\nconsole.log('x');",
  },
  "fleet/no-vague-suffix": {
    flags: "export class SessionManager {}",
    passes: "export class SessionStore {}",
  },
  "@typescript-eslint/no-floating-promises": {
    flags: "async function save() {}\nsave();",
    passes: "async function save() {}\nawait save();",
  },
  "@typescript-eslint/naming-convention": {
    flags: "export interface IUser { name: string }",
    passes: "export interface User { name: string }",
  },
};

// `complexity` is set to off: there is nothing to report, and the case is that it stays silent
// on code a cyclomatic gate of 10 would block.
const SILENT = {
  complexity: conditions(15),
};

function presetLinter() {
  return new ESLint({
    cwd: FIXTURE,
    overrideConfigFile: true,
    overrideConfig: [
      ...base,
      ...typed,
      {
        files: ["**/*.ts"],
        languageOptions: {
          parserOptions: {
            projectService: {
              allowDefaultProject: ["virtual-*.ts"],
              // One virtual file per case; the cap guards editor performance, not correctness.
              maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 100,
            },
            tsconfigRootDir: FIXTURE,
          },
        },
      },
    ],
  });
}

function presetRules() {
  return Object.keys(
    Object.assign({}, ...[...base, ...typed].map((config) => config.rules)),
  ).sort();
}

describe("fleet preset, rule by rule", () => {
  const eslint = presetLinter();
  let sequence = 0;
  const lint = async (code) => {
    sequence += 1;
    const filePath = path.join(FIXTURE, `virtual-${sequence}.ts`);
    const [result] = await eslint.lintText(code, { filePath });
    const fatal = result.messages.filter((message) => message.fatal);
    assert.deepEqual(fatal, [], "the fixture must parse");
    return result.messages;
  };

  for (const [rule, { flags, passes }] of Object.entries(PER_RULE)) {
    it(`${rule} reports the positive fixture once and the negative never`, async () => {
      const flagged = (await lint(flags)).filter((m) => m.ruleId === rule);
      assert.equal(flagged.length, 1, JSON.stringify(flagged));
      const passed = await lint(passes);
      assert.deepEqual(
        passed.filter((m) => m.ruleId === rule || m.ruleId === null),
        [],
      );
    });
  }

  for (const [rule, code] of Object.entries(SILENT)) {
    it(`${rule} stays off`, async () => {
      const messages = await lint(code);
      assert.deepEqual(
        messages.filter((m) => m.ruleId === rule),
        [],
      );
    });
  }

  it("covers every rule the preset sets, and nothing it does not", () => {
    assert.deepEqual(
      [...Object.keys(PER_RULE), ...Object.keys(SILENT)].sort(),
      presetRules(),
    );
  });
});

describe("fleet preset provenance", () => {
  it("names a standard, a source and a rationale for exactly the rules the preset sets", () => {
    assert.deepEqual(Object.keys(provenance).sort(), presetRules());
    for (const [rule, entry] of Object.entries(provenance)) {
      for (const field of ["standard", "source", "rationale"]) {
        assert.ok(entry[field], `${rule} has no ${field}`);
      }
    }
  });

  it("gives every custom rule a description naming its standard and source", () => {
    for (const [name, rule] of Object.entries(plugin.rules)) {
      const entry = provenance[`fleet/${name}`];
      assert.ok(entry, `fleet/${name} has no provenance entry`);
      const description = rule.meta.docs.description;
      assert.ok(description.startsWith(entry.standard), description);
      assert.ok(description.includes(entry.source.split(" ")[0]), description);
    }
  });

  it("is documented in the README threshold table", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    for (const rule of presetRules()) {
      const row = new RegExp(
        `^\\| \`${rule.replace(/[/@-]/g, "\\$&")}\` +\\|`,
        "m",
      );
      assert.match(
        readme,
        row,
        `README threshold table has no row for ${rule}`,
      );
    }
  });
});

// The consumer path end to end: a directory that installs this package, imports the preset by
// its package name, and runs the eslint CLI. The planted markers in the fixture are the
// expectation, so the run must report exactly them and nothing else.
describe("fleet preset through the eslint CLI", () => {
  function plantedFindings() {
    const expected = [];
    for (const file of ["planted.ts", "clean.ts", "cli.ts"]) {
      const lines = fs
        .readFileSync(path.join(FIXTURE, file), "utf8")
        .split("\n");
      let pending = [];
      lines.forEach((line, index) => {
        const marker = line.match(/^\s*\/\/ planted: (\S+)$/);
        if (marker) {
          pending.push(marker[1]);
          return;
        }
        for (const rule of pending)
          expected.push(`${file}:${index + 1}:${rule}`);
        pending = [];
      });
    }
    return expected.sort();
  }

  function consumer(t) {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "fleet-eslint-consumer-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const scope = path.join(dir, "node_modules", "@minipuft");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(
      ROOT,
      path.join(scope, "repository-standards-validation"),
      "dir",
    );
    for (const file of ["planted.ts", "clean.ts", "cli.ts", "tsconfig.json"]) {
      fs.copyFileSync(path.join(FIXTURE, file), path.join(dir, file));
    }
    fs.writeFileSync(
      path.join(dir, "eslint.config.mjs"),
      [
        'import { base } from "@minipuft/repository-standards-validation/eslint";',
        'import { typed } from "@minipuft/repository-standards-validation/eslint/typed";',
        "export default [",
        '  { files: ["**/*.ts"] },',
        "  ...base,",
        "  ...typed,",
        '  { files: ["**/*.ts"], languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },',
        "];",
        "",
      ].join("\n"),
    );
    return dir;
  }

  it("reports exactly the planted findings", (t) => {
    const dir = consumer(t);
    const run = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", "eslint", "bin", "eslint.js"),
        "--format",
        "json",
        ".",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.ok(run.stdout, run.stderr);
    const actual = JSON.parse(run.stdout)
      .flatMap((result) =>
        result.messages.map(
          (m) => `${path.basename(result.filePath)}:${m.line}:${m.ruleId}`,
        ),
      )
      .sort();
    const expected = plantedFindings();
    assert.ok(expected.length >= 10, "the fixture lost its markers");
    assert.deepEqual(actual, expected);
    assert.equal(run.status, 1, "an error-severity finding must fail the run");
  });
});
