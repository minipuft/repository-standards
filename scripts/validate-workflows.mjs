import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const files = [
  ".github/workflows/ci.yml",
  ".github/workflows/consumer-contract.yml",
  ".github/workflows/fleet-drift-audit.yml",
  "actions/verify-consumer/action.yml",
];
const violations = [];
const externalUse = /^([^./][^@\s]*)@([^\s#]+)$/;

for (const file of files) {
  const source = readFileSync(resolve(file), "utf8");
  try {
    parse(source);
  } catch (error) {
    violations.push(`${file} is not valid YAML: ${error.message}`);
  }
  for (const [index, line] of source.split("\n").entries()) {
    const value = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/)?.[1];
    if (!value || value.startsWith("./")) continue;
    const match = value.match(externalUse);
    if (!match || !/^[0-9a-f]{40}$/.test(match[2])) {
      violations.push(
        `${file}:${index + 1} external action is not pinned to a commit SHA`,
      );
    }
  }
}

if (violations.length) {
  for (const violation of violations) console.error(`WORKFLOW: ${violation}`);
  process.exitCode = 1;
} else {
  console.log("PASSED: workflow YAML and immutable Action pins");
}
