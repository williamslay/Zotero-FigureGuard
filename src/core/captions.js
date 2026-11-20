/**
 * Text line reconstruction and figure-caption detection.
 *
 * Captions are the main automatic evidence that a vector Form XObject is a
 * figure, so they are detected from text geometry only: nothing about a
 * specific file, page number or object name is assumed here.
 */

import { transformPoint, toMatrix, normalizeRect, intersectRects, rectArea, rectHeight, rectWidth, unionRect } from "./geom.js";

/**
 * Strictly punctuated caption labels: "Figure 2:", "Fig. 3)", "FIGURE 10:",
 * "Figure 4 —", "Fig. 5 –", "Fig. 5 - ...", and PDF.js split forms like "Fig . 8 :".
 * Excludes numeric ranges such as "Figure 6-11" or "Figure 6-(b)".
 */
export const CAPTION_RE =
  /^\s*(?:figure|fig(?:\s*\.)?)\s*([0-9]+(?:\.[0-9]+)?[a-zA-Z]?)\s*(?:[:.)]|[\u2014\u2013](?!\s*[0-9])|\s+-(?=\s+[^\d(]))/i;

/**
 * Controlled relaxed candidate without delimiter (e.g. "Figure 6 Performance comparison"
 * or standalone "Figure 7"). Always passes through local layout & anti-prose checks
 * in `collectCaptions` before acceptance.
 */
const RELAXED_CAPTION_RE =
  /^\s*(?:(?:Figure|FIGURE|Fig)\s+|Fig\s*\.\s*)([0-9]+(?:\.[0-9]+)?[a-zA-Z]?)(?=\s|$)/;

/** Prose words/verbs immediately following "Figure N" in cross-references. */
const PROSE_AFTER_NUMBER_RE =
  /^(?:shows?|showed|shown|illustrates?|presents?|compares?|plots?|depicts?|demonstrates?|summarizes?|lists?|gives?|reveals?|indicates?|reports?|confirms?|proves?|verifies?|highlights?|evaluates?|measures?|describes?|displays?|contains?|includes?|provides?|tracks?|varies|vary|uses?|takes?|outperforms?|achieves?|reduces?|increases?|decreases?|improves?|is|are|was|were|has|have|had|can|could|may|might|will|would|shall|should|must|and|or|as|at|by|for|from|in|into|of|on|to|with|also|only|again|still|then|further|clearly|explicitly|respectively|which|where|when|while|that|we|they|it|this|these|those)\b/i;

const RANGE_OR_SUBREF_AFTER_RE = /^(?:,|;|\(|[-–—]\s*(?:\(|[0-9]))/;

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
    bucket.push({ rect, str: item.str, fontSize, x: rect[0], fontName: item.fontName ?? null });
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
      const fontNames = [...new Set(segment.map((part) => part.fontName).filter(Boolean))];
      lines.push({
        text: joinSegmentText(segment),
        rect,
        baselineY: segment[0].rect[1],
        fontSize: median(segment.map((part) => part.fontSize)),
        fontName: segment[0].fontName ?? null,
        fontNames,
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
 * Join runs on the same baseline segment cleanly without introducing spurious
 * spaces before split punctuation (e.g. `Fig`, `.`, `8`, `:` -> `Fig. 8:`)
 * or between tightly kerning single-word token pieces.
 */
function joinSegmentText(segment) {
  if (!segment?.length) return "";
  let out = segment[0].str;
  for (let i = 1; i < segment.length; i++) {
    const prev = segment[i - 1];
    const part = segment[i];
    const gap = part.rect[0] - prev.rect[2];
    const size = Math.max(prev.fontSize, part.fontSize) || 10;
    const pStr = prev.str;
    const nStr = part.str;
    if (/\s$/.test(pStr) || /^\s/.test(nStr)) {
      out = `${out.replace(/\s+$/, "")} ${nStr.replace(/^\s+/, "")}`;
    } else if (/^[.,:;)\]]/.test(nStr) && gap <= Math.max(0.45 * size, 3.5)) {
      out += nStr;
    } else if (
      gap <= Math.max(0.06 * size, 0.5) &&
      /[A-Za-z0-9]$/.test(pStr) &&
      /^[A-Za-z0-9]/.test(nStr) &&
      pStr.length <= 6 &&
      nStr.length <= 6
    ) {
      out += nStr;
    } else {
      out += ` ${nStr}`;
    }
  }
  return out;
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
  for (let i = 1; i < bucket.length; i++) {
    const part = bucket[i];
    const size = median(segment.map((run) => run.fontSize)) || part.fontSize;
    const threshold = Math.max(gapUnits * size, gapFloor);
    const gap = part.rect[0] - right;
    const segmentIsCaption = CAPTION_RE.test(joinSegmentText(segment));
    let lookaheadText = part.str;
    if (segmentIsCaption && gap > size * 1.8) {
      const lookahead = [part];
      let prevRight = part.rect[2];
      for (let k = i + 1; k < Math.min(bucket.length, i + 4); k++) {
        if (bucket[k].rect[0] - prevRight > Math.max(size * 1.8, gapFloor)) break;
        lookahead.push(bucket[k]);
        prevRight = Math.max(prevRight, bucket[k].rect[2]);
      }
      lookaheadText = joinSegmentText(lookahead);
    }
    const startsSecondCaption = segmentIsCaption && gap > size * 1.8 && CAPTION_RE.test(lookaheadText);
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
 * Extract figure captions from text lines using strict punctuation matching plus
 * controlled delimiter-less candidates gated by local typography, line-continuity,
 * column-block, and (when available) graphic-proximity validation.
 *
 * @param {Array<{text: string, rect: number[], fontSize: number, fontName?: string}>} lines
 * @param {{placements?: Array<object>, pageRect?: number[]}} [options]
 * @returns {Array<{number: string, label: string, text: string, rect: number[], fontSize: number}>}
 */
export function collectCaptions(lines, options = {}) {
  const captions = [];
  const list = lines ?? [];
  const ctx = computeCaptionContext(list, options.pageRect);
  const consumedIndexes = new Set();

  for (let i = 0; i < list.length; i++) {
    if (consumedIndexes.has(i)) continue;
    const line = list[i];
    if (!line?.rect || !(rectArea(line.rect) > 0)) continue;

    const strictMatch = CAPTION_RE.exec(line.text);
    const relaxedMatch = strictMatch ? null : RELAXED_CAPTION_RE.exec(line.text);
    const match = strictMatch ?? relaxedMatch;
    if (!match) continue;

    const isStrict = Boolean(strictMatch);
    const rawAfter = line.text.slice(match[0].length);
    const afterTrimmed = rawAfter.trim();

    if (RANGE_OR_SUBREF_AFTER_RE.test(afterTrimmed)) continue;
    if (isWrappedBodyContinuation(line, list)) continue;
    if (isIndentedParagraphLine(line, list)) continue;

    if (isStrict) {
      captions.push({
        number: match[1],
        label: normalizeCaptionLabel(match[0]),
        text: line.text,
        rect: line.rect,
        fontSize: line.fontSize,
      });
      continue;
    }

    // Controlled Stage A1/A2 validation for delimiter-less candidates:
    // reject prose cross-references ("Figure 6 shows...", "Figure 6 in...")
    // and embedded prose paragraphs, and require positive layout/graphic support.
    if (afterTrimmed) {
      if (PROSE_AFTER_NUMBER_RE.test(afterTrimmed)) continue;
      if (/^[a-z]/.test(afterTrimmed)) continue;
    }

    const isBareHeader = afterTrimmed === "";
    const pairedNext = isBareHeader ? findBareHeaderDescriptionLine(line, list, i, ctx) : null;
    if (isBareHeader && pairedNext === false) {
      // Bare "Figure 7" immediately above lowercase/prose continuation ("shows...")
      continue;
    }

    const combinedLine = pairedNext
      ? {
          ...line,
          text: `${line.text.trim()} ${pairedNext.line.text.trim()}`,
          rect: unionRect(line.rect, pairedNext.line.rect),
        }
      : line;

    if (isEmbeddedInBodyBlock(combinedLine, isBareHeader, Boolean(pairedNext), list, ctx)) continue;

    const hasDistinctFont = hasDistinctCaptionTypography(line, ctx);
    const isolatedBlock = isIsolatedCaptionBlock(combinedLine, isBareHeader, list, ctx);
    const hasGraphic =
      Array.isArray(options.placements)
        ? hasNearbyGraphicCandidate(combinedLine.rect, options.placements, options.pageRect)
        : null;

    // When page graphic placements are known, delimiter-less lines on a page with
    // zero plausible nearby artwork must show distinct typography + isolated block.
    if (hasGraphic === false && !(hasDistinctFont && isolatedBlock)) continue;
    if (!hasDistinctFont && !isolatedBlock && hasGraphic !== true) continue;

    if (pairedNext) consumedIndexes.add(pairedNext.index);
    captions.push({
      number: match[1],
      label: normalizeCaptionLabel(match[0]),
      text: combinedLine.text,
      rect: combinedLine.rect,
      fontSize: line.fontSize,
    });
  }
  return captions;
}

function normalizeCaptionLabel(prefix) {
  return String(prefix ?? "")
    .trim()
    .replace(/\s+([.:)])/g, "$1");
}

function countWords(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function computeCaptionContext(lines, pageRect) {
  const sizes = [];
  const widths = [];
  const fontCounts = new Map();
  const distinctFonts = new Set();

  for (const line of lines ?? []) {
    if (line?.fontName) distinctFonts.add(line.fontName);
    const text = String(line?.text ?? "").trim();
    if (!text || CAPTION_RE.test(text)) continue;
    const fs = Number(line?.fontSize) || 0;
    const w = rectWidth(line.rect);
    const words = countWords(text);
    const minW = pageRect ? rectWidth(pageRect) * 0.25 : 140;
    if (fs >= 7.5 && words >= 5 && w >= minW) {
      sizes.push(fs);
      widths.push(w);
      if (line.fontName) fontCounts.set(line.fontName, (fontCounts.get(line.fontName) ?? 0) + 1);
    }
  }

  let bodyFontSize = null;
  let bodyLineWidth = null;
  let bodyFontName = null;
  if (sizes.length >= 3) {
    sizes.sort((a, b) => a - b);
    widths.sort((a, b) => a - b);
    bodyFontSize = sizes[Math.floor(sizes.length / 2)];
    bodyLineWidth = widths[Math.floor(widths.length * 0.75)];
    if (distinctFonts.size >= 2 && fontCounts.size > 0) {
      let topFont = null;
      let topCount = 0;
      for (const [fn, count] of fontCounts.entries()) {
        if (count > topCount) {
          topCount = count;
          topFont = fn;
        }
      }
      if (topFont && topCount >= sizes.length * 0.5) bodyFontName = topFont;
    }
  }
  return { bodyFontSize, bodyLineWidth, bodyFontName };
}

function findAdjacentColumnLine(line, lines, direction, maxGapFactor = 0.65) {
  const lr = line?.rect;
  const fs = Number(line?.fontSize) || 0;
  if (!lr || !(fs > 0)) return null;
  let best = null;
  let bestGap = Infinity;
  for (let i = 0; i < (lines?.length ?? 0); i++) {
    const other = lines[i];
    if (!other || other === line || !other.rect) continue;
    const or = other.rect;
    const gapY = direction === "above" ? or[1] - lr[3] : lr[1] - or[3];
    if (gapY < -1 || gapY > maxGapFactor * fs) continue;
    if (other.fontSize > 0 && Math.abs(other.fontSize - fs) > 1.2) continue;
    const ovX = Math.min(lr[2], or[2]) - Math.max(lr[0], or[0]);
    if (ovX < 0.2 * Math.min(rectWidth(lr), rectWidth(or)) && !(lr[0] >= or[0] - 4 && lr[2] <= or[2] + 4)) {
      continue;
    }
    if (gapY < bestGap) {
      bestGap = gapY;
      best = { line: other, index: i, gapY };
    }
  }
  return best;
}

/**
 * Filter mid-sentence prose line wraps that happen to begin with "Figure 6."
 * or "Figure 6 —" or relaxed "Figure 6 ..." right below an unterminated line.
 */
function isWrappedBodyContinuation(line, lines) {
  const lr = line?.rect;
  if (!lr || !(line.fontSize > 0)) return false;
  const lw = rectWidth(lr);
  const found = findAdjacentColumnLine(line, lines, "above", 0.58);
  if (!found) return false;
  const pr = found.line.rect;
  if (found.line.fontSize > 0 && Math.abs(found.line.fontSize - line.fontSize) > 1.0) return false;
  if (pr[0] > lr[0] + 4 || pr[2] < lr[2] - 12) return false;
  const prevText = String(found.line.text ?? "").trim();
  if (!prevText || /^\s*\([a-z0-9]{1,3}\)/i.test(prevText)) return false;
  if (CAPTION_RE.test(prevText)) return false;
  if (/[.?!:;)\]]$/.test(prevText)) return false;
  if (!/[a-z,-]$/.test(prevText)) return false;
  const words = countWords(prevText);
  return words >= 6 && rectWidth(pr) >= lw * 0.72;
}

/**
 * First-line-indented justified body paragraphs (`x0` indented >= 5 pt relative
 * to the line right below while sharing its right column margin) are prose,
 * never figure captions.
 */
function isIndentedParagraphLine(line, lines) {
  const lr = line?.rect;
  if (!lr || !(line.fontSize > 0)) return false;
  if (countWords(line.text) < 4) return false;
  const next = findAdjacentColumnLine(line, lines, "below", 0.65);
  if (!next) return false;
  const nr = next.line.rect;
  const lw = rectWidth(lr);
  const nw = rectWidth(nr);
  return lr[0] - nr[0] >= 5 && Math.abs(lr[2] - nr[2]) <= 12 && nw >= lw * 0.72;
}

/**
 * For a bare header line (`Figure 7` with no inline caption title), pair it
 * with its description line directly below (`System architecture ...`) when aligned
 * and non-prose; return `false` if line below starts a lowercase prose clause.
 */
function findBareHeaderDescriptionLine(line, lines, lineIndex, ctx) {
  const next = findAdjacentColumnLine(line, lines, "below", 0.9);
  if (!next || next.index === lineIndex) return null;
  const nt = String(next.line.text ?? "").trim();
  if (!nt || CAPTION_RE.test(nt) || RELAXED_CAPTION_RE.test(nt)) return null;
  if (PROSE_AFTER_NUMBER_RE.test(nt) || /^[a-z,;(\[]/.test(nt)) return false;
  const nextWords = countWords(nt);
  if (nextWords < 2) return null;
  // Require the description line to stay near the header column/width without
  // jumping into a completely separate wide paragraph preceded by tight prose.
  const lr = line.rect;
  const nr = next.line.rect;
  const sameLeft = Math.abs(lr[0] - nr[0]) <= 12;
  const centeredOverNext =
    Math.abs((lr[0] + lr[2]) / 2 - (nr[0] + nr[2]) / 2) <= Math.max(36, rectWidth(nr) * 0.25);
  if (!sameLeft && !centeredOverNext && !ctx.bodyLineWidth) return null;
  return next;
}

function isEmbeddedInBodyBlock(blockLine, isBareHeader, hasPairedNext, lines, ctx) {
  const fs = Number(blockLine.fontSize) || 0;
  if (!(fs > 0)) return false;
  const above = findAdjacentColumnLine(blockLine, lines, "above", 0.65);
  const below = findAdjacentColumnLine(blockLine, lines, "below", 0.65);
  const distinctFont = hasDistinctCaptionTypography(blockLine, ctx);

  if (above) {
    const aw = rectWidth(above.line.rect);
    const sameFont =
      (!ctx.bodyFontName || !above.line.fontName || above.line.fontName === blockLine.fontName) &&
      (!blockLine.fontSize || !above.line.fontSize || Math.abs(blockLine.fontSize - above.line.fontSize) <= 0.8);
    if (!distinctFont && sameFont && countWords(above.line.text) >= 5 && aw >= (ctx.bodyLineWidth ?? 140) * 0.7) {
      return true;
    }
  }

  if (!isBareHeader && below && !distinctFont) {
    const bw = rectWidth(below.line.rect);
    const lw = rectWidth(blockLine.rect);
    const minBodyW = (ctx.bodyLineWidth ?? 160) * 0.72;
    if (lw >= minBodyW && bw >= minBodyW && countWords(below.line.text) >= 5) {
      // Check whether the block continues tightly a 3rd line downward, indicating
      // multi-line body prose rather than a 2-line caption followed by caption skip.
      const third = findAdjacentColumnLine(below.line, lines, "below", 0.65);
      if (third && rectWidth(third.line.rect) >= minBodyW * 0.8) return true;
      if (/[a-z,]$/.test(blockLine.text.trim()) && below.line.text.trim().length > 0 && countWords(blockLine.text) >= 6) {
        const startsLower = /^[a-z]/.test(below.line.text.trim());
        const hasProseClause = /\b(?:shows?|presents?|compares?|illustrates?|improves?|outperforms?|reduces?|demonstrates?|is|are|was|were|we)\b/i.test(
          blockLine.text,
        );
        if (startsLower && hasProseClause) return true;
      }
    }
  }

  if (isBareHeader && !hasPairedNext && (above || below)) {
    // A bare "Figure 7" with neither a description line below nor separation from prose is noise.
    if (above && !distinctFont) return true;
  }
  return false;
}

function hasDistinctCaptionTypography(line, ctx) {
  if (ctx.bodyFontName && line.fontName && line.fontName !== ctx.bodyFontName) return true;
  if (ctx.bodyFontSize && ctx.bodyFontSize >= 8.5 && line.fontSize > 0 && line.fontSize <= ctx.bodyFontSize * 0.94) {
    return true;
  }
  return false;
}

function isIsolatedCaptionBlock(blockLine, isBareHeader, lines, ctx) {
  const fs = Number(blockLine.fontSize) || 10;
  const above = findAdjacentColumnLine(blockLine, lines, "above", 0.75);
  const below = findAdjacentColumnLine(blockLine, lines, "below", 0.75);
  if (isBareHeader && !above) return true;
  const narrowerThanBody = ctx.bodyLineWidth ? rectWidth(blockLine.rect) < ctx.bodyLineWidth * 0.85 : true;
  return !above && (!below || narrowerThanBody) && countWords(blockLine.text) <= 12 && fs > 0;
}

function hasNearbyGraphicCandidate(capRect, placements, pageRect) {
  if (!Array.isArray(placements) || !placements.length) return false;
  const pageArea = pageRect ? rectArea(pageRect) : 612 * 792;
  const nearbyPaths = [];
  let pathUnion = null;

  for (const p of placements) {
    const r = p?.rect;
    if (!Array.isArray(r) || rectArea(r) <= 0) continue;
    const areaRatio = pageArea > 0 ? rectArea(r) / pageArea : 0;
    if (areaRatio > 0.8) continue;

    const gapAbove = r[1] - capRect[3];
    const gapBelow = capRect[1] - r[3];
    const vertOk = (gapAbove >= -12 && gapAbove <= 90) || (gapBelow >= -12 && gapBelow <= 48);
    if (!vertOk) continue;

    const overlapX = Math.min(r[2], capRect[2]) - Math.max(r[0], capRect[0]);
    const minW = Math.min(rectWidth(r), rectWidth(capRect));
    if (p.kind === "path") {
      if (overlapX > -24) {
        nearbyPaths.push(r);
        pathUnion = pathUnion ? unionRect(pathUnion, r) : [...r];
      }
      if (rectWidth(r) >= 40 && rectHeight(r) >= 24 && overlapX >= 0.25 * minW) return true;
    } else if (rectWidth(r) >= 32 && rectHeight(r) >= 20 && overlapX >= 0.25 * minW) {
      return true;
    }
  }

  if (nearbyPaths.length >= 4 && pathUnion) {
    const overlapX = Math.min(pathUnion[2], capRect[2]) - Math.max(pathUnion[0], capRect[0]);
    const minW = Math.min(rectWidth(pathUnion), rectWidth(capRect));
    if (rectWidth(pathUnion) >= 40 && rectHeight(pathUnion) >= 24 && overlapX >= 0.25 * minW) {
      return true;
    }
  }
  return false;
}

function median(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  return nums[Math.floor(nums.length / 2)];
}
