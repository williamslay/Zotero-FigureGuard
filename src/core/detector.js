/**
 * Automatic figure detection: XObject placements + caption evidence.
 *
 * Design rules (Stage A spec, section 2):
 *   - Nothing is keyed on a specific resource name, page number or file.
 *   - A Form XObject is not a figure by itself: it needs caption or structure
 *     evidence, otherwise it stays uncovered (a conservative false negative).
 *   - A caption keeps the dark theme and never joins the covered region.
 *   - A full-bleed clip frame is evidence, never extent: it may prove a figure
 *     is there, it never decides how wide the region is.
 */

import { DEFAULT_DETECTOR_OPTIONS, areaRatioOf } from "./detector-options.js";
import {
  analyzePageText,
  blockersIntersectRect,
  clearSightRect,
  expandRegionsWithLabels4Way,
  findPageSubstrateIndexes,
  hasDirectSightValid,
  passesStandaloneImageGate,
} from "./text-layout.js";
import {
  coverageOf,
  expandRect,
  intersectRects,
  iou,
  rectArea,
  rectHeight,
  rectWidth,
  unionRect,
} from "./geom.js";

export { DEFAULT_DETECTOR_OPTIONS, areaRatioOf };

/**
 * Detect figure-like regions on one page.
 *
 * @param {object} input
 * @param {Array<{kind: string, rect: number[], depth?: number, opIndex?: number}>} [input.placements]
 * @param {Array<{number: string, label: string, rect: number[]}>} [input.captions]
 * @param {Array<{transform: ArrayLike<number>}>} [input.textItems] Text items of
 *   the page, used to grow a region over the table or tick-label text that
 *   belongs to it but carries no paint. See `expandRegionsWithText`.
 * @param {Array<{rect: number[], label?: string}>} [input.structRegions] Tagged-PDF
 *   `/Figure` rectangles, when the runtime can provide them.
 * @param {number[]} input.pageRect Page rect in user space, e.g. `[0, 0, 612, 792]`.
 * @param {Partial<typeof DEFAULT_DETECTOR_OPTIONS>} [input.options]
 * @returns {{regions: Array<object>, rejected: Array<object>, diagnostics: object}}
 */
export function detectFigureRegions(input) {
  const options = { ...DEFAULT_DETECTOR_OPTIONS, ...input.options };
  const pageRect = input.pageRect;
  const rawPlacements = input.placements ?? [];
  const captions = input.captions ?? [];
  const structRegions = input.structRegions ?? [];

  if (!Array.isArray(pageRect) || rectArea(pageRect) <= 0) {
    throw new TypeError("detectFigureRegions: pageRect must be a rect with positive area");
  }

  const textLayout = analyzePageText(input.textItems, captions, pageRect, options);
  const substrateIndexes = findPageSubstrateIndexes(rawPlacements, pageRect, options);
  const activePlacements = rawPlacements.filter((_, index) => !substrateIndexes.has(index));

  // Vector art comes in as one placement per painted path. Those boxes are far
  // too fine-grained to judge one by one, so they are chained into clusters
  // first (respecting text-table rules and prose/caption blockers).
  const pathMerge = mergePathPlacements(
    activePlacements.filter((placement) => placement?.kind === "path"),
    pageRect,
    options,
    captions,
    textLayout,
  );
  const basePlacements = [
    ...activePlacements.filter((placement) => placement?.kind !== "path"),
    ...pathMerge.placements,
  ];
  const placements = mergeMixedGraphicComponents(basePlacements, pageRect, textLayout, options);

  const evaluated = placements.map((placement, index) =>
    evaluatePlacement(placement, index, pageRect, options, textLayout),
  );
  // Pre-caption bounded 4-way label expansion pulls tightly adjacent axis ticks
  // and subfigure labels into the artwork box before caption linking, so captions
  // are never stolen by a closer neighbour while separated by axis text.
  const preExpandTargets = evaluated
    .filter((candidate) => candidate.passesBasicFilter && !candidate.fullBleedFrame)
    .map((candidate) => ({ rect: [...candidate.rect], index: candidate.index, captionRects: [] }));
  expandRegionsWithLabels4Way(preExpandTargets, textLayout, pageRect, options, { preCaption: true });
  const preExpandedRectByIndex = new Map(preExpandTargets.map((t) => [t.index, t.rect]));
  const linkRectFor = (candidate) => preExpandedRectByIndex.get(candidate.index) ?? candidate.rect;

  const structTagged = tagStructMatches(evaluated, structRegions);
  // Each placement may support at most one caption. The caption under the
  // figure wins; a caption above it is only used when nothing else links.
  const assignment = new Map();
  for (const caption of captions) {
    for (const candidate of evaluated) {
      if (!candidate.passesBasicFilter) continue;
      const link = linkCaption(caption, linkRectFor(candidate), options, pageRect);
      if (!link) continue;
      const current = assignment.get(candidate.index);
      if (!current || betterLink(link, current)) {
        assignment.set(candidate.index, { caption, gap: link.gap, side: link.side });
      }
    }
  }

  const byCaption = new Map();
  for (const [index, link] of assignment.entries()) {
    const key = captionKey(link.caption);
    if (!byCaption.has(key)) byCaption.set(key, { caption: link.caption, links: [] });
    byCaption.get(key).links.push({
      candidate: evaluated.find((candidate) => candidate.index === index),
      gap: link.gap,
      side: link.side,
    });
  }

  const regions = [];
  const rejected = [];

  for (const { caption, links } of byCaption.values()) {
    const row = pickNearestRow(links, caption.rect, options);
    if (!row.length) continue;
    // Placements that linked here but fell outside the selected row are dropped
    // from the region; without a record they vanish from the diagnostics too.
    const kept = new Set(row.map((item) => item.candidate.index));
    for (const link of links) {
      if (!kept.has(link.candidate.index)) rejected.push(reject(link.candidate, "dropped-row", 0));
    }
    const rect = row.reduce(
      (acc, item) => unionRect(acc, item.candidate.rect),
      [...row[0].candidate.rect],
    );
    const sourceKinds = row.flatMap((item) => item.candidate.sourceKinds ?? [item.candidate.kind]);
    const score = scoreRegion({
      kinds: sourceKinds,
      caption,
      link: row[0],
      rect,
      pageRect,
      structTagged: row.some((item) => structTagged.has(item.candidate.index)),
      options,
    });
    regions.push(buildRegion(rect, score, row.length, row.map((item) => item.candidate.index), options));
  }

  // Tagged structures with no matching XObject: the text-derived rect is still
  // better than nothing, at reduced confidence.
  for (const struct of structRegions) {
    if (struct.matchedPlacement) continue;
    const ratio = areaRatioOf(struct.rect, pageRect);
    if (ratio < options.minAreaRatio || ratio > options.maxAreaRatio) continue;
    const score = scoreRegion({
      kinds: ["struct"],
      caption: struct.caption ?? null,
      link: null,
      rect: struct.rect,
      pageRect,
      structTagged: true,
      options,
    });
    regions.push(buildRegion(struct.rect, score, 0, [], options));
  }

  // Placements that failed only the standalone-area gate are set aside rather
  // than rejected outright: their paint may belong to a figure that was
  // accepted through caption evidence, in which case the region border was
  // simply cut too short and absorption can fix it.
  const areaRejected = [];

  for (const candidate of evaluated) {
    if (assignment.has(candidate.index) || structTagged.has(candidate.index)) continue;
    if (!candidate.passesBasicFilter) {
      rejected.push(reject(candidate, candidate.rejectReason, 0));
      continue;
    }
    if (candidate.kind !== "image") {
      if (candidate.kind === "path") {
        if (candidate.areaRatio < options.pathAnchoredAreaRatio) {
          areaRejected.push({ candidate, reason: "path-below-area-threshold" });
          continue;
        }
        // Academic papers do not contain standalone vector figures on pages
        // without any Figure caption; requiring a page Figure caption prevents
        // tables, boxed notes, or rules from becoming false positives.
        if (!captions.length) {
          rejected.push(reject(candidate, "no-figure-caption-on-page", 0));
          continue;
        }
        if (isInsideTableCaptionRegion(candidate.rect, textLayout, captions)) {
          rejected.push(reject(candidate, "table-or-algorithm-region", 0));
          continue;
        }
        const score = scoreRegion({
          kinds: candidate.sourceKinds ?? ["path"],
          caption: null,
          link: null,
          rect: candidate.rect,
          pageRect,
          structTagged: false,
          standalonePath: true,
          options,
        });
        regions.push(buildRegion(candidate.rect, score, 1, [candidate.index], options));
        continue;
      }
      const score = scoreRegion({
        kinds: candidate.sourceKinds ?? [candidate.kind],
        caption: null,
        link: null,
        rect: candidate.rect,
        pageRect,
        structTagged: false,
        options,
      });
      rejected.push(reject(candidate, "no-figure-evidence", score.confidence));
      continue;
    }
    if (!passesStandaloneImageGate(candidate.rect, pageRect, textLayout, options)) {
      areaRejected.push({ candidate, reason: "image-below-area-threshold" });
      continue;
    }
    const score = scoreRegion({
      kinds: candidate.sourceKinds ?? ["image"],
      caption: null,
      link: null,
      rect: candidate.rect,
      pageRect,
      structTagged: false,
      standaloneImage: true,
      options,
    });
    regions.push(buildRegion(candidate.rect, score, 1, [candidate.index], options));
  }

  const merged = mergeRegions(regions.filter((region) => region.accepted));
  let unabsorbed = absorbAreaRejected(merged, areaRejected, options, pageRect);
  const absorbedRejectedRegions = new Set();
  unabsorbed = mergeStackedUpperBands(
    merged,
    regions,
    unabsorbed,
    absorbedRejectedRegions,
    textLayout,
    pageRect,
    options,
  );
  const textExpansion = expandRegionsWithLabels4Way(merged, textLayout, pageRect, options);

  for (const region of regions) {
    if (region.accepted || absorbedRejectedRegions.has(region)) continue;
    rejected.push({
      index: region.placementIndexes[0] ?? null,
      kind: region.kind,
      rect: region.rect,
      reason: region.rejectReason,
      confidence: region.confidence,
    });
  }
  for (const entry of unabsorbed) {
    rejected.push(reject(entry.candidate, entry.reason, 0));
  }
  merged.sort((a, b) => {
    if (Math.abs(b.rect[3] - a.rect[3]) > 1) return b.rect[3] - a.rect[3];
    return a.rect[0] - b.rect[0];
  });

  for (const region of merged) {
    region.pageAreaRatio = round(areaRatioOf(region.rect, pageRect), 4);
  }

  return {
    regions: merged,
    rejected,
    diagnostics: {
      placementCount: placements.length,
      rawPlacementCount: rawPlacements.length,
      captionCount: captions.length,
      structRegionCount: structRegions.length,
      rawPathBoxCount: pathMerge.diagnostics.rawPathBoxCount,
      pathBoxCount: pathMerge.diagnostics.pathBoxCount,
      pathMergePasses: pathMerge.diagnostics.pathMergePasses,
      pathBoxesTruncated: pathMerge.diagnostics.pathBoxesTruncated,
      pathBoxesOffPage: pathMerge.diagnostics.pathBoxesOffPage,
      pathClusterSplits: pathMerge.diagnostics.pathClusterSplits,
      textExpandedRegions: textExpansion,
      evaluated,
    },
  };
}

/**
 * Chain painted-path boxes that are close together into figure-sized candidates.
 *
 * A plot is drawn as hundreds of separate paths: one per axis tick, grid line,
 * curve and label box. Individually they are all noise; together they are the
 * figure. Two boxes join when the horizontal *and* vertical distance between
 * them is within the tolerance, and the merge is repeated until nothing changes
 * so a chain of panels becomes one cluster.
 *
 * Full-bleed clip frames - the `re` rectangle a figure is drawn inside - are
 * chained neither into the artwork nor across it: see `pathFullBleedAreaRatio`.
 * They are re-attached afterwards as evidence, so a page whose only painted
 * geometry is its frame still yields one anchorable box.
 *
 * @param {Array<{rect: number[], opIndex?: number, depth?: number}>} paths
 * @param {number[]} pageRect
 * @param {object} options
 * @param {Array<{rect: number[]}>} [captions] Caption rows, used to split a
 *   cluster that two stacked figures were chained into.
 * @returns {{placements: Array<object>, diagnostics: object}}
 */
function isThinRuleRect(rect) {
  const w = rectWidth(rect);
  const h = rectHeight(rect);
  const minS = Math.min(w, h);
  const maxS = Math.max(w, h);
  // Tiny markers/scatter dots (e.g. 1.2 x 1.3 pt) are plot glyphs, not table rules.
  return minS <= 4 && maxS >= 12;
}

function mergePathPlacements(paths, pageRect, options, captions, textLayout) {
  const usable = [];
  let offPageDropped = 0;
  for (const placement of paths ?? []) {
    const rect = placement?.rect;
    const visibilityRect = placement?.rawRect ?? rect;
    if (!Array.isArray(rect) || rect.some((value) => !Number.isFinite(value))) continue;
    if (rectArea(rect) <= 0) continue;
    const visible = intersectRects(visibilityRect, pageRect);
    if (!visible) continue;
    if (rectArea(visible) / rectArea(visibilityRect) < options.pathMinVisibleAreaRatio) {
      offPageDropped += 1;
      continue;
    }
    const clipped = intersectRects(rect, pageRect);
    if (!clipped) continue;
    usable.push({
      rect: [...clipped],
      raw: [...visibilityRect],
      mergedCount: 1,
      onlyThinRules: isThinRuleRect(clipped),
      members: [[...clipped]],
      opIndex: placement.opIndex ?? null,
      depth: placement.depth ?? 0,
    });
  }

  const pageArea = rectArea(pageRect);
  const pageWidth = rectWidth(pageRect);
  const isFullBleedFrame = pageArea > 0 && pageWidth > 0
    ? (box) => rectArea(box.raw) >= options.pathFullBleedAreaRatio * pageArea
      && rectWidth(box.raw) >= options.pathFullBleedWidthRatio * pageWidth
    : () => false;
  const frames = [];
  const artwork = [];
  for (const box of usable) (isFullBleedFrame(box) ? frames : artwork).push(box);

  const cap = Math.max(0, options.maxPathBoxesPerPage);
  const prepared = artwork.length > cap
    ? coalesceDenseArtwork(artwork, cap, pageRect, textLayout)
    : artwork;
  const truncated = Math.max(0, prepared.length - cap);
  let boxes = prepared.slice(0, cap);
  const tolerance = options.pathMergeGapDiagonalRatio * pageDiagonal(pageRect);
  let passes = 0;
  while (tolerance > 0 && passes < options.pathMergeMaxPasses && boxes.length > 1) {
    const next = mergePass(boxes, tolerance, textLayout);
    passes += 1;
    if (next.length === boxes.length) break;
    boxes = next;
  }

  boxes = mergePanelGrids(boxes, pageRect, options, textLayout);

  const split = splitAtInteriorCaptions(boxes, captions ?? [], pageRect, tolerance, options);

  const unmatchedFrames = frames
    .filter((frame) => !split.boxes.some((box) => gapWithin(box.rect, frame.rect, tolerance)))
    .map((frame) => ({ ...frame, fullBleedFrame: true }));
  const emitted = [...split.boxes, ...unmatchedFrames];

  return {
    placements: emitted.map((box) => ({
      kind: "path",
      rect: box.rect,
      depth: box.depth,
      opIndex: box.opIndex,
      mergedCount: box.mergedCount,
      onlyThinRules: Boolean(box.onlyThinRules),
      fullBleedFrame: Boolean(box.fullBleedFrame),
    })),
    diagnostics: {
      rawPathBoxCount: (paths ?? []).length,
      pathBoxCount: emitted.length,
      pathMergePasses: passes,
      pathBoxesTruncated: truncated,
      pathBoxesOffPage: offPageDropped,
      pathClusterSplits: split.splits,
    },
  };
}

/**
 * Linear-time pre-coalescing for pages whose vector density exceeds
 * `maxPathBoxesPerPage` (e.g. scatter/line plots with thousands of tiny markers).
 * Folds micro-paths contained inside existing artwork frames and coalesces
 * adjacent stream-order strokes without dropping later figures on the page.
 */
function coalesceDenseArtwork(artwork, cap, pageRect, textLayout) {
  const pageArea = rectArea(pageRect);
  const minContainerArea = 0.005 * pageArea;
  const blockers = textLayout?.proseBlockers ?? [];
  const containers = [];
  const cloned = artwork.map((box) => {
    const copy = {
      ...box,
      rect: [...box.rect],
      raw: [...box.raw],
      members: box.members.map((m) => [...m]),
    };
    if (!copy.onlyThinRules && rectArea(copy.rect) >= minContainerArea) {
      containers.push(copy);
    }
    return copy;
  });

  const kept = [];
  for (const box of cloned) {
    if (
      !box.onlyThinRules &&
      rectArea(box.rect) < minContainerArea &&
      containers.some(
        (c) =>
          c !== box &&
          box.rect[0] >= c.rect[0] - 1 &&
          box.rect[1] >= c.rect[1] - 1 &&
          box.rect[2] <= c.rect[2] + 1 &&
          box.rect[3] <= c.rect[3] + 1,
      )
    ) {
      const host = containers.find(
        (c) =>
          c !== box &&
          box.rect[0] >= c.rect[0] - 1 &&
          box.rect[1] >= c.rect[1] - 1 &&
          box.rect[2] <= c.rect[2] + 1 &&
          box.rect[3] <= c.rect[3] + 1,
      );
      host.mergedCount += box.mergedCount;
      continue;
    }
    kept.push(box);
  }

  if (kept.length <= cap) return kept;

  const folded = [];
  for (const box of kept) {
    const prev = folded[folded.length - 1];
    if (
      prev &&
      !prev.onlyThinRules &&
      !box.onlyThinRules &&
      rectArea(box.rect) < minContainerArea &&
      rectArea(prev.rect) < optionsMaxStreamCoalesceArea(pageArea) &&
      gapWithin(prev.rect, box.rect, 6) &&
      (!blockers.length || hasDirectSightValid(prev.rect, box.rect, blockers))
    ) {
      prev.rect = unionRect(prev.rect, box.rect);
      prev.mergedCount += box.mergedCount;
      prev.members.push(...box.members);
      continue;
    }
    folded.push(box);
  }
  return folded;
}

function optionsMaxStreamCoalesceArea(pageArea) {
  return 0.15 * pageArea;
}

/**
 * Whether an isolated thin line/rule cluster (`onlyThinRules`) may merge with
 * a non-thin graphic cluster. Prevents adjacent-column table rules from bridging
 * across a gutter along their long axis, and rejects disjoint rules separated
 * from the graphic by any text (e.g. booktabs table rows).
 */
function thinRuleCanJoinCluster(thin, other, blockers, allText) {
  if (blockers.length && !hasDirectSightValid(thin, other, blockers)) return false;
  const overlaps = !(
    other[0] > thin[2] ||
    other[2] < thin[0] ||
    other[1] > thin[3] ||
    other[3] < thin[1]
  );
  if (overlaps) return true;

  const w = rectWidth(thin);
  const h = rectHeight(thin);
  const dx = Math.max(other[0] - thin[2], thin[0] - other[2], 0);
  const dy = Math.max(other[1] - thin[3], thin[1] - other[3], 0);
  if (h <= 4 && w >= 16 && dx > 4) return false;
  if (w <= 4 && h >= 16 && dy > 4) return false;

  if (allText.length && !hasDirectSightValid(thin, other, allText)) return false;
  return true;
}

/** One transitive merge sweep over the current boxes. */
function mergePass(boxes, tolerance, textLayout) {
  const parent = boxes.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const blockers = textLayout?.proseBlockers ?? [];
  const allText = textLayout?.allTextRects ?? [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const left = find(i);
      const right = find(j);
      if (left === right) continue;
      if (!gapWithin(boxes[left].rect, boxes[right].rect, tolerance)) continue;
      const bridge = unionRect(boxes[left].rect, boxes[right].rect);
      // Thin horizontal/vertical table rules separated by text rows must never
      // bridge across table text, nor join a neighboring 2D figure cluster across
      // a collinear gap or text corridor.
      if (boxes[left].onlyThinRules && boxes[right].onlyThinRules) {
        if (!clearSightRect(bridge, allText)) continue;
      } else if (boxes[left].onlyThinRules || boxes[right].onlyThinRules) {
        const thin = boxes[left].onlyThinRules ? boxes[left].rect : boxes[right].rect;
        const other = boxes[left].onlyThinRules ? boxes[right].rect : boxes[left].rect;
        if (!thinRuleCanJoinCluster(thin, other, blockers, allText)) continue;
      } else if (blockers.length && !hasDirectSightValid(boxes[left].rect, boxes[right].rect, blockers)) {
        continue;
      }
      parent[right] = left;
    }
  }

  const groups = new Map();
  for (const [index, box] of boxes.entries()) {
    const root = find(index);
    const group = groups.get(root);
    if (!group) {
      groups.set(root, {
        rect: [...box.rect],
        mergedCount: box.mergedCount,
        onlyThinRules: Boolean(box.onlyThinRules),
        members: box.members ? box.members.map((member) => [...member]) : [[...box.rect]],
        opIndex: box.opIndex,
        depth: box.depth,
      });
      continue;
    }
    group.rect = unionRect(group.rect, box.rect);
    group.mergedCount += box.mergedCount;
    group.onlyThinRules = Boolean(group.onlyThinRules && box.onlyThinRules);
    for (const member of box.members ?? [box.rect]) group.members.push([...member]);
    if (box.opIndex != null && (group.opIndex == null || box.opIndex < group.opIndex)) {
      group.opIndex = box.opIndex;
    }
    group.depth = Math.min(group.depth, box.depth);
  }
  return [...groups.values()];
}

/**
 * Merge adjacent raster image tiles and small surrounding path strokes with an
 * image or form when there is clear sight (no prose/caption blocker between).
 */
function mergeMixedGraphicComponents(placements, pageRect, textLayout, options) {
  const gap = options.mixedGraphicGapPt ?? 12;
  if (!placements.length || !(gap >= 0)) return placements;

  const pageArea = rectArea(pageRect);
  const blockers = textLayout?.blockers ?? [];
  const items = placements.map((p, idx) => ({
    ...p,
    idx,
    sourceKinds: [p.kind],
    areaRatio: pageArea > 0 ? rectArea(p.rect) / pageArea : 0,
    active: true,
  }));

  const canMerge = (a, b) => {
    if (a.fullBleedFrame || b.fullBleedFrame) return false;
    if (a.onlyThinRules && b.onlyThinRules) return false;
    if (a.kind === "path" && b.kind === "path") return false;
    const kinds = new Set([...a.sourceKinds, ...b.sourceKinds]);
    // Do not merge two independent standalone Forms (e.g. side-by-side subfigures
    // each with its own caption); only merge image tiles, image+path, or form+small-path.
    const bothStandaloneForms =
      a.kind === "form" && b.kind === "form";
    if (bothStandaloneForms) return false;
    const twoSeparateLargeGraphics =
      a.kind !== "path" &&
      b.kind !== "path" &&
      !(a.kind === "image" && b.kind === "image" && gapWithin(a.rect, b.rect, 4));
    if (twoSeparateLargeGraphics && !kinds.has("path")) return false;
    if (a.kind === "form" && b.kind === "path" && b.areaRatio >= options.pathAnchoredAreaRatio) {
      return false;
    }
    if (b.kind === "form" && a.kind === "path" && a.areaRatio >= options.pathAnchoredAreaRatio) {
      return false;
    }
    const maxGap = a.kind === "image" && b.kind === "image" ? Math.min(gap, 4) : gap;
    if (!gapWithin(a.rect, b.rect, maxGap)) return false;
    if (blockers.length && !hasDirectSightValid(a.rect, b.rect, blockers)) return false;
    const combined = unionRect(a.rect, b.rect);
    if (blockersIntersectRect(combined, blockers)) return false;
    return !(pageArea > 0 && rectArea(combined) / pageArea > options.maxAreaRatio);
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].active) continue;
      for (let j = i + 1; j < items.length; j++) {
        if (!items[j].active) continue;
        if (!canMerge(items[i], items[j])) continue;
        const a = items[i];
        const b = items[j];
        a.rect = unionRect(a.rect, b.rect);
        a.sourceKinds = [...new Set([...a.sourceKinds, ...b.sourceKinds])];
        if (a.kind !== "image" && b.kind === "image") a.kind = "image";
        a.onlyThinRules = Boolean(a.onlyThinRules && b.onlyThinRules);
        a.areaRatio = pageArea > 0 ? rectArea(a.rect) / pageArea : 0;
        b.active = false;
        changed = true;
      }
    }
  }
  return items.filter((item) => item.active);
}

/**
 * Chain the equal-size, axis-aligned panels of a subfigure grid into one
 * candidate. Two clusters are peers when both are below
 * `pathAnchoredAreaRatio` (only clusters that could never stand alone merge),
 * their widths and heights agree within `panelSizeToleranceRatio`, they
 * overlap at least `panelAlignOverlapRatio` of the shorter side along the
 * shared axis, and the edge-to-edge gap along the other axis is at most
 * `panelPeerGapPt`. Transitive, like the generic sweep, so a 3x2 grid of
 * panels becomes a single figure.
 *
 * @param {Array<object>} boxes Cluster boxes carrying `members`.
 * @param {number[]} pageRect
 * @param {object} options
 * @returns {Array<object>} boxes with panel grids chained
 */
function mergePanelGrids(boxes, pageRect, options, textLayout) {
  if (boxes.length < 2 || !(options.panelPeerGapPt > 0)) return boxes;
  const small = boxes.map((box) => {
    if (box.onlyThinRules || areaRatioOf(box.rect, pageRect) >= options.pathAnchoredAreaRatio) {
      return false;
    }
    const w = rectWidth(box.rect);
    const h = rectHeight(box.rect);
    const minS = Math.min(w, h);
    const aspect = w / Math.max(1, h);
    // Shaded table-row header bars (e.g. 394 x 8 pt) are not 2D subfigure panels.
    return minS >= 14 && aspect >= options.minAspect && aspect <= options.maxAspect;
  });
  const blockers = textLayout?.blockers ?? [];
  const parent = boxes.map((_, index) => index);
  const find = (index) => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < boxes.length; i++) {
    if (!small[i]) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      if (!small[j]) continue;
      const left = find(i);
      const right = find(j);
      if (left === right) continue;
      // Peer test on the ORIGINAL panel rects: a chained group's union is
      // wider than one panel and would fail the equal-size test against the
      // next panel, stalling the sweep halfway across the grid.
      if (
        panelPeer(boxes[i].rect, boxes[j].rect, options) &&
        (!blockers.length || hasDirectSightValid(boxes[i].rect, boxes[j].rect, blockers))
      ) {
        parent[right] = left;
      }
    }
  }

  const groups = new Map();
  for (const [index, box] of boxes.entries()) {
    const root = find(index);
    const group = groups.get(root);
    if (!group) {
      groups.set(root, {
        rect: [...box.rect],
        mergedCount: box.mergedCount,
        onlyThinRules: Boolean(box.onlyThinRules),
        members: box.members ? box.members.map((member) => [...member]) : [[...box.rect]],
        opIndex: box.opIndex,
        depth: box.depth,
      });
      continue;
    }
    group.rect = unionRect(group.rect, box.rect);
    group.mergedCount += box.mergedCount;
    group.onlyThinRules = Boolean(group.onlyThinRules && box.onlyThinRules);
    for (const member of box.members ?? [box.rect]) group.members.push([...member]);
    if (box.opIndex != null && (group.opIndex == null || box.opIndex < group.opIndex)) {
      group.opIndex = box.opIndex;
    }
    group.depth = Math.min(group.depth, box.depth);
  }
  return [...groups.values()];
}

/** Would these two rects be two panels of one grid? See `mergePanelGrids`. */
function panelPeer(a, b, options) {
  const aw = rectWidth(a);
  const ah = rectHeight(a);
  const bw = rectWidth(b);
  const bh = rectHeight(b);
  const sizeTolerance = options.panelSizeToleranceRatio;
  if (Math.abs(aw - bw) > sizeTolerance * Math.max(aw, bw)) return false;
  if (Math.abs(ah - bh) > sizeTolerance * Math.max(ah, bh)) return false;
  const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const gapX = Math.max(b[0] - a[2], a[0] - b[2], 0);
  const gapY = Math.max(b[1] - a[3], a[1] - b[3], 0);
  const align = options.panelAlignOverlapRatio;
  if (overlapY >= align * Math.min(ah, bh)) return gapX <= options.panelPeerGapPt;
  if (overlapX >= align * Math.min(aw, bw)) return gapY <= options.panelPeerGapPt;
  return false;
}

/**
 * Split over-merged path clusters along caption rows that lie inside them.
 *
 * A caption row wholly or mostly inside a cluster's y-range, with real
 * horizontal overlap, is the layout evidence that two figures were chained
 * together (Borges fixture page 12: a 13.2 pt gap between two figure bands,
 * below the 18.02 pt merge tolerance). Each accepted split re-runs the normal
 * merge sweep inside both resulting bands so their borders are computed the
 * same way as any other cluster.
 *
 * @param {Array<object>} boxes Merged cluster boxes, each carrying `members`.
 * @param {Array<{rect: number[]}>} captions
 * @param {number[]} pageRect
 * @param {number} tolerance Same tolerance as the merge sweep, used again inside a band.
 * @param {object} options
 * @returns {{boxes: Array<object>, splits: number}}
 */
function splitAtInteriorCaptions(boxes, captions, pageRect, tolerance, options) {
  if (!boxes.some((box) => (box.members?.length ?? 0) > 1)) {
    return { boxes, splits: 0 };
  }
  const queue = [...boxes];
  const out = [];
  let splits = 0;
  let guard = options.pathMergeMaxPasses;
  while (queue.length) {
    const cluster = queue.shift();
    const rows = findInteriorCaptionRows(cluster.rect, captions, options);
    if (!rows.length || guard-- <= 0) {
      out.push(cluster);
      continue;
    }
    // Splitting at the row closest to the cluster's vertical centre first
    // separates the two figures a caption sits between; deeper rows are found
    // by the next pass over the resulting bands.
    const row = rows.reduce((best, other) =>
      slabCentreDistance(cluster.rect, other) < slabCentreDistance(cluster.rect, best) ? other : best,
    );
    const bands = splitMembersAtSlab(cluster.members, row, options);
    if (!bands[0].length || !bands[1].length) {
      out.push(cluster);
      continue;
    }
    const parts = [
      ...mergeMembers(bands[0], cluster, tolerance, options.pathMergeMaxPasses),
      ...mergeMembers(bands[1], cluster, tolerance, options.pathMergeMaxPasses),
    ];
    // Anti-loss guard: a band that is too thin, or that neither links a
    // caption nor clears the anchored-area gate, was not a figure of its own;
    // merging back keeps the cluster whole.
    if (!parts.every((part) => splitBandIsValid(part, captions, pageRect, options))) {
      out.push(cluster);
      continue;
    }
    splits += 1;
    queue.push(...parts);
  }
  return { boxes: out, splits };
}

/**
 * Merge a band's member rects into clusters with the standard sweep. Iterated
 * like the main merge: after the slab split, members that used to be chained
 * through the other band's boxes need a second sweep over the group rects
 * before the band converges (one pass left Borges page 12's lower band in
 * three overlapping groups).
 */
function mergeMembers(members, cluster, tolerance, maxPasses) {
  if (!members.length) return [];
  let boxes = members.map((rect) => ({
    rect,
    mergedCount: 1,
    members: [rect],
    opIndex: cluster.opIndex,
    depth: cluster.depth,
  }));
  let passes = 0;
  while (tolerance > 0 && passes < maxPasses && boxes.length > 1) {
    const next = mergePass(boxes, tolerance);
    passes += 1;
    if (next.length === boxes.length) break;
    boxes = next;
  }
  return boxes;
}

function splitBandIsValid(band, captions, pageRect, options) {
  if (!band.members?.length) return false;
  if (band.rect[3] - band.rect[1] < options.minSidePt) return false;
  if (areaRatioOf(band.rect, pageRect) >= options.pathAnchoredAreaRatio) return true;
  return captions.some((caption) => linkCaption(caption, band.rect, options, pageRect));
}

function slabCentreDistance(rect, slab) {
  return Math.abs((rect[1] + rect[3]) / 2 - (slab[1] + slab[3]) / 2);
}

/**
 * Partition member rects at a caption row's own y-slab: members fully below
 * the slab and members fully above it land in their own band; a member that
 * overlaps the slab is cut with the slab, and each side keeps the part of it
 * that lies outside. A part thinner than `minSidePt` is dropped, because it is
 * a rule or a descender inside the caption row rather than artwork.
 *
 * The whole rect used to be routed to the side holding the larger part, which
 * is what left the FluidKV fixture page 5 with a band of [354.43, 580, 533.86,
 * 601.1]: a frame that started 8 pt above the row was handed to the band below
 * it and inflated a 21 pt sliver into a "figure". Cutting it keeps each band
 * to the paint that is actually on its side.
 */
function splitMembersAtSlab(members, slab, options) {
  const minSide = options?.minSidePt ?? DEFAULT_DETECTOR_OPTIONS.minSidePt;
  const below = [];
  const above = [];
  for (const member of members ?? []) {
    if (member[3] <= slab[1]) below.push(member);
    else if (member[1] >= slab[3]) above.push(member);
    else {
      const under = [member[0], member[1], member[2], slab[1]];
      const over = [member[0], slab[3], member[2], member[3]];
      if (slab[1] - member[1] >= minSide) below.push(under);
      if (member[3] - slab[3] >= minSide) above.push(over);
    }
  }
  return [below, above];
}

/**
 * Caption rows that separate figures inside `clusterRect`: the row must be
 * interior to the cluster's vertical span — clearing both edges by
 * `maxCaptionOverlapPt`, the same tolerance `linkCaption` grants a caption box
 * that grazes the artwork above it — and overlap it horizontally by
 * `minCaptionOverlapRatio`, the same fraction `linkCaption` demands for
 * linking. Exported so fixture tests can prove a page has no such row.
 *
 * @param {number[]} clusterRect Cluster rect in user space.
 * @param {Array<{rect: number[]}>} captions
 * @param {object} options
 * @returns {Array<number[]>} The qualifying caption rects.
 */
export function findInteriorCaptionRows(clusterRect, captions, options = DEFAULT_DETECTOR_OPTIONS) {
  const inset = options.maxCaptionOverlapPt;
  const rows = [];
  for (const caption of captions ?? []) {
    const row = caption?.rect;
    if (!Array.isArray(row) || row.some((value) => !Number.isFinite(value))) continue;
    if (row[1] <= clusterRect[1] + inset || row[3] >= clusterRect[3] - inset) continue;
    const overlap = intersectRects(
      [clusterRect[0], -1e6, clusterRect[2], 1e6],
      [row[0], -1e6, row[2], 1e6],
    );
    const overlapWidth = overlap ? overlap[2] - overlap[0] : 0;
    if (overlapWidth < options.minCaptionOverlapRatio * Math.min(rectWidth(row), rectWidth(clusterRect)))
      continue;
    rows.push(row);
  }
  return rows;
}

/**
 * Shortest distance between two rects, per axis. Both distances must be within
 * the tolerance: a box far to the side is a different figure even when it is on
 * the same line.
 */
function gapWithin(a, b, tolerance) {
  const gapX = Math.max(b[0] - a[2], a[0] - b[2], 0);
  const gapY = Math.max(b[1] - a[3], a[1] - b[3], 0);
  return gapX <= tolerance && gapY <= tolerance;
}

function pageDiagonal(pageRect) {
  return Math.hypot(Math.abs(pageRect[2] - pageRect[0]), Math.abs(pageRect[3] - pageRect[1]));
}

function evaluatePlacement(placement, index, pageRect, options, textLayout = null) {
  const rect = placement.rect;
  const base = {
    index,
    kind: placement.kind ?? "unknown",
    sourceKinds: placement.sourceKinds ?? [placement.kind ?? "unknown"],
    fullBleedFrame: Boolean(placement.fullBleedFrame),
    rect,
    depth: placement.depth ?? 0,
    opIndex: placement.opIndex ?? null,
    areaRatio: 0,
    minSide: 0,
    aspect: 0,
    passesBasicFilter: true,
    rejectReason: null,
  };
  if (!Array.isArray(rect) || rect.some((value) => !Number.isFinite(value))) {
    return { ...base, passesBasicFilter: false, rejectReason: "invalid-rect" };
  }
  const area = rectArea(rect);
  const ratio = areaRatioOf(rect, pageRect);
  const width = rectWidth(rect);
  const height = rectHeight(rect);
  const detail = {
    ...base,
    areaRatio: ratio,
    minSide: Math.min(width, height),
    aspect: width / height,
  };
  if (area <= 0) return { ...detail, passesBasicFilter: false, rejectReason: "empty-rect" };
  if (!intersectRects(rect, pageRect)) {
    return { ...detail, passesBasicFilter: false, rejectReason: "off-page" };
  }
  if (placement.onlyThinRules && textLayout?.allTextRects?.length && blockersIntersectRect(rect, textLayout.allTextRects)) {
    return { ...detail, passesBasicFilter: false, rejectReason: "thin-decoration" };
  }
  if (ratio < options.minAreaRatio) {
    return { ...detail, passesBasicFilter: false, rejectReason: "below-min-area" };
  }
  if (ratio > options.maxAreaRatio) {
    return { ...detail, passesBasicFilter: false, rejectReason: "page-sized" };
  }
  if (detail.minSide < options.minSidePt) {
    return { ...detail, passesBasicFilter: false, rejectReason: "thin-decoration" };
  }
  if (detail.aspect < options.minAspect || detail.aspect > options.maxAspect) {
    return { ...detail, passesBasicFilter: false, rejectReason: "extreme-aspect" };
  }
  return detail;
}

function reject(candidate, reason, confidence) {
  return {
    index: candidate.index,
    kind: candidate.kind,
    rect: candidate.rect,
    reason,
    confidence: round(confidence, 3),
  };
}

/**
 * Ordering for "which caption does this placement belong to": the standard
 * layout (figure above its caption) beats a closer caption placed above the
 * figure, then the smaller gap wins.
 */
function betterLink(link, current) {
  if (link.side === "above" && current.side !== "above") return true;
  if (link.side !== "above" && current.side === "above") return false;
  return link.gap < current.gap;
}

/**
 * Is this placement anchored to this caption?
 * `side` is "above" (normal layout) or "below".
 *
 * A caption's reported rect includes the font's ascent and descent, so its box
 * typically reaches a few points into the artwork directly above it. An
 * intrusion of up to one caption row height (capped by `maxCaptionOverlapPt`)
 * therefore counts as a touching caption, scored with a zero gap.
 *
 * The gap limit grows with the width of the wider of the two boxes (see
 * `captionGapWidthAllowanceFactor`): a caption set under a row of subfigures is
 * as wide as the row, and the vertical distance from its last baseline to the
 * artwork above it is then several lines rather than a fraction of one.
 *
 * @param {{rect: number[]}} caption
 * @param {number[]} rect Placement or band rect in user space.
 * @param {object} options
 * @param {number[]} pageRect Page rect, for the width-normalised gap allowance.
 * @returns {{gap: number, side: "above"|"below"}|null}
 */
function linkCaption(caption, rect, options, pageRect) {
  const overlap = intersectRects(
    [rect[0], -1e6, rect[2], 1e6],
    [caption.rect[0], -1e6, caption.rect[2], 1e6],
  );
  const overlapWidth = overlap ? overlap[2] - overlap[0] : 0;
  const needed =
    options.minCaptionOverlapRatio * Math.min(rectWidth(caption.rect), rectWidth(rect));
  if (overlapWidth < needed) return null;

  const maxOverlap = Math.min(rectHeight(caption.rect), options.maxCaptionOverlapPt);
  const pageWidth = Math.abs(pageRect[2] - pageRect[0]);
  const gapAllow =
    options.maxCaptionGapPt +
    (pageWidth > 0
      ? (options.captionGapWidthAllowanceFactor *
          Math.max(rectWidth(caption.rect), rectWidth(rect))) /
          pageWidth
      : 0);
  // In user space larger y means higher on the page.
  const gapAbove = rect[1] - caption.rect[3];
  if (gapAbove >= -maxOverlap && gapAbove <= gapAllow) {
    return { gap: Math.max(0, gapAbove), side: "above" };
  }
  const gapBelow = caption.rect[1] - rect[3];
  if (gapBelow >= -maxOverlap && gapBelow <= gapAllow) {
    return { gap: Math.max(0, gapBelow) + 1, side: "below" };
  }
  return null;
}

/**
 * A caption may describe a row of side-by-side subfigures. Keep only the row
 * closest to the caption so a neighbouring column is not swallowed.
 */
function pickNearestRow(links, captionRect, options) {
  if (!links.length) return [];
  const sorted = [...links].sort((a, b) => a.candidate.rect[1] - b.candidate.rect[1]);
  const rows = [];
  for (const link of sorted) {
    const current = rows.at(-1);
    const touches =
      current &&
      link.candidate.rect[1] <= current.top + options.rowMergeGapPt &&
      link.candidate.rect[3] >= current.bottom - options.rowMergeGapPt;
    if (touches) {
      current.items.push(link);
      current.top = Math.max(current.top, link.candidate.rect[3]);
      current.bottom = Math.min(current.bottom, link.candidate.rect[1]);
      continue;
    }
    rows.push({
      items: [link],
      top: link.candidate.rect[3],
      bottom: link.candidate.rect[1],
      standardSide: link.side === "above",
    });
  }
  // Captions go under their figure in most papers, so a row above the caption
  // wins over a closer row below it. The reversed layout is only a fallback.
  const candidates = rows.some((row) => row.standardSide)
    ? rows.filter((row) => row.standardSide)
    : rows;
  let best = candidates[0];
  let bestGap = rowGap(best, captionRect, options);
  for (const row of candidates.slice(1)) {
    const gap = rowGap(row, captionRect, options);
    if (gap < bestGap) {
      best = row;
      bestGap = gap;
    }
  }
  return best.items;
}

/**
 * Distance between a candidate row and its caption, both in user space. An
 * intrusion of the caption box into the row, within the linking tolerance of
 * `linkCaption`, counts as zero so row selection agrees with link selection.
 */
function rowGap(row, captionRect, options) {
  const maxOverlap = Math.min(rectHeight(captionRect), options.maxCaptionOverlapPt);
  const gapAbove = row.bottom - captionRect[3];
  if (gapAbove >= -maxOverlap) return Math.max(0, gapAbove);
  return Math.max(0, captionRect[1] - row.top);
}

function scoreRegion({
  kinds,
  caption,
  link,
  rect,
  pageRect,
  structTagged,
  standaloneImage,
  standalonePath,
  options,
}) {
  const evidence = [];
  let confidence = 0;

  const isForm = kinds.includes("form");
  const isImage = kinds.includes("image");
  const isPath = kinds.includes("path");
  const sourceKinds = [...new Set(kinds)];
  const kind = sourceKinds.length > 1 ? "multi" : (sourceKinds[0] ?? "unknown");

  if (caption) {
    confidence += link?.side === "below" ? 0.4 : 0.45;
    evidence.push(`caption:${caption.label ?? `Figure ${caption.number}`}`);
    if (link?.side === "above" && link.gap <= options.smallCaptionGapPt) {
      confidence += 0.05;
      evidence.push(`close-caption-gap:${round(link.gap, 1)}`);
    }
  }
  if (structTagged) {
    confidence += 0.25;
    evidence.push("struct-tree:Figure");
  }
  if (isImage) {
    confidence += 0.15;
    evidence.push("image-xobject");
  } else if (isForm) {
    confidence += 0.1;
    evidence.push("form-xobject");
  } else if (isPath) {
    confidence += 0.05;
    evidence.push("vector-path");
  }
  if (standaloneImage) {
    confidence += 0.2;
    evidence.push("standalone-image");
  }
  if (standalonePath) {
    confidence += 0.25;
    evidence.push("standalone-path");
  }

  const ratio = areaRatioOf(rect, pageRect);
  if (ratio >= 0.02 && ratio <= 0.5) {
    confidence += 0.2;
    evidence.push(`area-ratio:${round(ratio, 3)}`);
  } else if (ratio > options.minAreaRatio && ratio < 0.02) {
    confidence += 0.1;
  }

  if (insideMargins(rect, pageRect, options.marginInsetPt)) {
    confidence += 0.1;
    evidence.push("inside-margins");
  }

  const aspect = rectWidth(rect) / rectHeight(rect);
  if (aspect >= options.minAspect && aspect <= options.maxAspect) {
    confidence += 0.05;
    evidence.push("sane-aspect");
  }

  confidence = Math.min(1, confidence);

  const gate =
    Boolean(caption) ||
    structTagged ||
    Boolean(standaloneImage) ||
    (isImage && ratio >= options.unanchoredImageMinAreaRatio) ||
    (isPath && ratio >= options.pathAnchoredAreaRatio);

  return {
    confidence,
    evidence,
    kind,
    sourceKinds,
    gate,
    ratio,
    captionLabel: caption ? (caption.label ?? `Figure ${caption.number}`) : null,
    captionNumber: caption?.number == null ? null : String(caption.number),
    captionRect: caption ? [...caption.rect] : null,
  };
}

function buildRegion(rect, score, placementCount, placementIndexes, options) {
  const accepted = score.gate && score.confidence >= options.acceptConfidence;
  return {
    rect: [...rect],
    kind: score.kind,
    sourceKinds: score.sourceKinds ?? [score.kind],
    confidence: round(score.confidence, 3),
    evidence: score.evidence,
    caption: score.captionLabel,
    captionNumber: score.captionNumber,
    captionRects: score.captionRect ? [score.captionRect] : [],
    placementCount,
    placementIndexes,
    accepted,
    rejectReason: !score.gate
      ? "no-figure-evidence"
      : accepted
        ? null
        : "below-confidence-threshold",
  };
}

function mergeRegions(regions) {
  const sorted = regions.filter((region) => region.accepted).sort((a, b) => b.confidence - a.confidence);
  const merged = [];
  for (const region of sorted) {
    const existing = merged.find(
      (other) =>
        iou(other.rect, region.rect) > 0.5 ||
        coverageOf(region.rect, other.rect) > 0.85 ||
        coverageOf(other.rect, region.rect) > 0.85,
    );
    if (existing) {
      existing.rect = unionRect(existing.rect, region.rect);
      existing.confidence = Math.max(existing.confidence, region.confidence);
      existing.evidence = [...new Set([...existing.evidence, ...region.evidence])];
      existing.sourceKinds = [
        ...new Set([...(existing.sourceKinds ?? [existing.kind]), ...(region.sourceKinds ?? [region.kind])]),
      ];
      existing.placementCount += region.placementCount;
      existing.placementIndexes = [...existing.placementIndexes, ...region.placementIndexes];
      existing.caption ??= region.caption;
      existing.captionNumber ??= region.captionNumber;
      existing.captionRects = [...existing.captionRects, ...region.captionRects];
      continue;
    }
    merged.push({ ...region, rect: [...region.rect], captionRects: [...region.captionRects] });
  }
  return merged;
}

/**
 * Absorb area-rejected placements into the accepted regions that already
 * contain them. A small image or path cluster whose centre lies strictly
 * inside a caption-accepted region is paint that belongs to that figure; the
 * region border was cut short and the union fixes it. Guard rails: the centre
 * must clear every region edge by `absorbCenterInsetPt`, the placement must
 * not touch a caption bound to the region, and the grown rect must still pass
 * the area gate, otherwise the region is left alone and the placement stays
 * rejected.
 *
 * @param {Array<object>} merged accepted, merged regions (mutated in place)
 * @param {Array<{candidate: object, reason: string}>} areaRejected
 * @param {object} options
 * @param {number[]} pageRect
 * @returns {Array<{candidate: object, reason: string}>} entries left rejected
 */
function absorbAreaRejected(merged, areaRejected, options, pageRect) {
  const inset = Math.max(0, options.absorbCenterInsetPt);
  const unabsorbed = [];
  for (const entry of areaRejected) {
    const rect = entry.candidate.rect;
    const centreX = (rect[0] + rect[2]) / 2;
    const centreY = (rect[1] + rect[3]) / 2;
    let target = null;
    let expanded = null;
    for (const region of merged) {
      const bounds = region.rect;
      const centreInside =
        centreX > bounds[0] + inset &&
        centreX < bounds[2] - inset &&
        centreY > bounds[1] + inset &&
        centreY < bounds[3] - inset;
      if (!centreInside) continue;
      const touchesCaption = region.captionRects.some((captionRect) =>
        intersectRects(rect, captionRect),
      );
      if (touchesCaption) continue;
      const grown = unionRect(bounds, rect);
      if (areaRatioOf(grown, pageRect) > options.maxAreaRatio) continue;
      if (!target || rectArea(grown) < rectArea(expanded)) {
        target = region;
        expanded = grown;
      }
    }
    if (!target) {
      unabsorbed.push(entry);
      continue;
    }
    target.rect = expanded;
    target.placementCount += 1;
    target.placementIndexes = [...target.placementIndexes, entry.candidate.index];
    if (!target.sourceKinds.includes(entry.candidate.kind)) {
      target.sourceKinds = [...target.sourceKinds, entry.candidate.kind];
      target.kind = target.sourceKinds.length > 1 ? "multi" : target.sourceKinds[0];
    }
    const tag = `absorbed-${entry.candidate.kind}`;
    if (!target.evidence.includes(tag)) target.evidence = [...target.evidence, tag];
  }
  return unabsorbed;
}

/**
 * Stitch unanchored upper sub-bands (e.g. top half of stacked architecture diagrams
 * or `(a)`/`(b)` figure stacks) onto the caption-anchored figure directly below
 * them when horizontally aligned and separated by <= 28 pt with no intervening
 * prose or caption blockers.
 */
function mergeStackedUpperBands(
  merged,
  allRegions,
  unabsorbed,
  absorbedRejectedRegions,
  textLayout,
  pageRect,
  options,
) {
  const blockers = textLayout?.blockers ?? [];
  const maxGapY = 28;
  const pageWidth = rectWidth(pageRect);
  const midX = (pageRect[0] + pageRect[2]) / 2;
  const remainingUnabsorbed = [...unabsorbed];

  const canAttachAbove = (base, uRect) => {
    // Only merge upper sub-bands positioned predominantly above the base's top
    // edge (never tiny components merely grazing the top edge from inside).
    const overlapInside = base.rect[3] - uRect[1];
    if (overlapInside > 2 || uRect[3] <= base.rect[3] + 1) return false;
    const gapY = Math.max(0, uRect[1] - base.rect[3]);
    if (gapY > maxGapY) return false;
    const overlapX = Math.min(base.rect[2], uRect[2]) - Math.max(base.rect[0], uRect[0]);
    const maxW = Math.max(rectWidth(base.rect), rectWidth(uRect));
    if (overlapX < 0.45 * maxW) return false;
    const baseTwoCol = rectWidth(base.rect) >= pageWidth * 0.55;
    const uTwoCol = rectWidth(uRect) >= pageWidth * 0.55;
    if (!baseTwoCol && !uTwoCol) {
      const baseSide = Math.sign((base.rect[0] + base.rect[2]) / 2 - midX);
      const uSide = Math.sign((uRect[0] + uRect[2]) / 2 - midX);
      if (baseSide !== 0 && uSide !== 0 && baseSide !== uSide) return false;
    }
    if (blockers.length) {
      if (!hasDirectSightValid(base.rect, uRect, blockers)) return false;
      const bandTop = Math.max(base.rect[3], uRect[1]);
      const bandBot = Math.min(base.rect[3], uRect[1]);
      const gapBand = [
        Math.min(base.rect[0], uRect[0]),
        bandBot,
        Math.max(base.rect[2], uRect[2]),
        bandTop,
      ];
      if (bandTop > bandBot && blockersIntersectRect(gapBand, blockers)) return false;
      if (blockersIntersectRect(uRect, blockers)) return false;
    }
    const grown = unionRect(base.rect, uRect);
    return areaRatioOf(grown, pageRect) <= options.maxAreaRatio;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < merged.length; i++) {
      const region = merged[i];
      if (!region?.caption) continue;

      // 1) Merge unanchored accepted regions directly above this captioned figure.
      for (let j = merged.length - 1; j >= 0; j--) {
        if (j === i) continue;
        const cand = merged[j];
        if (cand.caption || !canAttachAbove(region, cand.rect)) continue;
        region.rect = unionRect(region.rect, cand.rect);
        region.placementCount += cand.placementCount;
        region.placementIndexes = [...region.placementIndexes, ...cand.placementIndexes];
        region.sourceKinds = [...new Set([...region.sourceKinds, ...(cand.sourceKinds ?? [cand.kind])])];
        region.kind = region.sourceKinds.length > 1 ? "multi" : region.sourceKinds[0];
        merged.splice(j, 1);
        if (j < i) i -= 1;
        changed = true;
      }

      // 2) Merge unanchored rejected regions (e.g. conf 0.55 upper half of diagrams).
      for (const rej of allRegions) {
        if (rej.accepted || absorbedRejectedRegions.has(rej) || rej.caption) continue;
        if (rej.rejectReason !== "below-confidence-threshold") continue;
        if (!canAttachAbove(region, rej.rect)) continue;
        region.rect = unionRect(region.rect, rej.rect);
        region.placementCount += rej.placementCount;
        region.placementIndexes = [...region.placementIndexes, ...rej.placementIndexes];
        region.sourceKinds = [...new Set([...region.sourceKinds, ...(rej.sourceKinds ?? [rej.kind])])];
        region.kind = region.sourceKinds.length > 1 ? "multi" : region.sourceKinds[0];
        absorbedRejectedRegions.add(rej);
        changed = true;
      }

      // 3) Merge substantial unabsorbed path/image clusters directly above.
      for (let k = remainingUnabsorbed.length - 1; k >= 0; k--) {
        const entry = remainingUnabsorbed[k];
        if (entry.candidate.areaRatio < 0.004) continue;
        if (!canAttachAbove(region, entry.candidate.rect)) continue;
        region.rect = unionRect(region.rect, entry.candidate.rect);
        region.placementCount += 1;
        region.placementIndexes = [...region.placementIndexes, entry.candidate.index];
        if (!region.sourceKinds.includes(entry.candidate.kind)) {
          region.sourceKinds = [...region.sourceKinds, entry.candidate.kind];
          region.kind = region.sourceKinds.length > 1 ? "multi" : region.sourceKinds[0];
        }
        remainingUnabsorbed.splice(k, 1);
        changed = true;
      }
    }
  }
  return remainingUnabsorbed;
}

function isInsideTableCaptionRegion(rect, textLayout, captions) {
  const tableCaptions = textLayout?.tableCaptionRects ?? [];
  if (!tableCaptions.length) return false;
  const prose = textLayout?.proseBlockers ?? [];
  const figCaptions = (captions ?? []).map((c) => c?.rect).filter(Boolean);
  for (const tc of tableCaptions) {
    // Table/Algorithm captions usually sit above their body. If `rect` lies below
    // a Table/Algorithm caption with horizontal overlap and no intervening Figure
    // caption or prose block (excluding the Table caption's own blocker box), it
    // belongs to the table rather than a figure.
    if (tc[1] < rect[3] - 4) continue;
    const overlapX = Math.min(rect[2], tc[2]) - Math.max(rect[0], tc[0]);
    const minW = Math.min(rectWidth(rect), rectWidth(tc));
    if (overlapX < 0.3 * minW) continue;
    const corridor = [
      Math.min(rect[0], tc[0]),
      rect[3],
      Math.max(rect[2], tc[2]),
      tc[1] - 2,
    ];
    if (corridor[3] <= corridor[1]) return true;
    const hasFigBetween = figCaptions.some(
      (fc) =>
        fc[2] >= corridor[0] &&
        fc[0] <= corridor[2] &&
        fc[3] >= corridor[1] &&
        fc[1] <= corridor[3],
    );
    if (hasFigBetween) continue;
    const nonTableProse = prose.filter(
      (b) => !(b[2] >= tc[0] - 3 && b[0] <= tc[2] + 3 && b[3] >= tc[1] - 3 && b[1] <= tc[3] + 3),
    );
    if (!blockersIntersectRect(corridor, nonTableProse)) return true;
  }
  return false;
}

function tagStructMatches(evaluated, structRegions) {
  const tagged = new Set();

  for (const struct of structRegions ?? []) {
    for (const candidate of evaluated) {
      if (!candidate.passesBasicFilter) continue;
      if (iou(candidate.rect, struct.rect) > 0.2 || coverageOf(candidate.rect, struct.rect) > 0.6) {
        tagged.add(candidate.index);
        struct.matchedPlacement = candidate.index;
      }
    }
  }
  return tagged;
}

function insideMargins(rect, pageRect, inset) {
  return (
    rect[0] >= pageRect[0] + inset &&
    rect[1] >= pageRect[1] + inset &&
    rect[2] <= pageRect[2] - inset &&
    rect[3] <= pageRect[3] - inset
  );
}

function captionKey(caption) {
  return `${caption.number}@${round(caption.rect[0], 1)}:${round(caption.rect[1], 1)}`;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export { expandRect };
