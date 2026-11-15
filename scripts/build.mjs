/**
 * Builds the installable XPI for the Zotero Figure Guard extension.
 *
 * Layout of the archive (the loader entries sit at the archive root, because the
 * Zotero bootstrapped loader resolves rootURI + "bootstrap.js"):
 *   manifest.json
 *   bootstrap.js
 *   content/index.js   (esbuild bundle of src/zotero/main.js)
 *   content/figureguard-icon.svg   (the add-on icon, from assets/)
 *
 * Run with: npm run build
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(repoRoot, "build");
const distDir = path.join(repoRoot, "dist");

/**
 * Reads the version of every source that carries it. The manifest is what Zotero
 * installs and the file name is what the release publishes, so a mismatch in any
 * of them means the artefact would not describe the installed add-on.
 *
 * @returns {Promise<string>} The version, identical everywhere.
 */
async function readVersion() {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  if (!pkg?.version) throw new Error("package.json has no version");
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "manifest.json"), "utf8"));
  if (!manifest?.version) throw new Error("manifest.json has no version");
  const lock = JSON.parse(await readFile(path.join(repoRoot, "package-lock.json"), "utf8"));
  if (!lock?.version) throw new Error("package-lock.json has no version");
  // lockfileVersion 2 and 3 both store the workspace root under packages[""].
  if (!(Number(lock?.lockfileVersion) >= 2)) {
    throw new Error(
      `package-lock.json has lockfileVersion ${lock?.lockfileVersion}; version 2 or higher is required to check packages[""].`,
    );
  }
  const rootPackage = lock.packages?.[""];
  if (!rootPackage?.version) {
    throw new Error('package-lock.json has no version in packages[""]');
  }

  const fields = [
    ["package.json", pkg.version],
    ["manifest.json", manifest.version],
    ["package-lock.json root", lock.version],
    ['package-lock.json packages[""]', rootPackage.version],
  ];
  if (fields.some(([, value]) => value !== manifest.version)) {
    throw new Error(
      `Version mismatch: ${fields.map(([where, value]) => `${where} is ${value}`).join(", ")}. Keep them in sync.`,
    );
  }
  return manifest.version;
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
        "The build needs the system zip and unzip binaries.",
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

async function main() {
  const version = await readVersion();

  // 1. Clean slate: a stale build/ directory used to hide removed sources.
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });

  // 2. Bundle the Zotero layer (which pulls in the framework-free core).
  await build({
    entryPoints: [path.join(repoRoot, "src", "zotero", "main.js")],
    outfile: path.join(buildDir, "content", "index.js"),
    bundle: true,
    format: "iife",
    globalName: "FigureGuard",
    // esbuild target syntax has no dash: "firefox-115" is rejected as an
    // invalid version, so the Firefox 115 baseline is spelled "firefox115".
    target: ["firefox115"],
    sourcemap: false,
    minify: false,
    logLevel: "info",
  });

  const bundle = path.join(buildDir, "content", "index.js");
  if (!existsSync(bundle)) throw new Error(`esbuild did not produce ${bundle}`);

  // 3. Stage the XPI root files next to content/.
  for (const file of ["manifest.json", "bootstrap.js"]) {
    const source = path.join(repoRoot, file);
    if (!existsSync(source)) throw new Error(`Missing XPI root file: ${file}`);
    rmSync(path.join(buildDir, file), { force: true });
    copyFileSync(source, path.join(buildDir, file));
  }

  // 3b. Stage the add-on icon into content/, where manifest.json's `icons`
  // entries and the reader toolbar button both resolve it. The source is the
  // single tracked copy in assets/, so a missing file is a broken build.
  const iconSource = path.join(repoRoot, "assets", "figureguard-icon.svg");
  if (!existsSync(iconSource)) {
    throw new Error(
      `Missing add-on icon: ${path.relative(repoRoot, iconSource)}. ` +
        "The manifest icons entries and the toolbar button need assets/figureguard-icon.svg.",
    );
  }
  const iconTarget = path.join(buildDir, "content", "figureguard-icon.svg");
  rmSync(iconTarget, { force: true });
  copyFileSync(iconSource, iconTarget);

  // 4. Zip from inside build/ so the loader entries land at the archive root.
  const xpiName = `zotero-figure-guard-${version}.xpi`;
  const xpiPath = path.join(distDir, xpiName);
  const zipArgs = [
    "-r",
    "-X",
    "-q",
    xpiPath,
    "manifest.json",
    "bootstrap.js",
    "content/index.js",
    "content/figureguard-icon.svg",
  ];
  run("zip", zipArgs, buildDir);
  if (!existsSync(xpiPath)) throw new Error(`zip did not produce ${xpiPath}`);

  // 5. Show what went into the archive.
  const listing = run("unzip", ["-l", xpiPath], repoRoot);
  process.stdout.write(listing);

  // Entries are the rows that carry a size and a timestamp; the header, the
  // separator line and the trailing total row are not entries.
  const entryLine = /^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s/;
  const names = listing
    .split("\n")
    .filter((line) => entryLine.test(line))
    .map((line) => line.trim().split(/\s+/)[3]);
  const expected = [
    "manifest.json",
    "bootstrap.js",
    "content/index.js",
    "content/figureguard-icon.svg",
  ];
  const missing = expected.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    throw new Error(
      `Unexpected archive contents. Missing: [${missing.join(", ")}] Extra: [${extra.join(", ")}]`,
    );
  }

  const bytes = statSync(xpiPath).size;
  process.stdout.write(`\nBuilt ${path.relative(repoRoot, xpiPath)} (${bytes} bytes)\n`);
}

main().catch((err) => {
  console.error("[figure-color] build failed:", err?.message ?? err);
  process.exit(1);
});
