var FigureColorPlugin = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/zotero/main.js
  var main_exports = {};
  __export(main_exports, {
    BUTTON_LABEL: () => BUTTON_LABEL,
    BUTTON_TITLE: () => BUTTON_TITLE,
    MAX_PROBE_SESSIONS: () => MAX_PROBE_SESSIONS,
    PLUGIN_ID: () => PLUGIN_ID,
    REALM_HREF_MAX: () => REALM_HREF_MAX,
    TOOLBAR_EVENT: () => TOOLBAR_EVENT,
    VIEWER_BRIDGE_SRC: () => VIEWER_BRIDGE_SRC,
    WINDOW_TOPICS: () => WINDOW_TOPICS,
    addZoteroNotifier: () => addZoteroNotifier,
    clearCache: () => clearCache,
    enabled: () => enabled,
    getLog: () => getLog,
    getRegionCache: () => getRegionCache,
    getSessions: () => getSessions,
    lastDiagnostics: () => lastDiagnostics,
    probeAll: () => probeAll,
    probePaint: () => probePaint,
    resetWarnings: () => resetWarnings,
    runProbe: () => runProbe,
    setEnabled: () => setEnabled,
    shutdown: () => shutdown,
    startup: () => startup,
    version: () => version,
    wakeStats: () => wakeStats,
    wakeTabSessions: () => wakeTabSessions
  });

  // src/core/detector-options.js
  var DEFAULT_DETECTOR_OPTIONS = Object.freeze({
    /** Placements smaller than this fraction of the page are icons or bullets. */
    minAreaRatio: 4e-3,
    /** Placements larger than this are page backgrounds or full-page scans. */
    maxAreaRatio: 0.8,
    /** Shorter side below this is treated as a rule, underline or decoration. */
    minSidePt: 24,
    /** Maximum vertical distance between a figure and its caption. */
    maxCaptionGapPt: 26,
    /**
     * How far a caption's reported rect may intrude into the artwork it labels.
     * pdf.js text bboxes carry the full font ascent and descent, so a caption
     * row's box routinely reaches 2-5 pt past the figure edge above it (measured
     * on the flash-level fixture: 4.6 pt on page 4, 2.3 pt on page 12). Linking
     * therefore tolerates an intrusion of one caption row height, capped here,
     * and scores it as a zero gap instead of rejecting the link.
     */
    maxCaptionOverlapPt: 12,
    /** Gap below which the extra "close caption" confidence applies. */
    smallCaptionGapPt: 18,
    /**
     * Extra gap a wide caption row is granted on top of `maxCaptionGapPt`, in
     * page-width fractions of the wider of the caption row and the artwork. A
     * caption under a row of subfigures is typeset as wide as the row, and its
     * reported box stops at the descender of the last line, so the distance to
     * the artwork grows with the row instead of staying constant. Measured on the
     * FluidKV fixture figure 13: six 80.7 pt sub-forms sit under a 505.9 pt wide
     * caption row, and the artwork starts 30.59 pt above that box - 4.59 pt past
     * the flat limit. A factor of 6 grants 4.96 pt there, while the widest gap
     * that must stay unlinked - the 29.61 pt between the FluidKV figure 8 and the
     * figure 9 caption, a 206.8 pt cluster - grows only 2.03 pt and stays 3.6 pt
     * short of linking. Same-page body text is never this close to a figure, so
     * the allowance costs nothing on the three pinned fixtures.
     */
    captionGapWidthAllowanceFactor: 6,
    /**
     * How far outside a region's vertical edge a text item may sit, and by how far
     * the region may grow from the border the artwork produced, before the run
     * stops reading as part of the figure: axis units and tick labels are separate
     * text runs, not vector paint, so they leave the region border short. Measured
     * on the flash-level fixture the "16K" and "50" tick labels end 3.41 and 3.31 pt
     * short of the frame, so the label-to-frame gap is small; what the value has to
     * stay under is the 25.42 pt gutter between the two body columns of the FluidKV
     * fixture, whose nearest body run to a figure border is 30.60 pt away. Without
     * the growth half of the limit the nearest label lets the next one in and the
     * region walks to the page edge - the PipeBWrite fixture page 3 reached x 612
     * that way, 54 pt past the artwork, over the vertical ACM sidebar stamp.
     */
    textExpansionPt: 24,
    /** Required horizontal overlap between caption and placement. */
    minCaptionOverlapRatio: 0.3,
    /** Regions must reach this confidence before the overlay is drawn. */
    acceptConfidence: 0.6,
    /** An image with no caption still counts above this area fraction. */
    unanchoredImageMinAreaRatio: 0.02,
    /** Vertical distance within which placements join one subfigure row. */
    rowMergeGapPt: 6,
    /**
     * How far inside a region the centre of an area-rejected placement must sit
     * before it is absorbed into that region. The tolerance keeps a placement
     * that only grazes the border out of the union.
     */
    absorbCenterInsetPt: 1,
    /**
     * Vector art arrives as hundreds of single-stroke boxes. Boxes closer than
     * this fraction of the page diagonal are chained into one candidate, so the
     * panels of a plot become one figure while the gap between two figures,
     * which is wider, keeps them apart.
     */
    pathMergeGapDiagonalRatio: 0.018,
    /**
     * A painted path whose area outside the page exceeds this fraction does not
     * take part in clustering. The Borges fixture page 12 carries 15 degenerate
     * paths reaching y0 = -13846.3: h ~ 14455 pt, w ~ 11.4 pt, so only 4.2 % of
     * their own area is on the page, yet the full boxes chained the two figure
     * bands into one cluster of area ratio 15.15 that the page-sized gate
     * rejected. Every path box retained on all three fixtures is fully on the
     * page (visible ratio 1.0), so the 0.25 cut sits ~6x above the dropped ones
     * and 4x below the kept ones; no artwork is trimmed by this filter.
     */
    pathMinVisibleAreaRatio: 0.25,
    /**
     * A full-bleed clip frame is evidence, never extent.
     *
     * The clip rectangle a figure is drawn inside is painted as one path with a
     * single `re` operation, so it shows up as a box of its own: full-bleed in
     * both axes, area over a quarter of the page, and much larger than any of the
     * artwork strokes inside it. Chaining it into the artwork made it *extent*:
     * on the FluidKV fixture the page-5 frame (raw `[0, 0, 612, 346]`, area ratio
     * 0.44, width ratio 1.0) inflated the union to the page edges — the reported
     * band `[0, 0, 612, 181.9]` — and bridged the 28.29 pt gutter between figure 7
     * and figure 8, so two figures became one page-wide slab.
     *
     * Sweep margins, both measured on the four fixtures:
     *   - real artwork tops out at area ratio 0.208 (FluidKV page 6) and Borges
     *     page 12's tall body strips reach width ratio 0.02;
     *   - frames start at area ratio 0.324 and width ratio 0.863;
     *   - the area cut must stay at or above 0.25: 0.15 or 0.20 sweeps 11-15 pt
     *     of real artwork off Borges page 6 (the figure loses its left band).
     * The predicate runs on the RAW pre-clip rect, because clipping a frame to the
     * page is exactly what produced the wrong extent.
     */
    pathFullBleedAreaRatio: 0.25,
    /** Width counterpart of `pathFullBleedAreaRatio`; frames are full-bleed. */
    pathFullBleedWidthRatio: 0.8,
    /** Safety valve: path boxes past this count on one page are dropped. */
    maxPathBoxesPerPage: 1200,
    /** Upper bound on the merge sweeps, for pages with pathological nesting. */
    pathMergeMaxPasses: 30,
    /** A path cluster with no caption or tag still counts above this area. */
    pathAnchoredAreaRatio: 0.015,
    /** Page inset used for the "inside margins" confidence bonus. */
    marginInsetPt: 12,
    minAspect: 0.15,
    maxAspect: 8
  });
  function areaRatioOf(rect, pageRect, options = DEFAULT_DETECTOR_OPTIONS) {
    void options;
    const pageArea = Math.abs(pageRect[2] - pageRect[0]) * Math.abs(pageRect[3] - pageRect[1]);
    if (!pageArea) return 0;
    return Math.abs(rect[2] - rect[0]) * Math.abs(rect[3] - rect[1]) / pageArea;
  }

  // src/core/geom.js
  var IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
  function toMatrix(value) {
    if (!value) return null;
    const raw = Array.isArray(value) ? value : Array.from(value);
    if (raw.length < 6) return null;
    const out = [
      Number(raw[0]),
      Number(raw[1]),
      Number(raw[2]),
      Number(raw[3]),
      Number(raw[4]),
      Number(raw[5])
    ];
    return out.every(Number.isFinite) ? out : null;
  }
  function toRect(value) {
    if (!value) return null;
    const raw = Array.isArray(value) ? value : Array.from(value);
    if (raw.length < 4) return null;
    const out = [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])];
    return out.every(Number.isFinite) ? out : null;
  }
  function multiplyMatrices(outer, inner) {
    const a = outer;
    const b = inner;
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5]
    ];
  }
  function transformPoint(matrix, x, y) {
    return [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5]
    ];
  }
  function rectFromMatrix(matrix, rect) {
    const corners = [
      transformPoint(matrix, rect[0], rect[1]),
      transformPoint(matrix, rect[2], rect[1]),
      transformPoint(matrix, rect[2], rect[3]),
      transformPoint(matrix, rect[0], rect[3])
    ];
    return normalizeRect([
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1]))
    ]);
  }
  function normalizeRect(rect) {
    return [
      Math.min(rect[0], rect[2]),
      Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]),
      Math.max(rect[1], rect[3])
    ];
  }
  function rectWidth(rect) {
    return Math.abs(rect[2] - rect[0]);
  }
  function rectHeight(rect) {
    return Math.abs(rect[3] - rect[1]);
  }
  function rectArea(rect) {
    return rectWidth(rect) * rectHeight(rect);
  }
  function intersectRects(a, b) {
    const x0 = Math.max(a[0], b[0]);
    const y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[2], b[2]);
    const y1 = Math.min(a[3], b[3]);
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1, y1];
  }
  function intersectionArea(a, b) {
    const inter = intersectRects(a, b);
    return inter ? rectArea(inter) : 0;
  }
  function unionRect(a, b) {
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }
  function iou(a, b) {
    const inter = intersectionArea(a, b);
    if (!inter) return 0;
    const union = rectArea(a) + rectArea(b) - inter;
    return union > 0 ? inter / union : 0;
  }
  function coverageOf(inner, outer) {
    const area = rectArea(inner);
    if (!area) return 0;
    return intersectionArea(inner, outer) / area;
  }

  // src/core/captions.js
  var CAPTION_RE = /^\s*(?:figure|fig\.?)\s*([0-9]+[a-zA-Z]?)\s*[:.)]/i;
  function textItemRect(item) {
    const matrix = toMatrix(item?.transform);
    if (!matrix) return null;
    const det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
    const height = Math.abs(Number(item.height) || 0) || (det > 0 ? Math.sqrt(det) : 0);
    let width = Math.abs(Number(item.width) || 0);
    if (!width) {
      const chars = (item.str ?? "").length;
      width = chars * height * 0.5;
    }
    if (!width || !height) return null;
    return textRectFromBasis(matrix, width, height);
  }
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
        origin[1] + writing[1] * width + vertical[1] * height
      ]
    ];
    return normalizeRect([
      Math.min(...corners.map((p) => p[0])),
      Math.min(...corners.map((p) => p[1])),
      Math.max(...corners.map((p) => p[0])),
      Math.max(...corners.map((p) => p[1]))
    ]);
  }
  function unit(vector) {
    const length = Math.hypot(vector[0], vector[1]);
    return length > 0 ? [vector[0] / length, vector[1] / length] : null;
  }
  var DEFAULT_COLUMN_GAP_MIN_FONT_SIZE_UNITS = 2;
  var DEFAULT_COLUMN_GAP_MIN_PT = 8;
  function collectTextLines(items, options = {}) {
    const tolerance = options.baselineTolerance ?? 1.2;
    const gapUnits = options.columnGapMinFontSizeUnits ?? DEFAULT_COLUMN_GAP_MIN_FONT_SIZE_UNITS;
    const gapFloor = options.columnGapMinPt ?? DEFAULT_COLUMN_GAP_MIN_PT;
    const buckets = /* @__PURE__ */ new Map();
    for (const item of items ?? []) {
      if (typeof item?.str !== "string" || !item.str.trim()) continue;
      const rect = textItemRect(item);
      if (!rect) continue;
      const fontSize = Math.abs(Number(item.height) || 0) || 0;
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
          (acc, part) => normalizeRect([
            Math.min(acc[0], part.rect[0]),
            Math.min(acc[1], part.rect[1]),
            Math.max(acc[2], part.rect[2]),
            Math.max(acc[3], part.rect[3])
          ]),
          [...segment[0].rect]
        );
        lines.push({
          text: segment.map((part) => part.str).join(" "),
          rect,
          baselineY: segment[0].rect[1],
          fontSize: median(segment.map((part) => part.fontSize)),
          itemRects: segment.map((part) => part.rect)
        });
      }
    }
    lines.sort((a, b) => {
      if (Math.abs(a.baselineY - b.baselineY) > 1e-6) return b.baselineY - a.baselineY;
      return a.rect[0] - b.rect[0];
    });
    return lines;
  }
  function splitByGap(bucket, gapUnits, gapFloor) {
    const segments = [];
    let segment = [bucket[0]];
    let right = bucket[0].rect[2];
    for (const part of bucket.slice(1)) {
      const size = median(segment.map((run) => run.fontSize)) || part.fontSize;
      const threshold = Math.max(gapUnits * size, gapFloor);
      if (part.rect[0] - right > threshold) {
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
  function collectCaptions(lines, options = {}) {
    const captions = [];
    for (const line of lines ?? []) {
      const match = CAPTION_RE.exec(line.text);
      if (!match) continue;
      captions.push({
        number: match[1],
        label: `${match[0].trim()}`,
        text: line.text,
        rect: line.rect,
        fontSize: line.fontSize
      });
    }
    return captions;
  }
  function median(values) {
    const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
    if (!nums.length) return 0;
    return nums[Math.floor(nums.length / 2)];
  }

  // src/core/detector.js
  function detectFigureRegions(input) {
    const options = { ...DEFAULT_DETECTOR_OPTIONS, ...input.options };
    const pageRect = input.pageRect;
    const rawPlacements = input.placements ?? [];
    const captions = input.captions ?? [];
    const structRegions = input.structRegions ?? [];
    if (!Array.isArray(pageRect) || rectArea(pageRect) <= 0) {
      throw new TypeError("detectFigureRegions: pageRect must be a rect with positive area");
    }
    const pathMerge = mergePathPlacements(
      rawPlacements.filter((placement) => placement?.kind === "path"),
      pageRect,
      options,
      captions
    );
    const placements = [
      ...rawPlacements.filter((placement) => placement?.kind !== "path"),
      ...pathMerge.placements
    ];
    const evaluated = placements.map(
      (placement, index) => evaluatePlacement(placement, index, pageRect, options)
    );
    const structTagged = tagStructMatches(evaluated, structRegions);
    const assignment = /* @__PURE__ */ new Map();
    for (const caption of captions) {
      for (const candidate of evaluated) {
        if (!candidate.passesBasicFilter) continue;
        const link = linkCaption(caption, candidate.rect, options, pageRect);
        if (!link) continue;
        const current = assignment.get(candidate.index);
        if (!current || betterLink(link, current)) {
          assignment.set(candidate.index, { caption, gap: link.gap, side: link.side });
        }
      }
    }
    const byCaption = /* @__PURE__ */ new Map();
    for (const [index, link] of assignment.entries()) {
      const key = captionKey(link.caption);
      if (!byCaption.has(key)) byCaption.set(key, { caption: link.caption, links: [] });
      byCaption.get(key).links.push({
        candidate: evaluated.find((candidate) => candidate.index === index),
        gap: link.gap,
        side: link.side
      });
    }
    const regions = [];
    const rejected = [];
    for (const { caption, links } of byCaption.values()) {
      const row = pickNearestRow(links, caption.rect, options);
      if (!row.length) continue;
      const kept = new Set(row.map((item) => item.candidate.index));
      for (const link of links) {
        if (!kept.has(link.candidate.index)) rejected.push(reject(link.candidate, "dropped-row", 0));
      }
      const rect = row.reduce(
        (acc, item) => unionRect(acc, item.candidate.rect),
        [...row[0].candidate.rect]
      );
      const score = scoreRegion({
        kinds: row.map((item) => item.candidate.kind),
        caption,
        link: row[0],
        rect,
        pageRect,
        structTagged: row.some((item) => structTagged.has(item.candidate.index)),
        options
      });
      regions.push(buildRegion(rect, score, row.length, row.map((item) => item.candidate.index), options));
    }
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
        options
      });
      regions.push(buildRegion(struct.rect, score, 0, [], options));
    }
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
          const score3 = scoreRegion({
            kinds: ["path"],
            caption: null,
            link: null,
            rect: candidate.rect,
            pageRect,
            structTagged: false,
            standalonePath: true,
            options
          });
          regions.push(buildRegion(candidate.rect, score3, 1, [candidate.index], options));
          continue;
        }
        const score2 = scoreRegion({
          kinds: [candidate.kind],
          caption: null,
          link: null,
          rect: candidate.rect,
          pageRect,
          structTagged: false,
          options
        });
        rejected.push(reject(candidate, "no-figure-evidence", score2.confidence));
        continue;
      }
      if (candidate.areaRatio < options.unanchoredImageMinAreaRatio) {
        areaRejected.push({ candidate, reason: "image-below-area-threshold" });
        continue;
      }
      const score = scoreRegion({
        kinds: ["image"],
        caption: null,
        link: null,
        rect: candidate.rect,
        pageRect,
        structTagged: false,
        standaloneImage: true,
        options
      });
      regions.push(buildRegion(candidate.rect, score, 1, [candidate.index], options));
    }
    const merged = mergeRegions(regions.filter((region) => region.accepted));
    const unabsorbed = absorbAreaRejected(merged, areaRejected, options, pageRect);
    const textExpansion = expandRegionsWithText(merged, input.textItems, pageRect, options);
    for (const region of regions) {
      if (region.accepted) continue;
      rejected.push({
        index: region.placementIndexes[0] ?? null,
        kind: region.kind,
        rect: region.rect,
        reason: region.rejectReason,
        confidence: region.confidence
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
        evaluated
      }
    };
  }
  function mergePathPlacements(paths, pageRect, options, captions) {
    const usable = [];
    let offPageDropped = 0;
    for (const placement of paths ?? []) {
      const rect = placement?.rect;
      if (!Array.isArray(rect) || rect.some((value) => !Number.isFinite(value))) continue;
      if (rectArea(rect) <= 0) continue;
      const visible = intersectRects(rect, pageRect);
      if (!visible) continue;
      if (rectArea(visible) / rectArea(rect) < options.pathMinVisibleAreaRatio) {
        offPageDropped += 1;
        continue;
      }
      usable.push({
        rect: [...visible],
        raw: [...rect],
        mergedCount: 1,
        members: [[...visible]],
        opIndex: placement.opIndex ?? null,
        depth: placement.depth ?? 0
      });
    }
    const pageArea = rectArea(pageRect);
    const pageWidth = rectWidth(pageRect);
    const isFullBleedFrame = pageArea > 0 && pageWidth > 0 ? (box) => rectArea(box.raw) >= options.pathFullBleedAreaRatio * pageArea && rectWidth(box.raw) >= options.pathFullBleedWidthRatio * pageWidth : () => false;
    const frames = [];
    const artwork = [];
    for (const box of usable) (isFullBleedFrame(box) ? frames : artwork).push(box);
    const cap = Math.max(0, options.maxPathBoxesPerPage);
    const truncated = Math.max(0, artwork.length - cap);
    let boxes = artwork.slice(0, cap);
    const tolerance = options.pathMergeGapDiagonalRatio * pageDiagonal(pageRect);
    let passes = 0;
    while (tolerance > 0 && passes < options.pathMergeMaxPasses && boxes.length > 1) {
      const next = mergePass(boxes, tolerance);
      passes += 1;
      if (next.length === boxes.length) break;
      boxes = next;
    }
    const split = splitAtInteriorCaptions(boxes, captions ?? [], pageRect, tolerance, options);
    const unmatchedFrames = frames.filter(
      (frame) => !split.boxes.some((box) => gapWithin(box.rect, frame.rect, tolerance))
    );
    const emitted = [...split.boxes, ...unmatchedFrames];
    return {
      placements: emitted.map((box) => ({
        kind: "path",
        rect: box.rect,
        depth: box.depth,
        opIndex: box.opIndex,
        mergedCount: box.mergedCount
      })),
      diagnostics: {
        rawPathBoxCount: (paths ?? []).length,
        pathBoxCount: emitted.length,
        pathMergePasses: passes,
        pathBoxesTruncated: truncated,
        pathBoxesOffPage: offPageDropped,
        pathClusterSplits: split.splits
      }
    };
  }
  function mergePass(boxes, tolerance) {
    const parent = boxes.map((_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const left = find(i);
        const right = find(j);
        if (left === right) continue;
        if (gapWithin(boxes[left].rect, boxes[right].rect, tolerance)) parent[right] = left;
      }
    }
    const groups = /* @__PURE__ */ new Map();
    for (const [index, box] of boxes.entries()) {
      const root = find(index);
      const group = groups.get(root);
      if (!group) {
        groups.set(root, {
          rect: [...box.rect],
          mergedCount: box.mergedCount,
          // Raw member rects ride along: the interior-caption split pass needs
          // to re-partition a cluster box by box, which the union alone cannot.
          members: box.members ? box.members.map((member) => [...member]) : [[...box.rect]],
          opIndex: box.opIndex,
          depth: box.depth
        });
        continue;
      }
      group.rect = unionRect(group.rect, box.rect);
      group.mergedCount += box.mergedCount;
      for (const member of box.members ?? [box.rect]) group.members.push([...member]);
      if (box.opIndex != null && (group.opIndex == null || box.opIndex < group.opIndex)) {
        group.opIndex = box.opIndex;
      }
      group.depth = Math.min(group.depth, box.depth);
    }
    return [...groups.values()];
  }
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
      const row = rows.reduce(
        (best, other) => slabCentreDistance(cluster.rect, other) < slabCentreDistance(cluster.rect, best) ? other : best
      );
      const bands = splitMembersAtSlab(cluster.members, row, options);
      if (!bands[0].length || !bands[1].length) {
        out.push(cluster);
        continue;
      }
      const parts = [
        ...mergeMembers(bands[0], cluster, tolerance, options.pathMergeMaxPasses),
        ...mergeMembers(bands[1], cluster, tolerance, options.pathMergeMaxPasses)
      ];
      if (!parts.every((part) => splitBandIsValid(part, captions, pageRect, options))) {
        out.push(cluster);
        continue;
      }
      splits += 1;
      queue.push(...parts);
    }
    return { boxes: out, splits };
  }
  function mergeMembers(members, cluster, tolerance, maxPasses) {
    if (!members.length) return [];
    let boxes = members.map((rect) => ({
      rect,
      mergedCount: 1,
      members: [rect],
      opIndex: cluster.opIndex,
      depth: cluster.depth
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
  function findInteriorCaptionRows(clusterRect, captions, options = DEFAULT_DETECTOR_OPTIONS) {
    const inset = options.maxCaptionOverlapPt;
    const rows = [];
    for (const caption of captions ?? []) {
      const row = caption?.rect;
      if (!Array.isArray(row) || row.some((value) => !Number.isFinite(value))) continue;
      if (row[1] <= clusterRect[1] + inset || row[3] >= clusterRect[3] - inset) continue;
      const overlap = intersectRects(
        [clusterRect[0], -1e6, clusterRect[2], 1e6],
        [row[0], -1e6, row[2], 1e6]
      );
      const overlapWidth = overlap ? overlap[2] - overlap[0] : 0;
      if (overlapWidth < options.minCaptionOverlapRatio * Math.min(rectWidth(row), rectWidth(clusterRect)))
        continue;
      rows.push(row);
    }
    return rows;
  }
  function gapWithin(a, b, tolerance) {
    const gapX = Math.max(b[0] - a[2], a[0] - b[2], 0);
    const gapY = Math.max(b[1] - a[3], a[1] - b[3], 0);
    return gapX <= tolerance && gapY <= tolerance;
  }
  function pageDiagonal(pageRect) {
    return Math.hypot(Math.abs(pageRect[2] - pageRect[0]), Math.abs(pageRect[3] - pageRect[1]));
  }
  function evaluatePlacement(placement, index, pageRect, options) {
    const rect = placement.rect;
    const base = {
      index,
      kind: placement.kind ?? "unknown",
      rect,
      depth: placement.depth ?? 0,
      opIndex: placement.opIndex ?? null,
      areaRatio: 0,
      minSide: 0,
      aspect: 0,
      passesBasicFilter: true,
      rejectReason: null
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
      aspect: width / height
    };
    if (area <= 0) return { ...detail, passesBasicFilter: false, rejectReason: "empty-rect" };
    if (!intersectRects(rect, pageRect)) {
      return { ...detail, passesBasicFilter: false, rejectReason: "off-page" };
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
      confidence: round(confidence, 3)
    };
  }
  function betterLink(link, current) {
    if (link.side === "above" && current.side !== "above") return true;
    if (link.side !== "above" && current.side === "above") return false;
    return link.gap < current.gap;
  }
  function linkCaption(caption, rect, options, pageRect) {
    const overlap = intersectRects(
      [rect[0], -1e6, rect[2], 1e6],
      [caption.rect[0], -1e6, caption.rect[2], 1e6]
    );
    const overlapWidth = overlap ? overlap[2] - overlap[0] : 0;
    const needed = options.minCaptionOverlapRatio * Math.min(rectWidth(caption.rect), rectWidth(rect));
    if (overlapWidth < needed) return null;
    const maxOverlap = Math.min(rectHeight(caption.rect), options.maxCaptionOverlapPt);
    const pageWidth = Math.abs(pageRect[2] - pageRect[0]);
    const gapAllow = options.maxCaptionGapPt + (pageWidth > 0 ? options.captionGapWidthAllowanceFactor * Math.max(rectWidth(caption.rect), rectWidth(rect)) / pageWidth : 0);
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
  function pickNearestRow(links, captionRect, options) {
    if (!links.length) return [];
    const sorted = [...links].sort((a, b) => a.candidate.rect[1] - b.candidate.rect[1]);
    const rows = [];
    for (const link of sorted) {
      const current = rows.at(-1);
      const touches = current && link.candidate.rect[1] <= current.top + options.rowMergeGapPt && link.candidate.rect[3] >= current.bottom - options.rowMergeGapPt;
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
        standardSide: link.side === "above"
      });
    }
    const candidates = rows.some((row) => row.standardSide) ? rows.filter((row) => row.standardSide) : rows;
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
    options
  }) {
    const evidence = [];
    let confidence = 0;
    const isForm = kinds.includes("form");
    const isImage = kinds.includes("image");
    const isPath = kinds.includes("path");
    const sourceKinds = [...new Set(kinds)];
    const kind = sourceKinds.length > 1 ? "multi" : sourceKinds[0] ?? "unknown";
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
      confidence += 0.15;
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
    const gate = Boolean(caption) || structTagged || isImage && ratio >= options.unanchoredImageMinAreaRatio || isPath && ratio >= options.pathAnchoredAreaRatio;
    return {
      confidence,
      evidence,
      kind,
      sourceKinds,
      gate,
      ratio,
      captionLabel: caption ? caption.label ?? `Figure ${caption.number}` : null,
      captionNumber: caption?.number == null ? null : String(caption.number),
      captionRect: caption ? [...caption.rect] : null
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
      rejectReason: !score.gate ? "no-figure-evidence" : accepted ? null : "below-confidence-threshold"
    };
  }
  function mergeRegions(regions) {
    const sorted = regions.filter((region) => region.accepted).sort((a, b) => b.confidence - a.confidence);
    const merged = [];
    for (const region of sorted) {
      const existing = merged.find(
        (other) => iou(other.rect, region.rect) > 0.5 || coverageOf(region.rect, other.rect) > 0.85 || coverageOf(other.rect, region.rect) > 0.85
      );
      if (existing) {
        existing.rect = unionRect(existing.rect, region.rect);
        existing.confidence = Math.max(existing.confidence, region.confidence);
        existing.evidence = [.../* @__PURE__ */ new Set([...existing.evidence, ...region.evidence])];
        existing.sourceKinds = [
          .../* @__PURE__ */ new Set([...existing.sourceKinds ?? [existing.kind], ...region.sourceKinds ?? [region.kind]])
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
        const centreInside = centreX > bounds[0] + inset && centreX < bounds[2] - inset && centreY > bounds[1] + inset && centreY < bounds[3] - inset;
        if (!centreInside) continue;
        const touchesCaption = region.captionRects.some(
          (captionRect) => intersectRects(rect, captionRect)
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
  function expandRegionsWithText(merged, textItems, pageRect, options) {
    const allowance = options.textExpansionPt;
    if (!merged.length || !textItems?.length || !(allowance > 0)) return 0;
    const items = [];
    for (const item of textItems) {
      const rect = Array.isArray(item?.rect) ? item.rect : textItemRect(item ?? {});
      if (!rect || rect.some((value) => !Number.isFinite(value)) || rectArea(rect) <= 0) continue;
      if (typeof item?.str === "string" && !item.str.trim()) continue;
      let baselineY = Number(item?.baselineY);
      if (!Number.isFinite(baselineY)) {
        const matrix = toMatrix(item?.transform);
        baselineY = matrix ? transformPoint(matrix, 0, 0)[1] : rect[1];
      }
      items.push({ rect: [...rect], baselineY, used: false });
    }
    if (!items.length) return 0;
    const midX = (pageRect[0] + pageRect[2]) / 2;
    let grownRegions = 0;
    for (const region of merged) {
      const anchorSide = Math.sign((region.rect[0] + region.rect[2]) / 2 - midX);
      const border = [...region.rect];
      let grown = false;
      let changed = true;
      while (changed) {
        changed = false;
        let best = null;
        let bestGap = Infinity;
        for (const item of items) {
          if (item.used) continue;
          if (item.baselineY <= region.rect[1] || item.baselineY >= region.rect[3]) continue;
          const gap = Math.max(
            region.rect[0] - item.rect[2],
            item.rect[0] - region.rect[2],
            0
          );
          if (gap > allowance) continue;
          if (Math.sign((item.rect[0] + item.rect[2]) / 2 - midX) !== anchorSide) continue;
          if (region.captionRects.some((captionRect) => intersectRects(item.rect, captionRect))) continue;
          const grownRect = growWidth(region.rect, item.rect, pageRect);
          if (!grownRect || areaRatioOf(grownRect, pageRect) > options.maxAreaRatio) continue;
          if (rectWidth(grownRect) - rectWidth(region.rect) < 0.5) continue;
          if (border[0] - grownRect[0] > allowance || grownRect[2] - border[2] > allowance) {
            continue;
          }
          if (gap < bestGap) {
            best = item;
            bestGap = gap;
          }
        }
        if (!best) break;
        best.used = true;
        region.rect = growWidth(region.rect, best.rect, pageRect) ?? region.rect;
        grown = true;
        changed = true;
      }
      if (grown) grownRegions += 1;
    }
    return grownRegions;
  }
  function growWidth(rect, other, pageRect) {
    return intersectRects(
      [
        Math.min(rect[0], other[0]),
        rect[1],
        Math.max(rect[2], other[2]),
        rect[3]
      ],
      pageRect
    );
  }
  function tagStructMatches(evaluated, structRegions) {
    const tagged = /* @__PURE__ */ new Set();
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
    return rect[0] >= pageRect[0] + inset && rect[1] >= pageRect[1] + inset && rect[2] <= pageRect[2] - inset && rect[3] <= pageRect[3] - inset;
  }
  function captionKey(caption) {
    return `${caption.number}@${round(caption.rect[0], 1)}:${round(caption.rect[1], 1)}`;
  }
  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  // src/core/placements.js
  var PATH_PAINT_OP_NAMES = Object.freeze([
    "stroke",
    "closeStroke",
    "fill",
    "eoFill",
    "fillStroke",
    "eoFillStroke",
    "closeFillStroke",
    "closeEOFillStroke"
  ]);
  function resolveOperatorCodes(OPS) {
    const exact = [
      "save",
      "restore",
      "transform",
      "paintImageXObject",
      "paintImageXObjectRepeat",
      "paintJpegXObject",
      "paintFormXObjectBegin",
      "paintFormXObjectEnd",
      "constructPath",
      "rawFillPath",
      ...PATH_PAINT_OP_NAMES
    ];
    const codes = {};
    for (const name of exact) {
      if (typeof OPS?.[name] === "number") codes[name] = [OPS[name]];
    }
    codes.paintImageXObject = codes.paintImageXObject ?? [];
    for (const [key, value] of Object.entries(OPS ?? {})) {
      if (typeof value === "number" && /^paint(Image|Jpeg)XObject/.test(key) && !key.endsWith("Repeat") && !codes.paintImageXObject.includes(value)) {
        codes.paintImageXObject.push(value);
      }
    }
    return codes;
  }
  function operatorListArrays(operatorList) {
    if (!operatorList) return { ops: [], args: [] };
    return {
      ops: operatorList.ops ?? operatorList.fnArray ?? [],
      args: operatorList.args ?? operatorList.argsArray ?? []
    };
  }
  function collectPlacements({ ops, args = [], codes }) {
    const codeIndex = /* @__PURE__ */ new Map();
    for (const [name, list] of Object.entries(codes ?? {})) {
      for (const code of list ?? []) {
        if (!codeIndex.has(code)) codeIndex.set(code, name);
      }
    }
    const placements = [];
    const skipped = [];
    const stack = [];
    const paintCodes = /* @__PURE__ */ new Set();
    for (const name of PATH_PAINT_OP_NAMES) {
      for (const code of codes?.[name] ?? []) paintCodes.add(code);
    }
    let ctm = IDENTITY;
    let formDepth = 0;
    let clip = null;
    let restoreCount = 0;
    let pathCount = 0;
    let clippedCount = 0;
    const push = (placement) => placements.push(placement);
    for (let i = 0; i < ops.length; i++) {
      const name = codeIndex.get(ops[i]);
      if (!name) continue;
      const opArgs = args[i];
      switch (name) {
        case "save":
          stack.push({ ctm, formDepth, clip });
          break;
        case "restore": {
          const state = stack.pop();
          if (state) {
            ctm = state.ctm;
            formDepth = state.formDepth;
            clip = state.clip;
          }
          restoreCount += 1;
          break;
        }
        case "transform": {
          const matrix = toMatrix(opArgs);
          if (matrix) ctm = multiplyMatrices(ctm, matrix);
          break;
        }
        case "paintImageXObject":
        case "paintJpegXObject": {
          const rect = rectFromMatrix(ctm, [0, 0, 1, 1]);
          if (!isUsableRect(rect)) {
            skipped.push({ kind: "image", opIndex: i, reason: "degenerate-rect" });
            break;
          }
          const clipped = clipRect(rect, clip);
          if (!clipped) {
            clippedCount += 1;
            skipped.push({ kind: "image", opIndex: i, reason: "outside-clip" });
            break;
          }
          if (!sameRect(clipped, rect)) clippedCount += 1;
          push({
            kind: "image",
            rect: clipped,
            localBox: [0, 0, 1, 1],
            matrix: IDENTITY,
            ctm,
            depth: formDepth,
            opIndex: i
          });
          break;
        }
        case "paintImageXObjectRepeat": {
          skipped.push({ kind: "image", opIndex: i, reason: "image-repeat-ignored" });
          break;
        }
        case "constructPath":
        case "rawFillPath": {
          const mode = name === "constructPath" ? opArgs?.[0] : null;
          const bounds = toBounds(name === "constructPath" ? opArgs?.[2] : opArgs?.[1]);
          if (name === "constructPath" && !paintCodes.has(mode)) {
            skipped.push({ kind: "path", opIndex: i, reason: "path-not-painted" });
            break;
          }
          if (!bounds) {
            skipped.push({ kind: "path", opIndex: i, reason: "path-no-bounds" });
            break;
          }
          const rect = rectFromMatrix(ctm, bounds);
          if (!isUsableRect(rect)) {
            skipped.push({ kind: "path", opIndex: i, reason: "degenerate-rect" });
            break;
          }
          const clipped = clipRect(rect, clip);
          if (!clipped) {
            clippedCount += 1;
            skipped.push({ kind: "path", opIndex: i, reason: "outside-clip" });
            break;
          }
          if (!sameRect(clipped, rect)) clippedCount += 1;
          pathCount += 1;
          push({
            kind: "path",
            rect: clipped,
            localBox: null,
            matrix: IDENTITY,
            ctm,
            depth: formDepth,
            opIndex: i
          });
          break;
        }
        case "paintFormXObjectBegin": {
          const formMatrix = toMatrix(opArgs?.[0]) ?? IDENTITY;
          const localBox = toRect(opArgs?.[1]);
          const entryClip = clip;
          if (!localBox || localBox[2] <= localBox[0] || localBox[3] <= localBox[1]) {
            skipped.push({ kind: "form", opIndex: i, reason: "missing-or-empty-bbox" });
          } else {
            const rect = rectFromMatrix(multiplyMatrices(ctm, formMatrix), localBox);
            if (!isUsableRect(rect)) {
              skipped.push({ kind: "form", opIndex: i, reason: "degenerate-rect" });
            } else {
              const clipped = clipRect(rect, clip);
              if (!clipped) {
                clippedCount += 1;
                skipped.push({ kind: "form", opIndex: i, reason: "outside-clip" });
                clip = rect;
              } else {
                if (!sameRect(clipped, rect)) clippedCount += 1;
                push({
                  kind: "form",
                  rect: clipped,
                  localBox,
                  matrix: formMatrix,
                  ctm,
                  depth: formDepth,
                  opIndex: i
                });
                clip = clipped;
              }
            }
          }
          formDepth += 1;
          stack.push({ ctm, formDepth: formDepth - 1, form: true, clip: entryClip });
          ctm = multiplyMatrices(ctm, formMatrix);
          break;
        }
        case "paintFormXObjectEnd": {
          let state = null;
          let guard = stack.length;
          while (guard-- > 0) {
            state = stack.pop();
            if (state?.form) break;
            state = null;
          }
          if (state) {
            ctm = state.ctm;
            formDepth = state.formDepth;
            clip = state.clip;
          } else {
            formDepth = Math.max(0, formDepth - 1);
          }
          break;
        }
        default:
          break;
      }
    }
    return {
      placements,
      skipped,
      diagnostics: {
        operatorCount: ops.length,
        unclosedSave: stack.length,
        restoreCount,
        formDepthAtEnd: formDepth,
        pathBoxCount: pathCount,
        // How much evidence the /BBox clip trimmed: every placement the clip
        // removed entirely or shrunk counts once, so a survey can tell a tight
        // border from a lucky one.
        clippedCount
      }
    };
  }
  function isUsableRect(rect) {
    const r = normalizeRect(rect);
    return r.every(Number.isFinite) && r[2] - r[0] > 0 && r[3] - r[1] > 0;
  }
  function clipRect(rect, clip) {
    return clip ? intersectRects(rect, clip) : rect;
  }
  function sameRect(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  }
  function toBounds(value) {
    if (!value) return null;
    const raw = Array.isArray(value) || ArrayBuffer.isView(value) ? value : null;
    if (!raw || raw.length !== 4) return null;
    const out = [
      Number(raw[0]),
      Number(raw[1]),
      Number(raw[2]),
      Number(raw[3])
    ];
    return out.every(Number.isFinite) ? out : null;
  }

  // src/core/pdf-source.js
  var MEASURED_OP_CODES = Object.freeze({
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
    closeEOFillStroke: 27
  });
  function resolveRuntimeOPS(sources) {
    for (const source of sources ?? []) {
      if (source && typeof source.paintFormXObjectBegin === "number") return source;
    }
    return null;
  }
  async function collectPageEvidence({
    pdfPage,
    OPS = null,
    includeMarkedContent = false
  }) {
    if (!pdfPage || typeof pdfPage.getOperatorList !== "function") {
      throw new TypeError("collectPageEvidence: a PDFPageProxy is required");
    }
    const codes = codesFor(OPS);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const pageRect = Array.isArray(pdfPage.view) ? [...pdfPage.view] : [0, 0, viewport.width, viewport.height];
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
        usedMeasuredCodes: !resolveRuntimeOPS([OPS])
      }
    };
  }
  function codesFor(OPS) {
    const resolved = resolveRuntimeOPS([OPS]);
    if (resolved) return resolveOperatorCodes(resolved);
    if (!validateCodes(MEASURED_OP_CODES)) {
      return { save: [-1], restore: [-2], transform: [-3] };
    }
    return resolveOperatorCodes(MEASURED_OP_CODES);
  }
  function validateCodes(codes) {
    const values = Object.values(codes ?? {});
    if (!values.length) return false;
    if (new Set(values).size !== values.length) return false;
    return values.every((value) => Number.isInteger(value) && value >= 0);
  }

  // src/core/viewport.js
  function toViewportRect(rect, viewport) {
    if (!viewport) throw new TypeError("toViewportRect: viewport is required");
    const corners = [
      [rect[0], rect[1]],
      [rect[2], rect[3]]
    ];
    let points;
    if (typeof viewport.convertToViewportPoint === "function") {
      points = corners.map(([x, y]) => viewport.convertToViewportPoint(x, y));
    } else if (Array.isArray(viewport.transform)) {
      const m = viewport.transform;
      points = corners.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    } else {
      throw new TypeError("toViewportRect: unsupported viewport");
    }
    const rect2 = normalizeRect([
      points[0][0],
      points[0][1],
      points[1][0],
      points[1][1]
    ]);
    return rect2;
  }
  function overlayGeometry({ region, viewport, padViewport = 0, deviceScale = 1, rotation = 0 }) {
    const vp = toViewportRect(region, viewport);
    let left = vp[0] - padViewport;
    let top = vp[1] - padViewport;
    let right = vp[2] + padViewport;
    let bottom = vp[3] + padViewport;
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(viewport.width, right);
    bottom = Math.min(viewport.height, bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const canvasWidth = Math.max(1, Math.ceil(width * deviceScale));
    const canvasHeight = Math.max(1, Math.ceil(height * deviceScale));
    return {
      left,
      top,
      width,
      height,
      canvasWidth,
      canvasHeight,
      // Build the render viewport with `viewport.scale * deviceScale`; the
      // translation below is expressed in that (higher resolution) space.
      renderScale: viewport.scale * deviceScale,
      renderTransform: [1, 0, 0, 1, -left * deviceScale, -top * deviceScale]
    };
  }

  // src/core/render.js
  function paramsSink(paramsObj) {
    try {
      const inner = paramsObj?.wrappedJSObject;
      if (inner) return inner;
    } catch (err) {
    }
    return paramsObj;
  }
  async function renderRegion(input) {
    const {
      pdfPage,
      canvas,
      region,
      viewport,
      deviceScale = 1,
      padViewport = 0,
      rotation = 0,
      background = "#ffffff",
      renderOptions = {},
      paramsFactory = null,
      onTask
    } = input;
    const newParams = paramsFactory ?? (() => ({}));
    if (!pdfPage) throw new TypeError("renderRegion: pdfPage is required");
    if (!Array.isArray(region)) throw new TypeError("renderRegion: region is required");
    const geometry = overlayGeometry({ region, viewport, padViewport, deviceScale, rotation });
    const viewportOptions = newParams();
    viewportOptions.scale = geometry.renderScale;
    viewportOptions.rotation = viewport.rotation ?? rotation;
    const renderViewport = pdfPage.getViewport(viewportOptions);
    let target = canvas;
    if (!target) {
      throw new TypeError("renderRegion: canvas is required");
    }
    if (target.width !== geometry.canvasWidth) target.width = geometry.canvasWidth;
    if (target.height !== geometry.canvasHeight) target.height = geometry.canvasHeight;
    const ctx = target.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, target.width, target.height);
    }
    const params = newParams();
    const sink = paramsSink(params);
    sink.canvasContext = ctx;
    sink.viewport = renderViewport;
    sink.transform = geometry.renderTransform;
    for (const [key, value] of Object.entries(renderOptions)) sink[key] = value;
    const task = pdfPage.render(params);
    onTask?.(task);
    await task.promise;
    return { geometry, viewport: renderViewport, task, context: ctx };
  }

  // src/core/cache.js
  var RegionCache = class _RegionCache {
    /** @param {{maxEntries?: number}} [options] */
    constructor(options = {}) {
      this.maxEntries = options.maxEntries ?? 256;
      this.entries = /* @__PURE__ */ new Map();
      this.epoch = /* @__PURE__ */ new Map();
      this.keysByDocument = /* @__PURE__ */ new Map();
    }
    static key(documentId, pageIndex) {
      return `${documentId}::${pageIndex}`;
    }
    get(documentId, pageIndex) {
      const key = _RegionCache.key(documentId, pageIndex);
      const entry = this.entries.get(key);
      if (!entry) return null;
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry.value;
    }
    set(documentId, pageIndex, value) {
      const key = _RegionCache.key(documentId, pageIndex);
      const generation = this.entries.get(key)?.generation ?? 0;
      this.entries.set(key, { value, generation });
      this.indexKey(documentId, key);
      while (this.entries.size > this.maxEntries) {
        const evicted = this.entries.keys().next().value;
        this.entries.delete(evicted);
        this.unindexKey(evicted);
      }
      return value;
    }
    /**
     * Records that an entry key belongs to a document key, so invalidation can
     * delete exactly that document's pages.
     *
     * @param {string|number|null} documentId
     * @param {string} entryKey
     */
    indexKey(documentId, entryKey) {
      const docKey = String(documentId);
      let keys = this.keysByDocument.get(docKey);
      if (!keys) {
        keys = /* @__PURE__ */ new Set();
        this.keysByDocument.set(docKey, keys);
      }
      keys.add(entryKey);
    }
    /**
     * Drops an evicted entry key from the document index.
     *
     * @param {string} entryKey
     */
    unindexKey(entryKey) {
      for (const [docKey, keys] of this.keysByDocument) {
        keys.delete(entryKey);
        if (keys.size === 0) this.keysByDocument.delete(docKey);
      }
    }
    /**
     * Marks the start of a detection task. Store the returned token and ask
     * `isCurrent(token)` before applying results.
     */
    begin(documentId, pageIndex) {
      const key = _RegionCache.key(documentId, pageIndex);
      const previous = this.entries.get(key);
      const generation = (previous?.generation ?? 0) + 1;
      this.entries.set(key, { value: previous?.value ?? null, generation });
      this.indexKey(documentId, key);
      return {
        documentId,
        pageIndex,
        key,
        generation,
        epoch: this.epoch.get(documentId) ?? 0
      };
    }
    isCurrent(token) {
      if (!token) return false;
      const entry = this.entries.get(token.key);
      if (!entry || entry.generation !== token.generation) return false;
      return (this.epoch.get(token.documentId) ?? 0) === token.epoch;
    }
    /**
     * Drops every entry for one document, then blocks results still in flight by
     * bumping the document epoch. The index deletes exactly this document's
     * pages; the prefix pass stays as the fallback for entries whose document key
     * predates the index. A document that carries another document's scoped key
     * therefore no longer loses pages it does not own.
     *
     * @param {string|number|null} documentId
     */
    invalidateDocument(documentId) {
      const docKey = String(documentId);
      for (const key of this.keysByDocument.get(docKey) ?? []) this.entries.delete(key);
      this.keysByDocument.delete(docKey);
      for (const key of [...this.entries.keys()]) {
        if (key.startsWith(`${docKey}::`)) this.entries.delete(key);
      }
      this.epoch.set(documentId, (this.epoch.get(documentId) ?? 0) + 1);
    }
    /**
     * Read-only question: does this document key still hold any cached page? Used
     * by diagnostics to prove a released key really is empty, so it must not touch
     * the recency order the way `get()` does.
     *
     * @param {string|number|null} documentId
     * @returns {boolean}
     */
    hasDocument(documentId) {
      const docKey = String(documentId);
      const indexed = this.keysByDocument.get(docKey);
      if (indexed?.size) return true;
      for (const key of this.entries.keys()) {
        if (key.startsWith(`${docKey}::`)) return true;
      }
      return false;
    }
    clear() {
      this.entries.clear();
      this.epoch.clear();
      this.keysByDocument.clear();
    }
    get size() {
      return this.entries.size;
    }
  };
  function scopedDocumentId(scope, documentId) {
    const raw = String(documentId ?? "");
    const prefix = scope === null || scope === void 0 || scope === "" ? "" : `${String(scope)}|`;
    return `${prefix}${raw}`;
  }

  // src/core/index.js
  async function detectPageRegions({ pdfPage, OPS, structRegions, options }) {
    const evidence = await collectPageEvidence({ pdfPage, OPS });
    const detection = detectFigureRegions({
      placements: evidence.placements,
      captions: evidence.captions,
      structRegions,
      textItems: evidence.textItems,
      pageRect: evidence.pageRect,
      options
    });
    return {
      ...detection,
      pageRect: evidence.pageRect,
      viewport: evidence.viewport,
      captions: evidence.captions,
      skippedPlacements: evidence.skipped
    };
  }
  var CORE_VERSION = "0.1.0";

  // src/zotero/realm-render.js
  var RENDER_HELPER_NAME = "__fcpRenderRegion";
  var RENDER_HELPER_SRC = "window.__fcpRenderRegion = function (pdfPage, canvas, bufWidth, bufHeight, renderScale, rotation, tx, ty, background) {if (!pdfPage || !canvas) return null;var viewport = pdfPage.getViewport({ scale: renderScale, rotation: rotation });if (!viewport) return null;canvas.width = bufWidth;canvas.height = bufHeight;var ctx = canvas.getContext('2d');if (!ctx) return null;ctx.setTransform(1, 0, 0, 1, 0, 0);ctx.clearRect(0, 0, bufWidth, bufHeight);if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, bufWidth, bufHeight); }var transform = [1, 0, 0, 1, tx, ty];var params = { canvasContext: ctx, viewport: viewport, transform: transform };ctx.skipBlender = true;var task = pdfPage.render(params);if (!task) return null;return { task: task, done: task.finished ?? task.promise };};";
  var HELPER_CHANNELS = [
    ["direct", (win) => win[RENDER_HELPER_NAME]],
    ["wrapped", (win) => win.wrappedJSObject?.[RENDER_HELPER_NAME]]
  ];
  var helperCache = /* @__PURE__ */ new WeakMap();
  function readHelperChannel(innerWin, channel, tag) {
    const entry = HELPER_CHANNELS.find(([name]) => name === channel);
    if (!entry) return null;
    try {
      const fn = entry[1](innerWin);
      return typeof fn === "function" ? { fn, channel } : null;
    } catch (err) {
      warnOnce(`render-helper-read:${channel}`, err, tag || void 0);
      return null;
    }
  }
  function injectRenderHelper(innerWin, tag) {
    try {
      if (typeof innerWin.eval !== "function") {
        warnOnce("render-helper-no-eval", new Error("The viewer realm exposes no eval"), tag || void 0);
        return null;
      }
    } catch (err) {
      warnOnce("render-helper-no-eval", err, tag || void 0);
      return null;
    }
    try {
      innerWin.eval(RENDER_HELPER_SRC);
    } catch (err) {
      warnOnce("render-helper-eval", err, tag || void 0);
      return null;
    }
    let present = null;
    try {
      present = innerWin.eval(`typeof window.${RENDER_HELPER_NAME}`);
    } catch (err) {
      warnOnce("render-helper-check", err, tag || void 0);
      return null;
    }
    if (present !== "function") {
      warnOnce(
        "render-helper-missing",
        new Error(`eval ran but ${RENDER_HELPER_NAME} is "${present}" in the viewer realm`),
        tag || void 0
      );
      return null;
    }
    const direct = readHelperChannel(innerWin, "direct", tag) ?? readHelperChannel(innerWin, "wrapped", tag);
    if (!direct) {
      warnOnce("render-helper-unreachable", new Error(`eval installed ${RENDER_HELPER_NAME}, no read channel reaches it`), tag || void 0);
    }
    return direct;
  }
  function ensureRenderHelper(innerWin, tag = "") {
    if (!innerWin || typeof innerWin !== "object") return null;
    let cached;
    try {
      cached = helperCache.get(innerWin);
    } catch (ignored) {
      cached = void 0;
    }
    if (cached !== void 0) return cached ? cached.fn : null;
    const resolved = injectRenderHelper(innerWin, tag);
    try {
      helperCache.set(innerWin, resolved);
    } catch (ignored) {
    }
    return resolved ? resolved.fn : null;
  }
  async function renderRegionViaHelper(helper, input) {
    const { pdfPage, canvas, geometry, rotation = 0, background = "#ffffff", onTask } = input ?? {};
    if (typeof helper !== "function") throw new TypeError("renderRegionViaHelper: helper is required");
    if (!pdfPage) throw new TypeError("renderRegionViaHelper: pdfPage is required");
    if (!canvas) throw new TypeError("renderRegionViaHelper: canvas is required");
    const transform = Array.isArray(geometry?.renderTransform) ? geometry.renderTransform : null;
    if (!transform || transform.length < 6) throw new TypeError("renderRegionViaHelper: geometry is required");
    const result = helper(
      pdfPage,
      canvas,
      Number(geometry.canvasWidth) || 1,
      Number(geometry.canvasHeight) || 1,
      Number(geometry.renderScale) || 1,
      Number(rotation) || 0,
      Number(transform[4]) || 0,
      Number(transform[5]) || 0,
      background ?? null
    );
    const done = result?.done ?? null;
    if (!done) throw new Error("renderRegionViaHelper: the realm returned no render promise");
    const task = result?.task ?? null;
    if (task && onTask) onTask(task);
    const settled = await done;
    if (settled && typeof settled === "object" && settled.success === false) {
      throw settled.exception ?? new Error("renderRegionViaHelper: pdf.js rejected the render");
    }
    return result;
  }

  // src/zotero/xray.js
  function cloneIntoFn() {
    try {
      const clone = globalThis.Components?.utils?.cloneInto;
      return typeof clone === "function" ? clone : null;
    } catch (err) {
      warnOnce("xray-clone-into", err);
      return null;
    }
  }
  function isArrayLike(value) {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return true;
    try {
      if (typeof value.length === "number") return true;
      return typeof value[Symbol.iterator] === "function";
    } catch (err) {
      warnOnce("xray-array-like", err);
      return false;
    }
  }
  function indexLoop(value) {
    const length = Number(value.length) || 0;
    const out = [];
    for (let i = 0; i < length; i += 1) out.push(value[i]);
    return out;
  }
  function copyArrayLike(value, preferClone = true) {
    if (!isArrayLike(value)) return null;
    const cloneInto = cloneIntoFn();
    const clone = cloneInto ? () => cloneInto(value, {}) : null;
    const strategies = [];
    if (clone && preferClone) strategies.push(clone);
    strategies.push(() => Array.from(value));
    strategies.push(() => indexLoop(value));
    if (clone && !preferClone) strategies.push(clone);
    let lastError = null;
    for (const strategy of strategies) {
      try {
        const copy = strategy();
        if (Array.isArray(copy)) return copy;
        lastError = new TypeError("copyArrayLike: no Array produced");
      } catch (err) {
        lastError = err;
      }
    }
    warnOnce("xray-copy", lastError);
    return null;
  }
  function localNumbers(value) {
    const list = copyArrayLike(value, true);
    if (!list) return null;
    return list.map((entry) => Number(entry));
  }
  function scalar(value) {
    try {
      const num2 = Number(value);
      return Number.isFinite(num2) ? num2 : void 0;
    } catch (err) {
      warnOnce("xray-scalar", err);
      return void 0;
    }
  }
  function asString(value) {
    try {
      return typeof value === "string" ? value : void 0;
    } catch (err) {
      warnOnce("xray-string", err);
      return void 0;
    }
  }
  function localViewport(viewport) {
    if (!viewport) return null;
    const raw = viewport;
    const local = {
      scale: scalar(raw.scale),
      width: scalar(raw.width),
      height: scalar(raw.height),
      rotation: scalar(raw.rotation),
      offsetX: scalar(raw.offsetX),
      offsetY: scalar(raw.offsetY),
      transform: localNumbers(raw.transform)
    };
    Object.defineProperty(local, "convertToViewportPoint", {
      enumerable: false,
      writable: false,
      value: (x, y) => {
        try {
          return localNumbers(raw.convertToViewportPoint(x, y)) ?? [Number.NaN, Number.NaN];
        } catch (err) {
          warnOnce("xray-viewport-point", err);
          return [Number.NaN, Number.NaN];
        }
      }
    });
    return local;
  }
  function isNumericList(list) {
    for (const entry of list) {
      const type = typeof entry;
      if (entry === null || entry === void 0) continue;
      if (type === "number" || type === "bigint") continue;
      return false;
    }
    return true;
  }
  function localArgValue(value, depth) {
    if (!value || typeof value !== "object") return value;
    const list = copyArrayLike(value, depth === 0);
    if (!list) return value;
    if (list.length === 0 || isNumericList(list)) return list.map((entry) => Number(entry));
    if (depth === 0) return list.map((entry) => localArgValue(entry, depth + 1));
    return list;
  }
  function localOperatorList(operatorList) {
    let source;
    try {
      source = operatorListArrays(operatorList);
    } catch (err) {
      warnOnce("xray-operator-list", err);
      return { ops: [], args: [] };
    }
    const ops = localNumbers(source.ops) ?? [];
    const args = copyArrayLike(source.args, false) ?? [];
    for (let i = 0; i < args.length; i += 1) args[i] = localArgValue(args[i], 0);
    return { ops, args };
  }
  function localTextContent(textContent) {
    let items = [];
    try {
      items = copyArrayLike(textContent?.items, false) ?? [];
    } catch (err) {
      warnOnce("xray-text-items", err);
    }
    const out = [];
    for (const rawItem of items) {
      let item;
      try {
        item = {
          str: asString(rawItem?.str),
          width: scalar(rawItem?.width),
          height: scalar(rawItem?.height),
          fontName: asString(rawItem?.fontName),
          type: asString(rawItem?.type),
          transform: localNumbers(rawItem?.transform)
        };
      } catch (err) {
        warnOnce("xray-text-item", err);
        item = { str: void 0, width: void 0, height: void 0, fontName: void 0, type: void 0, transform: null };
      }
      out.push(item);
    }
    return { items: out, styles: {} };
  }
  function localPDFPage(pdfPage) {
    if (!pdfPage) return null;
    const raw = pdfPage;
    let view = null;
    try {
      view = localNumbers(raw.view);
    } catch (err) {
      warnOnce("xray-page-view", err);
    }
    return {
      view,
      getViewport(options) {
        try {
          return localViewport(raw.getViewport(options));
        } catch (err) {
          warnOnce("xray-page-getViewport", err);
          return null;
        }
      },
      async getOperatorList(...args) {
        try {
          return localOperatorList(await raw.getOperatorList(...args));
        } catch (err) {
          warnOnce("xray-page-getOperatorList", err);
          return { ops: [], args: [] };
        }
      },
      async getTextContent(...args) {
        try {
          return localTextContent(await raw.getTextContent(...args));
        } catch (err) {
          warnOnce("xray-page-getTextContent", err);
          return { items: [], styles: {} };
        }
      },
      render(options) {
        return raw.render(options);
      }
    };
  }

  // src/zotero/overlay.js
  var PAD_VIEWPORT = 1.6;
  var OVERLAY_Z_INDEX = 3;
  var OVERLAY_CLASS = "fcp-overlay";
  var ERROR_CLASS = "fcp-error";
  var warnedSites = /* @__PURE__ */ new Set();
  var warnLog = [];
  function getWarnLog() {
    return warnLog.slice();
  }
  function firstStackFrame(err) {
    try {
      const stack = typeof err?.stack === "string" ? err.stack : "";
      if (!stack) return "";
      const lines = stack.split("\n");
      for (const line of lines) {
        const frame = line.trim();
        if (!frame) continue;
        const looksLikeFrame = frame.includes("@") || frame.startsWith("at ");
        if (!looksLikeFrame) continue;
        return ` @ ${frame.replace(/^at\s+/, "")}`;
      }
      return "";
    } catch (ignored) {
      return "";
    }
  }
  function warnOnce(site, err, detail) {
    const key = typeof detail === "string" ? `${site}:${detail}` : site;
    if (warnedSites.has(key)) return false;
    warnedSites.add(key);
    warnLog.push(`${key}: ${err?.message ?? err}${firstStackFrame(err)}`);
    if (warnLog.length > 30) warnLog.shift();
    try {
      console.warn("[figure-color]", err);
    } catch (ignored) {
    }
    try {
      if (typeof Zotero !== "undefined" && Zotero?.debug) {
        Zotero.debug("[figure-color] " + key + ": " + (err?.message ?? err));
      }
    } catch (ignored) {
    }
    return true;
  }
  function resetWarnOnce() {
    warnedSites.clear();
    warnLog.length = 0;
  }
  var documentIds = /* @__PURE__ */ new WeakMap();
  var documentIdCounter = 0;
  function resolveDocumentId(pdfDocument) {
    if (!pdfDocument) return null;
    try {
      const printed = pdfDocument.fingerprints?.[0] ?? pdfDocument.loadingTask?.docId ?? pdfDocument._pdfDocument?.docId;
      if (typeof printed === "string" && printed) return `fcp:${printed}`;
    } catch (err) {
      warnOnce("document-id", err);
    }
    let id = documentIds.get(pdfDocument);
    if (!id) {
      documentIdCounter += 1;
      id = `fcp:doc-${documentIdCounter}`;
      try {
        documentIds.set(pdfDocument, id);
      } catch (err) {
        warnOnce("document-id-weakmap", err);
      }
    }
    return id;
  }
  var PROVISIONAL_DOCUMENT_ID = /^fcp:doc-\d+$/;
  function isProvisionalDocumentId(documentId) {
    return typeof documentId === "string" && PROVISIONAL_DOCUMENT_ID.test(documentId);
  }
  function canvasConnected(canvas, host) {
    if (typeof canvas?.isConnected === "boolean") return canvas.isConnected;
    if (typeof host?.isConnected === "boolean") return host.isConnected;
    return true;
  }
  var realmCounter = 0;
  function realmStamp(win) {
    if (!win || typeof win !== "object" && typeof win !== "function") return null;
    try {
      const existing = win.__fcpRealm;
      if (typeof existing === "string" && existing) return existing;
      realmCounter += 1;
      const stamp = `r${realmCounter}`;
      win.__fcpRealm = stamp;
      return stamp;
    } catch (err) {
      warnOnce("realm-stamp", err);
      return null;
    }
  }
  function canvasRealmWin(pageView, fallback) {
    try {
      const view = pageView?.div?.ownerDocument?.defaultView ?? null;
      if (view) return view;
    } catch (ignored) {
    }
    return fallback ?? null;
  }
  function stampCanvas(canvas, realmId, docId) {
    try {
      const dataset = canvas?.dataset;
      if (!dataset) return;
      if (realmId && dataset.fcpRealm !== realmId) dataset.fcpRealm = realmId;
      if (docId && !dataset.fcpDoc) dataset.fcpDoc = String(docId);
    } catch (ignored) {
    }
  }
  function finiteOrNull(value) {
    try {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (ignored) {
      return null;
    }
  }
  var GEOMETRY_TOLERANCE = 0.01;
  function viewportFieldMoved(painted, current) {
    if (painted === null && current === null) return false;
    if (painted === null || current === null) return true;
    return Math.abs(painted - current) > GEOMETRY_TOLERANCE;
  }
  function deviceScaleOf(innerWin) {
    try {
      const scale = innerWin?.devicePixelRatio;
      return Number.isFinite(scale) && scale > 0 ? scale : 1;
    } catch (err) {
      warnOnce("device-pixel-ratio", err);
      return 1;
    }
  }
  function realmParamsFactory(innerWin) {
    try {
      if (typeof innerWin?.Object === "function") return () => new innerWin.Object();
    } catch (err) {
      warnOnce("realm-object", err);
    }
    return () => ({});
  }
  function syncCanvases(canvases, count, innerDoc, provenance = null) {
    while (canvases.length > count) {
      const canvas = canvases.pop();
      try {
        canvas.parentNode?.removeChild(canvas);
      } catch (err) {
        warnOnce("remove-canvas", err);
      }
    }
    while (canvases.length < count) {
      const canvas = innerDoc.createElement("canvas");
      canvas.className = OVERLAY_CLASS;
      canvas.style.position = "absolute";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = String(OVERLAY_Z_INDEX);
      if (provenance) stampCanvas(canvas, provenance.realmId, provenance.docId);
      canvases.push(canvas);
    }
    return canvases;
  }
  function regionKindLabel(sourceKinds) {
    const kinds = Array.isArray(sourceKinds) ? sourceKinds : sourceKinds ? [sourceKinds] : [];
    if (!kinds.length) return null;
    const parts = [];
    if (kinds.includes("path")) parts.push("path");
    if (kinds.some((kind) => kind === "image" || kind === "form" || kind === "multi")) {
      parts.push("xobject");
    }
    if (kinds.includes("struct")) parts.push("struct");
    return parts.length ? parts.join("+") : "unknown";
  }
  var PageOverlay = class {
    /**
     * @param {object} input
     * @param {object} input.pageView A pdf.js page view with `.div` and `.viewport`.
     * @param {object} input.innerWin The pdf.js viewer realm (for createElement).
     * @param {string} input.documentId RegionCache document key.
     * @param {object} input.regionCache Shared `RegionCache` from core/cache.js.
     * @param {() => object|undefined} [input.resolveOPS] Returns the realm's `OPS`
     *   table, or undefined so the core falls back to MEASURED_OP_CODES.
     * @param {string} [input.tag] Reader label used for the one-time warnings.
     * @param {string|null} [input.docId] The session's raw document key, stamped onto
     *   every canvas this overlay creates. `documentId` above is the scoped cache key
     *   (`item:N|fcp:...`), which says nothing about the printed document identity a
     *   probe has to compare against the live document.
     * @param {number} [input.padViewport]
     */
    constructor({ pageView, innerWin, documentId, regionCache: regionCache2, resolveOPS: resolveOPS2, tag = "", padViewport = PAD_VIEWPORT, docId = null }) {
      this.pageView = pageView;
      this.innerWin = innerWin;
      this.documentId = documentId;
      this.docId = docId ?? null;
      this.regionCache = regionCache2;
      this.resolveOPS = typeof resolveOPS2 === "function" ? resolveOPS2 : () => void 0;
      this.tag = tag;
      this.padViewport = padViewport;
      this.paramsFactory = realmParamsFactory(innerWin);
      this.pageNumber = Number(pageView?.id) || 0;
      this.canvases = [];
      this.regionBoxes = [];
      this.regionKinds = [];
      this.tasks = [];
      this.diagnostics = null;
      this.lastPaintError = null;
      this.mountDetached = false;
      this.paintPath = null;
      this.lastPaintGeometry = null;
      this.painted = false;
      this.generation = 0;
      this.destroyed = false;
    }
    /** @returns {number} How many overlay canvases are mounted. */
    get canvasCount() {
      return this.canvases.length;
    }
    /**
     * How many mounted canvases are still in the live document tree. The session
     * counts these, because a canvas the viewer threw out with an old `pageView.div`
     * is painted but invisible.
     *
     * @returns {number}
     */
    get connectedCount() {
      let count = 0;
      for (const canvas of this.canvases) {
        if (canvasConnected(canvas, this.pageView?.div)) count += 1;
      }
      return count;
    }
    /**
     * Whether this overlay's canvases are still mounted in the live DOM, so a paint
     * into them would actually be visible.
     *
     * @returns {boolean}
     */
    isMounted() {
      if (this.canvases.length === 0) return true;
      return this.connectedCount === this.canvases.length;
    }
    /**
     * Detects (once per document and page) then paints every accepted region.
     *
     * @returns {Promise<{regions: Array<object>, diagnostics: object|null}|null>}
     *   Null when the page cannot be painted yet.
     */
    async paint() {
      const detected = await this.detect();
      if (!detected || this.destroyed) return null;
      await this.paintRegions(detected.regions);
      return detected;
    }
    /**
     * Runs detection, reusing the shared per-page cache result.
     *
     * @returns {Promise<{regions: Array<object>, diagnostics: object|null}|null>}
     */
    async detect() {
      const pdfPage = this.pageView?.pdfPage;
      if (!pdfPage) return null;
      if (!this.painted) {
        const cached = this.regionCache.get(this.documentId, this.pageNumber);
        if (cached) {
          this.regionBoxes = cached.regions.map((region) => region.rect);
          this.regionKinds = cached.regions.map((region) => regionKindLabel(region.sourceKinds));
          this.diagnostics = cached.diagnostics ?? null;
          this.painted = true;
        } else {
          const token = this.regionCache.begin(this.documentId, this.pageNumber);
          const result = await detectPageRegions({
            // Detection reads the page data out of the reader realm, so it gets a
            // local copy: TypedArray element access through an Xray wrapper throws.
            pdfPage: localPDFPage(pdfPage),
            // undefined keeps the core on its validated MEASURED_OP_CODES table.
            OPS: this.resolveOPS() ?? void 0
          });
          if (this.destroyed || !this.regionCache.isCurrent(token)) return null;
          const regions = result?.regions ?? [];
          this.regionCache.set(this.documentId, this.pageNumber, {
            regions,
            diagnostics: result?.diagnostics ?? null
          });
          this.regionBoxes = regions.map((region) => region.rect);
          this.regionKinds = regions.map((region) => regionKindLabel(region.sourceKinds));
          this.diagnostics = result?.diagnostics ?? null;
          this.painted = true;
        }
      }
      return { regions: this.regionBoxes, regionKinds: this.regionKinds, diagnostics: this.diagnostics };
    }
    /**
     * Positions and re-renders the canvases for the given user-space regions,
     * using the page view's current viewport. Safe to call again after a zoom or
     * rotation change.
     *
     * @param {Array<number[]|{rect: number[]}>} regions
     * @returns {Promise<void>}
     */
    async paintRegions(regions) {
      if (this.destroyed) return;
      const pageView = this.pageView;
      const pdfPage = pageView?.pdfPage;
      const viewport = localViewport(pageView?.viewport);
      const innerDoc = this.innerWin?.document;
      if (!pdfPage || !viewport || !innerDoc) return;
      const list = Array.isArray(regions) ? regions : [];
      const deviceScale = deviceScaleOf(this.innerWin);
      this.lastPaintGeometry = {
        viewportWidth: finiteOrNull(viewport.width),
        viewportHeight: finiteOrNull(viewport.height),
        viewportScale: finiteOrNull(viewport.scale),
        viewportRotation: finiteOrNull(viewport.rotation),
        deviceScale,
        at: Date.now()
      };
      this.lastPaintError = null;
      this.cancel();
      const generation = this.generation;
      const provenance = { realmId: realmStamp(canvasRealmWin(pageView, this.innerWin)), docId: this.docId };
      syncCanvases(this.canvases, list.length, innerDoc, provenance);
      const hostPositioned = this.ensureHostPositioning();
      this.mountDetached = false;
      this.regionBoxes = list.map((region) => (Array.isArray(region) ? region : region?.rect) ?? null);
      const freshKinds = list.map((region) => regionKindLabel(region?.sourceKinds));
      this.regionKinds = freshKinds.some((kind) => kind !== null) ? freshKinds : Array.from({ length: list.length }, (_, index) => this.regionKinds[index] ?? null);
      const helper = ensureRenderHelper(this.innerWin, this.tag);
      const rotation = viewport.rotation ?? 0;
      let mountDetached = false;
      const pushTask = (task) => this.tasks.push({ task, cancel: () => this.cancelTask(task) });
      for (let index = 0; index < list.length; index += 1) {
        const canvas = this.canvases[index];
        const region = this.regionBoxes[index];
        if (!canvas || !region) continue;
        stampCanvas(canvas, provenance.realmId, provenance.docId);
        if (!canvasConnected(canvas, pageView.div)) {
          try {
            pageView.div?.appendChild(canvas);
          } catch (err) {
            warnOnce("mount-canvas", err);
            continue;
          }
          if (!canvasConnected(canvas, pageView.div)) mountDetached = true;
        }
        let geometry;
        try {
          geometry = overlayGeometry({ region, viewport, padViewport: this.padViewport, deviceScale });
        } catch (err) {
          warnOnce("overlay-geometry", err);
          this.lastPaintError = `geometry: ${err?.message ?? String(err)}`;
          canvas.classList.add(ERROR_CLASS);
          continue;
        }
        canvas.style.left = `${geometry.left}px`;
        canvas.style.top = `${geometry.top}px`;
        canvas.style.width = `${geometry.width}px`;
        canvas.style.height = `${geometry.height}px`;
        canvas.classList.remove(ERROR_CLASS);
        try {
          canvas.style.visibility = "visible";
        } catch (ignored) {
        }
        try {
          if (helper) {
            this.paintPath = "helper";
            await renderRegionViaHelper(helper, {
              pdfPage,
              canvas,
              geometry,
              rotation,
              background: "#ffffff",
              onTask: pushTask
            });
          } else {
            const context = canvas.getContext("2d");
            if (!context) continue;
            try {
              context.skipBlender = true;
            } catch (ignored) {
            }
            this.paintPath = "legacy";
            await renderRegion({
              pdfPage,
              canvas,
              region,
              viewport,
              deviceScale,
              padViewport: this.padViewport,
              background: "#ffffff",
              paramsFactory: this.paramsFactory,
              onTask: pushTask
            });
          }
        } catch (err) {
          warnOnce("render-region", err);
          if (this.destroyed || generation !== this.generation) break;
          this.lastPaintError = `render: ${err?.message ?? String(err)}`;
          if (!this.canvases.includes(canvas)) continue;
          canvas.classList.add(ERROR_CLASS);
          try {
            canvas.style.visibility = "hidden";
          } catch (ignored) {
          }
        }
        if (this.generation !== generation) break;
      }
      this.mountDetached = mountDetached || !hostPositioned;
      if (this.mountDetached && !this.lastPaintError) {
        this.lastPaintError = "mount: host detached";
      }
    }
    /**
     * True when the page view's viewport differs from the one the last paint
     * pass used, i.e. the page geometry moved underneath the mounted canvases.
     *
     * Why this exists: on the real machine the overlays align on first open but
     * sit displaced after the toolbar toggle goes off then on, with identical
     * cached regions. A paint that ran against a viewport the page no longer has
     * leaves every canvas of the page displaced by the same proportion, and
     * nothing else re-paints until the next zoom. This lets the session spot that
     * state once the viewer has settled.
     *
     * Every read crosses the reader realm, so a throw answers false: a probe
     * that cannot read must not trigger a repaint.
     *
     * @returns {boolean}
     */
    geometryStale() {
      if (this.destroyed) return false;
      const painted = this.lastPaintGeometry;
      if (!painted) return false;
      try {
        const raw = this.pageView?.viewport;
        if (!raw) return false;
        const viewport = localViewport(raw);
        if (!viewport) return false;
        if (viewportFieldMoved(painted.viewportWidth, finiteOrNull(viewport.width))) return true;
        if (viewportFieldMoved(painted.viewportHeight, finiteOrNull(viewport.height))) return true;
        if (viewportFieldMoved(painted.viewportScale, finiteOrNull(viewport.scale))) return true;
        if (viewportFieldMoved(painted.viewportRotation, finiteOrNull(viewport.rotation))) return true;
        return false;
      } catch (err) {
        warnOnce("geometry-stale", err, this.tag || void 0);
        return false;
      }
    }
    /**
     * Makes the host element a positioning context, because the overlay canvases
     * are absolutely positioned inside `pageView.div`. Reports whether that host is
     * still in the live document: a detached div accepts writes without showing them,
     * and `offsetParent` stays null — the shape the real machine shows for the
     * document whose tab is in the background.
     *
     * @returns {boolean} False when the host is out of the DOM or refused the write.
     */
    ensureHostPositioning() {
      const div = this.pageView?.div;
      if (!div?.style) return false;
      try {
        if (!div.style.position) div.style.position = "relative";
      } catch (err) {
        warnOnce("host-positioning", err);
        return false;
      }
      return div.isConnected !== false;
    }
    cancelTask(task) {
      try {
        task?.cancel?.();
      } catch (ignored) {
      }
    }
    /** Cancels in-flight pdf.js render tasks. */
    cancel() {
      this.generation += 1;
      const tasks = this.tasks;
      this.tasks = [];
      for (const entry of tasks) {
        try {
          entry.cancel?.();
        } catch (ignored) {
        }
      }
    }
    /** Removes every canvas of this page. Detection results stay cached. */
    clear() {
      this.cancel();
      while (this.canvases.length) {
        const canvas = this.canvases.pop();
        try {
          canvas.parentNode?.removeChild(canvas);
        } catch (err) {
          warnOnce("clear-canvas", err);
        }
      }
      this.regionBoxes = [];
      this.regionKinds = [];
      this.painted = false;
    }
    /** Drops all references so the page view can be released. */
    destroy() {
      this.clear();
      this.painted = false;
      this.destroyed = true;
      this.pageView = null;
      this.innerWin = null;
      this.regionCache = null;
    }
  };

  // src/zotero/paint-probe.js
  var MAX_SAMPLED_PIXELS = 1e6;
  var MAX_SAMPLE_SIDE = 2e3;
  var MAX_REGION_ENTRIES = 8;
  var MAX_SCAN_PIXELS = 25e4;
  var GRID_SIDE = 5;
  function num(value) {
    try {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (err) {
      warnOnce("probe-scalar", err);
      return null;
    }
  }
  function round4(value) {
    return Math.round(value * 1e4) / 1e4;
  }
  function cssText(value) {
    try {
      return value === void 0 || value === null ? null : String(value);
    } catch (err) {
      warnOnce("probe-style", err);
      return null;
    }
  }
  function cssVarNumber(style, name) {
    try {
      const raw = style?.getPropertyValue?.(name);
      if (raw === void 0 || raw === null) return null;
      const trimmed = String(raw).trim();
      return trimmed === "" ? null : num(trimmed);
    } catch (err) {
      warnOnce("probe-css-var", err);
      return null;
    }
  }
  function offsetParentLabel(value) {
    try {
      if (!value) return null;
      const tag = String(value.tagName ?? "").toLowerCase();
      if (!tag) return null;
      const classes = typeof value.className === "string" ? value.className.trim().split(/\s+/).filter(Boolean) : [];
      return classes.length ? `${tag}.${classes[0]}` : tag;
    } catch (err) {
      warnOnce("probe-offset-parent", err);
      return null;
    }
  }
  function datasetText(canvas, field) {
    try {
      const value = canvas?.dataset?.[field];
      return typeof value === "string" && value ? value : null;
    } catch (err) {
      warnOnce(`probe-dataset-${field}`, err);
      return null;
    }
  }
  function averageTriple(sumR, sumG, sumB, count) {
    return [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)];
  }
  function samplePixels(canvas, options = {}) {
    const maxPixels = num(options.maxSampledPixels) ?? num(options.maxPaintReadbackPixels) ?? MAX_SAMPLED_PIXELS;
    const maxSide = num(options.maxSampleSide) ?? MAX_SAMPLE_SIDE;
    const maxScan = Math.max(1, num(options.maxScanPixels) ?? MAX_SCAN_PIXELS);
    let w0 = num(canvas?.width) ?? 0;
    let h0 = num(canvas?.height) ?? 0;
    if (w0 < 0) w0 = 0;
    if (h0 < 0) h0 = 0;
    let x = 0;
    let y = 0;
    let w = w0;
    let h = h0;
    let sampledBox = null;
    if (w * h > maxPixels) {
      w = Math.min(maxSide, w);
      h = Math.min(maxSide, h);
      if (w * h > maxPixels) {
        const factor = Math.sqrt(maxPixels / (w * h));
        w = Math.max(1, Math.floor(w * factor));
        h = Math.max(1, Math.floor(h * factor));
      }
      x = Math.floor((w0 - w) / 2);
      y = Math.floor((h0 - h) / 2);
      sampledBox = [x, y, w, h];
    }
    let data = null;
    try {
      const ctx = canvas?.getContext?.("2d");
      if (!ctx) return { error: "no 2d context" };
      data = localNumbers(ctx.getImageData(x, y, w, h)?.data);
    } catch (err) {
      warnOnce("probe-pixels", err);
      return { error: err?.message ?? String(err) };
    }
    if (!Array.isArray(data)) return { error: "pixel copy failed" };
    let stride = 1;
    while (Math.ceil(w / stride) * Math.ceil(h / stride) > maxScan && stride < Math.max(w, h)) {
      stride += 1;
    }
    const gridCounts = new Array(GRID_SIDE * GRID_SIDE).fill(0);
    const gridR = new Array(GRID_SIDE * GRID_SIDE).fill(0);
    const gridG = new Array(GRID_SIDE * GRID_SIDE).fill(0);
    const gridB = new Array(GRID_SIDE * GRID_SIDE).fill(0);
    let scanned = 0;
    let inkCount = 0;
    let inkR = 0;
    let inkG = 0;
    let inkB = 0;
    for (let py = 0; py < h; py += stride) {
      const row = py * w;
      const cellY = Math.min(GRID_SIDE - 1, Math.floor(py * GRID_SIDE / h));
      for (let px = 0; px < w; px += stride) {
        const p = (row + px) * 4;
        const r = data[p] === void 0 ? 255 : data[p];
        const g = data[p + 1] === void 0 ? 255 : data[p + 1];
        const b = data[p + 2] === void 0 ? 255 : data[p + 2];
        const a = data[p + 3] === void 0 ? 255 : data[p + 3];
        const cell = cellY * GRID_SIDE + Math.min(GRID_SIDE - 1, Math.floor(px * GRID_SIDE / w));
        gridCounts[cell] += 1;
        gridR[cell] += r;
        gridG[cell] += g;
        gridB[cell] += b;
        if (r < 250 || g < 250 || b < 250 || a < 250) {
          inkCount += 1;
          inkR += r;
          inkG += g;
          inkB += b;
        }
        scanned += 1;
      }
    }
    const grid = [];
    for (let cell = 0; cell < gridCounts.length; cell += 1) {
      grid.push(gridCounts[cell] > 0 ? averageTriple(gridR[cell], gridG[cell], gridB[cell], gridCounts[cell]) : [0, 0, 0]);
    }
    const result = {
      nonWhite: scanned > 0 ? round4(inkCount / scanned) : 0,
      mean: inkCount > 0 ? averageTriple(inkR, inkG, inkB, inkCount) : null,
      grid,
      stride,
      scannedPixels: scanned,
      readbackPixels: w * h
    };
    if (sampledBox) result.sampledBox = sampledBox;
    return result;
  }
  function probeOverlay(overlay, options = {}) {
    const canvases = Array.isArray(overlay?.canvases) ? overlay.canvases : [];
    const maxRegions = num(options.maxRegions) ?? MAX_REGION_ENTRIES;
    const sampledCanvases = 1 + Math.min(maxRegions, canvases.length);
    const scanBudget = Math.max(
      1,
      Math.floor((num(options.maxScanPixels) ?? MAX_SCAN_PIXELS) / sampledCanvases)
    );
    const sampleOptions = { ...options, maxScanPixels: scanBudget };
    const result = {
      pageNumber: num(overlay?.pageNumber),
      painted: Boolean(overlay?.painted),
      // Last failed geometry/render step for this page, e.g.
      // "render: Cannot use the same canvas during multiple render() operations".
      paintError: typeof overlay?.lastPaintError === "string" ? overlay.lastPaintError : null,
      // "helper" (realm-render.js ran inside the viewer realm), "legacy"
      // (core/render.js) or null before the first paint.
      paintPath: overlay?.paintPath === "helper" || overlay?.paintPath === "legacy" ? overlay.paintPath : null,
      canvasCount: 0,
      // True when the last paint wrote into canvases that are not in the live DOM:
      // the mount records are alive, the page the user sees has no overlay.
      mountDetached: false,
      deviceScale: { devicePixelRatio: null, visualScale: null },
      page: {
        cssWidth: null,
        cssHeight: null,
        canvasWidth: null,
        canvasHeight: null,
        nonWhite: null,
        stride: null,
        scannedPixels: null,
        readbackPixels: null
      },
      regions: [],
      // Paint-time viewport of this overlay (`PageOverlay.lastPaintGeometry`),
      // null before the first paint.
      lastPaintGeometry: null,
      liveViewport: { width: null, height: null, scale: null, rotation: null },
      hostBox: { clientWidth: null, clientHeight: null, rectWidth: null, rectHeight: null },
      cssVars: { scaleFactor: null, userUnit: null, totalScaleFactor: null }
    };
    try {
      const innerWin = overlay?.innerWin ?? null;
      result.deviceScale.devicePixelRatio = num(innerWin?.devicePixelRatio);
      try {
        result.deviceScale.visualScale = num(innerWin?.visualViewport?.scale) ?? null;
      } catch (err) {
        warnOnce("probe-visual-scale", err);
      }
      const pageView = overlay?.pageView ?? null;
      try {
        const div = pageView?.div ?? null;
        result.page.cssWidth = num(div?.clientWidth);
        result.page.cssHeight = num(div?.clientHeight);
      } catch (err) {
        warnOnce("probe-page-css", err);
      }
      try {
        const pageCanvas = pageView?.canvas ?? null;
        result.page.canvasWidth = num(pageCanvas?.width);
        result.page.canvasHeight = num(pageCanvas?.height);
        if (pageCanvas) {
          const sample = samplePixels(pageCanvas, sampleOptions);
          if (typeof sample.error === "string") result.page.error = sample.error;
          else {
            result.page.nonWhite = sample.nonWhite;
            result.page.stride = sample.stride;
            result.page.scannedPixels = sample.scannedPixels;
            result.page.readbackPixels = sample.readbackPixels;
            if (sample.sampledBox) result.page.sampledBox = sample.sampledBox;
          }
        }
      } catch (err) {
        warnOnce("probe-page-canvas", err);
      }
      try {
        result.lastPaintGeometry = overlay?.lastPaintGeometry ?? null;
      } catch (err) {
        warnOnce("probe-paint-geometry", err);
      }
      try {
        const viewport = localViewport(pageView?.viewport);
        result.liveViewport.width = num(viewport?.width);
        result.liveViewport.height = num(viewport?.height);
        result.liveViewport.scale = num(viewport?.scale);
        result.liveViewport.rotation = num(viewport?.rotation);
      } catch (err) {
        warnOnce("probe-live-viewport", err);
      }
      let hostDiv = null;
      try {
        hostDiv = pageView?.div ?? null;
        result.hostBox.clientWidth = num(hostDiv?.clientWidth);
        result.hostBox.clientHeight = num(hostDiv?.clientHeight);
        const hostRect = hostDiv?.getBoundingClientRect?.();
        result.hostBox.rectWidth = num(hostRect?.width);
        result.hostBox.rectHeight = num(hostRect?.height);
      } catch (err) {
        warnOnce("probe-host-box", err);
      }
      try {
        const hostStyle = hostDiv && typeof innerWin?.getComputedStyle === "function" ? innerWin.getComputedStyle(hostDiv) : null;
        result.cssVars.scaleFactor = cssVarNumber(hostStyle, "--scale-factor");
        result.cssVars.userUnit = cssVarNumber(hostStyle, "--user-unit");
        result.cssVars.totalScaleFactor = cssVarNumber(hostStyle, "--total-scale-factor");
      } catch (err) {
        warnOnce("probe-css-vars", err);
      }
      result.canvasCount = canvases.length;
      result.mountDetached = Boolean(overlay?.mountDetached);
      if (canvases.length > maxRegions) result.truncated = true;
      for (let index = 0; index < Math.min(maxRegions, canvases.length); index += 1) {
        const entry = {
          index,
          // Which evidence produced this region: "path" (vector art), "xobject"
          // (image/form), "struct" (tagged) or a combination. Null for regions that
          // were painted from bare rectangles.
          kind: overlay?.regionKinds?.[index] ?? null,
          // Provenance stamped by the paint pass: which realm handed this canvas out
          // and which document's regions it shows. `fcpRealm` differing from the
          // session's `realmId`, or `fcpDoc` differing from its `docId`, means the
          // canvas outlived the identity it was painted for. Null when the canvas
          // carries no dataset (a harness stand-in).
          fcpRealm: null,
          fcpDoc: null,
          cssLeft: null,
          cssTop: null,
          cssWidth: null,
          cssHeight: null,
          bufWidth: null,
          bufHeight: null,
          // The canvas' own on-screen box and positioning host, compared with
          // `hostBox` above: a box that disagrees with the paint-time geometry
          // while the host is the page div means stale numbers; a different host
          // means a mis-mounted canvas.
          rectLeft: null,
          rectTop: null,
          rectWidth: null,
          rectHeight: null,
          offsetParent: null,
          errClass: null,
          nonWhite: null,
          mean: null,
          grid: null,
          stride: null,
          scannedPixels: null,
          // Pixels the single `getImageData` call copied for this canvas, so a
          // clipped sample can be told apart from a genuinely blank raster.
          readbackPixels: null
        };
        result.regions.push(entry);
        try {
          const canvas = canvases[index];
          const style = canvas?.style ?? null;
          entry.cssLeft = cssText(style?.left);
          entry.cssTop = cssText(style?.top);
          entry.cssWidth = cssText(style?.width);
          entry.cssHeight = cssText(style?.height);
          entry.bufWidth = num(canvas?.width);
          entry.bufHeight = num(canvas?.height);
          entry.fcpRealm = datasetText(canvas, "fcpRealm");
          entry.fcpDoc = datasetText(canvas, "fcpDoc");
          try {
            entry.errClass = Boolean(canvas?.classList?.contains?.(ERROR_CLASS));
          } catch (err) {
            warnOnce("probe-err-class", err);
          }
          try {
            const rect = canvas?.getBoundingClientRect?.();
            entry.rectLeft = num(rect?.left);
            entry.rectTop = num(rect?.top);
            entry.rectWidth = num(rect?.width);
            entry.rectHeight = num(rect?.height);
          } catch (err) {
            warnOnce("probe-canvas-rect", err);
          }
          entry.offsetParent = offsetParentLabel(canvas?.offsetParent);
          if (!canvas) {
            entry.error = "no canvas";
            continue;
          }
          const sample = samplePixels(canvas, sampleOptions);
          if (typeof sample.error === "string") {
            entry.error = sample.error;
            continue;
          }
          entry.nonWhite = sample.nonWhite;
          entry.mean = sample.mean;
          entry.grid = sample.grid;
          entry.stride = sample.stride;
          entry.scannedPixels = sample.scannedPixels;
          entry.readbackPixels = sample.readbackPixels;
          if (sample.sampledBox) entry.sampledBox = sample.sampledBox;
        } catch (err) {
          warnOnce("probe-region", err);
          entry.error = err?.message ?? String(err);
        }
      }
    } catch (err) {
      warnOnce("probe-overlay", err);
      result.error = err?.message ?? String(err);
    }
    return result;
  }

  // src/zotero/zoom.js
  var DEBOUNCE_MS = 150;
  var SCALE_EVENTS = ["scalechanging", "scalechange"];
  var ROTATION_EVENTS = ["rotationchanging", "rotation"];
  function createZoomWatcher({ eventBus, onChange, delay = DEBOUNCE_MS, timers }) {
    const owned = timers instanceof Set ? timers : /* @__PURE__ */ new Set();
    const subscriptions = [];
    let timer = null;
    const schedule = (event, name) => {
      if (timer !== null) {
        clearTimeout(timer);
        owned.delete(timer);
      }
      timer = setTimeout(() => {
        owned.delete(timer);
        timer = null;
        try {
          onChange?.(event, name);
        } catch (err) {
          warnOnce("zoom-callback", err);
        }
      }, delay);
      owned.add(timer);
    };
    const handler = (event) => {
      try {
        schedule(event, event?.type ?? "viewchange");
      } catch (err) {
        warnOnce("zoom-schedule", err);
      }
    };
    for (const name of [...SCALE_EVENTS, ...ROTATION_EVENTS]) {
      try {
        eventBus?.on?.(name, handler);
        subscriptions.push({ name, handler });
      } catch (err) {
        warnOnce(`zoom-subscribe:${name}`, err);
      }
    }
    return {
      destroy() {
        if (timer !== null) {
          clearTimeout(timer);
          owned.delete(timer);
          timer = null;
        }
        for (const { name, handler: fn } of subscriptions) {
          try {
            eventBus?.off?.(name, fn);
          } catch (err) {
            warnOnce(`zoom-unsubscribe:${name}`, err);
          }
        }
        subscriptions.length = 0;
      }
    };
  }

  // src/zotero/reader-session.js
  var READY_POLL_MS = 250;
  var READY_TIMEOUT_MS = 2e4;
  var RECOVERY_INTERVAL_MS = 5e3;
  var RECOVERY_MAX_MS = 18e4;
  var RECOVERY_MAX_PASSES = Math.max(1, Math.ceil(RECOVERY_MAX_MS / RECOVERY_INTERVAL_MS));
  var RECOVERY_SLOW_INTERVAL_MS = 2e4;
  var DOCUMENT_CHECK_MS = 300;
  var SETTLED_REPAINT_MS = 350;
  var DOCUMENT_EVENTS = ["pagesloaded", "documentloaded", "documentinit"];
  var PAGE_RENDERED_EVENT = "pagerendered";
  function subscribe(eventBus, names, handler, site) {
    const bound = [];
    if (!eventBus || typeof eventBus.on !== "function") return bound;
    for (const name of names) {
      try {
        eventBus.on(name, handler);
        bound.push(name);
      } catch (err) {
        warnOnce(`subscribe:${site}:${name}`, err);
      }
    }
    return bound;
  }
  function unsubscribe(eventBus, names, handler, site) {
    if (!eventBus || typeof eventBus.off !== "function") return;
    for (const name of names) {
      try {
        eventBus.off(name, handler);
      } catch (err) {
        warnOnce(`unsubscribe:${site}:${name}`, err);
      }
    }
  }
  var VIEWER_ROUTES = [
    ["direct", (win) => win.PDFViewerApplication],
    ["wrapped", (win) => win.wrappedJSObject?.PDFViewerApplication],
    ["cu-unwrap", (win) => globalThis.Components?.utils?.unwrap?.(win)?.PDFViewerApplication],
    [
      "bridge",
      (win) => {
        const resolver = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser")?.FigureColorResolveViewer;
        return typeof resolver === "function" ? resolver(win, true) : null;
      }
    ]
  ];
  var realmRoutes = /* @__PURE__ */ new WeakMap();
  function isApplication(value) {
    try {
      return Boolean(value) && typeof value === "object";
    } catch (ignored) {
      return false;
    }
  }
  function readViewerRoute(innerWin, route, tag = "") {
    const entry = VIEWER_ROUTES.find(([name]) => name === route);
    if (!entry) return null;
    try {
      const app = entry[1](innerWin);
      return isApplication(app) ? app : null;
    } catch (err) {
      warnOnce(`unwrap-${route}`, err, tag || void 0);
      return null;
    }
  }
  function unwrapViewerApplication(innerWin, tag = "") {
    if (!innerWin || typeof innerWin !== "object") return { app: null, route: null };
    let cached = null;
    try {
      cached = realmRoutes.get(innerWin) ?? null;
    } catch (ignored) {
      cached = null;
    }
    if (cached) {
      const app = readViewerRoute(innerWin, cached, tag);
      if (app) return { app, route: cached };
    }
    for (const [route] of VIEWER_ROUTES) {
      const app = readViewerRoute(innerWin, route, tag);
      if (!app) continue;
      try {
        realmRoutes.set(innerWin, route);
      } catch (ignored) {
      }
      return { app, route };
    }
    return { app: null, route: null };
  }
  function openReaderRecords(readerAPI) {
    try {
      if (typeof readerAPI?.getOpenReaders === "function") return [...readerAPI.getOpenReaders()];
    } catch (err) {
      warnOnce("open-readers", err);
    }
    const records = readerAPI?._readers;
    if (!records) return [];
    try {
      if (Array.isArray(records)) return [...records];
      if (typeof records.values === "function") return [...records.values()];
      return Object.values(records);
    } catch (err) {
      warnOnce("open-readers-field", err);
      return [];
    }
  }
  var OWN_REALM_PROVENANCE = /* @__PURE__ */ new Set(["chain", "src", "scan", "bridge-guessed"]);
  var BRIDGE_GUESS_PASSES = 8;
  function realmBelongsToReader(win, reader) {
    if (!win || !reader) return false;
    try {
      if (reader?._internalReader?._primaryView?._iframeWindow === win) return true;
    } catch {
    }
    try {
      const views = reader?._internalReader?._views;
      if (Array.isArray(views)) {
        for (const view of views) {
          try {
            if (view?._iframeWindow === win) return true;
          } catch {
          }
        }
      }
    } catch {
    }
    try {
      const host = reader?._iframeWindow ?? null;
      if (host === win) return true;
      const frames = host?.document?.querySelectorAll?.("iframe") ?? [];
      for (const frame of frames) {
        try {
          if (frame?.contentWindow === win) return true;
        } catch {
        }
      }
    } catch {
    }
    return false;
  }
  function resolveInnerRealm(reader, tag = "") {
    let tried = false;
    try {
      const viewWindow = reader?._internalReader?._primaryView?._iframeWindow;
      if (viewWindow) return { win: viewWindow, provenance: "chain" };
      tried = true;
    } catch (err) {
      warnOnce("inner-window-chain", err);
    }
    try {
      const win = reader?._iframeWindow ?? null;
      const frames = win?.document?.querySelectorAll?.("iframe") ?? [];
      let exact = null;
      let viewer = null;
      let html = null;
      let viaBridge = null;
      for (const frame of frames) {
        const content = frame?.contentWindow ?? null;
        if (!content) continue;
        const src = String(frame.getAttribute?.("src") ?? "");
        if (!exact && (src === "pdf/web/viewer.html" || src.endsWith("/viewer.html"))) exact = content;
        if (!html && /(?:reader|viewer)\.html/.test(src)) html = content;
        if (!viewer) {
          const { app, route } = unwrapViewerApplication(content, tag);
          if (!app) continue;
          if (route === "bridge") viaBridge = viaBridge ?? content;
          else viewer = content;
        }
      }
      if (viewer) return { win: viewer, provenance: "scan" };
      if (exact) return { win: exact, provenance: "src" };
      if (html) return { win: html, provenance: "src" };
      if (viaBridge) return { win: viaBridge, provenance: "bridge" };
      tried = Boolean(win);
    } catch (err) {
      warnOnce("inner-window-scan", err);
    }
    if (tried) warnOnce("inner-window-missing", new Error("No pdf.js viewer window: reader left untouched"), tag);
    try {
      const bridge = typeof globalThis.Services?.wm?.getMostRecentWindow === "function" ? globalThis.Services.wm.getMostRecentWindow("navigator:browser")?.FigureColorResolveViewer : null;
      if (typeof bridge === "function") {
        const viaBridge = bridge(reader);
        if (viaBridge) return { win: viaBridge, provenance: "bridge" };
      }
    } catch (err) {
      warnOnce("inner-window-bridge", err);
    }
    return { win: null, provenance: "none" };
  }
  function chainProbe(reader) {
    const out = {
      at: Date.now(),
      k1: null,
      k2: null,
      k3: null,
      frames: null,
      readersSrc: null,
      readers: null,
      bridgeType: null,
      bridgeWin: null,
      bridgeRoute: null
    };
    try {
      out.k1 = typeof reader?._internalReader;
    } catch (err) {
      out.k1 = "throw:" + (err?.message ?? err);
    }
    try {
      out.k2 = typeof reader?._internalReader?._primaryView;
    } catch (err) {
      out.k2 = "throw:" + (err?.message ?? err);
    }
    try {
      out.k3 = typeof reader?._internalReader?._primaryView?._iframeWindow;
    } catch (err) {
      out.k3 = "throw:" + (err?.message ?? err);
    }
    try {
      out.frames = reader?._iframeWindow?.document?.querySelectorAll?.("iframe")?.length ?? null;
    } catch (err) {
      out.frames = "throw:" + (err?.message ?? err);
    }
    try {
      const readerAPI = globalThis.Zotero?.Reader ?? null;
      out.readersSrc = typeof readerAPI?.getOpenReaders === "function" ? "getOpenReaders" : readerAPI ? "_readers" : "none";
      out.readers = openReaderRecords(readerAPI).length;
    } catch (err) {
      out.readersSrc = "throw:" + (err?.message ?? err);
    }
    try {
      const bridge = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser")?.FigureColorResolveViewer;
      out.bridgeType = typeof bridge;
      if (typeof bridge === "function") {
        const w = bridge(reader);
        out.bridgeWin = w ? typeof w.PDFViewerApplication : "null";
        out.bridgeRoute = w ? unwrapViewerApplication(w).route : null;
      }
    } catch (err) {
      out.bridgeType = "throw:" + (err?.message ?? err);
    }
    return out;
  }
  function resolvePDFViewer(innerWin, tag = "") {
    try {
      return unwrapViewerApplication(innerWin, tag).app?.pdfViewer ?? null;
    } catch (err) {
      warnOnce("pdf-viewer", err, tag || void 0);
      return null;
    }
  }
  function resolveEventBus(innerWin, tag = "") {
    try {
      return unwrapViewerApplication(innerWin, tag).app?.eventBus ?? null;
    } catch (err) {
      warnOnce("event-bus", err, tag || void 0);
      return null;
    }
  }
  function resolveOPS(innerWin, tag = "") {
    try {
      return innerWin?.OPS ?? innerWin?.pdfjsLib?.OPS ?? unwrapViewerApplication(innerWin, tag).app?.pdfjsLib?.OPS ?? null;
    } catch (err) {
      warnOnce("ops-table", err, tag || void 0);
      return null;
    }
  }
  function listPageViews(pdfViewer) {
    if (!pdfViewer) return [];
    try {
      const pagesView = pdfViewer._pagesView ?? pdfViewer._pages;
      if (Array.isArray(pagesView)) return pagesView.filter((view) => Boolean(view));
    } catch (err) {
      warnOnce("pages-view", err);
    }
    try {
      if (typeof pdfViewer.getPages === "function") {
        const pages = pdfViewer.getPages();
        const list = Array.isArray(pages) ? [...pages] : Array.from(pages ?? []);
        if (list.length) return list.filter((view) => Boolean(view));
      }
    } catch (err) {
      warnOnce("get-pages", err);
    }
    const views = [];
    try {
      const count = Number(pdfViewer._pagesCount ?? pdfViewer.pagesCount ?? pdfViewer?.pdfDocument?.numPages ?? 0);
      for (let index = 0; index < count; index += 1) {
        const view = pdfViewer.getPageView?.(index);
        if (view) views.push(view);
      }
    } catch (err) {
      warnOnce("page-view-loop", err);
    }
    return views;
  }
  var ReaderSession = class {
    /**
     * @param {object} input
     * @param {object} input.reader A Zotero reader instance.
     * @param {object} input.regionCache The shared `RegionCache`.
     * @param {string} [input.tag] Short reader label used in warnings.
     * @param {boolean} [input.enabled] Auto mode, on by default.
     */
    constructor({ reader, regionCache: regionCache2, tag = "", enabled: enabled2 = true }) {
      this.reader = reader;
      this.regionCache = regionCache2;
      this.tag = tag;
      this.enabled = Boolean(enabled2);
      this.overlays = /* @__PURE__ */ new Map();
      this.pending = /* @__PURE__ */ new Set();
      this.readyWakes = /* @__PURE__ */ new Set();
      this.timers = /* @__PURE__ */ new Set();
      this.listeners = /* @__PURE__ */ new Set();
      this.innerWin = null;
      this.eventBus = null;
      this.documentId = null;
      this.cacheScope = reader?.itemID === void 0 || reader?.itemID === null ? "" : `item:${String(reader.itemID)}`;
      this.realmSwitches = 0;
      this.realmProvenance = "none";
      this.bridgeGuessPasses = 0;
      this.ready = false;
      this.attempts = 0;
      this.destroyed = false;
      this.zoom = null;
      this.documentCheckTimer = null;
      this.settledCheckTimer = null;
      this.settledRepaints = 0;
      this.recoveryRunning = false;
      this.recoveryPromise = null;
      this.loadEventNames = [];
      this.renderEventNames = [];
      this.catchUpDone = /* @__PURE__ */ new Set();
      this.documentIdAdopted = false;
      this.noBusWarned = false;
      this.lastValidation = null;
      this.lastStaleKey = null;
      this.onDocumentEvent = () => this.queueDocumentCheck();
      this.onPageRenderedEvent = (event) => {
        try {
          const pageNumber = Number(event?.pageNumber ?? event?.pageView?.id ?? 0);
          if (!pageNumber) return;
          const job = this.attachPageNumber(pageNumber);
          if (!job) return;
          this.scheduleSettledCheck();
        } catch (err) {
          warnOnce("pagerendered-handler", err);
        }
      };
    }
    /** Subscribes a state listener, used by the toolbar button. */
    addListener(listener) {
      if (typeof listener === "function") this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    /** Tells every listener the session state changed. */
    notify() {
      for (const listener of [...this.listeners]) {
        try {
          listener(this);
        } catch (err) {
          warnOnce("state-listener", err);
        }
      }
    }
    /**
     * Resolves the inner window, wires the event bus and waits for the document.
     *
     * @returns {Promise<boolean>} False when this reader is left untouched.
     */
    async start() {
      if (this.destroyed) return false;
      const ready = await this.waitUntilReady();
      if (this.destroyed) return false;
      if (!ready) {
        this.startRecovery();
        return false;
      }
      this.ready = true;
      this.syncDocumentId();
      if (!this.eventBus) {
        this.eventBus = resolveEventBus(this.innerWin, this.tag);
        if (this.eventBus) this.bindEvents();
      }
      if (!this.eventBus) this.startRecovery();
      await this.repaintAttached();
      this.catchUpPaint("start");
      this.scheduleSettledCheck();
      return true;
    }
    /**
     * Starts the recovery loop, at most one at a time per session. A session
     * whose document or event bus arrived after `READY_TIMEOUT_MS` is picked up
     * there instead of staying dead until the reader is reopened. The loop ends on
     * the first successful pass or on `destroy()`, never on its own.
     *
     * @returns {Promise<void>|null} The live loop, or null when nothing started.
     */
    startRecovery() {
      if (this.destroyed) return null;
      if (this.recoveryRunning) return this.recoveryPromise;
      this.recoveryRunning = true;
      this.recoveryPromise = this.runRecovery();
      return this.recoveryPromise;
    }
    /**
     * Sleeps `RECOVERY_INTERVAL_MS` between passes for `RECOVERY_MAX_MS`, then
     * keeps going on `RECOVERY_SLOW_INTERVAL_MS` forever. Out of budget the loop
     * slows down instead of stopping: on the real machine the viewer of a restored
     * tab showed up well after the fast window, and a session that gave up stayed
     * dead until the reader was reopened.
     * The sleep is a tracked `sleep()`, so `destroy()` resolves it and the loop
     * stops by itself; the next pass is never scheduled before the previous one
     * finished, so recovery timers cannot stack.
     *
     * @returns {Promise<void>}
     */
    async runRecovery() {
      try {
        for (let pass = 0; ; pass += 1) {
          const slow = pass >= RECOVERY_MAX_PASSES;
          if (pass === RECOVERY_MAX_PASSES) {
            warnOnce(
              "recovery-slow",
              new Error("Fast recovery budget exhausted, continuing on the slow heartbeat"),
              this.tag
            );
          }
          await this.sleep(slow ? RECOVERY_SLOW_INTERVAL_MS : RECOVERY_INTERVAL_MS);
          if (this.destroyed) return;
          if (this.recoveryPass()) return;
        }
      } finally {
        this.recoveryRunning = false;
      }
    }
    /**
     * One recovery pass: re-resolve what was missing during `start()`, and settle
     * the session once a document exists.
     *
     * @returns {boolean} True when recovery is done, so the loop stops.
     */
    recoveryPass() {
      if (this.destroyed) return true;
      try {
        const resolution = resolveInnerRealm(this.reader, this.tag);
        if (resolution.win && resolution.win !== this.innerWin && (!this.innerWin || !this.realmConfirmed())) {
          this.adoptRealm(resolution);
        }
        if (this.innerWin && !this.eventBus) {
          this.eventBus = resolveEventBus(this.innerWin, this.tag);
          if (this.eventBus) this.bindEvents();
        }
        this.ensureCurrentDocument("recovery");
        if (!this.currentPDFDocument()) return false;
        if (!this.eventBus) {
          this.syncDocumentId();
          if (this.overlayCount() === 0) void this.repaintAttached();
          this.notify();
          return false;
        }
        if (!this.realmConfirmed()) {
          this.bridgeGuessPasses += 1;
          if (this.bridgeGuessPasses < BRIDGE_GUESS_PASSES) {
            this.notify();
            return false;
          }
          this.realmProvenance = "bridge-guessed";
        }
        this.ready = true;
        this.syncDocumentId();
        void this.repaintAttached();
        this.notify();
        warnOnce("recovered", new Error("pdf.js became available after the readiness timeout"), this.tag);
        return true;
      } catch (err) {
        warnOnce(`recovery-pass:${this.tag}`, err);
        return false;
      }
    }
    /**
     * Wakes the session after its tab became the visible one.
     *
     * The wake is the moment the newly visible document can be told apart from the
     * one this session latched, so it goes through `ensureCurrentDocument()`: that
     * re-resolves the realm (a session that latched onto the other reader's realm
     * paints the visible page of the hidden document), re-derives the document
     * identity from whatever realm is held afterwards, and releases the cache key and
     * the overlays of the document that is no longer shown. `queueDocumentCheck()`
     * stays behind it: the sweep picks up a document that finishes loading while the
     * tab is in the background, which the validation above cannot see because the
     * document was not there yet.
     */
    onTabActivate() {
      if (this.destroyed) return;
      this.ensureCurrentDocument("tab-activate");
      this.queueDocumentCheck();
    }
    /**
     * The document this reader's live viewer shows, when its printed identity is not
     * the one the session latched.
     *
     * The startup latch bug: the inactive tab's realm is unresolved, the bridge
     * answers with the other reader's `PDFViewerApplication`, and the session stores
     * that document's key. Later `currentPDFDocument()` resolves to this tab's own
     * document, but nothing re-derives the id, so detection, the cache key and every
     * paint keep running under the other document's key. Only a printed key counts:
     * a provisional `fcp:doc-N` is re-minted per read under Xrays, which would turn
     * this check into a churn loop — the rule `applyDocumentId()` already enforces.
     *
     * @returns {string|null} The fresh key, or null when the identity did not drift.
     */
    docIdentityDrift() {
      try {
        if (!this.documentId) return null;
        if (!this.realmConfirmed()) return null;
        if (isProvisionalDocumentId(this.documentId)) return null;
        const fresh = resolveDocumentId(this.currentPDFDocument());
        if (!fresh || isProvisionalDocumentId(fresh)) return null;
        return fresh === this.documentId ? null : fresh;
      } catch (err) {
        warnOnce("doc-drift-read", err, this.tag);
        return null;
      }
    }
    /**
     * Re-keys the session onto a document identity a caller already read: the named
     * manual entry of the repair route, for a Run-Javascript fix or a diagnostic that
     * holds the fresh key and wants the pages and cache released in one call.
     *
     * No wake calls it any more. `ensureCurrentDocument()` owns the decision of when a
     * document changed, and `commitRekey()` is the half that releases the previous
     * document, so keeping a second decision point here would put the identity logic
     * back in two places.
     *
     * @param {string} freshId Printed key of the live document, from `docIdentityDrift()`.
     * @returns {void}
     */
    applyDocDrift(freshId) {
      if (this.destroyed || !freshId) return;
      this.commitRekey(freshId, "drift");
    }
    /**
     * Whether the realm this session paints is proven to be this reader's own.
     *
     * A realm named by the reader's chain, its `src` match or its frame scan is its
     * own; so is a guess whose budget was spent and accepted, and any window the
     * reader's own chain or iframe set still lists. Only the last-resort bridge guess
     * with budget left is still a guess: its document can belong to the other tab's
     * viewer, and comparing that document against this session's key proves nothing.
     *
     * @returns {boolean}
     */
    realmUnproven() {
      if (!this.innerWin) return true;
      if (this.realmConfirmed()) return false;
      return this.realmProvenance === "bridge" && this.bridgeGuessPasses < BRIDGE_GUESS_PASSES;
    }
    /**
     * Decides what a document identity that no longer matches the latched one costs.
     *
     * The single place that compares the latched key against the identity the live
     * document prints. `docIdentityDrift()` is the read: it reports a fresh key only
     * for a realm the session trusts and only printed-against-printed, so a
     * re-minted provisional key cannot turn this into a re-key loop, and the silent
     * provisional-to-printed adoption stays with `applyDocumentId()`.
     *
     * @param {string} trigger Site asking, recorded for diagnostics.
     * @returns {"ok"|"rekeyed"|"wait"} `wait` means the identity is unproven: the
     *   caller must neither paint nor drop anything.
     */
    validateDocumentIdentity(trigger) {
      if (this.destroyed) return "wait";
      if (!this.documentId) return this.recordValidation(trigger, "ok");
      const fresh = this.docIdentityDrift();
      if (!fresh) return this.recordValidation(trigger, "ok");
      if (this.realmUnproven()) {
        return this.recordValidation(trigger, "wait");
      }
      this.commitRekey(fresh, trigger);
      return this.recordValidation(trigger, "rekeyed");
    }
    /**
     * The one entry every wake goes through before it reads the cache, paints or
     * re-keys: make sure the realm is the one this reader shows, then make sure the
     * document identity the session holds is the identity of that realm's document.
     *
     * Order matters, and it is the whole bug. Identity is printed by the document
     * object, the document object is reached through the realm, so a wake that skips
     * the realm step compares the new document against a realm that still answers with
     * the old one — and reads "same document" out of the other tab's viewer.
     *
     * @param {string} [trigger] Name of the wake, recorded for `probeAll()`.
     * @returns {"ok"|"rekeyed"|"wait"} `wait` means the caller must paint nothing.
     */
    ensureCurrentDocument(trigger = "wake") {
      if (this.destroyed) return "wait";
      this.reevaluateRealm();
      return this.validateDocumentIdentity(trigger);
    }
    /**
     * Moves the session onto a new document identity and releases everything that
     * belonged to the previous one: the cached regions of the old key, the overlays
     * that carry the old key's regions, and their paint.
     *
     * The stale entries go out under the *old* key, before the fresh one is installed:
     * after the assignment `cacheKey()` names the new document, and the regions parsed
     * from the wrong one would stay in the shared cache for the whole plugin run.
     *
     * @param {string} freshId Printed key of the document the realm shows now.
     * @param {string} [trigger] Wake that asked, recorded for diagnostics.
     * @returns {void}
     */
    commitRekey(freshId, trigger = "manual") {
      if (this.destroyed || !freshId || freshId === this.documentId) return;
      const staleKey = this.cacheKey();
      this.documentId = freshId;
      this.regionCache.invalidateDocument(staleKey);
      this.lastStaleKey = staleKey;
      this.detachAll();
      void this.repaintAttached();
      this.scheduleSettledCheck();
      warnOnce(
        "doc-drift",
        new Error("the document this reader shows is not the one its session latched"),
        this.tag
      );
      this.notify();
    }
    /**
     * Records what the last identity validation decided, for `probeAll()`.
     *
     * @param {string} trigger Site asking for the validation.
     * @param {"ok"|"rekeyed"|"wait"} decision What the validation concluded.
     * @returns {string} The decision, so callers can return it through one expression.
     */
    recordValidation(trigger, decision) {
      this.lastValidation = {
        trigger: String(trigger ?? "wake"),
        decision,
        // The identity the session holds after the validation, so a report says both
        // what the wake decided and what document it left the reader on. For
        // `rekeyed` this is the fresh key, since `commitRekey()` ran first.
        after: this.documentId ?? null,
        at: (/* @__PURE__ */ new Date()).toISOString()
      };
      return decision;
    }
    /**
     * Re-stamps one overlay with the identity this session holds now.
     *
     * The viewer rebuilds a page view on a zoom, a toolbar toggle and a tab switch,
     * and the session reuses the overlay record for the live view. Without this, the
     * record a page got while document A was loaded keeps reading A's cached regions
     * and keeps its `painted` flag after the window started showing document B, which
     * is how the other document's boxes come back on every repaint.
     *
     * @param {PageOverlay} overlay
     * @returns {void}
     */
    restampOverlay(overlay) {
      if (!overlay) return;
      overlay.docId = this.documentId ?? null;
      const key = this.cacheKey();
      if (overlay.documentId === key) return;
      overlay.documentId = key;
      overlay.painted = false;
      overlay.regionBoxes = [];
    }
    /**
     * Adopts the pdf.js realm this reader points at now, when it is not the one the
     * session holds.
     *
     * @returns {boolean} True when another realm was adopted.
     */
    reevaluateRealm() {
      if (this.destroyed || !this.reader) return false;
      let resolution = null;
      try {
        resolution = resolveInnerRealm(this.reader, this.tag);
      } catch (err) {
        warnOnce("realm-reevaluate", err, this.tag);
        return false;
      }
      if (!resolution.win || resolution.win === this.innerWin) return false;
      const own = OWN_REALM_PROVENANCE.has(resolution.provenance) || realmBelongsToReader(resolution.win, this.reader);
      if (!own && this.innerWin && this.realmConfirmed()) return false;
      const previous = this.innerWin;
      this.adoptRealm(resolution);
      this.realmSwitches += 1;
      if (this.validateDocumentIdentity("realm-adopted") !== "rekeyed") {
        this.detachAll();
        void this.repaintAttached();
        this.notify();
      }
      warnOnce(
        "realm-switched",
        new Error("session moved to another pdf.js realm"),
        `${this.tag} from ${previous ? "realm" : "no realm"}`
      );
      return true;
    }
    /**
     * Whether the latched realm may serve as this session's document source: a
     * trusted resolution route, a guess whose budget was spent and accepted, or
     * a window the reader's own chain or iframe set still lists.
     *
     * @returns {boolean}
     */
    realmConfirmed() {
      if (!this.innerWin) return false;
      if (this.realmProvenance === "bridge-guessed") return true;
      return realmBelongsToReader(this.innerWin, this.reader);
    }
    /**
     * Latches a freshly resolved realm: releases the old window's handlers first,
     * then binds the new one. `releaseRealm()` before the bus is nulled, so the
     * old subscriptions are dropped from the bus they live on.
     *
     * @param {RealmResolution} resolution
     * @param {{ keepGuessPasses?: boolean }} [opts] Keep the guess budget when a
     *   bridge guess is only re-confirmed; a new adoption always resets it.
     * @returns {void}
     */
    adoptRealm(resolution, opts = {}) {
      this.releaseRealm();
      this.innerWin = resolution.win;
      this.realmProvenance = resolution.provenance;
      if (!opts.keepGuessPasses) this.bridgeGuessPasses = 0;
      this.eventBus = resolveEventBus(resolution.win, this.tag);
      this.bindEvents();
    }
    /**
     * Drops the event-bus subscriptions and the zoom watcher of the realm the
     * session holds, so switching realms cannot leave handlers on the old window.
     * The overlays are left alone: they are rebuilt by the repaint that follows a
     * successful pass.
     */
    releaseRealm() {
      if (this.visHandler && this.visChangeTarget) {
        try {
          this.visChangeTarget.removeEventListener?.("visibilitychange", this.visHandler);
        } catch (err) {
          warnOnce("visibility-unbind", err, this.tag);
        }
        this.visChangeTarget = null;
      }
      unsubscribe(this.eventBus, this.loadEventNames, this.onDocumentEvent, this.tag);
      unsubscribe(this.eventBus, this.renderEventNames, this.onPageRenderedEvent, this.tag);
      this.loadEventNames = [];
      this.renderEventNames = [];
      try {
        this.zoom?.destroy();
      } catch (err) {
        warnOnce("zoom-destroy", err);
      }
      this.zoom = null;
      this.eventBus = null;
      this.noBusWarned = false;
    }
    /**
     * Refreshes the RegionCache document key from the loaded document.
     *
     * A printed key never regresses: when the viewer stops reporting the
     * fingerprint or the loading-task doc id — a wrapper that hides the field, a
     * reader that swaps its realm — the fallback key would replace a printed one
     * and strand every detection cached under it, so the printed key is kept.
     *
     * @returns {string|null}
     */
    syncDocumentId() {
      try {
        const documentId = resolveDocumentId(this.currentPDFDocument());
        if (!documentId) return this.documentId;
        if (this.documentId && !isProvisionalDocumentId(this.documentId) && isProvisionalDocumentId(documentId)) {
          return this.documentId;
        }
        this.documentId = documentId;
      } catch (err) {
        warnOnce("sync-document-id", err);
      }
      return this.documentId;
    }
    /**
     * The RegionCache key of this session's document: the document id scoped to this
     * reader, so two readers showing two documents never share cache entries.
     *
     * @returns {string}
     */
    cacheKey() {
      return scopedDocumentId(this.cacheScope, this.documentId ?? "");
    }
    /** Subscribes to the event bus and starts the zoom watcher. */
    bindEvents() {
      const ownWindow = resolveInnerRealm(this.reader).win;
      const realmDocument = ownWindow?.document ?? this.innerWin?.document ?? null;
      if (realmDocument && typeof realmDocument.addEventListener === "function") {
        if (!this.visHandler) {
          this.visHandler = () => {
            if (this.innerWin?.document === realmDocument && realmDocument.visibilityState === "hidden") return;
            this.onTabActivate();
          };
        }
        try {
          realmDocument.addEventListener("visibilitychange", this.visHandler);
          this.visChangeTarget = realmDocument;
        } catch (err) {
          warnOnce("visibility-bind", err, this.tag);
        }
      }
      if (!this.eventBus) {
        if (!this.noBusWarned) {
          this.noBusWarned = true;
          warnOnce("no-event-bus", new Error("pdf.js event bus unavailable"), this.tag);
        }
        return;
      }
      this.loadEventNames = subscribe(this.eventBus, DOCUMENT_EVENTS, this.onDocumentEvent, this.tag);
      this.renderEventNames = subscribe(this.eventBus, [PAGE_RENDERED_EVENT], this.onPageRenderedEvent, this.tag);
      this.zoom = createZoomWatcher({
        eventBus: this.eventBus,
        onChange: () => this.onViewScaleChange(),
        timers: this.timers
      });
    }
    /** @returns {object|null} The pdfDocument currently shown by this reader. */
    currentPDFDocument() {
      try {
        return resolvePDFViewer(this.innerWin, this.tag)?.pdfDocument ?? null;
      } catch (err) {
        warnOnce("current-document", err);
        return null;
      }
    }
    /**
     * Sleeps on a tracked timer, so destroy() can release a caller that is
     * waiting for the document.
     *
     * @param {number} ms
     * @returns {Promise<void>}
     */
    sleep(ms) {
      return new Promise((resolve) => {
        const wake = () => {
          this.timers.delete(timer);
          this.readyWakes.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        this.timers.add(timer);
        this.readyWakes.add(wake);
      });
    }
    /**
     * Polls until the pdf.js document object exists, with a bounded wait. The
     * inner window is re-resolved on every pass because the chain can be missing
     * while the toolbar renders and appear a moment later.
     *
     * @returns {Promise<boolean>}
     */
    async waitUntilReady() {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      for (; ; ) {
        if (this.destroyed) return false;
        this.attempts += 1;
        if (!this.innerWin || !this.realmConfirmed()) {
          const resolution = resolveInnerRealm(this.reader, this.tag);
          if (resolution.win && resolution.win !== this.innerWin) {
            const own = OWN_REALM_PROVENANCE.has(resolution.provenance) || realmBelongsToReader(resolution.win, this.reader);
            if (own || !this.innerWin) this.adoptRealm(resolution);
          }
        }
        if (this.currentPDFDocument()) {
          if (!this.realmConfirmed()) {
            this.bridgeGuessPasses += 1;
            if (this.bridgeGuessPasses >= BRIDGE_GUESS_PASSES) this.realmProvenance = "bridge-guessed";
            else {
              await this.sleep(READY_POLL_MS);
              continue;
            }
          }
          return true;
        }
        if (Date.now() > deadline) {
          warnOnce("ready-timeout", new Error("Timed out waiting for the pdf.js viewer window and document"), this.tag);
          return false;
        }
        await this.sleep(READY_POLL_MS);
      }
    }
    /**
     * Handles a document swap inside the same iframe. Zotero keeps the viewer
     * window alive, so a reload or a "switch to this PDF" has to invalidate the
     * cache and drop the old overlays.
     */
    queueDocumentCheck() {
      if (this.destroyed) return;
      if (this.documentCheckTimer !== null) {
        clearTimeout(this.documentCheckTimer);
        this.timers.delete(this.documentCheckTimer);
      }
      const run = () => {
        this.documentCheckTimer = null;
        this.timers.delete(timer);
        const identity = this.ensureCurrentDocument("document-check");
        if (identity === "wait") {
          this.scheduleSettledCheck();
          return;
        }
        if (identity !== "ok") return;
        const pdfDocument = this.currentPDFDocument();
        const staleKey = this.cacheKey();
        const decision = this.applyDocumentId(resolveDocumentId(pdfDocument));
        if (decision !== "changed") {
          if (!pdfDocument && this.documentId) {
            this.documentId = null;
            this.detachAll();
          }
          this.catchUpPaint("pagesloaded");
          return;
        }
        this.regionCache.invalidateDocument(staleKey);
        this.detachAll();
        void this.repaintAttached();
        this.scheduleSettledCheck();
        this.queueDocumentCheck();
      };
      const timer = setTimeout(run, DOCUMENT_CHECK_MS);
      this.documentCheckTimer = timer;
      this.timers.add(timer);
    }
    /**
     * Re-checks every painted page once the viewer has settled, `SETTLED_REPAINT_MS`
     * after a full-document paint.
     *
     * Armed after every full-document paint: the first open of a document
     * (`start()`), a document swap (`queueDocumentCheck()`) and the toolbar enable
     * (`setEnabled(true)`). The reason all three is the shared RegionCache: it
     * lives for the whole plugin run, so with a warm cache the detection returns in
     * one microtask and the paint lands in the same tick as the viewer's own
     * relayout, while a cold cache parses the page for tens or hundreds of
     * milliseconds and therefore paints after the layout has settled. That is why
     * the same PDF is fine on one open and displaced on another. `scheduleSettledCheck()`
     * replaces a pending timer, so repeat arming cannot stack passes.
     *
     * The real-machine symptom is "correct on first open, displaced after the
     * toolbar toggle goes off then on": the enable paint races the viewer's own
     * relayout (toolbar state change, fit-width re-zoom) and paints against a
     * viewport the page replaces moments later. When the timer fires, each page
     * that still has cached regions and whose `geometryStale()` says the painted
     * viewport moved is re-painted through the proven `paintOverlay` path. A page
     * whose geometry did not move is left alone, so a settled pass is free for
     * every page that aligned correctly. `paintOverlay` reuses the cached regions
     * and reads the page's current viewport inside itself, so a warm RegionCache
     * means no new detection.
     */
    scheduleSettledCheck() {
      if (this.destroyed) return;
      if (this.settledCheckTimer !== null) {
        clearTimeout(this.settledCheckTimer);
        this.timers.delete(this.settledCheckTimer);
      }
      const run = () => {
        this.settledCheckTimer = null;
        this.timers.delete(timer);
        if (this.destroyed) return;
        for (const overlay of [...this.overlays.values()]) {
          try {
            if (!overlay || overlay.destroyed) continue;
            if (!overlay.regionBoxes.length) continue;
            if (overlay.geometryStale() !== true) continue;
            this.track(overlay, this.paintOverlay(overlay));
            this.settledRepaints += 1;
          } catch (err) {
            warnOnce("settled-repaint", err);
          }
        }
      };
      const timer = setTimeout(run, SETTLED_REPAINT_MS);
      this.settledCheckTimer = timer;
      this.timers.add(timer);
    }
    /**
     * One extra paint pass per trigger, for the pages a full-document paint missed.
     *
     * The fresh-open symptom on the real machine is "nothing paints at all": the
     * paint at the end of `start()` runs before pdf.js has built the page views,
     * and the late pages are normally caught by `pagerendered`, which a session
     * without an event bus never gets. A trigger therefore gets one bounded
     * catch-up pass, and only while the session has painted nothing, so a healthy
     * session — overlays already mounted — never pays for it twice.
     *
     * @param {"start"|"pagesloaded"} trigger Site asking for the pass; each one is
     *   honoured at most once per session, so a churning document event cannot turn
     *   the catch-up into a repaint loop.
     * @returns {boolean} True when the extra pass ran.
     */
    catchUpPaint(trigger) {
      if (this.destroyed || !this.enabled || !this.ready) return false;
      if (this.catchUpDone.has(trigger)) return false;
      this.catchUpDone.add(trigger);
      if (this.overlayCount() > 0) return false;
      void this.repaintAttached();
      return true;
    }
    /**
     * Re-keys the session's document id under the provisional-id rules.
     *
     * `resolveDocumentId()` prefers the printed identity (fingerprint, then
     * loading-task doc id) and falls back to a WeakMap key when Zotero's Xrays hide
     * both. That fallback is provisional: a read that hands back a fresh wrapper
     * object mints a new `fcp:doc-N`, and the old code read the new string as a
     * document swap — `invalidateDocument` plus `detachAll` on every document event,
     * wiping the canvases that had just been mounted.
     *
     * Rules: printed to another printed key is the only real swap; a provisional key
     * is replaced by a printed one silently, so the one-time transition keeps the
     * mounted paints; a printed key never regresses to a provisional one, and a
     * re-minted provisional key carries no new identity, so neither re-keys.
     *
     * @param {string|null} candidate Key `resolveDocumentId()` produced for the live document.
     * @returns {"same"|"adopted"|"changed"} `changed` is the only case whose caller
     *   has to invalidate the cache and detach the pages.
     */
    applyDocumentId(candidate) {
      const current = this.documentId;
      if (!candidate) return "same";
      const candidatePrinted = !isProvisionalDocumentId(candidate);
      if (!current) {
        this.documentId = candidate;
        return candidatePrinted ? "changed" : "same";
      }
      if (candidate === current) return "same";
      const currentPrinted = !isProvisionalDocumentId(current);
      if (currentPrinted && candidatePrinted) {
        this.documentId = candidate;
        return "changed";
      }
      if (!currentPrinted && candidatePrinted) {
        this.documentId = candidate;
        this.documentIdAdopted = true;
        return "adopted";
      }
      return "same";
    }
    /**
     * Attaches the overlay of one page, given its 1-based page number.
     *
     * @param {number} pageNumber
     */
    attachPageNumber(pageNumber) {
      for (const view of listPageViews(resolvePDFViewer(this.innerWin, this.tag))) {
        if (Number(view?.id) === Number(pageNumber)) return this.attachPageView(view);
      }
      return null;
    }
    /**
     * Attaches the overlay for one page view. Pages whose `pdfPage` is not there
     * yet are skipped: they report `pagerendered` a moment later.
     *
     * @param {object} pageView
     * @returns {Promise<void>|null}
     */
    attachPageView(pageView) {
      if (!this.enabled || this.destroyed || !this.documentId) return null;
      const pageNumber = Number(pageView?.id) || 0;
      if (!pageNumber) return null;
      if (!pageView?.pdfPage || !pageView?.div || !pageView?.viewport) return null;
      let overlay = this.overlays.get(pageNumber);
      if (!overlay) {
        try {
          overlay = new PageOverlay({
            pageView,
            innerWin: this.innerWin,
            // Scoped to this reader: two readers with the same printed fingerprint
            // must not read each other's cached regions.
            documentId: this.cacheKey(),
            // The raw key, for the canvas provenance stamp: the scoped key above is
            // the cache identity, this one says which document the paint read from.
            docId: this.documentId ?? null,
            regionCache: this.regionCache,
            resolveOPS: () => resolveOPS(this.innerWin, this.tag),
            tag: this.tag
          });
        } catch (err) {
          warnOnce("overlay-ctor", err);
          return null;
        }
        this.overlays.set(pageNumber, overlay);
      } else if (overlay.pageView && overlay.pageView !== pageView) {
        overlay.pageView = pageView;
        overlay.innerWin = this.innerWin;
        this.restampOverlay(overlay);
      } else if (overlay.isMounted && !overlay.isMounted()) {
        overlay.innerWin = this.innerWin;
        this.restampOverlay(overlay);
      }
      return this.track(overlay, this.paintOverlay(overlay));
    }
    /**
     * Detects and paints one overlay, re-checking ownership between the two
     * steps. Detection is async, so the feature may have been switched off, or
     * the page may have been re-attached with a different overlay, while it ran.
     * Painting into a dropped overlay would leave canvases mounted with the
     * feature off, covering regions with nothing in them.
     *
     * @param {PageOverlay} overlay
     * @returns {Promise<void>}
     */
    async paintOverlay(overlay) {
      if (!overlay || this.destroyed || !this.enabled) return;
      const detected = await overlay.detect();
      if (!detected) return;
      if (this.destroyed || !this.enabled || this.overlays.get(overlay.pageNumber) !== overlay) {
        overlay.clear();
        return;
      }
      if (overlay.documentId !== this.cacheKey()) {
        overlay.clear();
        return;
      }
      await overlay.paintRegions(detected.regions);
    }
    /**
     * Paints every page that already has a rendered pdfPage.
     *
     * @returns {Promise<void>}
     */
    async repaintAttached() {
      if (!this.enabled || this.destroyed) return;
      const jobs = [];
      for (const view of listPageViews(resolvePDFViewer(this.innerWin, this.tag))) {
        const job = this.attachPageView(view);
        if (job) jobs.push(job);
      }
      await Promise.all(jobs);
    }
    /**
     * Repositions and re-renders the existing canvases after a zoom or rotation
     * change, using each page view's new viewport. Detection is not repeated.
     */
    onViewScaleChange() {
      if (!this.enabled || this.destroyed) return;
      const identity = this.ensureCurrentDocument("scale-change");
      if (identity === "wait") {
        this.scheduleSettledCheck();
        return;
      }
      if (identity !== "ok") return;
      const key = this.cacheKey();
      const jobs = [];
      for (const overlay of [...this.overlays.values()]) {
        if (!overlay || overlay.destroyed) continue;
        if (overlay.documentId !== key) {
          this.restampOverlay(overlay);
        }
        const boxes = overlay.regionBoxes.length ? overlay.regionBoxes : null;
        const job = boxes ? this.track(overlay, overlay.paintRegions(boxes)) : this.track(overlay, this.paintOverlay(overlay));
        if (job) jobs.push(job);
      }
      void Promise.all(jobs);
    }
    /**
     * Keeps paint jobs reachable so teardown can cancel their render tasks.
     *
     * @param {PageOverlay} overlay
     * @param {Promise<void>|null} promise
     * @returns {Promise<void>|null}
     */
    track(overlay, promise) {
      if (!promise) return null;
      const job = promise.catch((err) => {
        warnOnce("page-paint", err);
        try {
          overlay?.clear?.();
        } catch (ignored) {
        }
      }).finally(() => this.pending.delete(job));
      this.pending.add(job);
      return job;
    }
    /**
     * Turns the overlay on or off for this reader. The shared RegionCache keeps
     * its contents, so switching back is cheap.
     *
     * @param {boolean} next
     * @returns {boolean} The new state.
     */
    setEnabled(next) {
      const value = Boolean(next);
      this.enabled = value;
      if (this.destroyed) return value;
      if (!value) this.detachAll();
      else {
        if (this.ensureCurrentDocument("enable") === "ok") {
          void this.repaintAttached();
          this.scheduleSettledCheck();
        }
      }
      this.notify();
      return value;
    }
    /** @returns {boolean} The new enabled state. */
    toggle() {
      return this.setEnabled(!this.enabled);
    }
    /** Removes every canvas of this reader without clearing the RegionCache. */
    detachAll() {
      for (const overlay of [...this.overlays.values()]) {
        try {
          overlay.clear();
        } catch (err) {
          warnOnce("detach-overlay", err);
        }
      }
      this.overlays.clear();
    }
    /**
     * How many overlay canvases are mounted *in the live DOM*. A canvas the viewer
     * threw out with an old page div is not counted: counting it is what let a hidden
     * document's stale mount mask a missing repaint on the visible one.
     *
     * @returns {number} How many pages currently carry overlay canvases.
     */
    overlayCount() {
      let count = 0;
      for (const overlay of this.overlays.values()) {
        count += overlay.connectedCount ?? overlay.canvasCount;
      }
      return count;
    }
    /** Unsubscribes everything and removes every canvas this session made. */
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      for (const overlay of [...this.overlays.values()]) {
        try {
          overlay.destroy();
        } catch (err) {
          warnOnce("destroy-overlay", err);
        }
      }
      this.overlays.clear();
      try {
        this.zoom?.destroy();
      } catch (err) {
        warnOnce("zoom-destroy", err);
      }
      this.zoom = null;
      if (this.documentCheckTimer !== null) {
        clearTimeout(this.documentCheckTimer);
        this.documentCheckTimer = null;
      }
      if (this.settledCheckTimer !== null) {
        clearTimeout(this.settledCheckTimer);
        this.settledCheckTimer = null;
      }
      for (const timer of this.timers) {
        try {
          clearTimeout(timer);
        } catch (ignored) {
        }
      }
      this.timers.clear();
      for (const wake of [...this.readyWakes]) {
        try {
          wake();
        } catch (ignored) {
        }
      }
      this.readyWakes.clear();
      unsubscribe(this.eventBus, this.loadEventNames, this.onDocumentEvent, this.tag);
      unsubscribe(this.eventBus, this.renderEventNames, this.onPageRenderedEvent, this.tag);
      this.loadEventNames = [];
      this.renderEventNames = [];
      if (this.visHandler && this.visChangeTarget) {
        try {
          this.visChangeTarget.removeEventListener?.("visibilitychange", this.visHandler);
        } catch (ignored) {
        }
        this.visChangeTarget = null;
      }
      this.pending.clear();
      this.listeners.clear();
      this.reader = null;
      this.regionCache = null;
    }
  };

  // src/zotero/main.js
  var PLUGIN_ID = "figure-color-preservation@local";
  var TOOLBAR_EVENT = "renderToolbar";
  var WINDOW_TOPICS = ["domwindowopened", "domwindowclosed"];
  var MAX_PROBE_SESSIONS = 8;
  var REALM_HREF_MAX = 120;
  var BUTTON_LABEL = "\u539F\u8272";
  var BUTTON_TITLE = "\u56FE\u8868\u539F\u8272\u663E\u793A";
  var TOGGLE_CLASS = "fcp-toggle";
  var TOGGLE_STYLE_ID = "fcp-toggle-style";
  var TOGGLE_CSS = `
.${TOGGLE_CLASS} {
  appearance: none;
  -moz-appearance: none;
  display: inline-flex;
  align-items: center;
  margin-inline: 2px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  font: inherit;
  line-height: 1.5;
  cursor: pointer;
  color: rgba(128, 128, 128, 0.85);
  background-color: rgba(128, 128, 128, 0.12);
  transition: background-color 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.${TOGGLE_CLASS}:hover {
  background-color: rgba(128, 128, 128, 0.28);
}
.${TOGGLE_CLASS}:active {
  transform: translateY(1px);
}
.${TOGGLE_CLASS}:focus-visible {
  outline: 2px solid rgba(1, 121, 242, 0.9);
  outline-offset: 1px;
}
.${TOGGLE_CLASS}[aria-pressed="true"] {
  color: #ffffff;
  background-color: #0179f2;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.${TOGGLE_CLASS}[aria-pressed="true"]:hover {
  color: #ffffff;
  background-color: #2b8ef5;
}
.${TOGGLE_CLASS}[aria-pressed="true"]:active {
  background-color: #0166cc;
}
`;
  var regionCache = null;
  var sessions = /* @__PURE__ */ new Map();
  var buttonLinks = /* @__PURE__ */ new Map();
  var observers = [];
  var registeredEventTypes = [];
  var zoteroNotifierId = null;
  var started = false;
  var addonVersion = "";
  function getZotero() {
    try {
      if (globalThis.Zotero) return globalThis.Zotero;
    } catch (err) {
      warnOnce("zotero-global", err);
    }
    try {
      if (typeof Zotero !== "undefined") return Zotero;
    } catch (ignored) {
    }
    return null;
  }
  function observerService() {
    try {
      const services = globalThis.Services;
      if (services?.observers && typeof services.observers.addObserver === "function") {
        return { svc: services.observers, mode: "observers" };
      }
      if (services?.obs && typeof services.obs.addObserver === "function") {
        return { svc: services.obs, mode: "obs" };
      }
    } catch (err) {
      warnOnce("observer-service", err);
    }
    return null;
  }
  function addWindowObserver(topic, handler) {
    const found = observerService();
    if (!found) {
      warnOnce("observer-add", new Error("No observer service for window topics"), topic);
      return null;
    }
    const observer = {
      observe(subject, observedTopic, data) {
        handler(subject, observedTopic ?? topic, data);
      }
    };
    try {
      found.svc.addObserver(observer, topic, null);
      return { svc: found.svc, topic, observer };
    } catch (err) {
      warnOnce("observer-add", err, topic);
      return null;
    }
  }
  function removeWindowObserver(handle) {
    if (!handle?.observer) return;
    try {
      handle.svc.removeObserver(handle.observer, handle.topic, null);
    } catch (err) {
      warnOnce("observer-remove", err, handle.topic);
    }
  }
  function onWindowEvent(subject, topic) {
    try {
      if (topic === "domwindowclosed") pruneSessions();
      else syncOpenReaders();
    } catch (err) {
      warnOnce("window-event", err, String(topic));
    }
  }
  function tagFor(reader) {
    try {
      return `item:${reader?.itemID ?? "?"}`;
    } catch (ignored) {
      return "reader";
    }
  }
  function detachButton(session) {
    const link = buttonLinks.get(session);
    if (!link) return false;
    buttonLinks.delete(session);
    try {
      link.button.removeEventListener("click", link.onClick);
    } catch (ignored) {
    }
    try {
      link.off();
    } catch (ignored) {
    }
    return true;
  }
  function ensureToggleStyles(doc) {
    try {
      if (typeof doc.getElementById === "function" && doc.getElementById(TOGGLE_STYLE_ID)) return;
      const head = doc.head ?? doc.querySelector?.("head") ?? doc.documentElement;
      if (!head) return;
      const style = doc.createElement("style");
      style.id = TOGGLE_STYLE_ID;
      style.textContent = TOGGLE_CSS;
      head.appendChild(style);
    } catch (ignored) {
    }
  }
  function createButton(doc, session) {
    detachButton(session);
    ensureToggleStyles(doc);
    const button = doc.createElement("button");
    button.textContent = BUTTON_LABEL;
    button.title = BUTTON_TITLE;
    button.type = "button";
    button.className = TOGGLE_CLASS;
    button.style.pointerEvents = "auto";
    const applyState = () => {
      try {
        button.setAttribute("aria-pressed", String(Boolean(session.enabled)));
      } catch (ignored) {
      }
    };
    const onClick = (event) => {
      try {
        event?.preventDefault?.();
        session.toggle();
      } catch (err) {
        warnOnce("button-click", err);
      }
    };
    button.addEventListener("click", onClick);
    const off = session.addListener(applyState);
    applyState();
    buttonLinks.set(session, { button, session, onClick, off });
    return button;
  }
  function ensureSession(reader) {
    if (!reader || !regionCache) return null;
    const existing = sessions.get(reader);
    if (existing) return existing.session;
    let session;
    try {
      session = new ReaderSession({ reader, regionCache, tag: tagFor(reader), enabled });
    } catch (err) {
      warnOnce("session-ctor", err);
      return null;
    }
    const entry = { session, startPromise: null, closeWatch: null };
    sessions.set(reader, entry);
    session.addListener(() => {
      lastDiagnostics = collectDiagnostics();
    });
    watchReaderClose(reader, session, entry);
    entry.startPromise = session.start().catch((err) => {
      warnOnce("session-start", err);
    });
    return session;
  }
  function watchReaderClose(reader, session, entry) {
    const win = (() => {
      try {
        return reader?._iframeWindow ?? null;
      } catch (err) {
        warnOnce("reader-window", err);
        return null;
      }
    })();
    if (!win?.addEventListener) return;
    const handler = () => {
      if (readerAlive(reader)) return;
      closeSession(session);
    };
    try {
      win.addEventListener("unload", handler, { once: true });
    } catch (err) {
      warnOnce("watch-unload", err);
    }
    try {
      win.addEventListener("zotero-reader-state", handler);
    } catch (err) {
      warnOnce("watch-reader-state", err);
    }
    entry.closeWatch = { win, handler };
  }
  function readerAlive(reader) {
    try {
      const win = reader?._iframeWindow;
      if (!win) return false;
      const doc = win.document;
      if (!doc) return false;
      return doc.readyState !== "unloaded";
    } catch (err) {
      warnOnce("reader-alive", err);
      return false;
    }
  }
  function closeSession(session) {
    if (session.destroyed) return;
    detachButton(session);
    for (const [reader, entry] of [...sessions]) {
      if (entry.session === session) {
        if (entry.closeWatch) {
          for (const type of ["unload", "zotero-reader-state"]) {
            try {
              entry.closeWatch.win.removeEventListener(type, entry.closeWatch.handler);
            } catch (ignored) {
            }
          }
        }
        sessions.delete(reader);
      }
    }
    try {
      session.destroy();
    } catch (err) {
      warnOnce("session-destroy", err);
    }
    lastDiagnostics = collectDiagnostics();
  }
  function pruneSessions() {
    for (const [reader, entry] of [...sessions]) {
      if (entry.session.destroyed || !readerAlive(reader)) {
        if (!entry.session.destroyed) closeSession(entry.session);
        else sessions.delete(reader);
      }
    }
  }
  function syncOpenReaders() {
    const zotero = getZotero();
    try {
      const windows = typeof zotero?.getMainWindows === "function" ? zotero.getMainWindows() ?? [] : [];
      for (const win of windows) {
        const readerAPI = win?.Zotero?.Reader ?? zotero?.Reader ?? null;
        const records = Array.isArray(readerAPI?._readers) ? readerAPI._readers : [];
        for (const record of records) {
          let reader = null;
          try {
            reader = typeof readerAPI?.getByTabID === "function" ? readerAPI.getByTabID(record?.tabID) ?? record?.reader ?? null : record?.reader ?? null;
          } catch (err) {
            warnOnce("get-by-tab-id", err);
          }
          if (reader) ensureSession(reader);
        }
      }
    } catch (err) {
      warnOnce("sync-open-readers", err);
    }
  }
  function onRenderToolbar(event) {
    try {
      const reader = event?.reader;
      if (!reader) return;
      const session = ensureSession(reader);
      if (!session || typeof event.append !== "function") return;
      if (session.ready && !session.destroyed && !session.pending?.size) {
        try {
          session.ensureCurrentDocument("toolbar-render");
        } catch (err) {
          warnOnce("toolbar-render-wake", err);
        }
      }
      const doc = event?.doc ?? null;
      if (!doc?.createElement) return;
      const button = createButton(doc, session);
      event.append(button);
    } catch (err) {
      warnOnce("render-toolbar", err);
    }
  }
  function collectDiagnostics() {
    if (!sessions.size) return null;
    let pages = 0;
    let canvases = 0;
    let detail = null;
    const documents = /* @__PURE__ */ new Set();
    for (const entry of sessions.values()) {
      const session = entry.session;
      if (session.destroyed) continue;
      if (session.documentId) documents.add(session.documentId);
      for (const overlay of session.overlays.values()) {
        if (!overlay.painted) continue;
        pages += 1;
        canvases += overlay.canvasCount;
        detail = overlay.diagnostics ?? detail;
      }
    }
    return {
      // Same rule as `probeAll()`: the installed add-on version when the bootstrap
      // supplied one, so no probe reports a build number that contradicts another.
      version: addonVersion || CORE_VERSION,
      enabled,
      readers: sessions.size,
      documents: documents.size,
      pages,
      canvases,
      core: detail
    };
  }
  var VIEWER_BRIDGE_SRC = "window.FigureColorResolveViewer = function (r, wantApp) {var appOf = function (w) { if (!w) return null; try { return w.PDFViewerApplication || null; } catch (e) { return null; } };try {var R = window.Zotero && window.Zotero.Reader;if (!R) return null;var L = null;if (typeof R.getOpenReaders === 'function') { try { L = Array.from(R.getOpenReaders()); } catch (e1) { L = null; } }if (!L) { var m = R._readers || {}; L = (typeof m.values === 'function' && m.length === undefined) ? Array.from(m.values()) : Object.values(m); }var rt = null; try { rt = r && r.tabID; } catch (e2) { rt = null; }var tabIdForReader = function (rec, cand) { var V = window.Zotero && window.Zotero.Viewer; var ids = [null, null]; try { if (V && typeof V.getTabID === 'function') { ids[0] = V.getTabID(rec); ids[1] = V.getTabID(cand); } } catch (e3) {} if (!ids[0] && rec && rec.tabID !== undefined) ids[0] = rec.tabID; if (!ids[1] && cand && cand.tabID !== undefined) ids[1] = cand.tabID; return ids;};var only = null; var onlyCount = 0; var tab = null; var tabHit = false;for (var i = 0; i < L.length; i++) {var rec = L[i];var c = (rec && rec.tabID !== undefined && typeof R.getByTabID === 'function') ? (R.getByTabID(rec.tabID) || rec) : rec;var f = c && c._internalReader && c._internalReader._primaryView ? c._internalReader._primaryView._iframeWindow : null;if (c === r || f === r) return wantApp ? appOf(f) : (f || null);var tids = tabIdForReader(rec, c);if (!tabHit && rt !== undefined && rt !== null && (tids[0] === rt || tids[1] === rt)) { tab = f; tabHit = true; }if (f) { only = f; onlyCount++; }}if (tabHit) return wantApp ? appOf(tab) : (tab || null);if (onlyCount !== 1) return null;return wantApp ? appOf(only) : only;} catch (err) { return null; }};";
  function installViewerBridge(win) {
    if (!win || typeof win.eval !== "function") return;
    try {
      win.eval(VIEWER_BRIDGE_SRC);
    } catch (err) {
      warnOnce("bridge-install", err);
    }
  }
  var wakeStats = { count: 0, nullTarget: 0 };
  function wakeTabSessions(event, ids, extra) {
    if (event !== "select" && event !== "load") return;
    const zotero = getZotero();
    const rawIds = Array.isArray(ids) ? ids : ids === void 0 || ids === null ? [] : [ids];
    const tabIds = rawIds.filter((id) => id !== void 0 && id !== null);
    if (!tabIds.length && extra?.id !== void 0 && extra?.id !== null) tabIds.push(extra.id);
    const targets = /* @__PURE__ */ new Set();
    for (const tabId of tabIds) {
      try {
        const target = zotero?.Reader?.getByTabID?.(tabId) ?? null;
        if (target) targets.add(target);
      } catch (ignored) {
      }
    }
    wakeStats.count += 1;
    if (!targets.size) wakeStats.nullTarget += 1;
    for (const [, record] of sessions) {
      const session = record.session;
      if (!session || session.destroyed) continue;
      if (targets.size && !targets.has(record.reader) && !targets.has(session.reader)) continue;
      try {
        session.onTabActivate?.();
      } catch (err) {
        warnOnce("tab-activate", err);
      }
    }
  }
  function addZoteroNotifier(zotero) {
    const api = zotero?.Notifier;
    if (!api || typeof api.registerObserver !== "function" || typeof api.unregisterObserver !== "function") return null;
    try {
      const ref = {
        notify: (event, type, ids, extra) => {
          void type;
          wakeTabSessions(event, ids, extra);
        }
      };
      const id = api.registerObserver(ref, ["tab"], "figure-color");
      return typeof id === "string" || typeof id === "number" ? id : null;
    } catch (err) {
      warnOnce("notifier-register", err);
      return null;
    }
  }
  function removeZoteroNotifier() {
    const api = getZotero()?.Notifier;
    if (zoteroNotifierId == null || !api || typeof api.unregisterObserver !== "function") {
      zoteroNotifierId = null;
      return;
    }
    try {
      api.unregisterObserver(zoteroNotifierId);
    } catch (err) {
      warnOnce("notifier-unregister", err);
    }
    zoteroNotifierId = null;
  }
  function startup(data = {}) {
    try {
      if (started) return;
      started = true;
      addonVersion = String(data?.version ?? "");
      regionCache = new RegionCache({ maxEntries: 256 });
      const zotero = getZotero();
      const readerAPI = zotero?.Reader ?? null;
      if (!readerAPI || typeof readerAPI.registerEventListener !== "function") {
        warnOnce("reader-api", new Error("Zotero.Reader.registerEventListener is unavailable"));
        return;
      }
      try {
        readerAPI.registerEventListener(TOOLBAR_EVENT, onRenderToolbar, data?.id || PLUGIN_ID);
        registeredEventTypes = [TOOLBAR_EVENT];
      } catch (err) {
        warnOnce("register-toolbar-event", err);
        return;
      }
      const win0 = (() => {
        try {
          return (typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null) ?? globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser") ?? null;
        } catch (ignored) {
          return null;
        }
      })();
      installViewerBridge(win0);
      const ready = (() => {
        try {
          return zotero?.initializedPromise ?? zotero?.Startup?.initializedPromise ?? null;
        } catch (ignored) {
          return null;
        }
      })();
      const afterReady = () => {
        if (!started) return;
        try {
          const wm = globalThis.Services?.wm;
          const win = (typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null) ?? wm?.getMostRecentWindow?.("navigator:browser") ?? null;
          if (win) win.FigureColorPlugin = globalThis.FigureColorPlugin ?? null;
          installViewerBridge(win);
        } catch (err) {
          warnOnce("publish-window", err);
        }
        for (const topic of WINDOW_TOPICS) observers.push(addWindowObserver(topic, onWindowEvent));
        zoteroNotifierId = addZoteroNotifier(zotero);
        syncOpenReaders();
        lastDiagnostics = collectDiagnostics();
      };
      if (ready && typeof ready.then === "function") ready.then(afterReady, (err) => {
        warnOnce("zotero-initialized", err);
        afterReady();
      });
      else afterReady();
    } catch (err) {
      warnOnce("startup", err);
    }
  }
  function shutdown() {
    try {
      started = false;
      addonVersion = "";
      while (observers.length) removeWindowObserver(observers.pop());
      removeZoteroNotifier();
      const readerAPI = getZotero()?.Reader ?? null;
      for (const type of registeredEventTypes) {
        try {
          readerAPI?.unregisterEventListener?.(type, onRenderToolbar);
        } catch (err) {
          warnOnce("unregister-event", err, type);
        }
      }
      registeredEventTypes = [];
      for (const [, entry] of [...sessions]) {
        if (!entry.session.destroyed) closeSession(entry.session);
      }
      for (const reader of [...sessions.keys()]) sessions.delete(reader);
      buttonLinks.clear();
      regionCache = null;
      lastDiagnostics = null;
    } catch (err) {
      warnOnce("shutdown", err);
    }
  }
  function setEnabled(next) {
    const value = Boolean(next);
    enabled = value;
    if (regionCache) {
      for (const entry of sessions.values()) {
        if (!entry.session.destroyed) entry.session.setEnabled(value);
      }
    }
    return enabled;
  }
  function clearCache() {
    try {
      regionCache?.clear();
    } catch (err) {
      warnOnce("clear-cache", err);
    }
  }
  function resetWarnings() {
    resetWarnOnce();
  }
  function getRegionCache() {
    return regionCache;
  }
  function getSessions() {
    return [...sessions.values()].map((entry) => entry.session);
  }
  function getLog() {
    return getWarnLog();
  }
  function resolveProbeTarget() {
    const zotero = getZotero();
    let tabID = null;
    try {
      tabID = globalThis.Zotero_Tabs?.selectedID ?? null;
    } catch (ignored) {
    }
    let reader = null;
    try {
      reader = zotero?.Reader?.getByTabID?.(tabID) ?? null;
    } catch (err) {
      warnOnce("probe-reader", err);
    }
    if (!reader) {
      for (const entry2 of sessions.values()) {
        if (!entry2.session.destroyed) {
          reader = entry2.session.reader;
          break;
        }
      }
    }
    const entry = reader ? sessions.get(reader) : null;
    return { tabID, reader, session: entry?.session ?? null };
  }
  function runProbe() {
    const { tabID, reader, session } = resolveProbeTarget();
    return {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      tabID,
      reader: reader ? reader?.constructor?.name ?? "object" : null,
      session: session ? {
        ready: session.ready,
        attempts: session.attempts,
        innerWin: Boolean(session.innerWin),
        eventBus: Boolean(session.eventBus),
        docId: session.documentId ?? null,
        overlays: session.overlays.size,
        enabled: session.enabled
      } : null,
      chain: reader ? chainProbe(reader) : null,
      timers: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
      log: getWarnLog()
    };
  }
  function pickTargetOverlay(session, pageNumber, currentPage) {
    const overlays = session?.overlays;
    if (!overlays || typeof overlays.get !== "function" || typeof overlays.values !== "function") return null;
    const wanted = Number(pageNumber);
    if (Number.isFinite(wanted)) {
      const hit = overlays.get(wanted);
      if (hit) return hit;
    }
    if (currentPage !== null) {
      const hit = overlays.get(currentPage);
      if (hit) return hit;
    }
    const first = overlays.values().next();
    return first.done ? null : first.value ?? null;
  }
  function sessionKey(session) {
    try {
      if (session?.tag) return String(session.tag);
    } catch (ignored) {
    }
    try {
      const documentId = session?.documentId;
      if (documentId) return String(documentId).slice(0, 12);
    } catch (ignored) {
    }
    return "reader";
  }
  function readRealm(innerWin, tag = "") {
    if (!innerWin) return { info: null, error: null };
    const info = {
      pva: null,
      route: null,
      wrappedPva: null,
      hasCuUnwrap: null,
      frames: null,
      href: null
    };
    info.route = unwrapViewerApplication(innerWin, tag).route;
    try {
      info.hasCuUnwrap = typeof globalThis.Components?.utils?.unwrap;
      info.wrappedPva = typeof innerWin.wrappedJSObject?.PDFViewerApplication;
      info.pva = typeof innerWin.PDFViewerApplication;
      info.frames = innerWin.document?.querySelectorAll?.("iframe")?.length ?? null;
      const href = innerWin.location?.href;
      info.href = href === void 0 || href === null ? null : String(href).slice(0, REALM_HREF_MAX);
    } catch (err) {
      return { info, error: err?.message ?? String(err) };
    }
    return { info, error: null };
  }
  function describeSession(session) {
    const entry = {
      key: sessionKey(session),
      ready: Boolean(session.ready),
      attempts: Number(session.attempts) || 0,
      // How many pages the settled pass had to heal: a non-zero count, seen with
      // the offset disappearing on the real machine, says the paint raced the
      // viewer's relayout.
      settledRepaints: Number(session.settledRepaints) || 0,
      innerWin: Boolean(session.innerWin),
      realm: null,
      eventBus: Boolean(session.eventBus),
      docId: session.documentId ?? null,
      // The key the region cache actually uses, the realm identity, and what the
      // live document answers right now: two readers sharing one `docId`, or one
      // reader whose `freshDocId` differs from `docId`, is the multi-tab bug.
      cacheKey: session.cacheKey?.() ?? session.documentId ?? null,
      realmId: null,
      freshDocId: null,
      // How often this session had to change its mind about which pdf.js realm it
      // paints, and whether a provisional document key was replaced by a printed
      // one. A non-zero `realmSwitches` next to a `freshDocId` that still differs
      // from `docId` says the correction is not landing on this machine.
      realmSwitches: Number(session.realmSwitches) || 0,
      // Where the latched realm came from (`chain`/`src`/`scan`/`bridge`/
      // `bridge-guessed`/`none`) and whether the window is still listed by this
      // reader's own chain or iframe set — frame membership, not document ownership:
      // it says the realm belongs to this reader's frames, which does not by itself
      // prove that the document inside it is the one this reader shows. `bridge` with
      // `realmOwned: false` is the cross-reader guess, kept visible so the probe proves
      // the adoption gate is landing on the real machine.
      realmProvenance: String(session.realmProvenance ?? "none"),
      realmOwned: (() => {
        try {
          return realmBelongsToReader(session.innerWin ?? null, session.reader ?? null);
        } catch {
          return false;
        }
      })(),
      // Whether the realm is still only a guess, so the identity read from it proves
      // nothing and the wakes hold their paint: `true` with `docId` set is the state
      // where the plugin deliberately paints nothing rather than the wrong document.
      realmUnproven: (() => {
        try {
          return Boolean(session.realmUnproven?.());
        } catch {
          return true;
        }
      })(),
      documentIdAdopted: Boolean(session.documentIdAdopted),
      // What the last wake through `ensureCurrentDocument()` decided — `{trigger,
      // decision, after, at}` with `decision` in `ok`/`rekeyed`/`wait` and `after` the
      // identity the wake left behind — plus the scoped cache key the last re-key
      // released. Together they answer "did the wake see my document, and whose regions
      // did it drop" without a code change.
      lastValidation: session.lastValidation ?? null,
      // True when the session's own drift read reports another document right now, so
      // the next wake re-keys: a trusted realm, printed against printed. Provisional
      // re-mints and unproven realms read false, exactly as the gate does.
      docIdStale: (() => {
        try {
          return Boolean(session.docIdentityDrift?.());
        } catch {
          return false;
        }
      })(),
      lastStaleKey: session.lastStaleKey ?? null,
      // True when the key the last re-key released still holds cached regions, which
      // would mean the previous document's regions are still readable by some session.
      // `false` is the clean state the re-key is supposed to leave.
      staleKeyPresent: (() => {
        try {
          const stale = session.lastStaleKey ?? null;
          if (!stale) return false;
          return Boolean(session.regionCache?.hasDocument?.(stale));
        } catch {
          return false;
        }
      })(),
      overlays: session.overlays?.size ?? 0,
      enabled: Boolean(session.enabled),
      currentPage: null,
      target: null,
      mountDetached: null
    };
    const realm = readRealm(session.innerWin, entry.key);
    entry.realm = realm.info;
    if (realm.error) entry.realmError = realm.error;
    entry.realmId = null;
    try {
      const stamped = realmStamp(session.innerWin ?? null);
      if (stamped) entry.realmId = stamped;
    } catch (ignored) {
      entry.realmId = null;
    }
    if (!entry.realmId) {
      try {
        const raw = session.innerWin ?? null;
        const zid = raw?.wrappedJSObject ?? raw;
        const internal = typeof zid?.__ID__ === "number" ? zid.__ID__ : null;
        const href = typeof entry.realm?.href === "string" ? entry.realm.href : "";
        entry.realmId = internal !== null ? `iwin:${internal}` : href ? `href:${href}@${entry.realm?.route ?? "?"}` : null;
      } catch (ignored) {
        entry.realmId = null;
      }
    }
    try {
      entry.freshDocId = resolveDocumentId(session.currentPDFDocument?.() ?? null);
    } catch (err) {
      entry.freshDocIdError = err?.message ?? String(err);
    }
    try {
      const value = Number(resolvePDFViewer(session.innerWin, entry.key)?.currentPageNumber);
      if (Number.isFinite(value)) entry.currentPage = value;
    } catch (err) {
      entry.currentPageError = err?.message ?? String(err);
    }
    entry.scale = { currentScale: null, currentScaleValue: null, defaultZoomValue: null };
    try {
      const viewer = resolvePDFViewer(session.innerWin, entry.key);
      const scale = Number(viewer?.currentScale);
      const scaleValue = viewer?.currentScaleValue;
      const defaultZoom = viewer?.defaultZoomValue;
      entry.scale.currentScale = Number.isFinite(scale) ? scale : null;
      entry.scale.currentScaleValue = typeof scaleValue === "string" && scaleValue ? scaleValue : null;
      entry.scale.defaultZoomValue = typeof defaultZoom === "string" && defaultZoom ? defaultZoom : null;
    } catch (err) {
      warnOnce("probe-scale", err);
    }
    try {
      const overlay = pickTargetOverlay(session, void 0, entry.currentPage);
      if (overlay) {
        entry.target = probeOverlay(overlay);
        const mounted = typeof overlay.isMounted === "function" ? overlay.isMounted() : true;
        entry.mountDetached = !mounted;
      }
    } catch (err) {
      entry.targetError = err?.message ?? String(err);
    }
    return entry;
  }
  function probeAll() {
    const entries = [];
    let count = 0;
    for (const record of sessions.values()) {
      const session = record.session;
      if (!session || session.destroyed) continue;
      count += 1;
      if (entries.length < MAX_PROBE_SESSIONS) entries.push(describeSession(session));
    }
    const freshIds = entries.map((entry) => entry.freshDocId).filter((value) => value !== null && value !== void 0);
    const docIdentityDistinct = freshIds.length > 1 ? new Set(freshIds).size === freshIds.length : null;
    const active = resolveProbeTarget().session;
    const result = {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      // The installed add-on version the bootstrap reported, so a machine report proves
      // which build is loaded; the core build stays visible in `coreVersion` for the
      // harness cases that call `startup()` without version data.
      version: addonVersion || CORE_VERSION,
      coreVersion: CORE_VERSION,
      sessions: entries,
      active: active && !active.destroyed ? sessionKey(active) : null,
      count,
      docIdentityDistinct,
      wake: { count: wakeStats.count, nullTarget: wakeStats.nullTarget },
      log: getWarnLog()
    };
    if (count > entries.length) result.truncated = true;
    return result;
  }
  function probePaint(pageNumber, options = {}) {
    const { session } = resolveProbeTarget();
    let currentPage = null;
    try {
      const viewer = session ? resolvePDFViewer(session.innerWin, session.tag) : null;
      const value = Number(viewer?.currentPageNumber);
      if (Number.isFinite(value)) currentPage = value;
    } catch (err) {
      warnOnce("probe-current-page", err);
    }
    let target = null;
    try {
      const overlay = pickTargetOverlay(session, pageNumber, currentPage);
      if (overlay) target = probeOverlay(overlay, options);
    } catch (err) {
      warnOnce("probe-target", err);
    }
    return {
      at: (/* @__PURE__ */ new Date()).toISOString(),
      ready: Boolean(session?.ready),
      innerWin: Boolean(session?.innerWin),
      overlays: session?.overlays?.size ?? 0,
      currentPage,
      target,
      log: getWarnLog()
    };
  }
  var version = CORE_VERSION;
  var lastDiagnostics = null;
  var enabled = true;
  return __toCommonJS(main_exports);
})();
