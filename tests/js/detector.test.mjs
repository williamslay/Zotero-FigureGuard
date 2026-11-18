import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_DETECTOR_OPTIONS, detectFigureRegions, findInteriorCaptionRows } from "../../src/core/detector.js";

const PAGE = [0, 0, 612, 792];

/** Form placement with a page-space rect. */
function form(rect, extra = {}) {
  return { kind: "form", rect, depth: 0, opIndex: 0, ...extra };
}
function image(rect, extra = {}) {
  return { kind: "image", rect, depth: 0, opIndex: 0, ...extra };
}
function path(rect, extra = {}) {
  return { kind: "path", rect, depth: 0, opIndex: 0, ...extra };
}
/** Caption placed `gap` points below `figureBottom`. */
function captionBelow(number, figureRect, gap = 8, widthOverride = null) {
  const width = widthOverride ?? 150;
  const top = figureRect[1] - gap;
  return {
    number,
    label: `Figure ${number}:`,
    text: `Figure ${number}: caption`,
    rect: [figureRect[0], top - 10, figureRect[0] + width, top],
    fontSize: 10,
  };
}

describe("detector: acceptance", () => {
  it("accepts a form anchored to the caption below it", () => {
    const figure = [54, 617.946, 294.1272, 720.0001];
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, figure);
    assert.equal(result.regions[0].captionNumber, "2");
    assert.ok(result.regions[0].confidence >= DEFAULT_DETECTOR_OPTIONS.acceptConfidence);
    assert.ok(result.regions[0].evidence.includes("caption:Figure 2:"));
  });

  it("accepts a caption placed above the figure", () => {
    const figure = [54, 500, 294, 620];
    const caption = {
      number: "1",
      label: "Figure 1:",
      text: "Figure 1: caption",
      rect: [54, 489, 200, 499],
      fontSize: 10,
    };
    const result = detectFigureRegions({ placements: [form(figure)], captions: [caption], pageRect: PAGE });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, figure);
  });

  it("accepts a standalone image that needs no caption", () => {
    const result = detectFigureRegions({
      placements: [image([100, 400, 300, 600])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].kind, "image");
    assert.ok(result.regions[0].evidence.includes("standalone-image"));
  });

  it("accepts a tagged /Figure region when no XObject matches", () => {
    const result = detectFigureRegions({
      placements: [],
      captions: [],
      structRegions: [{ rect: [60, 500, 300, 640] }],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].kind, "struct");
    assert.ok(result.regions[0].evidence.includes("struct-tree:Figure"));
  });

  it("merges side-by-side subfigures sharing one caption", () => {
    const left = [54, 600, 200, 720];
    const right = [320, 600, 466, 720];
    const caption = {
      number: "4",
      label: "Figure 4:",
      text: "Figure 4: two panels",
      rect: [54, 585, 466, 595],
      fontSize: 10,
    };
    const result = detectFigureRegions({
      placements: [form(left), form(right)],
      captions: [caption],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [54, 600, 466, 720]);
    assert.equal(result.regions[0].placementCount, 2);
  });
});

describe("detector: rejection", () => {
  it("leaves an unexplained form uncovered rather than guessing", () => {
    const result = detectFigureRegions({ placements: [form([54, 600, 294, 720])], pageRect: PAGE });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected[0].reason, "no-figure-evidence");
  });

  it("rejects a page-sized placement even with a caption", () => {
    const figure = [0, 0, 612, 792];
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(1, figure, 0)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected[0].reason, "page-sized");
  });

  it("rejects a thin rule or underline", () => {
    const result = detectFigureRegions({ placements: [form([54, 400, 558, 404])], pageRect: PAGE });
    assert.equal(result.rejected[0].reason, "thin-decoration");
  });

  it("rejects a placement below the minimum area", () => {
    const result = detectFigureRegions({ placements: [form([54, 400, 84, 420])], pageRect: PAGE });
    assert.equal(result.rejected[0].reason, "below-min-area");
  });

  it("rejects an extreme aspect ratio", () => {
    const result = detectFigureRegions({ placements: [form([0, 400, 612, 460])], pageRect: PAGE });
    assert.equal(result.rejected[0].reason, "extreme-aspect");
  });

  it("rejects a small image with no caption", () => {
    const result = detectFigureRegions({ placements: [image([100, 400, 160, 460])], pageRect: PAGE });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected[0].reason, "image-below-area-threshold");
  });

  it("rejects a placement painted off the page", () => {
    const result = detectFigureRegions({
      placements: [form([90_000, 0, 90_100, 100])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected[0].reason, "off-page");
  });

  it("does not link a caption that is too far away", () => {
    const figure = [54, 600, 294, 720];
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, 90)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected[0].reason, "no-figure-evidence");
  });

  it("requires horizontal overlap before linking a caption", () => {
    const figure = [54, 600, 294, 720];
    const farRight = {
      number: "2",
      label: "Figure 2:",
      text: "Figure 2: caption",
      rect: [400, 585, 540, 595],
      fontSize: 10,
    };
    const result = detectFigureRegions({ placements: [form(figure)], captions: [farRight], pageRect: PAGE });
    assert.equal(result.regions.length, 0);
  });

  it("links a caption whose box intrudes into the figure bottom", () => {
    // pdf.js text bboxes carry full ascent and descent, so a real caption row
    // reaches a few points into the artwork above it (4.6 pt on the
    // flash-level fixture). A 10 pt-tall caption tolerates that intrusion.
    const figure = [54, 600, 294, 720];
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, -4.6)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "2");
    assert.ok(result.regions[0].confidence >= 0.8, `confidence ${result.regions[0].confidence}`);
  });

  it("caps the caption intrusion at one row height, or at maxCaptionOverlapPt", () => {
    const figure = [54, 600, 294, 720];
    // 11 pt of intrusion exceeds the 10 pt caption row height: no link.
    const beyond = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, -11)],
      pageRect: PAGE,
    });
    assert.equal(beyond.regions.length, 0);
    assert.equal(beyond.rejected[0].reason, "no-figure-evidence");
    // The same 4.6 pt intrusion fails once the cap is lowered under it.
    const capped = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, -4.6)],
      pageRect: PAGE,
      options: { maxCaptionOverlapPt: 3 },
    });
    assert.equal(capped.regions.length, 0);
  });
});

describe("detector: guards and ordering", () => {
  it("throws on a missing or empty page rect", () => {
    assert.throws(() => detectFigureRegions({ placements: [], pageRect: [0, 0, 0, 0] }), TypeError);
    assert.throws(() => detectFigureRegions({ placements: [], pageRect: null }), TypeError);
  });

  it("sorts regions top of page first, then left to right", () => {
    const top = [320, 700, 500, 780];
    const bottom = [54, 400, 240, 500];
    const result = detectFigureRegions({
      placements: [form(bottom), form(top)],
      captions: [captionBelow(1, top, 8), captionBelow(2, bottom, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 2);
    assert.deepEqual(result.regions[0].rect, top);
    assert.deepEqual(result.regions[1].rect, bottom);
  });

  it("assigns each placement to at most one caption", () => {
    const figure = [54, 600, 294, 720];
    const near = captionBelow(2, figure, 6);
    const further = { ...captionBelow(3, figure, 20), rect: [54, 574, 200, 584] };
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [near, further],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "2");
  });

  it("binds a panel to the caption below it, not a closer caption above", () => {
    const figure = [54, 400, 294, 500];
    const titleAbove = {
      number: "11",
      label: "Figure 11:",
      text: "Figure 11: row above",
      rect: [54, 505, 200, 515],
      fontSize: 10,
    };
    const captionBelowFigure = {
      number: "12",
      label: "Figure 12:",
      text: "Figure 12: this panel",
      rect: [54, 375, 200, 385],
      fontSize: 10,
    };
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [titleAbove, captionBelowFigure],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "12");
    assert.deepEqual(result.regions[0].rect, figure);
  });

  it("records a dropped row instead of losing it silently", () => {
    // Two linked rows above one caption: the near row becomes the region and
    // the far row must show up in `rejected` as `dropped-row`.
    const near = [54, 302, 180, 330];
    const far = [54, 340, 180, 368];
    const result = detectFigureRegions({
      placements: [form(near), form(far)],
      captions: [{ number: "4", label: "Figure 4:", text: "Figure 4: two rows", rect: [54, 290, 180, 300], fontSize: 10 }],
      pageRect: PAGE,
      options: { maxCaptionGapPt: 60 },
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, near);
    const dropped = result.rejected.filter((entry) => entry.reason === "dropped-row");
    assert.equal(dropped.length, 1);
    assert.deepEqual(dropped[0].rect, far);
  });

  it("reports page area ratio for every accepted region", () => {

    const figure = [54, 617.946, 294.1272, 720.0001];
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [captionBelow(2, figure, 10.7)],
      pageRect: PAGE,
    });
    assert.ok(result.regions[0].pageAreaRatio > 0.04);
    assert.ok(result.regions[0].pageAreaRatio < 0.06);
  });

  it("keeps the confidence gate conservative for a marginal form", () => {
    const result = detectFigureRegions({
      placements: [form([54, 600, 294, 720])],
      captions: [captionBelow(2, [54, 600, 294, 720], 24)],
      pageRect: PAGE,
      options: { acceptConfidence: 1.1 },
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected.at(-1).reason, "below-confidence-threshold");
  });
});

describe("detector: vector path placements", () => {
  function path(rect, extra = {}) {
    return { kind: "path", rect, depth: 0, opIndex: 0, ...extra };
  }

  it("chains nearby path boxes into one cluster on a figure page", () => {
    const otherCaption = captionBelow("9", [400, 120, 520, 200], 8);
    const result = detectFigureRegions({
      placements: [path([50, 600, 150, 700]), path([160, 600, 260, 700])],
      captions: [otherCaption],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [50, 600, 260, 700]);
    assert.equal(result.regions[0].kind, "path");
    assert.ok(result.regions[0].evidence.includes("standalone-path"));
  });

  it("keeps path boxes beyond the merge tolerance apart on a figure page", () => {
    const otherCaption = captionBelow("9", [400, 120, 520, 200], 8);
    const result = detectFigureRegions({
      placements: [path([50, 600, 150, 700]), path([185, 600, 285, 700])],
      captions: [otherCaption],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 2);
  });

  it("rejects unanchored path clusters on pages without any Figure caption", () => {
    const result = detectFigureRegions({
      placements: [path([50, 600, 260, 700])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected.at(-1).reason, "no-figure-caption-on-page");
  });

  it("rejects a small path cluster below the anchored-area gate", () => {
    const result = detectFigureRegions({
      placements: [path([50, 600, 100, 650])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.equal(result.rejected.at(-1).reason, "path-below-area-threshold");
  });

  it("accepts a small path cluster when a caption anchors it", () => {
    const figure = [100, 600, 160, 660];
    const result = detectFigureRegions({
      placements: [path(figure)],
      captions: [captionBelow("5", figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "5");
    assert.ok(result.regions[0].sourceKinds.includes("path"));
  });

  it("reports mixed source kinds when a form and its paths share a caption", () => {
    const figure = [300, 600, 400, 700];
    const result = detectFigureRegions({
      placements: [form(figure), path([310, 610, 390, 690])],
      captions: [captionBelow("6", figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual([...result.regions[0].sourceKinds].sort(), ["form", "path"]);
    assert.ok(result.regions[0].evidence.includes("form-xobject"));
  });

  it("caps the raw path boxes and reports the truncation", () => {
    const result = detectFigureRegions({
      placements: [
        path([50, 700, 120, 760]),
        path([250, 700, 320, 760]),
        path([450, 700, 520, 760]),
      ],
      captions: [],
      pageRect: PAGE,
      options: { maxPathBoxesPerPage: 2 },
    });
    assert.equal(result.diagnostics.rawPathBoxCount, 3);
    assert.equal(result.diagnostics.pathBoxCount, 2);
    assert.equal(result.diagnostics.pathBoxesTruncated, 1);
  });
});

describe("detector: off-page path boxes and interior-caption splits", () => {
  const path = (rect) => ({ kind: "path", rect, depth: 0, opIndex: 0 });
  const row = (number, rect) => ({
    number,
    label: `Figure ${number}:`,
    text: `Figure ${number}: caption`,
    rect,
    fontSize: 10,
  });

  it("drops a mostly-off-page path box and counts it", () => {
    // Geometry from the Borges fixture page 12: a 11.4 x 14455 pt box whose
    // visible strip is 4.2 % of its own area, next to a 120 pt tall figure.
    const result = detectFigureRegions({
      placements: [path([100, -13846.3, 111.4, 608.87]), path([54, 600, 430, 720])],
      captions: [row("1", [60, 588, 300, 598])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathBoxesOffPage, 1);
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [54, 600, 430, 720]);
  });

  it("keeps a box at exactly the visible-area ratio and drops the one below it", () => {
    // 100 pt of a 400 pt tall box is on the page: 0.25 is the boundary and must
    // stay, so only a strictly smaller fraction may be dropped.
    const kept = detectFigureRegions({
      placements: [path([0, -300, 100, 100])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(kept.diagnostics.pathBoxesOffPage, 0);
    assert.equal(kept.diagnostics.pathBoxCount, 1);

    const dropped = detectFigureRegions({
      placements: [path([0, -302, 100, 100])],
      captions: [],
      pageRect: PAGE,
    });
    assert.equal(dropped.diagnostics.pathBoxesOffPage, 1);
    assert.equal(dropped.diagnostics.pathBoxCount, 0);
  });

  it("clips a retained bleed box to the page", () => {
    // A box reaching 40 pt below the page edge passes the visible-area filter,
    // but paint outside the page is invisible to the reader, so it must not
    // drag the highlight: the FluidKV fixture page 5 chained its two figures
    // into [-43.36, 488.5, 835.01, 807.89] on a 612 x 792 page (area ratio
    // 0.97, wider and taller than the figure) and page 6 showed the same
    // defect at ratio 0.65. The union now stops at the page border.
    const result = detectFigureRegions({
      placements: [path([50, -40, 250, 100]), path([50, 100, 250, 300])],
      captions: [row("2", [60, 302, 200, 312])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathBoxesOffPage, 0);
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [50, 0, 250, 300]);
  });

  it("splits a cluster chained over a caption row into two accepted bands", () => {
    // 13.2 pt gap, below the 18.02 pt merge tolerance, with a caption row
    // inside the cluster: the Borges fixture page 12 layout at unit scale.
    const lower = [54, 590, 430, 646.8];
    const upper = [54, 660, 430, 720];
    const result = detectFigureRegions({
      placements: [path(lower), path(upper)],
      captions: [row("7", [60, 648, 200, 658]), row("8", [60, 578, 300, 588])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 1);
    assert.equal(result.regions.length, 2);
    const rects = result.regions.map((region) => region.rect);
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - upper[i]) < 0.01)));
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - lower[i]) < 0.01)));
    for (const region of result.regions) assert.ok(region.confidence >= 0.85, `conf ${region.confidence}`);
  });

  it("does not split on caption rows that only touch a cluster edge", () => {
    // The 2.3 pt and 4.6 pt intrusions measured on the flash fixture: a caption
    // box that grazes the artwork is the figure's own label, not a seam.
    const cluster = [54, 600, 430, 720];
    const captions = [row("9", [60, 707.7, 300, 717.7]), row("10", [60, 592.3, 300, 602.3])];
    assert.deepEqual(findInteriorCaptionRows(cluster, captions), []);
    const result = detectFigureRegions({
      placements: [path([54, 600, 430, 646.8]), path([54, 660, 430, 720])],
      captions,
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 0);
    assert.equal(result.regions.length, 1);
  });

  it("merges a split back when a band is not a figure of its own", () => {
    // The band above the row is a 4 pt rule: below `minSidePt`, so the cluster
    // must survive whole rather than lose the rule or gain a sliver region.
    const result = detectFigureRegions({
      placements: [path([54, 600, 430, 700]), path([54, 713.2, 430, 717.2])],
      captions: [row("11", [60, 702, 200, 712]), row("12", [60, 588, 200, 598])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 0);
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [54, 600, 430, 717.2]);
  });

  it("does not split when the row overlaps the cluster by less than 0.3", () => {
    // A 220 pt wide row sharing 50 pt with a 376 pt cluster overlaps by 0.227:
    // it labels a neighbour column, not the seam between two figures.
    const seam = row("13", [380, 648, 600, 658]);
    assert.equal(findInteriorCaptionRows([54, 590, 430, 720], [seam]).length, 0);
    const result = detectFigureRegions({
      placements: [path([54, 590, 430, 646.8]), path([54, 660, 430, 720])],
      captions: [seam],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 0);
    assert.equal(result.diagnostics.pathBoxCount, 1);
  });

  it("clips a member that straddles the split row to the part on each side", () => {
    // A frame that overlaps the row keeps 54 pt above the slab against nothing
    // below it. Routing the whole rect gave the upper band a bottom edge 8 pt
    // inside the caption box (the FluidKV fixture page 5 then read the 21 pt
    // band under the row as a figure of its own); clipping at the slab keeps
    // the band to the artwork that is really above the row.
    const result = detectFigureRegions({
      placements: [path([54, 590, 430, 646.8]), path([54, 650, 430, 712])],
      captions: [row("14", [60, 648, 200, 658]), row("15", [60, 578, 300, 588])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 1);
    assert.equal(result.regions.length, 2);
    const rects = result.regions.map((region) => region.rect);
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - [54, 658, 430, 712][i]) < 0.01)));
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - [54, 590, 430, 646.8][i]) < 0.01)));
  });

  it("drops the sliver a straddling member leaves on the far side of the slab", () => {
    // Same split as above, but the straddling member starts 12 pt under the
    // row: below `minSidePt`, so it belongs to neither band. Kept, it would
    // have stretched the lower band 18 pt up into the caption box.
    const result = detectFigureRegions({
      placements: [path([54, 570, 430, 630]), path([54, 636, 430, 712])],
      captions: [row("16", [60, 648, 200, 658]), row("17", [60, 558, 300, 568])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathClusterSplits, 1);
    assert.equal(result.regions.length, 2);
    const rects = result.regions.map((region) => region.rect);
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - [54, 570, 430, 630][i]) < 0.01)));
    assert.ok(rects.some((rect) => rect.every((value, i) => Math.abs(value - [54, 658, 430, 712][i]) < 0.01)));
  });
});

describe("detector: full-bleed clip frames are evidence, never extent", () => {
  // The `re` rectangle a figure is clipped to is painted as a path of its own and
  // routinely spans 86 to 111 % of the page width (FluidKV pages 2, 5, 6). The
  // predicate reads the RAW rect: area >= 0.25 of the page and width >= 0.8 of
  // the page. On a 612 x 792 page that is 120996 pt^2 and 489.6 pt.
  const path = (rect) => ({ kind: "path", rect, depth: 0, opIndex: 0 });
  const row = (number, rect) => ({
    number,
    label: `Figure ${number}:`,
    text: `Figure ${number}: caption`,
    rect,
    fontSize: 10,
  });
  /** Same geometry with the rule switched off: pre-round-23 behaviour. */
  const BASELINE = { pathFullBleedAreaRatio: Infinity };

  it("keeps a full-bleed frame from chaining two side-by-side figures", () => {
    // 312 pt of gutter - far past the 18.02 pt merge tolerance - so the two
    // figures are two clusters on their own; the frame spans both.
    const left = [54, 600, 150, 700];
    const right = [462, 600, 558, 700];
    const frame = [20, 540, 612, 760]; // 0.269 area, 0.967 width -> frame
    const captions = [row("1", [54, 582, 204, 592]), row("2", [462, 582, 612, 592])];

    const bridged = detectFigureRegions({
      placements: [path(left), path(right), path(frame)],
      captions,
      pageRect: PAGE,
      options: BASELINE,
    });
    // The frame chains the two figures into one 592 pt slab; the seam rule cuts it
    // at the caption rows but the upper band is still page-wide and figure 2 is
    // left without a region of its own.
    assert.equal(bridged.diagnostics.pathBoxCount, 2);
    assert.equal(bridged.diagnostics.pathClusterSplits, 1);
    assert.deepEqual(bridged.regions.map((region) => region.rect), [[20, 592, 612, 760]]);
    assert.deepEqual(bridged.regions.map((region) => region.captionNumber), ["1"]);

    const result = detectFigureRegions({
      placements: [path(left), path(right), path(frame)],
      captions,
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathBoxCount, 2);
    assert.equal(result.diagnostics.pathClusterSplits, 0);
    assert.deepEqual(result.regions.map((region) => region.rect), [left, right]);
    assert.deepEqual(result.regions.map((region) => region.captionNumber), ["1", "2"]);
    for (const region of result.regions) {
      assert.ok(region.rect[2] - region.rect[0] <= 96, `extent ${region.rect}`);
    }
  });

  it("emits the frame itself when it is the only painted geometry on the page", () => {
    // Artwork drawn as text-free vector fill leaves the frame alone: dropping it
    // wholesale would make the page read as having no figure at all.
    const frame = [20, 540, 612, 760];
    const result = detectFigureRegions({
      placements: [path(frame)],
      captions: [row("3", [54, 510, 300, 520])],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathBoxCount, 1);
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, frame);
    assert.equal(result.regions[0].captionNumber, "3");
  });

  it("keeps a short page-wide band as extent, not a frame", () => {
    // The Borges fixture page 12 bands: 0.824 of the page width but only 0.0788
    // of its area, so the width test alone must not classify them. Dropped from
    // extent here, the region would shrink to the 100 pt artwork inside it.
    const band = [54, 644.3, 558, 720];
    const result = detectFigureRegions({
      placements: [path(band), path([100, 660, 200, 700])],
      captions: [row("7", [60, 634, 300, 644])],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, band);
  });

  it("keeps page-wide artwork below the area floor as extent", () => {
    // 0.2097 area, 0.964 width: the widest real artwork measured on the fixtures,
    // and the margin the 0.25 floor leaves it (the narrowest frame is 0.324).
    const art = [0, 620, 590, 792];
    const result = detectFigureRegions({
      placements: [path(art), path([250, 660, 350, 700])],
      captions: [row("4", [60, 608, 300, 618])],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, art);
  });

  it("does not frame a tall box that is only half a page wide", () => {
    // 0.346 area but 0.402 width: a single-column figure, not a clip frame, so
    // the width half of the predicate is what keeps it in extent.
    const column = [54, 80, 300, 760];
    const result = detectFigureRegions({
      placements: [path(column), path([100, 300, 200, 400])],
      captions: [row("5", [60, 68, 300, 78])],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, column);
  });
});

describe("detector: gap allowance for wide caption rows", () => {
  // Geometry from the FluidKV fixture figure 13: six 80.7 pt sub-forms whose
  // row is labelled by a 505.9 pt wide caption box ending 30.59 pt below the
  // artwork - past the flat 26 pt limit, inside the width allowance.
  const row = (number, top, width) => ({
    number,
    label: `Figure ${number}:`,
    text: `Figure ${number}: caption`,
    rect: [54, top - 10, 54 + width, top],
    fontSize: 10,
  });

  it("links a 505.9 pt wide caption row 30.59 pt under the artwork", () => {
    const result = detectFigureRegions({
      placements: [form([54, 640, 540, 720])],
      captions: [row(13, 609.41, 505.9)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "13");
  });

  it("keeps a 29.61 pt gap unlinked when the caption row is narrow", () => {
    // The figure 8 to figure 9 caption distance on the same fixture, over a
    // 206.8 pt cluster: the widest gap that must stay two separate figures.
    const result = detectFigureRegions({
      placements: [form([54, 640, 260.8, 720])],
      captions: [row(9, 610.39, 206.8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
  });

  it("takes the allowance from the caption row, not from the sub-forms", () => {
    // Panels are 80.7 pt each and their union is 308.1 pt wide, so the widest
    // artwork-side allowance is 29.02 pt - short of 30.59. Only the 505.9 pt
    // caption row, which grants 30.96 pt, links this row of subfigures.
    const panels = [0, 1, 2].map((index) =>
      form([54 + index * 86.7, 640, 134.7 + index * 86.7, 700]),
    );
    const wide = detectFigureRegions({
      placements: panels,
      captions: [row(13, 609.41, 505.9)],
      pageRect: PAGE,
    });
    assert.equal(wide.regions.length, 1);
    assert.equal(wide.regions[0].captionNumber, "13");

    const narrow = detectFigureRegions({
      placements: panels,
      captions: [row(13, 609.41, 200)],
      pageRect: PAGE,
    });
    assert.equal(narrow.regions.length, 0);
  });
});

describe("detector: text expansion of accepted regions", () => {
  const figure = [100, 600, 300, 700];
  const caption = {
    number: "1",
    label: "Figure 1:",
    text: "Figure 1: caption",
    rect: [100, 588, 250, 598],
    fontSize: 10,
  };
  /** Text run in page space; `baselineY` is where the glyphs sit. */
  const run = (rect, baselineY, str = "10") => ({ rect, baselineY, str });

  it("pulls a tick label 20 pt left of the artwork into the region", () => {
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([77, 640, 80, 652], 642)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, [77, 600, 300, 700]);
    assert.equal(result.diagnostics.textExpandedRegions, 1);
  });

  it("leaves a label 26 pt away outside the region", () => {
    // Body text starts 26 pt from the artwork column on the FluidKV fixture,
    // and the gutter between its two text columns is 25.42 pt.
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([34, 640, 74, 652], 642)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, figure);
    assert.equal(result.diagnostics.textExpandedRegions, 0);
  });

  it("needs the baseline inside the region band", () => {
    // Only 4 pt from the edge, but the line reads under the figure, so the
    // paragraph below it would be swept into the highlight.
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([76, 560, 96, 572], 562)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, figure);
  });

  it("will not grow over the caption row bound to the region", () => {
    // The caption box is wider than the artwork here, so the run beside the
    // region sits inside that box: 8 pt of gap, inside the 24 pt reach, but it
    // is the figure's own label line and must not widen the highlight.
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [{ ...caption, rect: [80, 596, 320, 606] }],
      textItems: [run([82, 598, 92, 608], 600.5)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, figure);
  });

  it("keeps a run on the other half of the page out of a two-column figure", () => {
    // Region centre 300, page mid-line 306, run centre 355: the 10 pt gap sits
    // across the 25.42 pt gutter, so the neighbour column must stay out.
    const across = detectFigureRegions({
      placements: [form([280, 600, 320, 700])],
      captions: [{ ...caption, rect: [280, 588, 320, 598] }],
      textItems: [run([330, 640, 336, 652], 645)],
      pageRect: PAGE,
    });
    assert.deepEqual(across.regions[0].rect, [280, 600, 320, 700]);

    const same = detectFigureRegions({
      placements: [form([300, 600, 340, 700])],
      captions: [{ ...caption, rect: [300, 588, 340, 598] }],
      textItems: [run([350, 640, 356, 652], 645)],
      pageRect: PAGE,
    });
    assert.deepEqual(same.regions[0].rect, [300, 600, 356, 700]);
  });

  it("ignores a run of spaces", () => {
    // pdf.js reports trailing spaces with the advance of the whole row: on the
    // Borges fixture page 13 such a run reached 2.6 pt past the text column.
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([77, 640, 80, 652], 642, "   ")],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, figure);
  });

  it("is a no-op without text items, and for a page with no qualifying run", () => {
    const without = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      pageRect: PAGE,
    });
    assert.deepEqual(without.regions[0].rect, figure);
    assert.equal(without.diagnostics.textExpandedRegions, 0);
  });

  it("chains a second run that stays inside the allowance", () => {
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([86, 640, 96, 652], 642), run([78, 640, 84, 652], 642)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, [78, 600, 300, 700]);
  });

  it("stops the chain at the allowance measured from the original border", () => {
    // Two runs 14 pt apart, each within reach of its predecessor: growth stops
    // 24 pt from the border the artwork produced, so the region cannot walk to
    // the page edge over a column of labels (the PipeBWrite fixture page 3 grew
    // 54 pt that way, to x 612, over the ACM sidebar stamp).
    const result = detectFigureRegions({
      placements: [form(figure)],
      captions: [caption],
      textItems: [run([86, 640, 96, 652], 642), run([62, 640, 72, 652], 642)],
      pageRect: PAGE,
    });
    assert.deepEqual(result.regions[0].rect, [86, 600, 300, 700]);
  });
});

describe("detector: absorption of area-rejected placements", () => {
  const figure = [54, 500, 294, 720];

  it("absorbs a rejected image whose centre sits inside the region", () => {
    // `inside` is fully covered and only fixes the placement bookkeeping;
    // `over-top` pokes 12 pt above the region border and must expand it.
    const inside = image([144, 584, 204, 644]);
    const overTop = image([134, 702, 214, 732]);
    const result = detectFigureRegions({
      placements: [form(figure), inside, overTop],
      captions: [captionBelow("7", figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [54, 500, 294, 732]);
    assert.equal(result.regions[0].placementCount, 3);
    assert.ok(result.regions[0].evidence.includes("absorbed-image"));
    assert.equal(
      result.rejected.filter((entry) => entry.reason === "image-below-area-threshold").length,
      0,
    );
  });

  it("does not absorb a placement that touches the bound caption row", () => {
    // This image hangs from inside the region down past the caption text
    // (no vertical link possible: both gaps exceed the tolerances), but the
    // region border must stay above the caption, so it is not absorbed.
    const result = detectFigureRegions({
      placements: [form(figure), image([144, 476, 204, 528])],
      captions: [captionBelow("7", figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, figure);
    const entry = result.rejected.find((r) => r.reason === "image-below-area-threshold");
    assert.ok(entry, "the placement stays rejected");
    assert.deepEqual(entry.rect, [144, 476, 204, 528]);
  });

  it("keeps the region alone when the absorbed centre is not strictly inside", () => {
    // The centre sits above the region top, so most of the image is outside
    // and the inset check rejects the absorption.
    const result = detectFigureRegions({
      placements: [form(figure), image([134, 715, 214, 749])],
      captions: [captionBelow("7", figure, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, figure);
    assert.ok(result.rejected.some((r) => r.reason === "image-below-area-threshold"));
  });
});

describe("detector: Zotero-aligned edge, table-guard, substrate, and mixed-image refinement", () => {
  it("keeps adjacent-column booktabs table rules separate from a nearby right-column figure", () => {
    const rightFig = [320.4, 484.5, 560.5, 590.1];
    const result = detectFigureRegions({
      placements: [
        // Left-column booktabs table rules + small cell grid (`onlyThinRules` must survive mergePanelGrids)
        path([62.9, 719.8, 285.3, 720.8]),
        path([63.1, 707.6, 64.1, 719.6]),
        path([285.1, 707.6, 286.1, 719.6]),
        path([62.9, 646.1, 285.3, 647.1]),
        path([54, 612.8, 307.8, 613.8]),
        path([54, 600.5, 307.8, 601.5]),
        path([54, 528.4, 307.8, 529.4]),
        // Right-column figure across a 12.6 pt two-column gutter (< 25 pt merge tolerance)
        form(rightFig),
        path(rightFig),
        path([347.7, 495, 549.6, 575.4]),
      ],
      captions: [captionBelow("14", rightFig, 8)],
      textItems: [
        { str: "Workload", rect: [87.6, 604.3, 126.7, 614.2] },
        { str: "F (Read-Modify-Write)", rect: [60, 532.1, 154.3, 542.1] },
        { str: "Table 2: YCSB workloads.", rect: [114.2, 511, 233.6, 523] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, rightFig);
  });

  it("prevents 1D horizontal table rules separated by text from chaining into a figure", () => {
    const result = detectFigureRegions({
      placements: [
        path([54, 697, 558, 698]),
        path([54, 670, 558, 671]),
        path([54, 623, 558, 624]),
        path([54, 590, 558, 591]),
      ],
      textItems: [
        { str: "Method", rect: [60, 680, 110, 690] },
        { str: "Throughput", rect: [200, 680, 270, 690] },
        { str: "Baseline", rect: [60, 640, 110, 650] },
        { str: "Ours", rect: [60, 600, 95, 610] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
  });

  it("filters tiled page-substrate raster backgrounds without swallowing figures", () => {
    const result = detectFigureRegions({
      placements: [
        image([0, 0, 612, 400]),
        image([0, 399, 612, 792]),
        form([100, 500, 300, 650]),
      ],
      captions: [captionBelow("1", [100, 500, 300, 650])],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [100, 500, 300, 650]);
  });

  it("merges raster image with surrounding vector axes in clear sight, blocked by prose", () => {
    const merged = detectFigureRegions({
      placements: [
        image([100, 520, 260, 660]),
        path([94, 520, 95, 660]),
        path([94, 514, 260, 515]),
      ],
      captions: [captionBelow("2", [94, 514, 260, 660])],
      pageRect: PAGE,
    });
    assert.equal(merged.regions.length, 1);
    assert.deepEqual(merged.regions[0].rect, [94, 514, 260, 660]);
    assert.deepEqual(merged.regions[0].sourceKinds, ["image", "path"]);
  });

  it("expands 4 ways onto left/right Y-axis labels and bottom subfigure labels on two-column plots", () => {
    const result = detectFigureRegions({
      placements: [path([110, 540, 510, 710])],
      captions: [
        {
          number: "7",
          label: "Figure 7:",
          text: "Figure 7: Two-column benchmark results.",
          rect: [180, 488, 420, 498],
          fontSize: 10,
        },
      ],
      textItems: [
        { str: "Throughput (M ops/s)", rect: [94, 580, 102, 660], transform: [0, 6, -6, 0, 94, 580] },
        { str: "NVM write latency (ns)", rect: [240, 524, 340, 532], transform: [8, 0, 0, 8, 240, 524] },
        { str: "(a) Put", rect: [150, 508, 190, 516], transform: [8, 0, 0, 8, 150, 508] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [94, 508, 510, 710]);
  });

  it("accepts wide-short standalone images under the 2-of-3 Zotero size gate", () => {
    // 400 x 18 pt? No: 400 x 21 is < 8% height. 120 x 70 = 8400/484704 = 0.0173 (< 0.02),
    // width ratio 120/612 = 0.196 (>= 0.15) and height ratio 70/792 = 0.088 (>= 0.08) -> passes 2-of-3.
    const result = detectFigureRegions({
      placements: [image([100, 500, 220, 570])],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [100, 500, 220, 570]);
  });

  it("coalesces dense micro-paths inside plots so later figures past maxPathBoxesPerPage are not truncated", () => {
    const firstFrame = [60, 620, 280, 720];
    const dots = Array.from({ length: 1300 }, (_, i) =>
      path([80 + (i % 150), 630 + ((i * 7) % 80), 81.2 + (i % 150), 631.2 + ((i * 7) % 80)]),
    );
    const secondFig = [320, 620, 550, 725];
    const result = detectFigureRegions({
      placements: [path(firstFrame), ...dots, path(secondFig)],
      captions: [captionBelow("1", firstFrame, 8), captionBelow("2", secondFig, 8)],
      pageRect: PAGE,
    });
    assert.equal(result.diagnostics.pathBoxesTruncated, 0);
    assert.equal(result.regions.length, 2);
    assert.deepEqual(
      result.regions.map((r) => r.captionNumber),
      ["2", "1"],
    );
  });

  it("stitches an unanchored upper architecture sub-band across a ~20 pt label gap onto the captioned figure", () => {
    const lowerBand = [60, 596, 280, 647];
    const upperBand = [74, 667, 292, 704];
    const result = detectFigureRegions({
      placements: [path(lowerBand), path(upperBand)],
      captions: [captionBelow("3", lowerBand, 8)],
      textItems: [
        { str: "Fast Disk", rect: [55, 648, 88, 657], transform: [8, 0, 0, 8, 55, 648] },
        { str: "Access key user12345", rect: [62, 712, 150, 722], transform: [8, 0, 0, 8, 62, 712] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.equal(result.regions[0].captionNumber, "3");
    assert.deepEqual(result.regions[0].rect, [55, 596, 292, 722]);
  });

  it("keeps edge-straddling labels and rotated Y-axis overhangs unchopped", () => {
    const box = [80, 600, 280, 700];
    const result = detectFigureRegions({
      placements: [form(box)],
      captions: [captionBelow("1", box, 8)],
      textItems: [
        // Rotated Y-axis label extending 10 pt past top border and straddling label extending 6 pt above
        { str: "Throughput (req/sec)", rect: [62, 604, 70, 710], transform: [0, 6, -6, 0, 62, 604] },
        { str: "Header tag", rect: [140, 696, 200, 706], transform: [8, 0, 0, 8, 140, 696] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 1);
    assert.deepEqual(result.regions[0].rect, [62, 600, 280, 710]);
  });

  it("does not chain 8 pt table header shading bars in mergePanelGrids", () => {
    const result = detectFigureRegions({
      placements: [
        path([45.8, 149.4, 440.2, 157.4]),
        path([45.8, 104.4, 440.2, 112.4]),
      ],
      textItems: [
        { str: "Table 1. Research Questions", rect: [88.5, 627.6, 397.3, 636.6] },
        { str: "Question#4: Evolution", rect: [50.8, 135, 250, 142] },
      ],
      pageRect: [0, 0, 486, 720],
    });
    assert.equal(result.regions.length, 0);
  });

  it("rejects an unanchored path block sitting directly under a Table caption even on a figure page", () => {
    const result = detectFigureRegions({
      placements: [path([320, 200, 560, 400])],
      captions: [captionBelow("2", [54, 500, 290, 650], 8)],
      textItems: [
        { str: "Table 1. Summary of approaches", rect: [320, 620, 560, 630] },
      ],
      pageRect: PAGE,
    });
    assert.equal(result.regions.length, 0);
    assert.ok(result.rejected.some((r) => r.reason === "table-or-algorithm-region"));
  });
});
