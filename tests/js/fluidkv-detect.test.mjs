/**
 * Fourth fixture: "FluidKV: Seamlessly Bridging the Gap between Indexing
 * Performance and Memory-Footprint on Ultra-Fast Storage" — a 14-page ACM paper
 * whose figures are a clip-path frame around vector art and around tables of
 * numbers. It is the fixture for three border rules, all of which lost real
 * artwork here before round 22:
 *   - pages 2, 5 and 6 drew their frames 17.2 to 364 pt past the trim, so the box
 *     was discarded whole: page 6 yielded nothing at all, page 5 one of its two
 *     figure bands, page 2 a fragment instead of the frame;
 *   - page 10 figure 13 is six 80.7 x 51.9 pt panels whose caption row sits
 *     30.59 pt away, past the 26 pt link gap, so all six went unanchored;
 *   - text drawn as part of a figure — axis labels, table columns — was never
 *     inside the box, because only painted geometry set the border.
 * Round 23 put the frame rule in on this fixture. The clip frame a figure is
 * drawn inside is painted as one path of its own, 86 to 111 % of the page width,
 * and chaining it in made it *extent*: page-wide bands on pages 2, 5 and 6, plus
 * a bridge across the 28.29 pt gutter between figures 7 and 8, so two figures
 * became one slab. A frame is now evidence, never extent.
 * All rects in the assertions are PDF user space (origin bottom-left) unless
 * stated otherwise; the report writes page top-left coordinates.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_DETECTOR_OPTIONS, detectPageRegions } from "../../src/core/index.js";
import { findInteriorCaptionRows } from "../../src/core/detector.js";
import { OPS, REPO_ROOT, openFixture } from "./helpers/doc.mjs";

const FLUIDKV_PDF = path.join(
  REPO_ROOT,
  "FluidKV_ Seamlessly Bridging the Gap between Indexing Performance and Memory-Footprint on Ultra-Fast Storage.pdf",
);

const round2 = (rect) => rect.map((value) => Math.round(value * 100) / 100);

describe("fluidkv fixture: whole document survey", () => {
  let doc;
  let close;
  let survey;
  /** Accepted regions in user space, plus the captions, for the geometry guards. */
  let regionEvidence;
  /** Same pages detected with `textExpansionPt: 0`, the no-growth control. */
  let control;

  before(async () => {
    ({ doc, close } = await openFixture(FLUIDKV_PDF));
    survey = [];
    regionEvidence = [];
    control = new Map();
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const result = await detectPageRegions({ pdfPage: page, OPS });
      const viewport = page.getViewport({ scale: 1 });
      const toPageTopLeft = (rect) => {
        const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[3]);
        const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[1]);
        return [x1, y1, x2, y2].map((value) => Math.round(value * 100) / 100);
      };
      const captionNumbers = result.captions.map((caption) => String(caption.number));
      const diagnostics = result.diagnostics;
      survey.push({
        page: pageNumber,
        placements: diagnostics.placementCount,
        xobjects: diagnostics.rawPlacementCount - diagnostics.rawPathBoxCount,
        pathBoxes: diagnostics.rawPathBoxCount,
        pathClusters: diagnostics.pathBoxCount,
        pathBoxesOffPage: diagnostics.pathBoxesOffPage,
        pathClusterSplits: diagnostics.pathClusterSplits,
        textExpandedRegions: diagnostics.textExpandedRegions,
        captions: captionNumbers,
        accepted: result.regions.map((region) => ({
          rect: toPageTopLeft(region.rect),
          caption: region.captionNumber,
          kind: region.sourceKinds.join("+"),
          confidence: region.confidence,
          pageAreaRatio: region.pageAreaRatio,
        })),
        rejectedReasons: result.rejected.map((entry) => entry.reason),
        uncoveredCaptions: captionNumbers.filter(
          (number) => !result.regions.some((region) => region.captionNumber === number),
        ),
      });
      regionEvidence.push({
        page: pageNumber,
        pageRect: result.pageRect,
        regions: result.regions.map((region) => ({
          rect: region.rect,
          captionNumber: region.captionNumber,
          captionRects: region.captionRects,
        })),
        captions: result.captions,
      });
      control.set(pageNumber, await detectPageRegions({
        pdfPage: page,
        OPS,
        options: { textExpansionPt: 0 },
      }));
      page.cleanup();
    }
  });
  after(async () => {
    await close();
  });

  it("reads the eighteen captions of the document", () => {
    // Caption 8 is found but never anchored; see the page-5 test.
    const numbers = survey.flatMap((entry) => entry.captions);
    assert.deepEqual(
      [...numbers].map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    );
  });

  it("accepts eighteen regions on the eight pages that carry figure art", () => {
    assert.deepEqual(
      survey.map((entry) => entry.accepted.length),
      [0, 1, 3, 2, 3, 1, 0, 0, 2, 3, 3, 0, 0, 0],
    );
    const total = survey.reduce((sum, entry) => sum + entry.accepted.length, 0);
    // 14 before round 22: page 6 produced nothing, page 5 one of its two bands,
    // and page 10 two of its three figures. 17 before round 23: figure 8 on page
    // 5 was chained into the figure 7 slab and had no region of its own.
    assert.equal(total, 18);
  });

  it("keeps every accepted region inside the page", () => {
    for (const entry of regionEvidence) {
      const [px1, py1, px2, py2] = entry.pageRect;
      for (const region of entry.regions) {
        const [x1, y1, x2, y2] = region.rect;
        assert.ok(x1 >= px1 - 1e-6 && x2 <= px2 + 1e-6, `page ${entry.page} x ${x1}..${x2}`);
        assert.ok(y1 >= py1 - 1e-6 && y2 <= py2 + 1e-6, `page ${entry.page} y ${y1}..${y2}`);
      }
    }
  });

  it("recovers the three pages whose frames bleed past the trim", () => {
    // Page 2 figure 1 is a table inside a box drawn [270.9, 431.1, 976, 787.8]:
    // 364 pt of it off the right edge, 4 pt below the bottom. Discarded whole,
    // the page fell back to a 202 x 38 pt fragment of the artwork. Clipped it
    // still reached from the left column to the trim, so as *extent* it gave a
    // 341 pt wide band of area ratio 0.1002; as evidence only it leaves the
    // artwork union [346.83, 668.82, 548.97, 707], and the 20.2 pt of rotated
    // axis title the text rule pulls in on its left, ratio 0.0176.
    assert.deepEqual(survey[1].accepted, [
      { rect: [326.63, 82.36, 549.64, 133.56], caption: "1", kind: "path", confidence: 0.8, pageAreaRatio: 0.0236 },
    ]);
    // Page 5: a 150 pt-tall clip box at [-43.36, 488.5, 835.01, 807.89] chained
    // the three figures into one cluster of page area ratio 0.97 and bridged the
    // 28.29 pt gutter between figure 7 and figure 8. Excluded from extent, each
    // figure keeps its own ink plus 4-way figure labels: figure 7, figure 8, figure 9.
    assert.deepEqual(
      survey[4].accepted.map((region) => region.rect),
      [
        [55.1, 84.98, 293.67, 170.58],
        [321.96, 84.24, 553.76, 199.4],
        [328.32, 250.6, 547.53, 332.77],
      ],
    );
    assert.deepEqual(survey[4].accepted.map((region) => region.caption), ["7", "8", "9"]);
    // Page 6 produced nothing at all before round 22: now includes the FastStore /
    // BufferStore / StableStore column headers at the top of the diagram.
    assert.deepEqual(
      survey[5].accepted.map((region) => region.rect),
      [[364.13, 83.05, 552.47, 170.48]],
    );
  });

  it("keeps page 5 as three figures instead of two page-wide bands", () => {
    // With the frame out of the union nothing is chained across the gutter, so
    // the seam rule has nothing to cut here: splits fall from 2 to 0, and
    // caption 8 - the only caption in the document without a region of its own
    // before round 23 - is bound to the figure it names.
    assert.equal(survey[4].pathClusterSplits, 0);
    assert.deepEqual(survey[4].uncoveredCaptions, []);
    const bands = regionEvidence[4].regions;
    const gutter = Math.round((survey[4].accepted[1].rect[0] - survey[4].accepted[0].rect[2]) * 100) / 100;
    assert.equal(gutter, 28.29, "figure 7 to figure 8 gutter");
    for (const region of bands) {
      // 244.8 pt is 40 % of the 612 pt page: a figure band of one column, not a
      // page-wide slab. Before round 23 both bands measured the full 612 pt.
      const width = region.rect[2] - region.rect[0];
      assert.ok(width < 244.8, `page 5 figure ${region.captionNumber} ${round2(region.rect)} is figure-sized`);
      // A caption row interior to a region means two figures met inside it.
      assert.deepEqual(findInteriorCaptionRows(region.rect, regionEvidence[4].captions), []);
    }
  });

  it("links page 10 figure 13 across the 30.59 pt gap above its caption", () => {
    const got = survey[9].accepted.find((region) => region.caption === "13");
    assert.ok(got, "page 10 accepts a region for figure 13");
    assert.deepEqual(got.rect, [53.58, 83.68, 562.69, 153.49]);
    assert.equal(got.kind, "form");
    assert.equal(got.confidence, 0.9);
    // Six 80.7 x 51.9 pt panels, union [56.04, 656.05, 562.69, 708.32], with the
    // caption row [53.8, 616.5, 559.73, 625.46] under them: 30.59 pt of gap, past
    // `maxCaptionGapPt` (26 pt) but inside the allowance a 505.93 pt wide caption
    // row buys itself, 26 + 6 x 505.93 / 612 = 30.96 pt.
    const gap = 656.05 - 625.46;
    assert.ok(gap > DEFAULT_DETECTOR_OPTIONS.maxCaptionGapPt, `gap ${gap} exceeds the base 26 pt`);
    const allowance =
      DEFAULT_DETECTOR_OPTIONS.maxCaptionGapPt +
      (DEFAULT_DETECTOR_OPTIONS.captionGapWidthAllowanceFactor * 505.93) / 612;
    assert.ok(gap <= allowance, `gap ${gap} inside allowance ${allowance.toFixed(2)}`);
  });

  it("still rejects the page 10 artwork box on aspect, at maxAspect 8", () => {
    // The path cluster of the same figure is 506.65 x 52.27 pt: aspect 9.69. It
    // stays rejected, which is the point - the wide-row fix was made in the
    // caption link, not by raising `maxAspect`, which would have let this box,
    // and the page 11 rule under figure 17, compete as figures of their own.
    assert.equal(DEFAULT_DETECTOR_OPTIONS.maxAspect, 8);
    assert.equal(
      survey[9].rejectedReasons.filter((reason) => reason === "extreme-aspect").length,
      1,
      "page 10 keeps exactly one extreme-aspect rejection",
    );
  });

  it("grows fifteen borders onto the text the figure is drawn with", () => {
    assert.deepEqual(
      survey.map((entry) => entry.textExpandedRegions),
      [0, 1, 2, 1, 2, 1, 0, 0, 2, 3, 3, 0, 0, 0],
    );
    const grown = [
      [2, "1", 346.83, 326.63],
      [3, "2", 60.71, 59.54],
      [3, "4", 324.87, 323.57],
      [4, "5", 56.04, 55.13],
      [5, "9", 340.76, 328.32],
      [9, "11", 56.04, 55.22],
      [10, "13", 56.04, 53.58],
      [10, "14", 56.04, 55.03],
      [10, "15", 317.96, 316.93],
      [11, "16", 56.04, 54.86],
      [11, "17", 320.2, 319.27],
      [11, "18", 320.2, 318.21],
    ];
    for (const [pageNumber, captionNumber, ctlLeft, grownLeft] of grown) {
      const region = regionEvidence[pageNumber - 1].regions.find(
        (candidate) => candidate.captionNumber === captionNumber,
      );
      const unexpanded = control.get(pageNumber).regions.find(
        (candidate) => candidate.captionNumber === captionNumber,
      );
      assert.ok(region && unexpanded, `page ${pageNumber} figure ${captionNumber} in both runs`);
      assert.equal(round2(unexpanded.rect)[0], ctlLeft, `page ${pageNumber} figure ${captionNumber} control left`);
      assert.equal(round2(region.rect)[0], grownLeft, `page ${pageNumber} figure ${captionNumber} grown left`);
    }
  });

  it("switches text growth off without moving the accepted caption set", () => {
    for (const [pageNumber, result] of control) {
      assert.equal(result.diagnostics.textExpandedRegions, 0, `page ${pageNumber} control growth`);
      const baseline = survey[pageNumber - 1];
      assert.deepEqual(
        result.regions.map((region) => region.captionNumber),
        baseline.accepted.map((region) => region.caption),
        `page ${pageNumber} control region set`,
      );
    }
  });

  it("grows nothing across a caption row it is already bound to", () => {
    for (const entry of regionEvidence) {
      for (const region of entry.regions) {
        for (const captionRect of region.captionRects) {
          const overlaps =
            captionRect[0] < region.rect[2] &&
            region.rect[0] < captionRect[2] &&
            captionRect[1] < region.rect[3] &&
            region.rect[1] < captionRect[3];
          assert.equal(overlaps, false, `page ${entry.page} caption ${region.captionNumber} inside region`);
        }
      }
    }
  });

  it("leaves the six caption-free pages empty", () => {
    for (const pageNumber of [1, 7, 8, 12, 13, 14]) {
      const entry = survey[pageNumber - 1];
      assert.deepEqual(entry.captions, [], `page ${pageNumber} captions`);
      assert.deepEqual(entry.accepted, [], `page ${pageNumber} regions`);
    }
  });

  it("writes the survey for the FluidKV report", async () => {
    const fs = await import("node:fs/promises");
    const file = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "reports",
      "fluidkv-detection.json",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(survey, null, 2)}\n`);
    assert.equal(survey.length, 14);
  });
});
