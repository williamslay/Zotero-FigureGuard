/**
 * Integrity check for the built XPI, so CI can prove the artefact it uploads is
 * the artefact the build described. Uses the same system zip/unzip binaries as
 * scripts/build.mjs plus node:crypto, so no extra dependencies.
 *
 * Checks: the file exists and is non-empty, the archive is a valid ZIP, it holds
 * exactly manifest.json, bootstrap.js and content/index.js at the expected
 * paths with nothing stray, the manifest inside agrees with the source manifest
 * (and with --expect-version when given), the file name matches the manifest
 * version, and dist/SHA256SUMS.txt is written in sha256sum text format.
 *
 * Usage: node scripts/verify-xpi.mjs [--expect-version <version>] [--dist <dir>]
 *
 * Run with: node scripts/verify-xpi.mjs
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = "Usage: node scripts/verify-xpi.mjs [--expect-version <version>] [--dist <dir>]";

/** Every entry the archive must carry, and nothing else. */
export const EXPECTED_ENTRIES = Object.freeze([
  "manifest.json",
  "bootstrap.js",
  "content/index.js",
]);

/** Entry patterns that must never ship inside the XPI. */
const STRAY_RULES = Object.freeze([
  { label: "node_modules/", match: (name) => name === "node_modules" || name.startsWith("node_modules/") },
  { label: ".pdf", match: (name) => name.toLowerCase().endsWith(".pdf") },
  { label: ".git", match: (name) => name.split("/").some((part) => part.startsWith(".git")) },
  { label: ".log", match: (name) => name.toLowerCase().endsWith(".log") },
  { label: "reports/", match: (name) => name.startsWith("reports/") },
  { label: "build/", match: (name) => name.startsWith("build/") },
  { label: "tests/", match: (name) => name.startsWith("tests/") },
]);

/**
 * Parses the command line.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {{dist: string, expectVersion: string|null}}
 */
export function parseArgs(argv) {
  const options = { dist: path.join(repoRoot, "dist"), expectVersion: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--expect-version" && flag !== "--dist") {
      throw new Error(`Unknown argument: ${flag}. ${USAGE}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}. ${USAGE}`);
    }
    if (flag === "--expect-version") options.expectVersion = value;
    else options.dist = path.resolve(value);
    index += 1;
  }
  return options;
}

/**
 * @param {string} version
 * @returns {string} The archive name the build produces for that version.
 */
export function xpiFileName(version) {
  return `figure-color-preservation-${version}.xpi`;
}

/**
 * Inverse of xpiFileName.
 *
 * @param {string} name Archive file name or path.
 * @returns {string|null} The version, or null when the name does not match.
 */
export function versionFromFileName(name) {
  const match = /^figure-color-preservation-(.+)\.xpi$/.exec(path.basename(name));
  return match ? match[1] : null;
}

/**
 * Turns `unzip -Z1` output into plain entry names. Directory entries (a
 * trailing slash, which zip may or may not list) are dropped, because the
 * archive is judged by the files it carries.
 *
 * @param {string} listing
 * @returns {string[]}
 */
export function parseEntries(listing) {
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/"));
}

/**
 * Exact entry-set comparison.
 *
 * @param {string[]} names Entries found in the archive.
 * @param {readonly string[]} [expected]
 * @returns {{missing: string[], extra: string[]}}
 */
export function diffEntries(names, expected = EXPECTED_ENTRIES) {
  return {
    missing: expected.filter((name) => !names.includes(name)),
    extra: names.filter((name) => !expected.includes(name)),
  };
}

/**
 * @param {string[]} names Entries found in the archive.
 * @param {readonly {label: string, match: (name: string) => boolean}[]} [rules]
 * @returns {string[]} One description per offending entry, e.g.
 *   "node_modules/esbuild/index.js (node_modules/)".
 */
export function findStrayEntries(names, rules = STRAY_RULES) {
  const strays = [];
  for (const name of names) {
    for (const rule of rules) {
      if (rule.match(name)) strays.push(`${name} (${rule.label})`);
    }
  }
  return strays;
}

/**
 * @param {string} hash Hex digest.
 * @param {string} basename Archive file name, never a path: sha256sum -c
 *   resolves names relative to the checksum file.
 * @returns {string} One line of sha256sum text format, without a newline.
 */
export function checksumLine(hash, basename) {
  return `${hash}  ${basename}`;
}

/**
 * @param {string} file
 * @returns {string} Lowercase hex SHA-256 of the file contents.
 */
export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Runs a system binary and fails loudly on a nonzero exit status.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string} stdout
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(
      `${command} failed to start: ${result.error.message}. ` +
        "The verifier needs the system unzip binary.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * @returns {string} The version the artefact is named after: --expect-version
 *   when it was passed, otherwise the source package.json version.
 */
function readSourceVersion() {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  if (!pkg?.version) throw new Error("package.json has no version");
  return pkg.version;
}

/**
 * @param {string} file
 * @returns {string} A repository-relative path when the file is inside the
 *   repository, the given path otherwise, so a --dist outside it stays readable.
 */
function displayPath(file) {
  const relative = path.relative(repoRoot, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return file;
  return relative;
}

async function main() {
  const { dist, expectVersion } = parseArgs(process.argv.slice(2));
  const sourceManifest = JSON.parse(
    readFileSync(path.join(repoRoot, "manifest.json"), "utf8"),
  );
  if (!sourceManifest?.version) throw new Error("manifest.json has no version");
  const sourceId = sourceManifest?.applications?.zotero?.id;
  if (!sourceId) throw new Error("manifest.json has no applications.zotero.id");

  const version = expectVersion ?? readSourceVersion();
  const fileName = xpiFileName(version);
  const xpiPath = path.join(dist, fileName);

  // 1. The artefact exists and is not an empty file.
  if (!existsSync(xpiPath)) {
    const candidates = existsSync(dist)
      ? readdirSync(dist).filter((name) => name.endsWith(".xpi"))
      : [];
    throw new Error(
      `XPI not found: ${displayPath(xpiPath)}` +
        (candidates.length ? ` (found: ${candidates.join(", ")})` : " (no .xpi in that directory)") +
        ". Run npm run build first.",
    );
  }
  const bytes = statSync(xpiPath).size;
  if (bytes === 0) throw new Error(`XPI is empty: ${displayPath(xpiPath)}`);

  // 2. The archive is a readable, uncorrupted ZIP.
  run("unzip", ["-t", xpiPath], repoRoot);

  const listing = run("unzip", ["-Z1", xpiPath], repoRoot);
  const names = parseEntries(listing);

  // 3. Exactly the three expected entries, nothing else.
  const { missing, extra } = diffEntries(names);
  if (missing.length || extra.length) {
    throw new Error(
      `Unexpected archive contents in ${fileName}. ` +
        `Missing: [${missing.join(", ")}] Extra: [${extra.join(", ")}]`,
    );
  }

  // 4 and 5. Root placement of the loader files, exact path of the bundle.
  for (const rootEntry of ["manifest.json", "bootstrap.js"]) {
    if (!names.includes(rootEntry)) {
      const prefixed = names.filter((name) => name !== rootEntry && name.endsWith(`/${rootEntry}`));
      throw new Error(
        `${rootEntry} is not at the archive root of ${fileName}` +
          (prefixed.length ? ` (found ${prefixed.join(", ")})` : "") +
          ". The Zotero loader resolves rootURI + bootstrap.js.",
      );
    }
  }
  if (!names.includes("content/index.js")) {
    throw new Error(
      `content/index.js is not at that exact path in ${fileName} ` +
        `(entries: ${names.join(", ")}).`,
    );
  }

  // 6. Nothing that must stay out of the shipped archive.
  const strays = findStrayEntries(names);
  if (strays.length) {
    throw new Error(`Stray entries in ${fileName}: ${strays.join(", ")}`);
  }

  // 7. The manifest inside agrees with the source manifest and with the caller.
  const innerRaw = run("unzip", ["-p", xpiPath, "manifest.json"], repoRoot);
  let innerManifest;
  try {
    innerManifest = JSON.parse(innerRaw);
  } catch (err) {
    throw new Error(
      `manifest.json inside ${fileName} is not valid JSON: ${err?.message ?? err}`,
    );
  }
  if (!innerManifest?.version) {
    throw new Error(`manifest.json inside ${fileName} has no version`);
  }
  if (innerManifest.version !== sourceManifest.version) {
    throw new Error(
      `Version mismatch inside ${fileName}: archived manifest.json is ${innerManifest.version}, ` +
        `source manifest.json is ${sourceManifest.version}.`,
    );
  }
  if (expectVersion && innerManifest.version !== expectVersion) {
    throw new Error(
      `Version mismatch: archived manifest.json is ${innerManifest.version}, --expect-version is ${expectVersion}.`,
    );
  }

  // 8. The add-on id the archive installs is the id the repository declares.
  const innerId = innerManifest?.applications?.zotero?.id;
  if (innerId !== sourceId) {
    throw new Error(
      `Add-on id mismatch inside ${fileName}: archived manifest.json is ${innerId ?? "(missing)"}, ` +
        `source manifest.json is ${sourceId}.`,
    );
  }

  // 9. The file name describes the version Zotero installs.
  const nameVersion = versionFromFileName(fileName);
  if (nameVersion !== innerManifest.version) {
    throw new Error(
      `File name mismatch: ${fileName} says ${nameVersion ?? "(no version)"}, ` +
        `archived manifest.json is ${innerManifest.version}.`,
    );
  }

  // 10. Publish a checksum a release job can pin: sha256sum -c SHA256SUMS.txt.
  const line = checksumLine(sha256(xpiPath), fileName);
  writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${line}\n`, "utf8");
  process.stdout.write(`${line}\n`);
  process.stdout.write(
    `[figure-color] verified ${displayPath(xpiPath)} (${bytes} bytes, ${names.length} entries)\n`,
  );
}

// Only run when invoked directly, so a unit test can import the pure helpers
// without a built artefact in dist/.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[figure-color] verify-xpi failed:", err?.message ?? err);
    process.exit(1);
  });
}
