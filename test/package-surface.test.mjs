import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const packageJson = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
);

function packedFiles() {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: PACKAGE_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  return new Set(pack.files.map((file) => file.path));
}

test("the tarball carries every bin target", () => {
  const packed = packedFiles();
  for (const [name, target] of Object.entries(packageJson.bin)) {
    assert.ok(
      packed.has(path.posix.normalize(target)),
      `bin ${name} -> ${target} is not in the tarball`,
    );
  }
});

test("the tarball carries what delivery-contract reads at runtime", () => {
  const packed = packedFiles();
  const manifestPath = "templates/delivery-contract/manifest.json";
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, manifestPath), "utf8"),
  );
  const required = [
    "contracts/delivery-contract.schema.json",
    manifestPath,
    ...manifest.files.map(
      (entry) => `templates/delivery-contract/${entry.path}`,
    ),
  ];
  for (const file of required) {
    assert.ok(packed.has(file), `${file} is not in the tarball`);
  }
});
