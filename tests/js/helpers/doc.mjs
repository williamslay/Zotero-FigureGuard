/** Shared pdf.js bootstrap for the offline test harness. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../..");
export const FIXTURE_PDF = path.join(REPO_ROOT, "fixture", "PipeBWrite.pdf");
export const FIXTURE_JSON = path.join(REPO_ROOT, "fixture", "fixture-verified.json");

export const OPS = pdfjsLib.OPS;

/** Opens the fixture PDF with the same options the Zotero integration uses. */
export async function openFixture(pdfPath = FIXTURE_PDF) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const task = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const close = async () => {
    await task.destroy();
  };
  return { doc, task, close };
}

export async function readJson(file) {
  return JSON.parse(await fs.promises.readFile(file, "utf8"));
}
