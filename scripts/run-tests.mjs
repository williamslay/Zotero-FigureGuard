/**
 * Two-tier test runner for the Zotero Figure Guard extension.
 *
 * Tiers:
 *   ci   only the test files that need no PDF, so a clone without the
 *        copyrighted fixture PDFs (not redistributed) runs a green suite and
 *        every test it claims to have run really executed.
 *   all  every tests/js/*.test.mjs, the full maintainer regression.
 *
 * Usage: node scripts/run-tests.mjs [ci|all]   (no argument behaves like "all")
 *
 * Classification is by exclusion: FIXTURE_TEST_FILES is the checked-in list of
 * test files that open a fixture PDF in a before() hook, and every other
 * tests/js/*.test.mjs is treated as PDF-free. The list is verified against the
 * file contents (see findUnclassified), so a newly added PDF-dependent test
 * that was not added to the list fails ci mode instead of silently cancelling.
 * Because the check is a plain text search, a PDF-free test that merely
 * mentions openFixture or FIXTURE_PDF in a comment also trips it and has to be
 * reworded or classified on purpose.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(repoRoot, "tests", "js");

/** Test files that read a copyrighted fixture PDF; skipped by the ci tier. */
export const FIXTURE_TEST_FILES = Object.freeze([
  "borges-detect.test.mjs",
  "fixture-detect.test.mjs",
  "flash-detect.test.mjs",
  "fluidkv-detect.test.mjs",
  "hikv-detect.test.mjs",
  "render.test.mjs",
  "viewport.test.mjs",
]);

/** Counters read out of the TAP summary the node:test tap reporter prints. */
const TAP_COUNTERS = Object.freeze(["tests", "pass", "fail", "cancelled", "skipped"]);

/**
 * True when the source of a test file reaches for the PDF harness.
 *
 * @param {string} source Contents of a *.test.mjs file.
 * @returns {boolean}
 */
export function usesFixturePdf(source) {
  return /\bopenFixture\b|\bFIXTURE_PDF\b/.test(source);
}

/**
 * Basenames of every test file in the suite directory, sorted.
 *
 * @param {string} [dir] tests/js
 * @returns {string[]} e.g. ["cache.test.mjs", ...]
 */
export function listTestFiles(dir = testsDir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * The PDF-free tier: every test file that is not a fixture test.
 *
 * @param {string[]} [testFiles] basenames, defaults to listTestFiles()
 * @param {readonly string[]} [fixtureFiles] defaults to FIXTURE_TEST_FILES
 * @returns {string[]} sorted basenames that need no PDF
 */
export function pdfFreeTestFiles(
  testFiles = listTestFiles(),
  fixtureFiles = FIXTURE_TEST_FILES,
) {
  return testFiles.filter((name) => !fixtureFiles.includes(name));
}

/**
 * Drift guard: test files that read a PDF but are not classified as fixture
 * tests. A non-empty result means FIXTURE_TEST_FILES needs a new entry (or the
 * file needs rewording), otherwise the ci tier would run it and record its
 * cancellations as a pass.
 *
 * @param {string[]} [testFiles] basenames, defaults to listTestFiles()
 * @param {readonly string[]} [fixtureFiles] defaults to FIXTURE_TEST_FILES
 * @param {string} [dir] tests/js, where the basenames are read from
 * @returns {string[]} offending basenames, sorted
 */
export function findUnclassified(
  testFiles = listTestFiles(),
  fixtureFiles = FIXTURE_TEST_FILES,
  dir = testsDir,
) {
  return testFiles
    .filter((name) => !fixtureFiles.includes(name))
    .filter((name) => usesFixturePdf(readFileSync(path.join(dir, name), "utf8")))
    .sort();
}

/**
 * Reads the TAP summary counters.
 *
 * @param {string} stdout Full TAP output of a node:test run.
 * @returns {Record<(typeof TAP_COUNTERS)[number], number>|null} null when a
 *   counter line is missing, which means the run died before reporting.
 */
export function parseTapSummary(stdout) {
  const summary = {};
  for (const counter of TAP_COUNTERS) {
    const match = new RegExp(`^# ${counter} (\\d+)\\s*$`, "m").exec(stdout);
    if (!match) return null;
    summary[counter] = Number(match[1]);
  }
  return summary;
}

/**
 * Runs node --test over the given test files and returns its raw output.
 *
 * @param {string[]} files Absolute paths of test files.
 * @returns {{stdout: string, stderr: string}}
 */
function runNodeTest(files) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", ...files],
    {
      cwd: repoRoot,
      encoding: "utf8",
      // The tap reporter prints one block per test; the full suite is far
      // larger than the 1 MB default buffer and would be truncated.
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`node --test failed to start: ${result.error.message}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * @param {string[]} files Basenames to run.
 * @returns {string[]} Absolute paths.
 */
function toPaths(files) {
  return files.map((name) => path.join(testsDir, name));
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {"ci"|"all"}
 */
export function parseMode(argv) {
  const mode = argv[0] ?? "all";
  if (mode !== "ci" && mode !== "all") {
    throw new Error(
      `Unknown mode: ${mode}. Usage: node scripts/run-tests.mjs [ci|all]`,
    );
  }
  return mode;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const testFiles = listTestFiles();
  const stale = FIXTURE_TEST_FILES.filter((name) => !testFiles.includes(name));
  if (stale.length) {
    throw new Error(
      `FIXTURE_TEST_FILES lists files that no longer exist: ${stale.join(", ")}. Update scripts/run-tests.mjs.`,
    );
  }

  const files = mode === "ci" ? pdfFreeTestFiles(testFiles) : testFiles;
  const skipped = testFiles.filter((name) => !files.includes(name));
  if (mode === "ci") {
    const unclassified = findUnclassified(testFiles, FIXTURE_TEST_FILES, testsDir);
    if (unclassified.length) {
      throw new Error(
        `Unclassified fixture-dependent test files: ${unclassified.join(", ")} read a PDF ` +
          "but are not in FIXTURE_TEST_FILES. Add them there, or drop the PDF use.",
      );
    }
  }

  const { stdout, stderr } = runNodeTest(toPaths(files));
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const summary = parseTapSummary(stdout);
  if (!summary) {
    throw new Error("Could not parse the TAP summary; the test run did not finish.");
  }
  if (summary.fail > 0) {
    throw new Error(`${summary.fail} test(s) failed.`);
  }
  if (summary.pass === 0) {
    throw new Error("No test passed; the suite produced no passing test.");
  }
  if (mode === "ci" && summary.cancelled > 0) {
    throw new Error(
      `${summary.cancelled} test(s) cancelled in ci mode. A cancelled test is not a pass: ` +
        "ci may only run the PDF-free files, so check the fixture PDFs.",
    );
  }

  process.stdout.write(
    `\n[figure-color] mode=${mode} files_run=${files.length} files_skipped=${skipped.length} ` +
      `tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} ` +
      `cancelled=${summary.cancelled} skipped=${summary.skipped}\n`,
  );
  if (mode === "ci") {
    process.stdout.write(
      `[figure-color] ${skipped.length} fixture-dependent file(s) skipped: the copyrighted ` +
        "fixture PDFs are not redistributed.\n",
    );
  }
}

// Only run when invoked directly: a unit test imports this module for the
// classification helpers and must not spawn the suite from inside the suite.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[figure-color] test run failed:", err?.message ?? err);
    process.exit(1);
  });
}
