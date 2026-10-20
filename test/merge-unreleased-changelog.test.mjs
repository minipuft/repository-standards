/**
 * `merge-unreleased-changelog.mjs`, the release workflow's post-step, driven as a child process on
 * hand-written changelog fixtures in a temp directory, so the CLI path is proven and not only the
 * functions.
 *
 * WHY THIS EXISTS. Release Please inserts each new `## [X.Y.Z]` section at the top of the file,
 * above `## [Unreleased]`. The script merged the Unreleased bullets into the new version but never
 * moved the header, so every release pushed it one section further down (it sat below 5.1.1 and
 * 5.1.0 on claude-prompts-mcp `main`, measured 2026-10-06). The empty-Unreleased case is the one
 * that recurs, and the script used to exit before doing anything on it.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  parseSections,
  relocateUnreleased,
  selfTest,
} from "../templates/delivery-contract/scripts/merge-unreleased-changelog.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../templates/delivery-contract/scripts/merge-unreleased-changelog.mjs",
    import.meta.url,
  ),
);

const PREAMBLE = `# Changelog

Notes   about   the format.
  Odd  indentation stays.

`;

const V_NEW = `## [2.0.0](https://example.test/compare/v1.1.0...v2.0.0) (2026-02-02)

### Added

* new auto entry (#2)

### Fixed

* auto fix (#3)

`;

const V_MID = `## [1.1.0](https://example.test/compare/v1.0.0...v1.1.0) (2026-01-02)

### Changed

* middle entry   with  odd   spacing


`;

const V_OLD = `## [1.0.0] (2026-01-01)

### Added

* first entry
`;

/** Write `content` to a temp CHANGELOG.md, run the script on it, return stdout and the file. */
function run(content, args = (file) => [file]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-unreleased-"));
  try {
    const file = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(file, content, "utf-8");
    const output = execFileSync("node", [SCRIPT, ...args(file)], {
      encoding: "utf-8",
    });
    return {
      output: output.trim(),
      after: fs.readFileSync(file, "utf-8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const count = (text, pattern) => (text.match(pattern) || []).length;

test("merge-unreleased-changelog a: merges bullets from an Unreleased block below the newest version and moves the header to the top", () => {
  const unreleased = `## [Unreleased]

### Added

* manual entry with detail

### Documentation

* manual docs entry

`;
  const { output, after } = run(
    `${PREAMBLE}${V_NEW}${unreleased}${V_MID}${V_OLD}`,
  );

  const expectedNewest = `## [2.0.0](https://example.test/compare/v1.1.0...v2.0.0) (2026-02-02)

### Added

* manual entry with detail
* new auto entry (#2)

### Fixed

* auto fix (#3)

### Documentation

* manual docs entry

`;
  assert.equal(
    after,
    `${PREAMBLE}## [Unreleased]\n\n${expectedNewest}${V_MID}${V_OLD}`,
  );
  assert.equal(count(after, /^## \[Unreleased\]/gm), 1);
  assert.ok(after.endsWith(`${V_MID}${V_OLD}`));
  assert.match(output, /Merged 2 manual entries/);
  assert.match(output, /moved \[Unreleased\]/);
});

test("merge-unreleased-changelog b: relocates an empty Unreleased from two releases down to the top and changes nothing else", () => {
  const { output, after } = run(
    `${PREAMBLE}${V_NEW}${V_MID}## [Unreleased]\n\n\n\n${V_OLD}`,
  );

  assert.equal(after, `${PREAMBLE}## [Unreleased]\n\n${V_NEW}${V_MID}${V_OLD}`);
  assert.match(output, /moved \[Unreleased\]/);
});

test("merge-unreleased-changelog c: leaves a file with an empty Unreleased already at the top byte-identical", () => {
  const input = `${PREAMBLE}## [Unreleased]\n\n${V_NEW}${V_MID}${V_OLD}`;
  const { output, after } = run(input);

  assert.equal(after, input);
  assert.match(output, /nothing to (merge|do)/i);
});

// A changelog with no Unreleased header has chosen not to keep one. Inventing one would add a
// section the maintainers never asked for and a diff on every release, so the file is left alone.
test("merge-unreleased-changelog d: leaves a file with no Unreleased header byte-identical", () => {
  const input = `${PREAMBLE}${V_NEW}${V_MID}${V_OLD}`;
  const { output, after } = run(input);

  assert.equal(after, input);
  assert.match(output, /no \[Unreleased\] section/i);
});

test("merge-unreleased-changelog e: --changelog <path> names the file the same way the bare positional does", () => {
  const input = `${PREAMBLE}${V_NEW}${V_MID}## [Unreleased]\n\n\n\n${V_OLD}`;
  const positional = run(input);
  const flagged = run(input, (file) => ["--changelog", file]);

  assert.equal(flagged.after, positional.after);
  assert.match(flagged.output, /moved \[Unreleased\]/);
});

test("merge-unreleased-changelog f: --self-test exits 0 on the shipped logic and its inline case is the merge plus the relocation", () => {
  const result = spawnSync("node", [SCRIPT, "--self-test"], {
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /self-test passed/);
  assert.equal(selfTest().ok, true);
});

test("merge-unreleased-changelog g: a missing changelog and an unknown flag each exit 1 and name the problem", () => {
  const missing = spawnSync("node", [SCRIPT, "/nonexistent/CHANGELOG.md"], {
    encoding: "utf-8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Changelog not found/);

  const unknown = spawnSync("node", [SCRIPT, "--bogus"], {
    encoding: "utf-8",
  });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown flag: --bogus/);
});

test("merge-unreleased-changelog pure functions: the flag wins over the positional, headings parse in order, a body without headings travels with its header", () => {
  assert.equal(
    parseArgs(["a.md", "--changelog", "b.md"]).changelogPath,
    "b.md",
  );
  assert.deepEqual(
    [...parseSections("### Added\n\n* one\n* two\n\n### Fixed\n* three\n")],
    [
      ["Added", ["* one", "* two"]],
      ["Fixed", ["* three"]],
    ],
  );

  const moved = relocateUnreleased(
    `${V_NEW}## [Unreleased]\n\nfree text, no headings\n\n${V_OLD}`,
  );
  assert.equal(
    moved,
    `## [Unreleased]\n\nfree text, no headings\n\n${V_NEW}${V_OLD}`,
  );
});
