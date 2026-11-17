import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  buildUpdateEntry,
  buildUpdatesManifest,
  mergeUpdateEntries,
  parseArgs,
} from "../../scripts/generate-updates-json.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("updates.json manifest configuration", () => {
  it("points manifest.json update_url at the GitHub Pages updates.json endpoint", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
    assert.equal(
      manifest.applications?.zotero?.update_url,
      "https://williamslay.github.io/Zotero-FigureGuard/updates.json",
    );
  });
});

describe("generate-updates-json helpers", () => {
  it("builds a valid Zotero update entry with sha256 prefix and compatibility bounds", () => {
    const hash = "a".repeat(64);
    const entry = buildUpdateEntry({
      version: "0.6.0",
      updateLink: "https://github.com/williamslay/Zotero-FigureGuard/releases/download/v0.6.0/zotero-figure-guard-0.6.0.xpi",
      hashHex: hash,
      minVersion: "6.999",
      maxVersion: "10.9.9",
    });

    assert.deepEqual(entry, {
      version: "0.6.0",
      update_link: "https://github.com/williamslay/Zotero-FigureGuard/releases/download/v0.6.0/zotero-figure-guard-0.6.0.xpi",
      update_hash: `sha256:${hash}`,
      applications: {
        zotero: {
          strict_min_version: "6.999",
          strict_max_version: "10.9.9",
        },
      },
    });
  });

  it("merges new versions while preserving history and deduplicating re-runs", () => {
    const v050 = buildUpdateEntry({
      version: "0.5.0",
      updateLink: "https://example.test/v0.5.0.xpi",
      hashHex: "1".repeat(64),
      minVersion: "6.999",
      maxVersion: "10.9.9",
    });
    const v060 = buildUpdateEntry({
      version: "0.6.0",
      updateLink: "https://example.test/v0.6.0.xpi",
      hashHex: "2".repeat(64),
      minVersion: "6.999",
      maxVersion: "10.9.9",
    });
    const v060Rebuild = buildUpdateEntry({
      version: "0.6.0",
      updateLink: "https://example.test/v0.6.0.xpi",
      hashHex: "3".repeat(64),
      minVersion: "6.999",
      maxVersion: "10.9.9",
    });

    const merged = mergeUpdateEntries([v050, v060], v060Rebuild);
    assert.deepEqual(merged, [v050, v060Rebuild]);

    const doc = buildUpdatesManifest({
      addonId: "figure-guard@zotero.org",
      entry: v060Rebuild,
      existingManifest: { addons: { "figure-guard@zotero.org": { updates: [v050, v060] } } },
    });
    assert.equal(doc.addons["figure-guard@zotero.org"].updates.length, 2);
    assert.equal(doc.addons["figure-guard@zotero.org"].updates[1].update_hash, `sha256:${"3".repeat(64)}`);
  });

  it("parses CLI flags cleanly", () => {
    const parsed = parseArgs(["--repo", "org/repo", "--expect-version", "0.6.0"]);
    assert.equal(parsed.repo, "org/repo");
    assert.equal(parsed.expectVersion, "0.6.0");
  });

  it("generates updates.json from a built XPI and merges an existing updates.json", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "fg-updates-"));
    try {
      const manifest = JSON.parse(readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
      const xpiPath = path.join(tmp, `zotero-figure-guard-${manifest.version}.xpi`);
      writeFileSync(xpiPath, "fake-xpi-bytes");
      const existingPath = path.join(tmp, "existing.json");
      writeFileSync(
        existingPath,
        JSON.stringify({
          addons: {
            [manifest.applications.zotero.id]: {
              updates: [{ version: "0.4.0", update_link: "https://example.test/0.4.0.xpi" }],
            },
          },
        }),
      );
      const outPath = path.join(tmp, "updates.json");
      const result = spawnSync(
        process.execPath,
        [
          path.join(repoRoot, "scripts", "generate-updates-json.mjs"),
          "--repo",
          "williamslay/Zotero-FigureGuard",
          "--expect-version",
          manifest.version,
          "--xpi",
          xpiPath,
          "--existing",
          existingPath,
          "--out",
          outPath,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      const generated = JSON.parse(readFileSync(outPath, "utf8"));
      const updates = generated.addons[manifest.applications.zotero.id].updates;
      assert.equal(updates.length, 2);
      assert.equal(updates[0].version, "0.4.0");
      assert.equal(updates[1].version, manifest.version);
      assert.match(updates[1].update_hash, /^sha256:[a-f0-9]{64}$/);
      assert.equal(
        updates[1].update_link,
        `https://github.com/williamslay/Zotero-FigureGuard/releases/download/v${manifest.version}/zotero-figure-guard-${manifest.version}.xpi`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
