/**
 * Text line reconstruction and figure-caption detection.
 *
 * Captions are the main automatic evidence that a vector Form XObject is a
 * figure, so they are detected from text geometry only: nothing about a
 * specific file, page number or object name is assumed here.
 */

import { transformPoint, toMatrix, normalizeRect } from "./geom.js";

/** Matches "Figure 2:", "Fig. 3)", "FIGURE 10:" and similar labels. */
export const CAPTION_RE = /^\s*(?:figure|fig\.?)\s*([0-9]+[a-zA-Z]?)\s*[:.)]/i;

/**
 * User-space rectangle of a PDF.js text-content item.
 * @param {{transform: ArrayLike<number>, width?: number, height?: number, str?: string}} item
 * @returns {number[]|null}
 */
export function textItemRect(item) {
  const matrix = toMatrix(item?.transform);
  if (!matrix) return null;
  const det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
  // pdf.js reports `height` in user space; fall back to the text-matrix scale.
  const height = Math.abs(Number(item.height) || 0) || (det > 0 ? Math.sqrt(det) : 0);
  let width = Math.abs(Number(item.width) || 0);
  if (!width) {
    // Some producers omit advance widths; a rough estimate keeps the caption
    // usable for proximity tests without pretending to be exact.
    const chars = (item.str ?? "").length;
    width = chars * height * 0.5;
  }
  if (!width || !height) return null;
  return textRectFromBasis(matrix, width, height);
}

/**
 * pdf.js reports `width`/`height` already in user space, so only the text
 * matrix origin and basis vectors may be applied to them.
 */
function textRectFromBasis(matrix, width, height) {
  const origin = transformPoint(matrix, 0, 0);
  const writing = unit([matrix[0], matrix[1]]);
  const vertical = unit([matrix[2], matrix[3]]);
  if (!writing || !vertical) return null;
  const corners = [
    origin,
    [origin[0] + writing[0] * width, origin[1] + writing[1] * width],
    [origin[0] + vertical[0] * height, origin[1] + vertical[1] * height],
    [
      origin[0] + writing[0] * width + vertical[0] * height,
      origin[1] + writing[1] * width + vertical[1] * height,
    ],
  ];
  return normalizeRect([
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ]);
}

function unit(vector) {
  const length = Math.hypot(vector[0], vector[1]);
  return length > 0 ? [vector[0] / length, vector[1] / length] : null;
}

/**
 * Default horizontal gap, in font-size units, that starts a new text segment on
 * the same baseline. Measured on a two-column sample document: the widest gap
 * inside one column - table cells, side-by-side captions - is 2.0 units, while
 * the narrowest column gutter is 2.17 units, so 2 units splits columns without
 * cutting words or table rows apart.
 */
export const DEFAULT_COLUMN_GAP_MIN_FONT_SIZE_UNITS = 2;

/**
 * Floor for the segment gap in points: a threshold that scales with a 4 pt
 * footnote would cut inside a single word, where advance-width rounding alone
 * leaves gaps of several points.
 */
export const DEFAULT_COLUMN_GAP_MIN_PT = 8;

/**
 * Group text items into lines using the baseline, then join their strings.
 *
 * A baseline shared by two columns - typical for a caption sitting next to body
 * text - must not become one line, otherwise the line starts with the body text
 * and the caption pattern can never match it. Runs on one baseline are therefore
 * cut into segments wherever the horizontal gap between the right edge of the
 * previous run and the left edge of the next one exceeds the threshold; each
 * segment becomes its own line. A baseline with a single segment behaves exactly
 * as before.
 *
 * @param {Array<object>} items PDF.js text content items (non-marked-content).
 * @param {{baselineTolerance?: number, columnGapMinFontSizeUnits?: number, columnGapMinPt?: number}} [options]
 * @returns {Array<{text: string, rect: number[], baselineY: number, fontSize: number, itemRects: number[][]}>}
 */
export function collectTextLines(items, options = {}) {
  const tolerance = options.baselineTolerance ?? 1.2;
  const gapUnits = options.columnGapMinFontSizeUnits ?? DEFAULT_COLUMN_GAP_MIN_FONT_SIZE_UNITS;
  const gapFloor = options.columnGapMinPt ?? DEFAULT_COLUMN_GAP_MIN_PT;
  const buckets = new Map();

  for (const item of items ?? []) {
    if (typeof item?.str !== "string" || !item.str.trim()) continue;
    const rect = textItemRect(item);
    if (!rect) continue;
    const fontSize = Math.abs(Number(item.height) || 0) || 0;
    // Bucket key keeps items on one baseline together even when a producer
    // splits the line into several runs.
    const key = Math.round(rect[1] / tolerance);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push({ rect, str: item.str, fontSize, x: rect[0] });
  }

  const lines = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => a.x - b.x);
    for (const segment of splitByGap(bucket, gapUnits, gapFloor)) {
      const rect = segment.reduce(
        (acc, part) =>
          normalizeRect([
            Math.min(acc[0], part.rect[0]),
            Math.min(acc[1], part.rect[1]),
            Math.max(acc[2], part.rect[2]),
            Math.max(acc[3], part.rect[3]),
          ]),
        [...segment[0].rect],
      );
      lines.push({
        text: segment.map((part) => part.str).join(" "),
        rect,
        baselineY: segment[0].rect[1],
        fontSize: median(segment.map((part) => part.fontSize)),
        itemRects: segment.map((part) => part.rect),
      });
    }
  }
  lines.sort((a, b) => {
    if (Math.abs(a.baselineY - b.baselineY) > 1e-6) return b.baselineY - a.baselineY;
    return a.rect[0] - b.rect[0];
  });
  return lines;
}

/**
 * Cut one baseline's runs into horizontal segments.
 *
 * @param {Array<{rect: number[], fontSize: number, x: number}>} bucket Runs sorted by x.
 * @param {number} gapUnits Gap threshold as a multiple of the segment font size.
 * @param {number} gapFloor Gap threshold in points; the larger of the two applies.
 * @returns {Array<Array<object>>}
 */
function splitByGap(bucket, gapUnits, gapFloor) {
  const segments = [];
  let segment = [bucket[0]];
  let right = bucket[0].rect[2];
  for (const part of bucket.slice(1)) {
    const size = median(segment.map((run) => run.fontSize)) || part.fontSize;
    const threshold = Math.max(gapUnits * size, gapFloor);
    const gap = part.rect[0] - right;
    const segmentIsCaption = CAPTION_RE.test(segment.map((run) => run.str).join(" "));
    const startsSecondCaption = segmentIsCaption && gap > size * 1.8 && CAPTION_RE.test(part.str);
    if (gap > threshold || startsSecondCaption) {
      segments.push(segment);
      segment = [part];
      right = part.rect[2];
    } else {
      segment.push(part);
      right = Math.max(right, part.rect[2]);
    }
  }
  segments.push(segment);
  return segments;
}

/**
 * Extract figure captions from text lines.
 *
 * @param {Array<{text: string, rect: number[], fontSize: number}>} lines
 * @param {{maxCaptionFontSize?: number}} [options] Lines much larger than the
 *   body text are usually headings, not captions.
 * @returns {Array<{number: string, label: string, text: string, rect: number[], fontSize: number}>}
 */
export function collectCaptions(lines, options = {}) {
  void options;
  const captions = [];
  const list = lines ?? [];
  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    const match = CAPTION_RE.exec(line.text);
    if (!match) continue;
    if (isWrappedBodyContinuation(line, match[0], list)) continue;
    captions.push({
      number: match[1],
      label: `${match[0].trim()}`,
      text: line.text,
      rect: line.rect,
      fontSize: line.fontSize,
    });
  }
  return captions;
}

/**
 * Filter mid-sentence prose line wraps that happen to begin with "Figure 6."
 * (e.g. "...for the reasons explained in\nFigure 6. For larger pairs...").
 */
function isWrappedBodyContinuation(line, matchedPrefix, lines) {
  if (!matchedPrefix.trim().endsWith(".")) return false;
  const lr = line?.rect;
  if (!lr || !(line.fontSize > 0)) return false;
  const lw = lr[2] - lr[0];
  for (const prev of lines) {
    if (prev === line || !prev?.rect) continue;
    const pr = prev.rect;
    const gapY = pr[1] - lr[3];
    if (gapY < -1 || gapY > 0.55 * line.fontSize) continue;
    if (prev.fontSize > 0 && Math.abs(prev.fontSize - line.fontSize) > 1.0) continue;
    if (pr[0] > lr[0] + 4 || pr[2] < lr[2] - 12) continue;
    const prevText = String(prev.text ?? "").trim();
    if (!prevText || /^\s*\([a-z0-9]{1,3}\)/i.test(prevText)) continue;
    if (/[.?!:;)\]]$/.test(prevText)) continue;
    if (!/[a-z,]$/.test(prevText)) continue;
    const words = prevText.split(/\s+/).filter(Boolean).length;
    if (words >= 6 && pr[2] - pr[0] >= lw * 0.75) return true;
  }
  return false;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  return nums[Math.floor(nums.length / 2)];
}
