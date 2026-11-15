/**
 * pdf.js adapter: collect everything the detector needs from one page.
 *
 * This is the only core module that touches pdf.js objects, which keeps the
 * detector itself testable with plain data and keeps the Zotero integration thin.
 */

import { collectPlacements, operatorListArrays, resolveOperatorCodes } from "./placements.js";
import { collectCaptions, collectTextLines } from "./captions.js";

/**
 * pdf.js numeric operator codes for the versions measured offline. Used only
 * when the runtime cannot expose its `OPS` table. Codes are validated by
 * `validateCodes()` before use, so a wrong table fails closed.
 */
export const MEASURED_OP_CODES = Object.freeze({
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintImageXObjectRepeat: 88,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  constructPath: 91,
  rawFillPath: 94,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
});

/**
 * Find the `OPS` table in a reader realm.
 * @param {Array<object|null|undefined>} sources
 * @returns {Record<string, number>|null}
 */
export function resolveRuntimeOPS(sources) {
  for (const source of sources ?? []) {
    if (source && typeof source.paintFormXObjectBegin === "number") return source;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} input.pdfPage pdf.js `PDFPageProxy`.
 * @param {Record<string, number>} [input.OPS] pdf.js `OPS` table for this realm.
 * @param {boolean} [input.includeMarkedContent]
 * @returns {Promise<{
 *   viewport: object, pageRect: number[], placements: Array<object>,
 *   lines: Array<object>, captions: Array<object>, skipped: Array<object>,
 *   textItems: Array<object>, diagnostics: object
 * }>}
 */
export async function collectPageEvidence({
  pdfPage,
  OPS = null,
  includeMarkedContent = false,
}) {
  if (!pdfPage || typeof pdfPage.getOperatorList !== "function") {
    throw new TypeError("collectPageEvidence: a PDFPageProxy is required");
  }

  const codes = codesFor(OPS);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const pageRect = Array.isArray(pdfPage.view)
    ? [...pdfPage.view]
    : [0, 0, viewport.width, viewport.height];

  const operatorList = await pdfPage.getOperatorList();
  const { ops, args } = operatorListArrays(operatorList);
  const { placements, skipped, diagnostics } = collectPlacements({ ops, args, codes });

  const textContent = await pdfPage.getTextContent({ includeMarkedContent });
  const textItems = (textContent?.items ?? []).filter((item) => !item?.type);
  const lines = collectTextLines(textItems);
  const captions = collectCaptions(lines);

  return {
    viewport,
    pageRect,
    placements,
    lines,
    captions,
    skipped,
    // The detector grows a region over the text that belongs to its artwork, so
    // the raw runs have to travel with the rest of the evidence.
    textItems,
    diagnostics: {
      ...diagnostics,
      textItemCount: textItems.length,
      lineCount: lines.length,
      usedMeasuredCodes: !resolveRuntimeOPS([OPS]),
    },
  };
}

function codesFor(OPS) {
  const resolved = resolveRuntimeOPS([OPS]);
  if (resolved) return resolveOperatorCodes(resolved);
  if (!validateCodes(MEASURED_OP_CODES)) {
    // Without a trustworthy operator table the detector must not guess.
    return { save: [-1], restore: [-2], transform: [-3] };
  }
  return resolveOperatorCodes(MEASURED_OP_CODES);
}

/** Sanity check a code table: distinct codes and balanced save/restore names. */
export function validateCodes(codes) {
  const values = Object.values(codes ?? {});
  if (!values.length) return false;
  if (new Set(values).size !== values.length) return false;
  return values.every((value) => Number.isInteger(value) && value >= 0);
}
