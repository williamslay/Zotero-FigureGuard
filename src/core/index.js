/**
 * Public entry point of the framework-free detection core.
 *
 * Layers:
 *   detector.js / placements.js / captions.js  pure data, no pdf.js
 *   pdf-source.js / render.js / viewport.js    pdf.js adapters
 *   ../zotero/*                                Zotero-only integration
 */

import { detectFigureRegions, DEFAULT_DETECTOR_OPTIONS } from "./detector.js";
import { collectPageEvidence } from "./pdf-source.js";

export * from "./geom.js";
export * from "./detector-options.js";
export { detectFigureRegions } from "./detector.js";
export * from "./placements.js";
export * from "./captions.js";
export * from "./viewport.js";
export * from "./render.js";
export * from "./cache.js";
export { collectPageEvidence, MEASURED_OP_CODES, resolveRuntimeOPS } from "./pdf-source.js";

/**
 * Convenience wrapper: detect regions directly from a pdf.js page.
 *
 * @param {object} input
 * @param {object} input.pdfPage
 * @param {Record<string, number>} [input.OPS]
 * @param {Array<{rect: number[]}>} [input.structRegions]
 * @param {object} [input.options]
 * @returns {Promise<{regions: Array<object>, rejected: Array<object>,
 *                    diagnostics: object, pageRect: number[], viewport: object}>}
 */
export async function detectPageRegions({ pdfPage, OPS, structRegions, options }) {
  const evidence = await collectPageEvidence({ pdfPage, OPS });
  const detection = detectFigureRegions({
    placements: evidence.placements,
    captions: evidence.captions,
    structRegions,
    textItems: evidence.textItems,
    pageRect: evidence.pageRect,
    options,
  });
  return {
    ...detection,
    pageRect: evidence.pageRect,
    viewport: evidence.viewport,
    captions: evidence.captions,
    skippedPlacements: evidence.skipped,
  };
}

export const CORE_VERSION = "0.1.0";
export { DEFAULT_DETECTOR_OPTIONS };
