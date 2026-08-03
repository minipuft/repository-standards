import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("downstream preset extends an immutable tag using this repository's v-prefix", () => {
  const preset = JSON.parse(readFileSync("renovate/downstream.json", "utf8"));
  assert.equal(preset.extends.length, 1);
  assert.match(
    preset.extends[0],
    /^github>minipuft\/repository-standards\/\/renovate\/default\.json#v\d+\.\d+\.\d+$/,
  );
});
