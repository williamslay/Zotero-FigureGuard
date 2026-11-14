/**
 * Detector thresholds. All lengths are PDF user-space points; ratios are
 * fractions of the page area. Values are deliberately conservative: an
 * unexplained Form XObject stays uncovered instead of painting a white box
 * over body text.
 */
export const DEFAULT_DETECTOR_OPTIONS = Object.freeze({
  /** Placements smaller than this fraction of the page are icons or bullets. */
  minAreaRatio: 0.004,
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
  maxAspect: 8,
});

/** Area of `rect` as a fraction of `pageRect`. */
export function areaRatioOf(rect, pageRect, options = DEFAULT_DETECTOR_OPTIONS) {
  void options;
  const pageArea = Math.abs(pageRect[2] - pageRect[0]) * Math.abs(pageRect[3] - pageRect[1]);
  if (!pageArea) return 0;
  return Math.abs(rect[2] - rect[0]) * Math.abs(rect[3] - rect[1]) / pageArea;
}
