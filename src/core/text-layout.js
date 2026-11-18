/**
 * Text-line classification, line-of-sight blocker geometry, page substrate
 * filtering, and 4-way figure label expansion.
 *
 * Inspired by Zotero Reading Mode's graphic block refinement pipeline:
 * prose lines and captions act as sight blockers that keep independent figures
 * split apart and prevent body text from being swallowed, while short labels
 * (axis ticks, rotated axis titles, subfigure markers) in clear line of sight
 * expand figure borders in all four directions.
 */

import { CAPTION_RE, collectTextLines, textItemRect } from "./captions.js";
import {
  intersectRects,
  normalizeRect,
  rectArea,
  rectHeight,
  rectWidth,
  toMatrix,
  unionRect,
} from "./geom.js";

const TABLE_OR_ALGO_CAPTION_RE = /^\s*(?:table|tab\.?|algorithm)\s*[0-9ivx]+\s*[:.)\s]/i;
const SECTION_HEADING_RE = /^\s*(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+[A-Z]/;
const SUBFIGURE_PREFIX_RE = /^\s*\([a-z0-9]{1,3}\)(?:\s|$)/i;
const NUMERIC_TICK_ROW_RE = /^[\d.,+\-%eE/\s()]+$/;

/**
 * Determine whether two rectangles intersect.
 * @param {number[]} a
 * @param {number[]} b
 */
function rectsOverlap(a, b) {
  return !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
}

function inflateRect(rect, amount) {
  return [rect[0] - amount, rect[1] - amount, rect[2] + amount, rect[3] + amount];
}

function rectGap(a, b) {
  const dx = b[0] > a[2] ? b[0] - a[2] : a[0] > b[2] ? a[0] - b[2] : 0;
  const dy = b[1] > a[3] ? b[1] - a[3] : a[1] > b[3] ? a[1] - b[3] : 0;
  return Math.hypot(dx, dy);
}

/**
 * Test whether `rect` intersects any sorted blocker box `[x0, y0, x1, y1]`.
 * `blockers` must be sorted ascending by `rect[0]`.
 *
 * @param {number[]} rect
 * @param {number[][]} blockers
 * @returns {boolean}
 */
export function blockersIntersectRect(rect, blockers) {
  if (!rect || !blockers?.length) return false;
  const [x1, y1, x2, y2] = rect;
  for (const blocker of blockers) {
    if (blocker[0] > x2) break;
    if (blocker[2] >= x1 && blocker[1] <= y2 && blocker[3] >= y1) return true;
  }
  return false;
}

/**
 * Returns true when no blocker intersects `rect`.
 *
 * @param {number[]} rect
 * @param {number[][]} blockers Sorted by `rect[0]`.
 * @returns {boolean}
 */
export function clearSightRect(rect, blockers) {
  return !blockersIntersectRect(rect, blockers);
}

/**
 * Line-of-sight visibility between two boxes across a sorted blocker list.
 * Overlapping boxes must have a blocker-free union; separated boxes that
 * project onto each other along X or Y must have a blocker-free corridor.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @param {number[][]} blockers Sorted by `rect[0]`.
 * @param {number} [minOverlap=0.5]
 * @returns {boolean}
 */
export function hasDirectSightValid(a, b, blockers, minOverlap = 0.5) {
  if (rectsOverlap(a, b)) {
    return clearSightRect(unionRect(a, b), blockers);
  }
  const ox1 = Math.max(a[0], b[0]);
  const ox2 = Math.min(a[2], b[2]);
  if (ox2 - ox1 >= minOverlap) {
    const y1 = Math.min(a[3], b[3]);
    const y2 = Math.max(a[1], b[1]);
    return clearSightRect([ox1, y1, ox2, y2], blockers);
  }
  const oy1 = Math.max(a[1], b[1]);
  const oy2 = Math.min(a[3], b[3]);
  if (oy2 - oy1 >= minOverlap) {
    const x1 = Math.min(a[2], b[2]);
    const x2 = Math.max(a[0], b[0]);
    return clearSightRect([x1, oy1, x2, oy2], blockers);
  }
  return false;
}

function isRotatedTextItem(item) {
  const matrix = toMatrix(item?.transform);
  if (!matrix) return false;
  return Math.abs(matrix[1]) > Math.abs(matrix[0]) * 0.5;
}

function countWords(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function isProseOrHeadingLine(line, pageWidth) {
  const text = String(line?.text ?? "").trim();
  if (!text) return false;
  if (CAPTION_RE.test(text) || TABLE_OR_ALGO_CAPTION_RE.test(text)) return true;
  if (SUBFIGURE_PREFIX_RE.test(text)) return false;
  if (NUMERIC_TICK_ROW_RE.test(text)) return false;
  // Tiny-font labels (< 7.5 pt) inside figures and legends are not body prose.
  if ((line.fontSize ?? 0) > 0 && line.fontSize < 7.5) return false;

  const width = rectWidth(line.rect);
  const words = countWords(text);
  const ratio = pageWidth > 0 ? width / pageWidth : 0;

  // Short-token tick/label rows (e.g. "4K 16K 64K 256K 1M") are figure axes, not prose.
  const tokens = text.split(/\s+/).filter(Boolean);
  const alphaLongWords = tokens.filter((tok) =>
    /^[a-zA-Z]{4,}$/.test(tok.replace(/[.,;:?!)"'\]]+$/g, "")),
  ).length;
  const lowercaseWords = tokens.filter((tok) => /^[a-z]{2,}(?:-[a-z]{2,})*[.,;:?!]?$/.test(tok)).length;
  const hasSentencePunct = /[.?!;:]/.test(text);
  const endsSentence = /[.?!,;:](\s|$)/.test(text);
  if (alphaLongWords < 3 && !endsSentence) return false;

  // Multi-series legend rows ("RocksDB MatrixKV ...") have no lowercase prose words or punctuation.
  if (lowercaseWords === 0 && !hasSentencePunct && !SECTION_HEADING_RE.test(text)) return false;

  if (ratio >= 0.3 && words >= 5) return true;
  // Paragraph tail lines ending with sentence punctuation (e.g. "80% to FLAX.",
  // "shows the duration of the compaction.") are prose blockers unless tiny/circled.
  if (endsSentence && words >= 3 && lowercaseWords >= 1 && !/[①-⑳ⓐ-ⓩⒶ-Ⓩ]/.test(text)) return true;
  // Narrow lines (< 30% of page) with circled diagram callouts or no prose structure
  // belong to flowcharts/diagrams rather than body text columns.
  if (words >= 6 && ratio >= 0.16) {
    if (/[①-⑳ⓐ-ⓩⒶ-Ⓩ]/.test(text) && ratio < 0.3) return false;
    if (lowercaseWords >= 3 || hasSentencePunct) return true;
  }
  if (SECTION_HEADING_RE.test(text) && words >= 2 && (line.fontSize ?? 0) >= 8.5) return true;
  return false;
}

/**
 * Partition page text into hard blockers (captions, prose sentences, headings)
 * and absorbable figure labels (ticks, rotated axis titles, subfigure tags,
 * legend names), while retaining raw text boxes for ruled-table checks.
 *
 * @param {Array<object>} textItems
 * @param {Array<{rect: number[]}>} captions
 * @param {number[]} pageRect
 * @param {object} options
 * @returns {{
 *   blockers: number[][],
 *   captionBlockers: number[][],
 *   allTextRects: number[][],
 *   labelCandidates: Array<{rect: number[], text: string, isRotated: boolean}>
 * }}
 */
export function analyzePageText(textItems, captions, pageRect, options = {}) {
  const inflate = Math.max(0, options.blockerInflatePt ?? 1.5);
  const pageWidth = rectWidth(pageRect);
  const horizontalItems = [];
  const rotatedLabels = [];
  const allTextRects = [];
  const labelCandidates = [];
  const tableCaptionRects = [];

  for (const item of textItems ?? []) {
    const hasStr = typeof item?.str === "string";
    if (hasStr && !item.str.trim()) continue;
    const rect = Array.isArray(item?.rect) ? normalizeRect(item.rect) : textItemRect(item);
    if (!rect || rect.some((v) => !Number.isFinite(v)) || rectArea(rect) <= 0) continue;
    const text = hasStr ? item.str.trim() : "";
    if (text) allTextRects.push(rect);
    if (isRotatedTextItem(item)) {
      rotatedLabels.push({ rect, text, isRotated: true });
    } else if (Array.isArray(item?.rect) && !item?.transform) {
      // Pre-computed rect without transform (synthetic test runs or pre-normalised items).
      if (TABLE_OR_ALGO_CAPTION_RE.test(text)) tableCaptionRects.push(rect);
      if (!isProseOrHeadingLine({ rect, text, fontSize: 10 }, pageWidth)) {
        labelCandidates.push({ rect, text, isRotated: false });
      }
    } else {
      horizontalItems.push(item);
    }
  }

  const hLines = collectTextLines(horizontalItems);
  const blockers = [];
  const proseBlockers = [];
  const captionBlockers = [];
  const hItemEntries = [];

  for (const item of horizontalItems) {
    const rect = Array.isArray(item?.rect) ? normalizeRect(item.rect) : textItemRect(item);
    if (!rect || rect.some((v) => !Number.isFinite(v)) || rectArea(rect) <= 0) continue;
    hItemEntries.push({ rect, text: String(item.str ?? "").trim(), isRotated: false });
  }

  for (const cap of captions ?? []) {
    if (!Array.isArray(cap?.rect) || rectArea(cap.rect) <= 0) continue;
    const inf = inflateRect(cap.rect, inflate);
    blockers.push(inf);
    captionBlockers.push(inf);
  }

  for (const line of hLines) {
    if (CAPTION_RE.test(line.text)) continue;
    if (TABLE_OR_ALGO_CAPTION_RE.test(line.text)) {
      tableCaptionRects.push(line.rect);
    }
    if (isProseOrHeadingLine(line, pageWidth)) {
      const inf = inflateRect(line.rect, inflate);
      blockers.push(inf);
      proseBlockers.push(inf);
    }
  }

  blockers.sort((a, b) => a[0] - b[0]);
  proseBlockers.sort((a, b) => a[0] - b[0]);
  captionBlockers.sort((a, b) => a[0] - b[0]);
  allTextRects.sort((a, b) => a[0] - b[0]);

  for (const entry of hItemEntries) {
    if (!blockersIntersectRect(entry.rect, blockers)) {
      labelCandidates.push(entry);
    }
  }
  labelCandidates.push(...rotatedLabels);

  return { blockers, proseBlockers, captionBlockers, tableCaptionRects, allTextRects, labelCandidates };
}

/**
 * Identify indices of placements that act as page substrates (single full-page
 * elements >= `maxAreaRatio`, or tiled raster image grids whose union covers
 * >= `maxAreaRatio` of the page).
 *
 * @param {Array<object>} placements
 * @param {number[]} pageRect
 * @param {object} options
 * @returns {Set<number>}
 */
export function findPageSubstrateIndexes(placements, pageRect, options = {}) {
  const substrateIndexes = new Set();
  const pageArea = rectArea(pageRect);
  if (!(pageArea > 0) || !placements?.length) return substrateIndexes;

  const minCoverage = options.maxAreaRatio ?? 0.8;
  const minSide = Math.min(rectWidth(pageRect), rectHeight(pageRect));
  const maxTileGap = Math.max(1.5, minSide * 0.005);
  const maxTileOverlap = 0.1;

  const imageEntries = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (!p?.rect) continue;
    const clipped = intersectRects(p.rect, pageRect);
    if (p.kind === "image" && clipped && rectArea(clipped) > 0) {
      imageEntries.push({ index: i, rect: clipped });
    }
  }

  if (imageEntries.length >= 2) {
    imageEntries.sort((a, b) => a.rect[0] - b.rect[0] || a.index - b.index);
    const parent = imageEntries.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let i = 0; i < imageEntries.length; i++) {
      for (let j = i + 1; j < imageEntries.length; j++) {
        if (imageEntries[j].rect[0] > imageEntries[i].rect[2] + maxTileGap) break;
        if (rectGap(imageEntries[i].rect, imageEntries[j].rect) > maxTileGap) continue;
        const smaller = Math.min(rectArea(imageEntries[i].rect), rectArea(imageEntries[j].rect));
        const inter = intersectRects(imageEntries[i].rect, imageEntries[j].rect);
        const overlapRatio = inter && smaller > 0 ? rectArea(inter) / smaller : 0;
        if (overlapRatio <= maxTileOverlap) {
          const r1 = find(i);
          const r2 = find(j);
          if (r1 !== r2) parent[r2] = r1;
        }
      }
    }

    const groups = new Map();
    for (let i = 0; i < imageEntries.length; i++) {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(imageEntries[i]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let sumArea = 0;
      let union = [...group[0].rect];
      for (const entry of group) {
        sumArea += rectArea(entry.rect);
        union = unionRect(union, entry.rect);
      }
      if (sumArea / pageArea >= minCoverage && rectArea(union) / pageArea >= minCoverage) {
        for (const entry of group) substrateIndexes.add(entry.index);
      }
    }
  }

  return substrateIndexes;
}

/**
 * Multi-criteria standalone image gate matching Zotero Reading Mode:
 * accepts when at least 2 of (width >= 15%, height >= 8%, area >= 1.5%) hold,
 * or when `areaRatio >= unanchoredImageMinAreaRatio`, provided the image does
 * not strongly collide with prose/caption blockers when unanchored.
 */
export function passesStandaloneImageGate(rect, pageRect, textLayout, options = {}) {
  const pageWidth = rectWidth(pageRect);
  const pageHeight = rectHeight(pageRect);
  const pageArea = rectArea(pageRect);
  if (!(pageWidth > 0 && pageHeight > 0 && pageArea > 0)) return false;

  const w = rectWidth(rect);
  const h = rectHeight(rect);
  const area = rectArea(rect);
  const areaRatio = area / pageArea;

  let matches = 0;
  if (w >= pageWidth * (options.standaloneImageMinWidthRatio ?? 0.15)) matches += 1;
  if (h >= pageHeight * (options.standaloneImageMinHeightRatio ?? 0.08)) matches += 1;
  if (areaRatio >= (options.standaloneImageMinAreaRatio ?? 0.015)) matches += 1;

  const sizeOk = matches >= 2 || areaRatio >= options.unanchoredImageMinAreaRatio;
  if (!sizeOk) return false;

  // Reject unanchored graphics that swallow prose/caption text lines.
  if (textLayout?.blockers?.length && blockersIntersectRect(rect, textLayout.blockers)) {
    return false;
  }
  return true;
}

/**
 * Expand candidate/region bounding boxes in all 4 directions into adjacent
 * non-blocker figure labels (Y-axis ticks, rotated Y-axis titles, X-axis ticks
 * and titles, top titles, subfigure `(a)/(b)` labels) without crossing captions
 * or prose blockers and without stealing labels closer to another region.
 *
 * @param {Array<{rect: number[], captionRects?: number[][]}>} targets
 * @param {{blockers: number[][], captionBlockers: number[][], labelCandidates: Array<object>}} textLayout
 * @param {number[]} pageRect
 * @param {object} options
 * @param {{preCaption?: boolean}} [mode]
 * @returns {number} count of regions expanded
 */
export function expandRegionsWithLabels4Way(targets, textLayout, pageRect, options, mode = {}) {
  if (!targets?.length || !textLayout?.labelCandidates?.length) return 0;

  const sideLimit = options.textExpansionPt ?? 24;
  if (!(sideLimit > 0)) return 0;
  const aboveLimit = mode.preCaption ? 12 : (options.textAboveExpansionPt ?? 18);
  const belowLimit = mode.preCaption
    ? (options.textBelowPreCaptionPt ?? 26)
    : (options.textBelowExpansionPt ?? 36);

  const pageWidth = rectWidth(pageRect);
  const pageArea = rectArea(pageRect);
  const midX = (pageRect[0] + pageRect[2]) / 2;
  const borders = targets.map((t) => [...t.rect]);
  // Only genuinely full/two-column spanning figures (extending well into both halves)
  // are allowed to expand on both sides of the page midline; narrower figures stay
  // on their own half so single-column figures never cross the central gutter.
  const twoColSpanFlags = borders.map(
    (b) => rectWidth(b) >= pageWidth * 0.55 && b[0] < midX - 40 && b[2] > midX + 40,
  );
  const used = new Set();
  let grownRegions = 0;

  for (let idx = 0; idx < targets.length; idx++) {
    const region = targets[idx];
    const border = borders[idx];
    const isTwoColSpan = twoColSpanFlags[idx];
    const colSide = Math.sign((border[0] + border[2]) / 2 - midX);
    // Blockers that already graze/intrude into the initial artwork box (e.g.
    // pdf.js caption ascent overlapping the bottom by 2-5 pt) must not freeze
    // expansion along the remaining sides; check only external blockers + lRect.
    const externalBlockers = textLayout.blockers.filter((b) => !rectsOverlap(b, border));
    let grown = false;

    let changed = true;
    while (changed) {
      changed = false;
      let bestIndex = -1;
      let bestDist = Infinity;

      for (let li = 0; li < textLayout.labelCandidates.length; li++) {
        if (used.has(li)) continue;
        const cand = textLayout.labelCandidates[li];
        const lRect = cand.rect;

        const dxLeft = Math.max(0, region.rect[0] - lRect[2]);
        const dxRight = Math.max(0, lRect[0] - region.rect[2]);
        const dyBelow = Math.max(0, region.rect[1] - lRect[3]);
        const dyAbove = Math.max(0, lRect[1] - region.rect[3]);

        // Keep narrower / single-column figures from reaching horizontally across
        // the central page gutter; vertical sub-labels stay aligned with the figure.
        if ((dxLeft > 0 || dxRight > 0) && !isTwoColSpan && colSide !== 0) {
          const labelSide = Math.sign((lRect[0] + lRect[2]) / 2 - midX);
          if (labelSide !== colSide) continue;
        }

        // Must be close along the axis of expansion and aligned along the other.
        const horizOverlap =
          Math.min(border[2] + 12, lRect[2]) - Math.max(border[0] - 12, lRect[0]) > 0;
        const vertOverlap =
          Math.min(border[3] + 8, lRect[3]) - Math.max(border[1] - 8, lRect[1]) > 0;

        if (!horizOverlap && !vertOverlap) continue;
        if ((dxLeft > 0 || dxRight > 0) && !vertOverlap) continue;
        if ((dyBelow > 0 || dyAbove > 0) && !horizOverlap) continue;

        const nextRect = intersectRects(unionRect(region.rect, lRect), pageRect);
        if (!nextRect) continue;
        if (
          rectWidth(nextRect) - rectWidth(region.rect) < 0.5 &&
          rectHeight(nextRect) - rectHeight(region.rect) < 0.5
        ) {
          continue;
        }

        // Respect max expansion budgets measured from the original artwork border.
        if (
          border[0] - nextRect[0] > sideLimit ||
          nextRect[2] - border[2] > sideLimit ||
          nextRect[3] - border[3] > aboveLimit ||
          border[1] - nextRect[1] > belowLimit
        ) {
          continue;
        }
        if (pageArea > 0 && rectArea(nextRect) / pageArea > options.maxAreaRatio) continue;
        const aspect = rectWidth(nextRect) / Math.max(1, rectHeight(nextRect));
        if (aspect < options.minAspect || aspect > options.maxAspect) continue;

        const expandAbove = Math.max(0, nextRect[3] - region.rect[3]);
        const expandBelow = Math.max(0, region.rect[1] - nextRect[1]);
        // Skip minor (<= 2.5 pt) font-ascent overhangs of labels already seated
        // inside the graphic, while still capturing labels that protrude past an edge.
        if (expandAbove > 0 && expandAbove <= 2.5 && lRect[1] < region.rect[3] - 2) continue;
        if (expandBelow > 0 && expandBelow <= 2.5 && lRect[3] > region.rect[1] + 2) continue;

        // Vertical growth must never cross onto the far side of any caption or
        // prose blocker, while preserving edge-straddling and multi-axis labels.
        if (blockersIntersectRect(lRect, textLayout.blockers)) continue;
        if (blockersIntersectRect(nextRect, externalBlockers)) continue;
        if (region.captionRects?.some((cr) => rectsOverlap(lRect, cr))) continue;
        if (expandBelow > 0) {
          const crossedCaption = textLayout.captionBlockers.some(
            (cb) =>
              Math.min(nextRect[2], cb[2]) - Math.max(nextRect[0], cb[0]) > 0 &&
              cb[1] <= border[1] + 8 &&
              lRect[1] < cb[3],
          );
          if (crossedCaption) continue;
        }
        if (expandAbove > 0) {
          const crossedCaption = textLayout.captionBlockers.some(
            (cb) =>
              Math.min(nextRect[2], cb[2]) - Math.max(nextRect[0], cb[0]) > 0 &&
              cb[3] >= border[3] - 8 &&
              lRect[3] > cb[1],
          );
          if (crossedCaption) continue;
        }

        // Closest-region ownership check (prevents stealing another figure's label).
        const dist = rectGap(region.rect, lRect);
        let closerElsewhere = false;
        for (let oi = 0; oi < targets.length; oi++) {
          if (oi === idx) continue;
          if (rectGap(targets[oi].rect, lRect) + 1e-3 < dist) {
            closerElsewhere = true;
            break;
          }
        }
        if (closerElsewhere) continue;

        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = li;
        }
      }

      if (bestIndex < 0) break;
      used.add(bestIndex);
      const chosen = textLayout.labelCandidates[bestIndex].rect;
      const next = intersectRects(unionRect(region.rect, chosen), pageRect);
      if (next) {
        region.rect = next;
        grown = true;
        changed = true;
      }
    }

    if (grown) grownRegions += 1;
  }

  return grownRegions;
}
