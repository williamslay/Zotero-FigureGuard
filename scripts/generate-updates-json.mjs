/**
 * Generates or updates a Zotero/Firefox WebExtension `updates.json` manifest
 * for a released `.xpi`, reading metadata from `manifest.json` and hashing the
 * built archive in `dist/` (or an explicit `--xpi` path).
 *
 * Usage:
 *   node scripts/generate-updates-json.mjs \
 *     [--repo owner/name] \
 *     [--expect-version X.Y.Z] \
 *     [--dist dist] \
 *     [--xpi path/to/file.xpi] \
 *     [--existing path/to/existing-updates.json] \
 *     [--out path/to/updates.json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, xpiFileName } from "./verify-xpi.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "williamslay/Zotero-FigureGuard";

const USAGE =
  "Usage: node scripts/generate-updates-json.mjs [--repo owner/name] [--expect-version <version>] " +
  "[--dist <dir>] [--xpi <file>] [--existing <file>] [--out <file>]";

/**
 * Parses command-line options for generating `updates.json`.
 *
 * @param {string[]} argv Arguments after script name.
 * @returns {{repo: string, expectVersion: string|null, dist: string, xpi: string|null, existing: string|null, out: string}}
 */
export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    expectVersion: null,
    dist: path.join(repoRoot, "dist"),
    xpi: null,
    existing: null,
    out: path.join(repoRoot, "dist", "updates.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}. ${USAGE}`);
    }
    if (flag === "--repo") options.repo = value;
    else if (flag === "--expect-version") options.expectVersion = value;
    else if (flag === "--dist") options.dist = path.resolve(value);
    else if (flag === "--xpi") options.xpi = path.resolve(value);
    else if (flag === "--existing") options.existing = path.resolve(value);
    else if (flag === "--out") options.out = path.resolve(value);
    else throw new Error(`Unknown argument: ${flag}. ${USAGE}`);
    index += 1;
  }
  return options;
}

/**
 * Builds one Zotero update entry for `updates.json`.
 *
 * @param {{version: string, updateLink: string, hashHex: string, minVersion: string, maxVersion: string}} input
 * @returns {object}
 */
export function buildUpdateEntry({ version, updateLink, hashHex, minVersion, maxVersion }) {
  if (!version) throw new Error("buildUpdateEntry: version is required");
  if (!updateLink) throw new Error("buildUpdateEntry: updateLink is required");
  if (!/^[a-f0-9]{64}$/i.test(String(hashHex ?? ""))) {
    throw new Error(`buildUpdateEntry: expected 64-char sha256 hex, got "${hashHex}"`);
  }
  const zoteroApp = {};
  if (minVersion) zoteroApp.strict_min_version = minVersion;
  if (maxVersion) zoteroApp.strict_max_version = maxVersion;
  return {
    version,
    update_link: updateLink,
    update_hash: `sha256:${hashHex.toLowerCase()}`,
    applications: {
      zotero: zoteroApp,
    },
  };
}

/**
 * Merges a new version entry into an existing list of update entries,
 * replacing any entry with the same version while preserving older versions.
 *
 * @param {Array<object>} existingUpdates
 * @param {object} nextEntry
 * @returns {Array<object>}
 */
export function mergeUpdateEntries(existingUpdates, nextEntry) {
  const list = Array.isArray(existingUpdates) ? existingUpdates : [];
  const filtered = list.filter((entry) => entry && typeof entry === "object" && entry.version !== nextEntry.version);
  return [...filtered, nextEntry];
}

/**
 * Builds the complete `updates.json` object for the given add-on id.
 *
 * @param {{addonId: string, entry: object, existingManifest?: object|null}} input
 * @returns {object}
 */
export function buildUpdatesManifest({ addonId, entry, existingManifest = null }) {
  if (!addonId) throw new Error("buildUpdatesManifest: addonId is required");
  const priorUpdates = existingManifest?.addons?.[addonId]?.updates;
  return {
    addons: {
      [addonId]: {
        updates: mergeUpdateEntries(priorUpdates, entry),
      },
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
  const version = options.expectVersion ?? manifest?.version;
  if (!version) throw new Error("manifest.json has no version");
  if (manifest.version !== version) {
    throw new Error(`manifest.json version (${manifest.version}) does not match expected version (${version})`);
  }
  const zoteroMeta = manifest?.applications?.zotero;
  const addonId = zoteroMeta?.id;
  if (!addonId) throw new Error("manifest.json has no applications.zotero.id");

  const fileName = xpiFileName(version);
  const xpiPath = options.xpi ?? path.join(options.dist, fileName);
  if (!existsSync(xpiPath)) {
    throw new Error(`XPI not found: ${xpiPath}. Run npm run build first.`);
  }

  let existingManifest = null;
  if (options.existing && existsSync(options.existing)) {
    const raw = readFileSync(options.existing, "utf8").trim();
    if (raw) existingManifest = JSON.parse(raw);
  }

  const updateLink = `https://github.com/${options.repo}/releases/download/v${version}/${fileName}`;
  const entry = buildUpdateEntry({
    version,
    updateLink,
    hashHex: sha256(xpiPath),
    minVersion: zoteroMeta.strict_min_version ?? "",
    maxVersion: zoteroMeta.strict_max_version ?? "",
  });
  const updatesJson = buildUpdatesManifest({ addonId, entry, existingManifest });

  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(updatesJson, null, 2)}\n`, "utf8");
  process.stdout.write(`[figure-color] wrote ${options.out} for ${addonId} v${version}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error("[figure-color] generate-updates-json failed:", err?.message ?? err);
    process.exit(1);
  }
}
