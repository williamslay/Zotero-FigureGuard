import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  EXPECTED_ENTRIES,
  checksumLine,
  diffEntries,
  findStrayEntries,
  parseArgs,
  parseEntries,
  sha256,
  versionFromFileName,
  xpiFileName,
} from "../../scripts/verify-xpi.mjs";

describe("parseArgs", () => {
  it("defaults to the repository dist and no expected version", () => {
    const options = parseArgs([]);
    assert.equal(options.expectVersion, null);
    assert.equal(path.basename(options.dist), "dist");
    assert.ok(path.isAbsolute(options.dist));
  });

  it("reads both flags", () => {
    const options = parseArgs(["--expect-version", "1.2.3", "--dist", "build-out"]);
    assert.equal(options.expectVersion, "1.2.3");
    assert.equal(path.basename(options.dist), "build-out");
  });

  it("rejects an unknown argument with a usage line", () => {
    assert.throws(
      () => parseArgs(["--verbose"]),
      /Unknown argument: --verbose\. Usage: node scripts\/verify-xpi\.mjs/,
    );
  });

  it("rejects a flag without a value", () => {
    assert.throws(() => parseArgs(["--expect-version"]), /Missing value for --expect-version/);
    assert.throws(() => parseArgs(["--dist"]), /Missing value for --dist/);
  });
});

describe("archive file name", () => {
  it("round-trips the version", () => {
    assert.equal(xpiFileName("0.1.31"), "figure-color-preservation-0.1.31.xpi");
    assert.equal(versionFromFileName("figure-color-preservation-0.1.31.xpi"), "0.1.31");
    assert.equal(versionFromFileName("/tmp/figure-color-preservation-1.2.3.xpi"), "1.2.3");
  });

  it("returns null for a name without a version", () => {
    assert.equal(versionFromFileName("figure-color.xpi"), null);
    assert.equal(versionFromFileName("manifest.json"), null);
  });
});

describe("parseEntries", () => {
  it("drops directory entries and blank lines", () => {
    assert.deepEqual(parseEntries("content/\nmanifest.json\n\nbootstrap.js\n"), [
      "manifest.json",
      "bootstrap.js",
    ]);
  });

  it("keeps nested file entries as they are", () => {
    assert.deepEqual(parseEntries("content/index.js"), ["content/index.js"]);
  });
});

describe("diffEntries", () => {
  it("accepts exactly the expected set", () => {
    assert.deepEqual(diffEntries([...EXPECTED_ENTRIES]), { missing: [], extra: [] });
  });

  it("is order independent", () => {
    assert.deepEqual(diffEntries(["content/index.js", "bootstrap.js", "manifest.json"]), {
      missing: [],
      extra: [],
    });
  });

  it("reports a missing bundle", () => {
    assert.deepEqual(diffEntries(["manifest.json", "bootstrap.js"]), {
      missing: ["content/index.js"],
      extra: [],
    });
  });

  it("reports an extra entry", () => {
    assert.deepEqual(
      diffEntries([...EXPECTED_ENTRIES, "node_modules/pdfjs-dist/pdf.js"]),
      { missing: [], extra: ["node_modules/pdfjs-dist/pdf.js"] },
    );
  });

  it("rejects a bundle hidden under a directory", () => {
    const { missing, extra } = diffEntries(["manifest.json", "bootstrap.js", "build/content/index.js"]);
    assert.deepEqual(missing, ["content/index.js"]);
    assert.deepEqual(extra, ["build/content/index.js"]);
  });
});

describe("findStrayEntries", () => {
  it("accepts the expected entries", () => {
    assert.deepEqual(findStrayEntries([...EXPECTED_ENTRIES]), []);
  });

  it("names every stray pattern", () => {
    const strays = findStrayEntries([
      "node_modules/pdfjs-dist/pdf.js",
      "PipeBWrite.pdf",
      ".git/config",
      "debug.log",
      "reports/A2/figure1.md",
      "build/content/index.js",
      "tests/js/render.test.mjs",
    ]);
    assert.deepEqual(strays, [
      "node_modules/pdfjs-dist/pdf.js (node_modules/)",
      "PipeBWrite.pdf (.pdf)",
      ".git/config (.git)",
      "debug.log (.log)",
      "reports/A2/figure1.md (reports/)",
      "build/content/index.js (build/)",
      "tests/js/render.test.mjs (tests/)",
    ]);
  });
});

describe("checksum line", () => {
  const hash = "a".repeat(64);

  it("uses two spaces and the basename only", () => {
    const line = checksumLine(hash, "figure-color-preservation-0.1.31.xpi");
    assert.equal(line, `${hash}  figure-color-preservation-0.1.31.xpi`);
    assert.match(line, /^[0-9a-f]{64}  [^/\s]+\.xpi$/);
  });

  it("digests file contents the way sha256sum does", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "figureguard-verify-"));
    const file = path.join(dir, "sample.txt");
    writeFileSync(file, "hello", "utf8");
    // Well-known digest of the five bytes "hello", with no trailing newline.
    assert.equal(sha256(file), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
