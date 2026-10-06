// The fleet ESLint preset. `base` needs no type information and applies to every file the
// consumer's config already lints. The type-aware layer lives in `./typed.mjs`, a separate entry
// point, so a JavaScript-only consumer never has to install typescript-eslint. Thresholds are
// the standards' numbers; their reasons are in `provenance`, which the README table and the
// tests both read against.

import sonarjs from "eslint-plugin-sonarjs";

import noLogAndSwallow from "./rules/no-log-and-swallow.mjs";
import noScatteredLogging from "./rules/no-scattered-logging.mjs";
import noVagueSuffix from "./rules/no-vague-suffix.mjs";

export const plugin = {
  meta: { name: "@minipuft/eslint-plugin-fleet" },
  rules: {
    "no-log-and-swallow": noLogAndSwallow,
    "no-scattered-logging": noScatteredLogging,
    "no-vague-suffix": noVagueSuffix,
  },
};

// One entry per rule the preset sets: the standard it enforces, the config-repository file the
// standard lives in, and the one-line reason for its threshold or severity.
export const provenance = {
  "sonarjs/cognitive-complexity": {
    standard: "Complexity limits",
    source: "refactoring.md",
    rationale:
      "15 per function; cognitive complexity weights nesting, which is what costs a reader",
  },
  complexity: {
    standard: "Complexity limits",
    source: "refactoring.md",
    rationale:
      "off on purpose: cyclomatic counts every `??` and `?.` as a branch and blocks idiomatic code",
  },
  "max-depth": {
    standard: "Complexity limits",
    source: "refactoring.md",
    rationale:
      "nesting is what cognitive complexity charges for; 4 is the ceiling",
  },
  "max-params": {
    standard: "Complexity limits",
    source: "refactoring.md",
    rationale:
      "6, not 4: a constructor taking five injected services is dependency injection, not a defect",
  },
  "max-lines": {
    standard: "Size guidance",
    source: "refactoring.md",
    rationale:
      "1000 as a warning only: size is a diagnostic that asks how many responsibilities a file holds",
  },
  "no-empty": {
    standard: "Handle errors explicitly",
    source: "CLAUDE.md",
    rationale: "an empty catch discards the failure; `allowEmptyCatch` is off",
  },
  "fleet/no-log-and-swallow": {
    standard: "Error and state boundaries",
    source: "architecture.md",
    rationale:
      "a catch that only logs reports success to its caller; rethrow or return the failure",
  },
  "fleet/no-scattered-logging": {
    standard: "Wide-event logging",
    source: "wide-event-telemetry skill",
    rationale:
      "one wide event per unit of work; a console line is the scattered form (warning, per-file opt-out)",
  },
  "fleet/no-vague-suffix": {
    standard: "Naming standards",
    source: "CLAUDE.md",
    rationale:
      "Manager, Handler, Helper, Utils and a domain-less Service name a category, not a behavior",
  },
  "@typescript-eslint/no-floating-promises": {
    standard: "Error and state boundaries",
    source: "architecture.md",
    rationale:
      "an unawaited promise reports success before persistence has returned",
  },
  "@typescript-eslint/naming-convention": {
    standard: "Naming standards",
    source: "CLAUDE.md",
    rationale:
      "no type decoration: `IUser`, `EStatus` and `strName` repeat what the type already says",
  },
};

export const base = [
  {
    name: "fleet/base",
    plugins: { fleet: plugin, sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["error", 15],
      complexity: "off",
      "max-depth": ["error", 4],
      "max-params": ["error", 6],
      "max-lines": [
        "warn",
        { max: 1000, skipBlankLines: true, skipComments: true },
      ],
      "no-empty": ["error", { allowEmptyCatch: false }],
      "fleet/no-log-and-swallow": "warn",
      "fleet/no-scattered-logging": "warn",
      "fleet/no-vague-suffix": "warn",
    },
  },
];

export default { plugin, base, provenance };
