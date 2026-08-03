#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { validateConsumerContract } from "../../lib/consumer-contract-validator.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value)
      throw new Error(`invalid argument: ${flag ?? "missing"}`);
    options[flag.slice(2)] = value;
  }
  for (const required of ["workspace", "contract", "profile"]) {
    if (!options[required]) throw new Error(`missing --${required}`);
  }
  return options;
}

function installConsumer(workspace, profile) {
  if (profile === "marketplace") return;
  const result = spawnSync("npm", ["ci", "--ignore-scripts"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm ci failed with exit code ${result.status}`);
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const workspace = resolve(options.workspace);
  installConsumer(workspace, options.profile);
  const violations = validateConsumerContract({
    workspace,
    contractPath: options.contract,
    selectedProfile: options.profile,
  });
  if (violations.length) {
    for (const violation of violations) console.error(`CONTRACT: ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASSED: ${options.profile} consumer contract`);
}

try {
  main();
} catch (error) {
  console.error(`CONTRACT: ${error.message}`);
  process.exitCode = 1;
}
