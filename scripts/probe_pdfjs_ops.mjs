/**
 * A0 offline probe: what does pdf.js `getOperatorList()` actually expose for
 * Form XObjects in the fixture PDF?
 *
 * Prints, for the requested page:
 *   - pdf.js version
 *   - the leading operators injected by pdf.js (to detect an initial transform)
 *   - every paintFormXObjectBegin / paintImageXObject with the CTM accumulated
 *     from save/restore/transform operators, and the resulting user-space rect
 *   - text items matching a caption pattern
 * And, for all pages, per-page counts of form/image paint operators.
 *
 * Usage: node scripts/probe_pdfjs_ops.mjs [pdfPath] [pageIndex]
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const pdfjsVersion = require("pdfjs-dist/package.json").version;

const OPS_NAMES = (() => {
  const names = new Map();
  for (const [key, value] of Object.entries(pdfjsLib.OPS)) {
    if (typeof value === "number") names.set(value, key);
  }
  return names;
})();

const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function transformPoint(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function rectFromTransform(m, box) {
  const pts = [
    transformPoint(m, box[0], box[1]),
    transformPoint(m, box[2], box[1]),
    transformPoint(m, box[2], box[3]),
    transformPoint(m, box[0], box[3]),
  ];
  return [
    Math.min(...pts.map((p) => p[0])),
    Math.min(...pts.map((p) => p[1])),
    Math.max(...pts.map((p) => p[0])),
    Math.max(...pts.map((p) => p[1])),
  ];
}

function summarizeOps(opList, limit) {
  const { ops: opsArr, args: argsArr } = opListArrays(opList);
  const out = [];
  for (let i = 0; i < Math.min(opsArr.length, limit); i++) {
    out.push({
      i,
      op: OPS_NAMES.get(opsArr[i]) ?? String(opsArr[i]),
      args: argsArr?.[i] ?? null,
    });
  }
  return out;
}

/**
 * pdf.js exposes the operator list either as an `OperatorList` (`ops` / `args`,
 * <= v4 style) or as plain arrays (`fnArray` / `argsArray`, v5/v6 style).
 */
function opListArrays(opList) {
  return { ops: opList.ops ?? opList.fnArray, args: opList.args ?? opList.argsArray };
}

function walk(opList) {
  const { ops: opsArr, args: argsArr } = opListArrays(opList);
  let ctm = IDENTITY;
  const stack = [];
  const events = [];
  const opCounts = new Map();
  let formDepth = 0;
  for (let i = 0; i < opsArr.length; i++) {
    const op = opsArr[i];
    const args = argsArr?.[i];
    const name = OPS_NAMES.get(op) ?? String(op);
    opCounts.set(name, (opCounts.get(name) ?? 0) + 1);
    switch (name) {
      case "save":
        stack.push(ctm);
        break;
      case "restore":
        if (stack.length) ctm = stack.pop();
        break;
      case "transform":
        ctm = mul(ctm, args);
        break;
      case "beginText":
        break;
      case "setTransform":
        break;
      case "paintImageXObject":
      case "paintImageXObjectRepeat":
        events.push({
          kind: "image",
          opIndex: i,
          ctm: ctm.map((v) => +v.toFixed(5)),
          rectUserSpace: rectFromTransform(ctm, [0, 0, 1, 1]).map((v) => +v.toFixed(4)),
          args: args ?? null,
          formDepth,
        });
        break;
      case "paintFormXObjectBegin": {
        const matrix = args?.[0] ?? IDENTITY;
        const bbox = args?.[1];
        const entry = {
          kind: "formBegin",
          opIndex: i,
          ctmBefore: ctm.map((v) => +v.toFixed(5)),
          formMatrix: Array.isArray(matrix) ? matrix.map((v) => +v.toFixed(5)) : matrix,
          formBBox: Array.isArray(bbox) ? bbox.map((v) => +v.toFixed(4)) : bbox,
          rectUserSpace:
            Array.isArray(bbox) && bbox.length === 4
              ? rectFromTransform(mul(ctm, Array.isArray(matrix) ? matrix : IDENTITY), bbox).map(
                  (v) => +v.toFixed(4),
                )
              : null,
          formDepth,
        };
        events.push(entry);
        formDepth += 1;
        break;
      }
      case "paintFormXObjectEnd":
        formDepth = Math.max(0, formDepth - 1);
        events.push({ kind: "formEnd", opIndex: i, formDepth });
        break;
      default:
        break;
    }
  }
  return { events, opCounts: Object.fromEntries(opCounts), stackLeft: stack.length, formDepthLeft: formDepth };
}

async function main() {
  const pdfPath = process.argv[2] ?? "fixture/PipeBWrite.pdf";
  const pageIndex = process.argv[3] === undefined ? 4 : Number(process.argv[3]);
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const docTask = pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  });
  const doc = await docTask.promise;

  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const opList = await page.getOperatorList();
  const { events, opCounts, stackLeft, formDepthLeft } = walk(opList);
  const textContent = await page.getTextContent();
  const captionItems = textContent.items
    .filter((it) => typeof it.str === "string" && /fig(ure|\.)\s*\d+/i.test(it.str))
    .map((it) => ({
      str: it.str.slice(0, 60),
      transform: it.transform.map((v) => +v.toFixed(3)),
      height: +(it.height ?? 0).toFixed(3),
      width: +(it.width ?? 0).toFixed(3),
      hasEOL: !!it.hasEOL,
    }));

  const survey = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const vp = pg.getViewport({ scale: 1 });
    const ol = await pg.getOperatorList();
    const w = walk(ol);
    survey.push({
      page: p,
      width: +vp.width.toFixed(2),
      height: +vp.height.toFixed(2),
      rotation: pg.rotate,
      opCount: opListArrays(ol).ops.length,
      formBegins: w.events.filter((e) => e.kind === "formBegin").length,
      imagePaints: w.events.filter((e) => e.kind === "image").length,
      maxFormDepth: Math.max(0, ...w.events.map((e) => e.formDepth)),
      stackLeft: w.stackLeft,
    });
    pg.cleanup();
  }

  console.log(
    JSON.stringify(
      {
        file: path.basename(pdfPath),
        pdfjsDistVersion: pdfjsDistVersion(),
        pageIndex,
        viewportSize: [viewport.width, viewport.height],
        pageRotate: page.rotate,
        userUnit: page.userUnit ?? null,
        opCount: opListArrays(opList).ops.length,
        leadingOps: summarizeOps(opList, 24),
        formAndImageEvents: events,
        opCounts,
        unclosed: { stackLeft, formDepthLeft },
        captionItems,
        pageSurvey: survey,
      },
      null,
      2,
    ),
  );
  // The document proxy has no destroy(); the task returned by getDocument owns it.
  await docTask.destroy();
}

function pdfjsDistVersion() {
  return pdfjsVersion;
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
