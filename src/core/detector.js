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

  // Scientific papers require a Figure/Fig. caption (or explicit /Figure tag):
  // skip text analysis and vector clustering on pages with no figure evidence.
  if (!captions.length && !structRegions.length) {
    let rawPathBoxCount = 0;
    const rejectedNoCaption = [];
    for (let index = 0; index < rawPlacements.length; index++) {
      const placement = rawPlacements[index];
      if (placement?.kind === "path") rawPathBoxCount += 1;
      rejectedNoCaption.push({
        index,
        kind: placement?.kind ?? "unknown",
        rect: Array.isArray(placement?.rect) ? [...placement.rect] : null,
        reason: "no-figure-caption-on-page",
        confidence: 0,
      });
    }
    return {
      regions: [],
      rejected: rejectedNoCaption,
      diagnostics: {
        placementCount: 0,
        rawPlacementCount: rawPlacements.length,
        captionCount: 0,
        acceptedRegionCount: 0,
        orphanCaptionCount: 0,
        proposalCount: 0,
        proposalRecoveredCount: 0,
        proposalConflictCount: 0,
        structRegionCount: 0,
        rawPathBoxCount,
        pathBoxCount: 0,
        pathMergePasses: 0,
        pathBoxesTruncated: 0,
        pathBoxesOffPage: 0,
        pathClusterSplits: 0,
        textExpandedRegions: 0,
        skippedNoCaption: true,
        captionOutcomes: [],
        failureReasonCounts: {
          "no-caption-detected": 1,
          "caption-without-graphics": 0,
          "caption-link-failed": 0,
          "candidate-rejected": 0,
          "proposal-conflict": 0,
          "region-accepted": 0,
        },
        evaluated: [],
      },
    };
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
        if (
          isInsideTableCaptionRegion(candidate.rect, textLayout, captions) ||
          territoryOwnerIndex(candidate.rect, textLayout) >= 0
        ) {
          rejected.push(reject(candidate, "table-or-algorithm-region", 0));
          continue;
        }
        // Full-bleed clip frames and paths covering prose/caption lines cannot
        // act as unanchored standalone figures (they are backdrops over text).
        if (candidate.fullBleedFrame) {
          rejected.push(reject(candidate, "unanchored-full-bleed-frame", 0));
          continue;
        }
        if (textLayout?.blockers?.length && blockersIntersectRect(candidate.rect, textLayout.blockers)) {
          rejected.push(reject(candidate, "prose-blocker-collision", 0));
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
    if (
      isInsideTableCaptionRegion(candidate.rect, textLayout, captions) ||
      territoryOwnerIndex(candidate.rect, textLayout) >= 0
    ) {
      rejected.push(reject(candidate, "table-or-algorithm-region", 0));
      continue;
    }
    // Images without any Figure caption or /Figure struct tag are never
    // accepted standalone in scholarly papers; retain only in `areaRejected`
    // so cropped sub-images inside a captioned figure can still be absorbed.
    const reason = passesStandaloneImageGate(candidate.rect, pageRect, textLayout, options)
      ? "no-figure-evidence"
      : "image-below-area-threshold";
    areaRejected.push({ candidate, reason });
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
    captions,
    pageRect,
    options,
  );
  let textExpansion = expandRegionsWithLabels4Way(merged, textLayout, pageRect, options);
  const {
    linkedCount: proposalLinks,
    recoveredIndexes,
    proposalCount,
    proposalConflictCount,
    conflictedCaptions,
  } = reconcileWithCaptionProposals(
    merged,
    regions,
    unabsorbed,
    rejected,
    absorbedRejectedRegions,
    evaluated,
    captions,
    textLayout,
    pageRect,
    options,
  );
  if (recoveredIndexes.size > 0) {
    for (let i = rejected.length - 1; i >= 0; i--) {
      if (recoveredIndexes.has(rejected[i].index)) rejected.splice(i, 1);
    }
  }
  if (proposalLinks > 0) {
    textExpansion += expandRegionsWithLabels4Way(merged, textLayout, pageRect, options);
  }

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

  const stageCDiag = summarizeStageCDiagnostics({
    captions,
    merged,
    evaluated,
    rejected,
    conflictedCaptions,
    proposalCount,
    proposalLinks,
    proposalConflictCount,
    options,
  });

  return {
    regions: merged,
    rejected,
    diagnostics: {
      placementCount: placements.length,
      rawPlacementCount: rawPlacements.length,
      captionCount: captions.length,
      acceptedRegionCount: merged.length,
      orphanCaptionCount: stageCDiag.orphanCaptionCount,
      proposalCount,
      proposalRecoveredCount: proposalLinks,
      proposalConflictCount,
      structRegionCount: structRegions.length,
      rawPathBoxCount: pathMerge.diagnostics.rawPathBoxCount,
      pathBoxCount: pathMerge.diagnostics.pathBoxCount,
      pathMergePasses: pathMerge.diagnostics.pathMergePasses,
      pathBoxesTruncated: pathMerge.diagnostics.pathBoxesTruncated,
      pathBoxesOffPage: pathMerge.diagnostics.pathBoxesOffPage,
      pathClusterSplits: pathMerge.diagnostics.pathClusterSplits,
      textExpandedRegions: textExpansion,
      skippedNoCaption: false,
      captionOutcomes: stageCDiag.captionOutcomes,
      failureReasonCounts: stageCDiag.failureReasonCounts,
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
  return minS <= 4 && (maxS >= 6 || maxS / Math.max(0.1, minS) >= 4);
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
    const next = mergePass(boxes, tolerance, textLayout, captions);
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
  if (Math.hypot(dx, dy) > 15) return false;
  if (h <= 4 && w >= 16 && dx > 4) return false;
  if (w <= 4 && h >= 16 && dy > 4) return false;

  if (allText.length && !hasDirectSightValid(thin, other, allText)) return false;
  return true;
}

function territoryOwnerIndex(rect, textLayout) {
  const territories = textLayout?.tableTerritories ?? [];
  if (!territories.length) return -1;
  const cx = (rect[0] + rect[2]) / 2;
  const cy = (rect[1] + rect[3]) / 2;
  const area = rectArea(rect);
  for (let i = 0; i < territories.length; i++) {
    const tr = territories[i].rect;
    if (cx >= tr[0] && cx <= tr[2] && cy >= tr[1] && cy <= tr[3]) return i;
    if (area > 0) {
      const inter = intersectRects(rect, tr);
      if (inter && rectArea(inter) / area >= 0.55) return i;
    }
  }
  return -1;
}

/**
 * Returns the index of the `Table`/`Algorithm` caption directly owning `rect`
 * (either via an explicit `TableTerritory` occupied zone or directly beneath
 * the caption with at most one text row above `rect[3]`), or `-1` if none.
 */
function directTableOwnerIndex(rect, textLayout, captions) {
  const terrIdx = territoryOwnerIndex(rect, textLayout);
  if (terrIdx >= 0) return 1000 + terrIdx;
  const tableCaptions = textLayout?.tableCaptionRects ?? [];
  if (!tableCaptions.length) return -1;
  const prose = textLayout?.proseBlockers ?? [];
  const allText = textLayout?.allTextRects ?? [];
  const figCaptions = (captions ?? []).map((c) => c?.rect).filter(Boolean);
  for (let idx = 0; idx < tableCaptions.length; idx++) {
    const tc = tableCaptions[idx];
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
    if (corridor[3] <= corridor[1]) return idx;
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
    if (blockersIntersectRect(corridor, nonTableProse)) continue;
    const rowBuckets = new Set();
    for (const t of allText) {
      if (t[2] < corridor[0] || t[0] > corridor[2] || t[3] < corridor[1] || t[1] > corridor[3]) {
        continue;
      }
      rowBuckets.add(Math.round(((t[1] + t[3]) / 2) / 5));
      if (rowBuckets.size >= 2) break;
    }
    if (rowBuckets.size < 2) return idx;
  }
  return -1;
}

/** One transitive merge sweep over the current boxes. */
function mergePass(boxes, tolerance, textLayout, captions) {
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
  const hasTableHints = Boolean(
    textLayout?.tableCaptionRects?.length || textLayout?.tableTerritories?.length,
  );
  const tableOwners = hasTableHints
    ? boxes.map((box) => directTableOwnerIndex(box.rect, textLayout, captions))
    : null;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const left = find(i);
      const right = find(j);
      if (left === right) continue;
      if (tableOwners && (tableOwners[left] >= 0 || tableOwners[right] >= 0) && tableOwners[left] !== tableOwners[right]) {
        continue;
      }
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
    const tA = territoryOwnerIndex(a.rect, textLayout);
    const tB = territoryOwnerIndex(b.rect, textLayout);
    if ((tA >= 0 || tB >= 0) && tA !== tB) return false;
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
  const terrOwners = textLayout?.tableTerritories?.length
    ? boxes.map((box) => territoryOwnerIndex(box.rect, textLayout))
    : null;
  for (let i = 0; i < boxes.length; i++) {
    if (!small[i]) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      if (!small[j]) continue;
      const left = find(i);
      const right = find(j);
      if (left === right) continue;
      if (terrOwners && (terrOwners[left] >= 0 || terrOwners[right] >= 0) && terrOwners[left] !== terrOwners[right]) {
        continue;
      }
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
function findEnclosedBottomCaptions(clusterRect, captions, options = DEFAULT_DETECTOR_OPTIONS) {
  const minSide = options.minSidePt ?? 24;
  const rows = [];
  for (const caption of captions ?? []) {
    const row = caption?.rect;
    if (!Array.isArray(row) || row.some((value) => !Number.isFinite(value))) continue;
    // Cluster bottom encloses the caption's bottom edge (`row[1] >= clusterRect[1] - 0.5`)
    // with substantial artwork left above the caption (`clusterRect[3] - row[3] >= minSide`).
    if (row[1] < clusterRect[1] - 0.5 || clusterRect[3] - row[3] < minSide) continue;
    const overlap = intersectRects(
      [clusterRect[0], -1e6, clusterRect[2], 1e6],
      [row[0], -1e6, row[2], 1e6],
    );
    const overlapWidth = overlap ? overlap[2] - overlap[0] : 0;
    if (overlapWidth < options.minCaptionOverlapRatio * Math.min(rectWidth(row), rectWidth(clusterRect))) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

function splitAtInteriorCaptions(boxes, captions, pageRect, tolerance, options) {
  if (!captions?.length || !boxes.some((box) => box.members?.length)) {
    return { boxes, splits: 0 };
  }
  const queue = [...boxes];
  const out = [];
  let splits = 0;
  let guard = options.pathMergeMaxPasses;
  while (queue.length) {
    const cluster = queue.shift();
    const rows = findInteriorCaptionRows(cluster.rect, captions, options);
    const bottomEnclosed = !rows.length ? findEnclosedBottomCaptions(cluster.rect, captions, options) : [];
    const activeRows = rows.length ? rows : bottomEnclosed;
    if (!activeRows.length || guard-- <= 0) {
      out.push(cluster);
      continue;
    }
    // Splitting at the row closest to the cluster's vertical centre first
    // separates the two figures a caption sits between; deeper rows are found
    // by the next pass over the resulting bands.
    const row = activeRows.reduce((best, other) =>
      slabCentreDistance(cluster.rect, other) < slabCentreDistance(cluster.rect, best) ? other : best,
    );
    const bands = splitMembersAtSlab(cluster.members, row, options);
    const isTrimOnly = !rows.length && !bands[0].length && bands[1].length > 0;
    if ((!bands[0].length || !bands[1].length) && !isTrimOnly) {
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
    if (!parts.length || !parts.every((part) => splitBandIsValid(part, captions, pageRect, options))) {
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
  captions,
  pageRect,
  options,
) {
  const blockers = textLayout?.blockers ?? [];
  const maxGapY = 28;
  const pageWidth = rectWidth(pageRect);
  const midX = (pageRect[0] + pageRect[2]) / 2;
  const remainingUnabsorbed = [...unabsorbed];

  const canAttachAbove = (base, uRect) => {
    if (isInsideTableCaptionRegion(uRect, textLayout, captions)) return false;
    if (territoryOwnerIndex(uRect, textLayout) >= 0) return false;
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

/**
 * Build a clean vertical proposal corridor above `cap` bounded by the first
 * horizontal obstacle (`prose`, `tableRects`, other captions, accepted regions).
 */
function buildProposalCorridor(cap, propLeft, propRight, merged, textLayout, pageRect, options) {
  const cr = cap.rect;
  const prose = textLayout?.proseBlockers ?? [];
  const capBlockers = textLayout?.captionBlockers ?? [];
  const tableRects = [
    ...(textLayout?.tableCaptionRects ?? []),
    ...((textLayout?.tableTerritories ?? []).map((t) => t.rect)),
  ];
  let ceilingY = pageRect[3] - 12;
  const obstacles = [
    ...prose,
    ...tableRects,
    ...capBlockers.filter(
      (cb) => !(cb[2] >= cr[0] - 4 && cb[0] <= cr[2] + 4 && cb[3] >= cr[1] - 4 && cb[1] <= cr[3] + 4),
    ),
    ...merged.filter((r) => r.caption != null).map((r) => r.rect),
  ];
  for (const obs of obstacles) {
    if (obs[2] < propLeft || obs[0] > propRight) continue;
    if (obs[1] >= cr[3] - 2 && obs[1] < ceilingY) ceilingY = obs[1];
  }
  if (ceilingY - cr[3] < options.minSidePt) return null;
  return [propLeft, cr[3] - options.maxCaptionOverlapPt, propRight, ceilingY];
}

function proposalSightClear(rect, capRect, side, prose, otherCaps, tableRects) {
  const sight =
    side === "below"
      ? [Math.min(rect[0], capRect[0]), rect[3], Math.max(rect[2], capRect[2]), Math.max(rect[3], capRect[1])]
      : [Math.min(rect[0], capRect[0]), capRect[3], Math.max(rect[2], capRect[2]), Math.max(capRect[3], rect[1])];
  if (sight[3] <= sight[1]) return true;
  if (blockersIntersectRect(sight, prose)) return false;
  const capSight =
    side === "below"
      ? [sight[0], sight[1], sight[2], Math.max(sight[1], sight[3] - 2)]
      : [sight[0], Math.min(sight[3], sight[1] + 2), sight[2], sight[3]];
  if (capSight[3] > capSight[1] && blockersIntersectRect(capSight, otherCaps)) return false;
  return !tableRects.some((tr) => !(tr[0] > sight[2] || tr[2] < sight[0] || tr[1] > sight[3] || tr[3] < sight[1]));
}

function overlapsExistingRegion(rect, merged) {
  return merged.some(
    (r) => iou(r.rect, rect) > 0.5 || coverageOf(rect, r.rect) > 0.5 || coverageOf(r.rect, rect) > 0.5,
  );
}

/**
 * Recover compact wide/tall multi-panel figures (e.g. full-width strip bar
 * charts ~504 x 54 pt) that exceeded `maxAspect` before caption matching, only
 * when they sit directly adjacent to an otherwise orphaned Figure caption in
 * clear sight and never belong to a Table/Algorithm or overlap an existing region.
 */
function recoverExtremeAspectForOrphans({
  orphanCaptions,
  merged,
  evaluated,
  captions,
  textLayout,
  pageRect,
  options,
}) {
  const recoveredIndexes = new Set();
  if (!orphanCaptions.length || !evaluated?.length) return { linkedCount: 0, recoveredIndexes };

  const minSideFloor = options.anchoredExtremeAspectMinSidePt ?? 32;
  const minAspectFloor = options.anchoredMinAspect ?? 0.0625;
  const maxAspectCeil = options.anchoredMaxAspect ?? 16;
  const prose = textLayout?.proseBlockers ?? [];
  const capBlockers = textLayout?.captionBlockers ?? [];
  const tableRects = [
    ...(textLayout?.tableCaptionRects ?? []),
    ...((textLayout?.tableTerritories ?? []).map((t) => t.rect)),
  ];
  const pageWidth = rectWidth(pageRect);
  const fullLeft = pageRect[0] + 18;
  const fullRight = pageRect[2] - 18;

  const eligible = evaluated.filter(
    (c) =>
      c.rejectReason === "extreme-aspect" &&
      !c.fullBleedFrame &&
      !c.onlyThinRules &&
      c.minSide >= minSideFloor &&
      c.aspect >= minAspectFloor &&
      c.aspect <= maxAspectCeil &&
      territoryOwnerIndex(c.rect, textLayout) < 0 &&
      !isInsideTableCaptionRegion(c.rect, textLayout, captions) &&
      !blockersIntersectRect(c.rect, prose) &&
      !overlapsExistingRegion(c.rect, merged),
  );
  if (!eligible.length) return { linkedCount: 0, recoveredIndexes };

  const matches = [];
  for (let ci = 0; ci < orphanCaptions.length; ci++) {
    const cap = orphanCaptions[ci];
    const otherCaps = capBlockers.filter(
      (cb) =>
        !(cb[2] >= cap.rect[0] - 4 && cb[0] <= cap.rect[2] + 4 && cb[3] >= cap.rect[1] - 4 && cb[1] <= cap.rect[3] + 4),
    );
    const wideCorridor = buildProposalCorridor(cap, fullLeft, fullRight, merged, textLayout, pageRect, options);
    for (let ei = 0; ei < eligible.length; ei++) {
      const cand = eligible[ei];
      if (blockersIntersectRect(cand.rect, otherCaps)) continue;
      const ovX = Math.min(cand.rect[2], cap.rect[2]) - Math.max(cand.rect[0], cap.rect[0]);
      const ovRatio = ovX / Math.max(1, Math.min(rectWidth(cand.rect), rectWidth(cap.rect)));
      if (ovRatio < options.minCaptionOverlapRatio) continue;

      let side = null;
      let gap = Infinity;
      const aboveGap = cand.rect[1] - cap.rect[3];
      if (
        wideCorridor &&
        coverageOf(cand.rect, wideCorridor) >= 0.85 &&
        aboveGap >= -options.maxCaptionOverlapPt &&
        aboveGap <= 48 &&
        proposalSightClear(cand.rect, cap.rect, "above", prose, otherCaps, tableRects)
      ) {
        side = "above";
        gap = Math.max(0, aboveGap);
      } else {
        const directLink = linkCaption(cap, cand.rect, options, pageRect);
        if (
          directLink?.side === "below" &&
          directLink.gap <= options.maxCaptionGapPt &&
          proposalSightClear(cand.rect, cap.rect, "below", prose, otherCaps, tableRects)
        ) {
          side = "below";
          gap = directLink.gap;
        }
      }
      if (!side) continue;

      const regMid = (cand.rect[0] + cand.rect[2]) / 2;
      const capMid = (cap.rect[0] + cap.rect[2]) / 2;
      const centerDist = Math.abs(regMid - capMid) / Math.max(1, pageWidth);
      const kindBonus = cand.kind === "form" || cand.kind === "image" ? 0.05 : 0;
      const sideBonus = side === "above" ? 1 : 0;
      const score =
        sideBonus + ovRatio * 2.0 + Math.max(0, 1 - gap / 48) + areaRatioOf(cand.rect, pageRect) + kindBonus - centerDist * 0.5;
      matches.push({ ci, ei, cand, cap, side, gap, score });
    }
  }
  if (!matches.length) return { linkedCount: 0, recoveredIndexes };

  matches.sort((a, b) => b.score - a.score);
  const usedCaps = new Set();
  const usedCands = new Set();
  let linkedCount = 0;

  for (const m of matches) {
    if (usedCaps.has(m.ci) || usedCands.has(m.ei)) continue;
    if (overlapsExistingRegion(m.cand.rect, merged)) continue;

    // Coalesce coinciding extreme-aspect layers (e.g. a Form XObject and its
    // own path cluster at identical bounds) into one multi-kind region.
    const group = [m.ei];
    for (let si = 0; si < eligible.length; si++) {
      if (si === m.ei || usedCands.has(si)) continue;
      const sib = eligible[si];
      if (
        iou(m.cand.rect, sib.rect) >= 0.5 ||
        coverageOf(sib.rect, m.cand.rect) >= 0.85 ||
        coverageOf(m.cand.rect, sib.rect) >= 0.85
      ) {
        group.push(si);
      }
    }

    let rect = [...m.cand.rect];
    const sourceKinds = [];
    const placementIndexes = [];
    for (const idx of group) {
      const item = eligible[idx];
      rect = unionRect(rect, item.rect);
      for (const sk of item.sourceKinds ?? [item.kind]) sourceKinds.push(sk);
      placementIndexes.push(item.index);
    }

    const score = scoreRegion({
      kinds: sourceKinds,
      caption: m.cap,
      link: { gap: m.gap, side: m.side },
      rect,
      pageRect,
      structTagged: false,
      options,
    });
    score.evidence.push("extreme-aspect-orphan-recovery");
    const built = buildRegion(rect, score, placementIndexes.length, placementIndexes, options);
    if (!built.accepted) continue;

    usedCaps.add(m.ci);
    for (const idx of group) usedCands.add(idx);
    for (const pIdx of placementIndexes) recoveredIndexes.add(pIdx);
    merged.push(built);
    linkedCount += 1;
  }

  return { linkedCount, recoveredIndexes };
}

function buildProposalCorridors(orphanCaptions, merged, textLayout, pageRect, options) {
  const pageWidth = rectWidth(pageRect);
  const midX = (pageRect[0] + pageRect[2]) / 2;
  const proposals = [];
  for (let ci = 0; ci < orphanCaptions.length; ci++) {
    const cap = orphanCaptions[ci];
    const cr = cap.rect;
    const center = (cr[0] + cr[2]) / 2;
    const isWide =
      rectWidth(cr) >= pageWidth * 0.45 ||
      (cr[0] < midX - 24 && cr[2] > midX + 24) ||
      Math.abs(center - midX) <= 36;
    const propLeft = isWide || center < midX ? pageRect[0] + 18 : midX + 2;
    const propRight = isWide || center >= midX ? pageRect[2] - 18 : midX - 2;
    const corridor = buildProposalCorridor(cap, propLeft, propRight, merged, textLayout, pageRect, options);
    if (!corridor) continue;
    proposals.push({
      ci,
      cap,
      propLeft,
      propRight,
      corridor,
      ceilingY: corridor[3],
    });
  }
  return proposals;
}

function labelBridgedGap(rect, capRect, labelCandidates, side, maxStepPt = 28) {
  const rawGap = side === "below" ? capRect[1] - rect[3] : rect[1] - capRect[3];
  if (!labelCandidates?.length) return { gap: rawGap, hasLabelsInGap: false };
  const x0 = Math.min(rect[0], capRect[0]) - 12;
  const x1 = Math.max(rect[2], capRect[2]) + 12;
  if (side === "above") {
    const inBand = labelCandidates
      .map((c) => c?.rect)
      .filter((r) => r && r[2] >= x0 && r[0] <= x1 && r[1] >= capRect[3] - 2 && r[3] <= rect[1] + 2)
      .sort((a, b) => b[3] - a[3]);
    if (!inBand.length) return { gap: rawGap, hasLabelsInGap: false };
    let frontier = rect[1];
    for (const lr of inBand) {
      if (frontier - lr[3] <= maxStepPt) frontier = Math.min(frontier, lr[1]);
    }
    return { gap: Math.max(0, frontier - capRect[3]), hasLabelsInGap: true };
  }
  const inBand = labelCandidates
    .map((c) => c?.rect)
    .filter((r) => r && r[2] >= x0 && r[0] <= x1 && r[1] >= rect[3] - 2 && r[3] <= capRect[1] + 2)
    .sort((a, b) => a[1] - b[1]);
  if (!inBand.length) return { gap: rawGap, hasLabelsInGap: false };
  let frontier = rect[3];
  for (const lr of inBand) {
    if (lr[1] - frontier <= maxStepPt) frontier = Math.max(frontier, lr[3]);
  }
  return { gap: Math.max(0, capRect[1] - frontier), hasLabelsInGap: true };
}

function captionGapAllowance(capRect, rect, pageWidth, options) {
  return (
    options.maxCaptionGapPt +
    (pageWidth > 0
      ? (options.captionGapWidthAllowanceFactor * Math.max(rectWidth(capRect), rectWidth(rect))) /
        pageWidth
      : 0)
  );
}

/**
 * Recover unlinked normal-aspect graphic placements (`form`, `image`, or
 * sub-threshold `path` clusters) that sit in a remaining orphan caption's
 * clear-sight corridor — including pages where initial linking failed and
 * `merged` started completely empty.
 */
function isCaptionCoveredByRegions(cap, regions, options) {
  for (const region of regions ?? []) {
    if (region.captionNumber != null && String(region.captionNumber) === String(cap.number)) {
      return true;
    }
    if (region.captionRects?.some((cr) => Math.abs(cr[0] - cap.rect[0]) < 1 && Math.abs(cr[1] - cap.rect[1]) < 1)) {
      return true;
    }
    if (!region.caption) continue;
    const ovX = Math.min(region.rect[2], cap.rect[2]) - Math.max(region.rect[0], cap.rect[0]);
    const minW = Math.min(rectWidth(region.rect), rectWidth(cap.rect));
    const gap = region.rect[1] - cap.rect[3];
    if (ovX >= options.minCaptionOverlapRatio * minW && gap >= -options.maxCaptionOverlapPt && gap <= 36) {
      return true;
    }
  }
  return false;
}

function canJoinProposalPeers(aRect, bRect, allBlockers, prose, otherCaps, textLayout, captions, options) {
  const combined = unionRect(aRect, bRect);
  if (blockersIntersectRect(combined, prose) || blockersIntersectRect(combined, otherCaps)) return false;
  if (territoryOwnerIndex(combined, textLayout) >= 0 || isInsideTableCaptionRegion(combined, textLayout, captions)) {
    return false;
  }
  if (allBlockers?.length && !hasDirectSightValid(aRect, bRect, allBlockers)) return false;

  if (
    iou(aRect, bRect) >= 0.5 ||
    coverageOf(aRect, bRect) >= 0.85 ||
    coverageOf(bRect, aRect) >= 0.85
  ) {
    return true;
  }
  const ovY = Math.min(aRect[3], bRect[3]) - Math.max(aRect[1], bRect[1]);
  const minH = Math.min(rectHeight(aRect), rectHeight(bRect));
  const gapX = Math.max(bRect[0] - aRect[2], aRect[0] - bRect[2], 0);
  if (ovY >= 0.4 * minH && gapX <= (options.panelPeerGapPt ?? 60)) return true;

  const ovX = Math.min(aRect[2], bRect[2]) - Math.max(aRect[0], bRect[0]);
  const minW = Math.min(rectWidth(aRect), rectWidth(bRect));
  const gapY = Math.max(bRect[1] - aRect[3], aRect[1] - bRect[3], 0);
  return ovX >= 0.45 * minW && gapY <= 28;
}

/**
 * Group corridor-contained graphic components into both single-component and
 * clear-sight multi-panel proposal clusters for one orphan caption.
 */
function buildCorridorProposalClusters(corridorItemIndices, eligible, allBlockers, prose, otherCaps, textLayout, captions, pageRect, options) {
  const groups = [];
  const seenKeys = new Set();

  const tryAddGroup = (indices) => {
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    if (!sorted.length) return;
    if (sorted.length === 1 && eligible[sorted[0]].subMinArea) return;
    const key = sorted.join(",");
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    let rect = [...eligible[sorted[0]].rect];
    for (let i = 1; i < sorted.length; i++) rect = unionRect(rect, eligible[sorted[i]].rect);
    const ratio = areaRatioOf(rect, pageRect);
    const w = rectWidth(rect);
    const h = rectHeight(rect);
    if (ratio < options.minAreaRatio || ratio > options.maxAreaRatio) return;
    if (Math.min(w, h) < options.minSidePt) return;
    const aspect = w / Math.max(1, h);
    if (aspect < options.minAspect || aspect > options.maxAspect) return;
    if (blockersIntersectRect(rect, prose) || blockersIntersectRect(rect, otherCaps)) return;
    if (territoryOwnerIndex(rect, textLayout) >= 0 || isInsideTableCaptionRegion(rect, textLayout, captions)) return;

    let hasVerticalStack = false;
    for (let i = 0; i < sorted.length && !hasVerticalStack; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = eligible[sorted[i]].rect;
        const b = eligible[sorted[j]].rect;
        if (Math.max(b[1] - a[3], a[1] - b[3]) > 2) {
          hasVerticalStack = true;
          break;
        }
      }
    }
    groups.push({
      indices: sorted,
      rect,
      hasVerticalStack,
      hasSubMinArea: sorted.some((idx) => eligible[idx].subMinArea),
    });
  };

  for (const idx of corridorItemIndices) tryAddGroup([idx]);

  if (corridorItemIndices.length >= 2) {
    const n = corridorItemIndices.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = eligible[corridorItemIndices[i]].rect;
        const b = eligible[corridorItemIndices[j]].rect;
        if (canJoinProposalPeers(a, b, allBlockers, prose, otherCaps, textLayout, captions, options)) {
          const r1 = find(i);
          const r2 = find(j);
          if (r1 !== r2) parent[r2] = r1;
        }
      }
    }
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!buckets.has(root)) buckets.set(root, []);
      buckets.get(root).push(corridorItemIndices[i]);
    }
    for (const members of buckets.values()) {
      if (members.length >= 2) tryAddGroup(members);
    }
  }

  return groups;
}

/**
 * Recover unlinked normal-aspect graphic placements (`form`, `image`, or
 * sub-threshold `path` clusters) and cohesive multi-panel clusters that sit in a
 * remaining orphan caption's clear-sight corridor — including pages where initial
 * linking failed and `merged` started completely empty.
 */
function recoverUnlinkedGraphicsForOrphans({
  orphanCaptions,
  merged,
  allRegions,
  unabsorbed,
  rejected,
  absorbedRejectedRegions,
  evaluated,
  captions,
  textLayout,
  pageRect,
  options,
}) {
  const recoveredIndexes = new Set();
  const conflictedCaptions = new Set();
  if (!orphanCaptions.length) {
    return { linkedCount: 0, recoveredIndexes, proposalCount: 0, conflictCount: 0, conflictedCaptions };
  }

  const allBlockers = textLayout?.blockers ?? [];
  const prose = textLayout?.proseBlockers ?? [];
  const capBlockers = textLayout?.captionBlockers ?? [];
  const labelCandidates = textLayout?.labelCandidates ?? [];
  const tableRects = [
    ...(textLayout?.tableCaptionRects ?? []),
    ...((textLayout?.tableTerritories ?? []).map((t) => t.rect)),
  ];
  const pageWidth = rectWidth(pageRect);
  const proposals = buildProposalCorridors(orphanCaptions, merged, textLayout, pageRect, options);
  if (!proposals.length) {
    return { linkedCount: 0, recoveredIndexes, proposalCount: 0, conflictCount: 0, conflictedCaptions };
  }

  const pool = [];
  for (const reg of allRegions ?? []) {
    if (reg.accepted || absorbedRejectedRegions.has(reg) || reg.caption) continue;
    if (reg.rejectReason !== "below-confidence-threshold") continue;
    const firstIdx = reg.placementIndexes?.[0];
    const cand = firstIdx != null ? evaluated?.[firstIdx] : null;
    if (cand?.fullBleedFrame || cand?.onlyThinRules) continue;
    pool.push({
      rect: reg.rect,
      kinds: reg.sourceKinds ?? [reg.kind],
      kind: reg.kind,
      placementIndexes: [...(reg.placementIndexes ?? [])],
      placementCount: reg.placementCount ?? 1,
      poolType: "region",
      subMinArea: false,
      ref: reg,
    });
  }
  for (let ui = 0; ui < (unabsorbed?.length ?? 0); ui++) {
    const entry = unabsorbed[ui];
    const cand = entry?.candidate;
    if (!cand || cand.fullBleedFrame || cand.onlyThinRules) continue;
    if (areaRatioOf(cand.rect, pageRect) < options.minAreaRatio) continue;
    pool.push({
      rect: cand.rect,
      kinds: cand.sourceKinds ?? [cand.kind],
      kind: cand.kind,
      placementIndexes: [cand.index],
      placementCount: 1,
      poolType: "unabsorbed",
      subMinArea: false,
      ref: entry,
    });
  }
  for (const rej of rejected ?? []) {
    const cand = rej.index != null ? evaluated?.[rej.index] : null;
    if (!cand || cand.fullBleedFrame || cand.onlyThinRules) continue;
    if (rej.reason === "no-figure-evidence" && cand.passesBasicFilter) {
      pool.push({
        rect: cand.rect,
        kinds: cand.sourceKinds ?? [cand.kind],
        kind: cand.kind,
        placementIndexes: [cand.index],
        placementCount: 1,
        poolType: "rejected",
        subMinArea: false,
        ref: rej,
      });
    } else if (rej.reason === "below-min-area" && cand.minSide >= 16 && rectArea(cand.rect) >= 256) {
      pool.push({
        rect: cand.rect,
        kinds: cand.sourceKinds ?? [cand.kind],
        kind: cand.kind,
        placementIndexes: [cand.index],
        placementCount: 1,
        poolType: "rejected",
        subMinArea: true,
        ref: rej,
      });
    }
  }

  const eligible = pool.filter(
    (item) =>
      rectArea(item.rect) > 0 &&
      territoryOwnerIndex(item.rect, textLayout) < 0 &&
      !isInsideTableCaptionRegion(item.rect, textLayout, captions) &&
      !blockersIntersectRect(item.rect, prose) &&
      !overlapsExistingRegion(item.rect, merged),
  );
  if (!eligible.length) {
    return { linkedCount: 0, recoveredIndexes, proposalCount: 0, conflictCount: 0, conflictedCaptions };
  }

  const matches = [];
  for (const prop of proposals) {
    const { ci, cap, propLeft, propRight, corridor } = prop;
    const maxOverlap = Math.min(rectHeight(cap.rect), options.maxCaptionOverlapPt);
    const otherCaps = capBlockers.filter(
      (cb) =>
        !(cb[2] >= cap.rect[0] - 4 && cb[0] <= cap.rect[2] + 4 && cb[3] >= cap.rect[1] - 4 && cb[1] <= cap.rect[3] + 4),
    );
    const propColW = propRight - propLeft;
    const isWideCol = propColW >= pageWidth * 0.6;

    const corridorAboveItems = [];
    const corridorBelowItems = [];
    for (let ei = 0; ei < eligible.length; ei++) {
      const item = eligible[ei];
      if (blockersIntersectRect(item.rect, otherCaps)) continue;
      if (coverageOf(item.rect, corridor) >= 0.85) corridorAboveItems.push(ei);
      else if (item.rect[0] >= propLeft - 4 && item.rect[2] <= propRight + 4 && item.rect[3] <= cap.rect[1] + maxOverlap) {
        corridorBelowItems.push(ei);
      }
    }

    const evaluateGroups = (sideLabel, groups) => {
      for (const grp of groups) {
        const { indices, rect, hasVerticalStack, hasSubMinArea } = grp;
        const ovX = Math.min(rect[2], cap.rect[2]) - Math.max(rect[0], cap.rect[0]);
        const horizGap = ovX >= 0 ? 0 : -ovX;
        const minW = Math.max(1, Math.min(rectWidth(rect), rectWidth(cap.rect)));
        const ovRatio = Math.max(0, ovX) / minW;
        const allInCorridor = indices.every((idx) => coverageOf(eligible[idx].rect, corridor) >= 0.85);
        const overlapOk =
          ovRatio >= options.minCaptionOverlapRatio ||
          (sideLabel === "above" && allInCorridor && (ovX > 0 || horizGap <= 16));
        if (!overlapOk) continue;

        const gapAllow = captionGapAllowance(cap.rect, rect, pageWidth, options);
        const members = indices.map((idx) => eligible[idx]);
        const allowCorridorGap80 =
          members.some((m) => m.poolType === "region" || (m.kind === "path" && m.poolType === "unabsorbed")) ||
          hasVerticalStack ||
          hasSubMinArea;

        let gap = Infinity;
        if (sideLabel === "above") {
          const aboveGap = rect[1] - cap.rect[3];
          if (aboveGap < -maxOverlap || aboveGap > 80) continue;
          if (!proposalSightClear(rect, cap.rect, "above", prose, otherCaps, tableRects)) continue;
          const bridged = labelBridgedGap(rect, cap.rect, labelCandidates, "above");
          const withinGap =
            aboveGap <= gapAllow || (bridged.hasLabelsInGap && bridged.gap <= gapAllow) || allowCorridorGap80;
          if (!withinGap) continue;
          gap = Math.max(0, aboveGap);
        } else {
          if (rect[0] < propLeft - 4 || rect[2] > propRight + 4 || ovRatio < options.minCaptionOverlapRatio) continue;
          const belowGap = cap.rect[1] - rect[3];
          if (belowGap < -maxOverlap || belowGap > 48) continue;
          if (!proposalSightClear(rect, cap.rect, "below", prose, otherCaps, tableRects)) continue;
          const bridged = labelBridgedGap(rect, cap.rect, labelCandidates, "below");
          if (!(belowGap <= gapAllow || (bridged.hasLabelsInGap && bridged.gap <= gapAllow) || allowCorridorGap80)) {
            continue;
          }
          gap = Math.max(0, belowGap) + 1;
        }

        const regMid = (rect[0] + rect[2]) / 2;
        const capMid = (cap.rect[0] + cap.rect[2]) / 2;
        const centerDist = Math.abs(regMid - capMid) / Math.max(1, pageWidth);
        const colSpanRatio = rectWidth(rect) / Math.max(1, propColW);
        const columnFitBonus = isWideCol ? (colSpanRatio >= 0.45 ? 0.25 : 0) : colSpanRatio >= 0.45 ? 0.25 : 0;
        const kindBonus = members.some((m) => m.kind === "form" || m.kind === "image") ? 0.05 : 0;
        const multiPanelBonus = indices.length > 1 ? 0.15 : 0;
        const sideBonus = sideLabel === "above" ? 1 : 0;
        const score =
          sideBonus +
          ovRatio * 1.5 +
          Math.max(0, 1 - gap / 80) +
          Math.min(0.4, areaRatioOf(rect, pageRect) * 2) +
          columnFitBonus +
          multiPanelBonus +
          kindBonus -
          centerDist * 0.4;

        matches.push({ ci, indices, rect, cap, side: sideLabel, gap, score });
      }
    };

    if (corridorAboveItems.length) {
      const aboveGroups = buildCorridorProposalClusters(
        corridorAboveItems,
        eligible,
        allBlockers,
        prose,
        otherCaps,
        textLayout,
        captions,
        pageRect,
        options,
      );
      evaluateGroups("above", aboveGroups);
    }
    if (corridorBelowItems.length) {
      const belowGroups = buildCorridorProposalClusters(
        corridorBelowItems,
        eligible,
        allBlockers,
        prose,
        otherCaps,
        textLayout,
        captions,
        pageRect,
        options,
      );
      evaluateGroups("below", belowGroups);
    }
  }
  if (!matches.length) {
    return { linkedCount: 0, recoveredIndexes, proposalCount: 0, conflictCount: 0, conflictedCaptions };
  }

  matches.sort((a, b) => b.score - a.score);
  const usedCaps = new Set();
  const usedCands = new Set();
  const recoveredUnabsorbed = new Set();
  let linkedCount = 0;
  let conflictCount = 0;

  for (const m of matches) {
    if (usedCaps.has(m.ci)) continue;
    const itemConflict = m.indices.some((idx) => usedCands.has(idx));
    if (itemConflict || overlapsExistingRegion(m.rect, merged)) {
      conflictCount += 1;
      conflictedCaptions.add(captionKey(m.cap));
      continue;
    }

    const group = new Set(m.indices);
    for (let si = 0; si < eligible.length; si++) {
      if (group.has(si) || usedCands.has(si)) continue;
      const sib = eligible[si];
      if (
        iou(m.rect, sib.rect) >= 0.5 ||
        coverageOf(sib.rect, m.rect) >= 0.85 ||
        coverageOf(m.rect, sib.rect) >= 0.85
      ) {
        group.add(si);
      }
    }

    let rect = [...m.rect];
    const sourceKinds = [];
    const placementIndexes = [];
    let placementCount = 0;
    for (const idx of group) {
      const item = eligible[idx];
      rect = unionRect(rect, item.rect);
      for (const sk of item.kinds) sourceKinds.push(sk);
      for (const pIdx of item.placementIndexes) {
        if (!placementIndexes.includes(pIdx)) placementIndexes.push(pIdx);
      }
      placementCount += item.placementCount;
    }

    const score = scoreRegion({
      kinds: sourceKinds,
      caption: m.cap,
      link: { gap: m.gap, side: m.side },
      rect,
      pageRect,
      structTagged: false,
      options,
    });
    score.evidence.push("unlinked-orphan-recovery");
    if (group.size > 1) score.evidence.push("multi-panel-proposal");
    const built = buildRegion(rect, score, placementCount, placementIndexes, options);
    if (!built.accepted) continue;

    usedCaps.add(m.ci);
    for (const idx of group) {
      usedCands.add(idx);
      const item = eligible[idx];
      if (item.poolType === "region") absorbedRejectedRegions.add(item.ref);
      else if (item.poolType === "unabsorbed") recoveredUnabsorbed.add(item.ref);
      else if (item.poolType === "rejected" && item.ref.index != null) recoveredIndexes.add(item.ref.index);
    }
    merged.push(built);
    linkedCount += 1;
  }

  if (recoveredUnabsorbed.size > 0) {
    for (let i = unabsorbed.length - 1; i >= 0; i--) {
      if (recoveredUnabsorbed.has(unabsorbed[i])) unabsorbed.splice(i, 1);
    }
  }

  return {
    linkedCount,
    recoveredIndexes,
    proposalCount: matches.length,
    conflictCount,
    conflictedCaptions,
  };
}

/**
 * PDFFigures 2.0-inspired caption proposal corridor + global conflict-free
 * reconciliation for orphaned captions whose figure already exists in an
 * unanchored region above them (e.g. multi-row panel grids with tall tick
 * labels exceeding `maxCaptionGapPt`, or stacked unanchored upper bands inside
 * an empty column proposal corridor), plus orphan recovery for unlinked valid
 * graphics, multi-panel groups, and compact wide/tall charts exceeding `maxAspect`.
 */
function reconcileWithCaptionProposals(
  merged,
  allRegions,
  unabsorbed,
  rejected,
  absorbedRejectedRegions,
  evaluated,
  captions,
  textLayout,
  pageRect,
  options,
) {
  const recoveredIndexes = new Set();
  const conflictedCaptions = new Set();
  if (!captions?.length) {
    return {
      linkedCount: 0,
      recoveredIndexes,
      proposalCount: 0,
      proposalConflictCount: 0,
      conflictedCaptions,
    };
  }
  const pageWidth = rectWidth(pageRect);

  let orphanCaptions = captions.filter((cap) => !isCaptionCoveredByRegions(cap, merged, options));
  if (!orphanCaptions.length) {
    return {
      linkedCount: 0,
      recoveredIndexes,
      proposalCount: 0,
      proposalConflictCount: 0,
      conflictedCaptions,
    };
  }

  const prose = textLayout?.proseBlockers ?? [];
  const capBlockers = textLayout?.captionBlockers ?? [];
  const tableRects = [
    ...(textLayout?.tableCaptionRects ?? []),
    ...((textLayout?.tableTerritories ?? []).map((t) => t.rect)),
  ];

  const proposals = buildProposalCorridors(orphanCaptions, merged, textLayout, pageRect, options);

  let linkedCount = 0;
  let proposalCount = 0;
  let proposalConflictCount = 0;

  if (merged?.length && proposals.length) {
    const candidates = [];
    for (const prop of proposals) {
      const { ci, cap, corridor } = prop;
      const otherCaps = capBlockers.filter(
        (cb) =>
          !(cb[2] >= cap.rect[0] - 4 && cb[0] <= cap.rect[2] + 4 && cb[3] >= cap.rect[1] - 4 && cb[1] <= cap.rect[3] + 4),
      );
      for (let ri = 0; ri < merged.length; ri++) {
        const region = merged[ri];
        if (region.caption) continue;
        if (territoryOwnerIndex(region.rect, textLayout) >= 0) continue;
        if (coverageOf(region.rect, corridor) < 0.85) continue;
        const gap = region.rect[1] - cap.rect[3];
        if (gap < -options.maxCaptionOverlapPt || gap > 80) continue;
        if (!proposalSightClear(region.rect, cap.rect, "above", prose, otherCaps, tableRects)) continue;
        const ovX = Math.min(region.rect[2], cap.rect[2]) - Math.max(region.rect[0], cap.rect[0]);
        const ovRatio = Math.max(0, ovX) / Math.max(1, Math.min(rectWidth(region.rect), rectWidth(cap.rect)));
        const regMid = (region.rect[0] + region.rect[2]) / 2;
        const capMid = (cap.rect[0] + cap.rect[2]) / 2;
        const centerDist = Math.abs(regMid - capMid) / Math.max(1, pageWidth);
        const score =
          ovRatio * 2.0 + Math.max(0, 1 - Math.max(0, gap) / 80) + areaRatioOf(region.rect, pageRect) - centerDist * 0.5;
        candidates.push({ ci, ri, prop, gap: Math.max(0, gap), score });
      }
    }
    proposalCount += candidates.length;

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      const usedCaps = new Set();
      const usedRegs = new Set();

      for (const match of candidates) {
        if (usedCaps.has(match.ci)) continue;
        if (usedRegs.has(match.ri)) {
          proposalConflictCount += 1;
          conflictedCaptions.add(captionKey(match.prop.cap));
          continue;
        }
        usedCaps.add(match.ci);
        usedRegs.add(match.ri);

        const region = merged[match.ri];
        const { cap, corridor } = match.prop;
        for (const rej of allRegions) {
          if (rej.accepted || absorbedRejectedRegions.has(rej) || rej.caption) continue;
          if (rej.rejectReason !== "below-confidence-threshold") continue;
          if (territoryOwnerIndex(rej.rect, textLayout) >= 0) continue;
          if (coverageOf(rej.rect, corridor) < 0.85) continue;
          const upGap = rej.rect[1] - region.rect[3];
          if (upGap < -2 || upGap > 48) continue;
          const band = [
            Math.min(region.rect[0], rej.rect[0]),
            Math.min(region.rect[3], rej.rect[1]),
            Math.max(region.rect[2], rej.rect[2]),
            Math.max(region.rect[3], rej.rect[1]),
          ];
          if (blockersIntersectRect(band, prose)) continue;
          if (blockersIntersectRect(rej.rect, prose)) continue;
          region.rect = unionRect(region.rect, rej.rect);
          region.placementCount += rej.placementCount;
          region.placementIndexes = [...region.placementIndexes, ...rej.placementIndexes];
          region.sourceKinds = [...new Set([...region.sourceKinds, ...(rej.sourceKinds ?? [rej.kind])])];
          region.kind = region.sourceKinds.length > 1 ? "multi" : region.sourceKinds[0];
          absorbedRejectedRegions.add(rej);
        }

        const updated = scoreRegion({
          kinds: region.sourceKinds ?? [region.kind],
          caption: cap,
          link: { gap: match.gap, side: "above" },
          rect: region.rect,
          pageRect,
          structTagged: region.evidence?.includes("struct-tree:Figure") ?? false,
          options,
        });
        region.caption = updated.captionLabel;
        region.captionNumber = updated.captionNumber;
        region.captionRects = [cap.rect];
        region.confidence = round(Math.max(region.confidence, updated.confidence), 3);
        region.evidence = [...new Set([...(region.evidence ?? []), ...updated.evidence, "proposal-corridor"])];
        linkedCount += 1;
      }
    }
    orphanCaptions = captions.filter((cap) => !isCaptionCoveredByRegions(cap, merged, options));
  }

  const unlinkedRecovered = recoverUnlinkedGraphicsForOrphans({
    orphanCaptions,
    merged,
    allRegions,
    unabsorbed,
    rejected,
    absorbedRejectedRegions,
    evaluated,
    captions,
    textLayout,
    pageRect,
    options,
  });
  linkedCount += unlinkedRecovered.linkedCount;
  proposalCount += unlinkedRecovered.proposalCount;
  proposalConflictCount += unlinkedRecovered.conflictCount;
  for (const ck of unlinkedRecovered.conflictedCaptions) conflictedCaptions.add(ck);
  for (const idx of unlinkedRecovered.recoveredIndexes) recoveredIndexes.add(idx);
  orphanCaptions = captions.filter((cap) => !isCaptionCoveredByRegions(cap, merged, options));

  const recovered = recoverExtremeAspectForOrphans({
    orphanCaptions,
    merged,
    evaluated,
    captions,
    textLayout,
    pageRect,
    options,
  });
  linkedCount += recovered.linkedCount;
  for (const idx of recovered.recoveredIndexes) recoveredIndexes.add(idx);

  return {
    linkedCount,
    recoveredIndexes,
    proposalCount,
    proposalConflictCount,
    conflictedCaptions,
  };
}

function isExplicitlyBoundToRegion(cap, regions) {
  for (const r of regions ?? []) {
    if (r.captionNumber != null && String(r.captionNumber) === String(cap.number)) return true;
    if (r.captionRects?.some((cr) => Math.abs(cr[0] - cap.rect[0]) < 1 && Math.abs(cr[1] - cap.rect[1]) < 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Summarize per-caption and page-level failure diagnostics without noisy logs.
 */
function summarizeStageCDiagnostics({
  captions,
  merged,
  evaluated,
  rejected,
  conflictedCaptions,
  proposalCount,
  proposalLinks,
  proposalConflictCount,
  options,
}) {
  void proposalCount;
  void proposalLinks;
  void proposalConflictCount;
  const counts = {
    "no-caption-detected": 0,
    "caption-without-graphics": 0,
    "caption-link-failed": 0,
    "candidate-rejected": 0,
    "proposal-conflict": 0,
    "region-accepted": 0,
  };
  const captionOutcomes = [];
  let orphanCaptionCount = 0;

  const claimedIndexes = new Set((merged ?? []).flatMap((r) => r.placementIndexes ?? []));
  const unclaimedUsableGraphics = (evaluated ?? []).filter(
    (c) => !claimedIndexes.has(c.index) && c.passesBasicFilter && !c.fullBleedFrame && !c.onlyThinRules,
  );
  const nonNoiseRejected = (rejected ?? []).filter(
    (r) =>
      r.reason !== "below-min-area" &&
      r.reason !== "thin-decoration" &&
      r.reason !== "off-page" &&
      r.reason !== "empty-rect",
  );

  for (const cap of captions ?? []) {
    const key = captionKey(cap);
    if (
      isExplicitlyBoundToRegion(cap, merged) ||
      (!conflictedCaptions?.has(key) && isCaptionCoveredByRegions(cap, merged, options))
    ) {
      counts["region-accepted"] += 1;
      captionOutcomes.push({
        captionNumber: String(cap.number),
        outcome: "region-accepted",
      });
      continue;
    }

    orphanCaptionCount += 1;
    let outcome = "caption-without-graphics";
    if (conflictedCaptions?.has(key)) {
      outcome = "proposal-conflict";
    } else if (unclaimedUsableGraphics.length > 0) {
      outcome = "caption-link-failed";
    } else if (
      nonNoiseRejected.length > 0 ||
      (rejected ?? []).some(
        (r) =>
          r.reason === "extreme-aspect" ||
          r.reason === "below-confidence-threshold" ||
          r.reason === "table-or-algorithm-region" ||
          r.reason === "prose-blocker-collision" ||
          r.reason === "unanchored-full-bleed-frame",
      )
    ) {
      outcome = "candidate-rejected";
    }
    counts[outcome] += 1;
    captionOutcomes.push({
      captionNumber: String(cap.number),
      outcome,
    });
  }

  return {
    orphanCaptionCount,
    captionOutcomes,
    failureReasonCounts: counts,
  };
}

function isInsideTableCaptionRegion(rect, textLayout, captions) {
  const tableCaptions = textLayout?.tableCaptionRects ?? [];
  if (!tableCaptions.length) return false;
  const prose = textLayout?.proseBlockers ?? [];
  const figCaptions = (captions ?? []).map((c) => c?.rect).filter(Boolean);
  const territories = textLayout?.tableTerritories ?? [];
  for (const tc of tableCaptions) {
    const overlapX = Math.min(rect[2], tc[2]) - Math.max(rect[0], tc[0]);
    const minW = Math.min(rectWidth(rect), rectWidth(tc));
    if (overlapX < 0.3 * minW) continue;
    const nonTableProse = prose.filter(
      (b) => !(b[2] >= tc[0] - 3 && b[0] <= tc[2] + 3 && b[3] >= tc[1] - 3 && b[1] <= tc[3] + 3),
    );

    // 1) Table/Algorithm caption sits above its body.
    if (tc[1] >= rect[3] - 4) {
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
      if (!blockersIntersectRect(corridor, nonTableProse)) return true;
      continue;
    }

    // 2) Bottom-captioned table (`Table N:` sits directly below the table).
    const ownsBelow = territories.some(
      (t) =>
        t.direction === "below" &&
        Math.abs(t.captionRect[0] - tc[0]) < 1 &&
        Math.abs(t.captionRect[1] - tc[1]) < 1,
    );
    if (ownsBelow) continue;
    if (rect[1] >= tc[3] - 4 && rect[1] - tc[3] <= 36) {
      const corridor = [
        Math.min(rect[0], tc[0]),
        tc[3] + 2,
        Math.max(rect[2], tc[2]),
        rect[1],
      ];
      const hasFigBetween = figCaptions.some(
        (fc) =>
          fc[2] >= corridor[0] &&
          fc[0] <= corridor[2] &&
          fc[3] >= corridor[1] &&
          fc[1] <= corridor[3],
      );
      if (hasFigBetween) continue;
      if (!blockersIntersectRect(corridor, nonTableProse)) return true;
    }
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
