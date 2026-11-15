import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_TEST_FILES,
  findUnclassified,
  listTestFiles,
  parseMode,
  parseTapSummary,
  pdfFreeTestFiles,
  usesFixturePdf,
} from "../../scripts/run-tests.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The seven test files that read a fixture PDF in a before() hook. */
const KNOWN_FIXTURE_FILES = [
  "borges-detect.test.mjs",
  "fixture-detect.test.mjs",
  "flash-detect.test.mjs",
  "fluidkv-detect.test.mjs",
  "hikv-detect.test.mjs",
  "render.test.mjs",
  "viewport.test.mjs",
];

/** Every test file the ci tier must run, apart from the two added by this file. */
const KNOWN_PDF_FREE_FILES = [
  "cache.test.mjs",
  "captions.test.mjs",
  "cross-document.test.mjs",
  "detector.test.mjs",
  "geom.test.mjs",
  "overlay.test.mjs",
  "paint-probe.test.mjs",
  "placements.test.mjs",
  "probe-all.test.mjs",
  "reader-session.test.mjs",
  "realm-render.test.mjs",
  "unwrap-viewer.test.mjs",
  "viewer-bridge.test.mjs",
  "xray.test.mjs",
];

// Concatenated on purpose: this file has to stay free of the harness tokens, or
// the drift guard would classify it as a fixture test and the ci tier would
// never run it.
const PDF_HARNESS_TOKENS = ["open" + "Fixture", "FIXTURE_" + "PDF"];

describe("fixture harness token probe", () => {
  it("recognises both harness tokens", () => {
    for (const token of PDF_HARNESS_TOKENS) {
      assert.equal(usesFixturePdf(`import { ${token} } from "./helpers/doc.mjs";`), true, token);
    }
  });

  it("ignores the JSON fixture export", () => {
    assert.equal(usesFixturePdf('import { FIXTURE_JSON, OPS } from "./helpers/doc.mjs";'), false);
  });
});

describe("test tier classification", () => {
  const files = listTestFiles(TESTS_DIR);

  it("lists only test file basenames", () => {
    assert.ok(files.includes("xray.test.mjs"));
    assert.ok(files.every((name) => name.endsWith(".test.mjs")));
    assert.ok(!files.includes("doc.mjs"), "helpers must not be listed");
  });

  it("keeps the checked-in fixture list exact", () => {
    assert.deepEqual([...FIXTURE_TEST_FILES].sort(), [...KNOWN_FIXTURE_FILES].sort());
  });

  it("has no stale entry in the fixture list", () => {
    for (const name of FIXTURE_TEST_FILES) {
      assert.ok(files.includes(name), `${name} no longer exists`);
    }
  });

  it("partitions the suite into the two tiers", () => {
    const pdfFree = pdfFreeTestFiles(files);
    assert.equal(pdfFree.length, files.length - FIXTURE_TEST_FILES.length);
    assert.deepEqual(pdfFree.filter((name) => FIXTURE_TEST_FILES.includes(name)), []);
  });

  it("runs every PDF-free file in the ci tier", () => {
    const pdfFree = pdfFreeTestFiles(files);
    for (const name of [...KNOWN_PDF_FREE_FILES, "run-tests.test.mjs", "verify-xpi.test.mjs"]) {
      assert.ok(pdfFree.includes(name), `${name} must not be skipped by ci`);
    }
  });

  it("reads a PDF in every fixture test and in no PDF-free test", () => {
    for (const name of KNOWN_FIXTURE_FILES) {
      assert.equal(usesFixturePdf(readFileSync(path.join(TESTS_DIR, name), "utf8")), true, name);
    }
    for (const name of pdfFreeTestFiles(files)) {
      assert.equal(usesFixturePdf(readFileSync(path.join(TESTS_DIR, name), "utf8")), false, name);
    }
  });

  it("reports no drift against the checked-in list", () => {
    assert.deepEqual(findUnclassified(files, FIXTURE_TEST_FILES, TESTS_DIR), []);
  });

  it("flags a fixture test that is missing from the list", () => {
    const shortList = FIXTURE_TEST_FILES.filter((name) => name !== "viewport.test.mjs");
    assert.deepEqual(findUnclassified(files, shortList, TESTS_DIR), ["viewport.test.mjs"]);
  });
});

describe("parseMode", () => {
  it("defaults to the full regression", () => {
    assert.equal(parseMode([]), "all");
  });

  it("accepts both tiers", () => {
    assert.equal(parseMode(["ci"]), "ci");
    assert.equal(parseMode(["all"]), "all");
  });

  it("rejects an unknown mode with a usage line", () => {
    assert.throws(() => parseMode(["unit"]), /Unknown mode: unit\. Usage: node scripts\/run-tests\.mjs \[ci\|all\]/);
  });
});

describe("parseTapSummary", () => {
  const sample = [
    "TAP version 13",
    "# Subtest: works",
    "ok 1 - works",
    "# tests 3",
    "# suites 1",
    "# pass 2",
    "# fail 0",
    "# cancelled 1",
    "# skipped 0",
    "# todo 0",
    "# duration_ms 42",
    "",
  ].join("\n");

  it("reads every counter", () => {
    assert.deepEqual(parseTapSummary(sample), {
      tests: 3,
      pass: 2,
      fail: 0,
      cancelled: 1,
      skipped: 0,
    });
  });

  it("returns null when a counter is missing", () => {
    assert.equal(parseTapSummary("# tests 3\n# pass 3\n"), null);
  });

  it("returns null on empty output", () => {
    assert.equal(parseTapSummary(""), null);
  });
});
