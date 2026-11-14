/**
 * Second fixture: "Flash-Level Asynchronous Execution for In-Storage LSM-Tree
 * Operations" — an 18-page ACM two-column paper with no StructTreeRoot. The
 * region borders below were cross-checked against MuPDF render ground truth
 * (round 18); the caption-intrusion tolerance and the absorption of
 * area-rejected placements exist because of this document. All rects are page
 * top-left coordinates.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { detectPageRegions } from "../../src/core/index.js";
import { findInteriorCaptionRows } from "../../src/core/detector.js";
import { OPS, REPO_ROOT, openFixture } from "./helpers/doc.mjs";

const FLASH_PDF = path.join(
  REPO_ROOT,
  "Flash-Level Asynchronous Execution for In-Storage LSM-Tree Operations.pdf",
);

describe("flash-level fixture: whole document survey", () => {
  let doc;
  let close;
  let survey;
  /** Off-page drops and interior-caption splits per page, kept out of the report shape. */
  let pathCounters;
  /** Accepted regions in user space, for the interior-caption-row guard. */
  let regionEvidence;

  before(async () => {
    ({ doc, close } = await openFixture(FLASH_PDF));
    survey = [];
    pathCounters = [];
    regionEvidence = [];
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
      survey.push({
        page: pageNumber,
        captions: captionNumbers,
        accepted: result.regions.map((region) => ({
          rect: toPageTopLeft(region.rect),
          captionNumber: region.captionNumber,
          kind: region.sourceKinds.join("+"),
          confidence: region.confidence,
          pageAreaRatio: region.pageAreaRatio,
        })),
        uncoveredCaptions: captionNumbers.filter(
          (number) => !result.regions.some((region) => region.captionNumber === number),
        ),
      });
      pathCounters.push({
        offPage: result.diagnostics.pathBoxesOffPage,
        splits: result.diagnostics.pathClusterSplits,
        expanded: result.diagnostics.textExpandedRegions,
      });
      regionEvidence.push({
        page: pageNumber,
        regions: result.regions.map((region) => region.rect),
        captions: result.captions,
      });
      page.cleanup();
    }
  });
  after(async () => {
    await close();
  });

  it("binds every one of the ten figure captions to a region", () => {
    const numbers = survey.flatMap((entry) => entry.captions);
    assert.deepEqual(
      [...numbers].map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    const uncovered = survey.flatMap((entry) =>
      entry.uncoveredCaptions.map((number) => `page ${entry.page} Figure ${number}`),
    );
    assert.deepEqual(uncovered, []);
  });

  it("accepts exactly one region per figure, ten in total", () => {
    const total = survey.reduce((sum, entry) => sum + entry.accepted.length, 0);
    assert.equal(total, 10);
  });

  it("labels the page-4 region with caption 3 despite the bbox intrusion", () => {
    // pdf.js reports the caption row down to 4.6 pt inside the figure bottom;
    // linking must still bind it and the confidence must clear 0.8.
    const region = survey[3].accepted.find((entry) => entry.captionNumber === "3");
    assert.ok(region, "page 4 has a region bound to Figure 3");
    assert.ok(region.confidence >= 0.8, `confidence ${region.confidence}`);
  });

  it("labels the page-12 region with caption 10 despite the bbox intrusion", () => {
    const region = survey[11].accepted.find((entry) => entry.captionNumber === "10");
    assert.ok(region, "page 12 has a region bound to Figure 10");
    assert.ok(region.confidence >= 0.8, `confidence ${region.confidence}`);
  });

  it("clips the page-1 region at the form /BBox instead of the raw image row", () => {
    // Two 930x616 images used to lift the region top to 239.28 although they
    // are painted inside a form whose /BBox ends at 252; MuPDF ground truth
    // puts the ink top at 255.75, so the old border hung ~13 pt of clipped
    // white space above the figure. Since the clip fix the region stops at
    // the form border 252 — tighter than the previous "top <= 241" bound and
    // matching the rendered ink.
    const regions = survey[0].accepted;
    assert.equal(regions.length, 1);
    assert.ok(
      Math.abs(regions[0].rect[1] - 252) <= 0.5,
      `region top ${regions[0].rect[1]} stops at the form clip`,
    );
  });

  it("clips the page-8 Figure 6 region to the form's own /BBox", async () => {
    // 16 thin coloured legend bars inside the Figure 6 form are drawn at
    // local x0 = -68, outside the form's own /BBox, so a conforming renderer
    // never paints them (MuPDF shows no ink left of x = 58.9). Unclipped,
    // their union dragged the left edge to 14.32; the clip must pull it to
    // the form border 58.76 with the other edges untouched. The text run that
    // the border now grows over is asserted separately, so the clip is checked
    // with the growth turned off.
    const page = await doc.getPage(8);
    const unexpanded = await detectPageRegions({
      pdfPage: page,
      OPS,
      options: { textExpansionPt: 0 },
    });
    const clipped = unexpanded.regions.find((region) => region.captionNumber === "6");
    assert.ok(clipped, "page 8 has a region bound to Figure 6 without text growth");
    const clipLeft = page.getViewport({ scale: 1 }).convertToViewportPoint(clipped.rect[0], clipped.rect[3])[0];
    page.cleanup();
    assert.ok(
      Math.abs(clipLeft - 58.76) <= 0.05,
      `painted border ${clipLeft.toFixed(2)} stops on the form clip`,
    );

    const region = survey[7].accepted.find((entry) => entry.captionNumber === "6");
    assert.ok(region, "page 8 has a region bound to Figure 6");
    assert.ok(
      region.rect[0] >= 43 && region.rect[0] <= 44,
      `left edge ${region.rect[0]} reaches the "16K" tick label, not the clipped bars at 14.32`,
    );
    assert.deepEqual(region.rect.slice(1), [72, 286.88, 169.12], "other edges untouched");
  });

  it("keeps the page-12 region at its ground-truth border within 2 pt", () => {
    const region = survey[11].accepted.find((entry) => entry.captionNumber === "10");
    const expected = [54, 72, 557.93, 243.64];
    for (let corner = 0; corner < 4; corner++) {
      const diff = Math.abs(region.rect[corner] - expected[corner]);
      assert.ok(diff <= 2, `page 12 corner ${corner}: ${region.rect[corner]} vs ${expected[corner]}`);
    }
  });

  it("never returns a region larger than a third of the page", () => {
    for (const entry of survey) {
      for (const region of entry.accepted) {
        assert.ok(
          region.pageAreaRatio <= 0.35,
          `page ${entry.page} region ${region.rect} covers ${region.pageAreaRatio}`,
        );
      }
    }
  });

  it("drops no path box as off-page and splits no cluster", () => {
    // Round 21 added the off-page filter and the interior-caption split. This
    // document has no artwork painted outside the page and no caption row
    // buried inside a path cluster, so both rules must be no-ops here: the
    // accepted borders recorded in reports/flash-detection.json are unchanged.
    const offPage = pathCounters.flatMap((c, index) =>
      c.offPage ? [`page ${index + 1} dropped ${c.offPage}`] : [],
    );
    const splits = pathCounters.flatMap((c, index) =>
      c.splits ? [`page ${index + 1} split ${c.splits}`] : [],
    );
    assert.deepEqual(offPage, []);
    assert.deepEqual(splits, []);
  });

  it("grows the two plots whose tick labels are text, and no other page", () => {
    // Page 8 figure 6 and page 10 figure 9 are the only figures on this document
    // whose axis labels are drawn as text runs outside the painted frame, at
    // 3.41 and 3.31 pt. The growth takes those two left edges over the labels,
    // 15.35 and 13.92 pt, and leaves the other sixteen pages as they were.
    const grown = pathCounters.flatMap((c, index) =>
      c.expanded ? [`page ${index + 1} grew ${c.expanded}`] : [],
    );
    assert.deepEqual(grown, ["page 8 grew 1", "page 10 grew 1"]);
  });

  it("keeps every accepted border pinned against the ground truth", () => {
    // The two left edges on pages 8 and 10 are the text expansion: the tick
    // labels of those plots are text, not paint, and sit 15.35 pt and 13.92 pt
    // left of the painted border.
    const pinned = [
      [1, "1", [317.88, 252, 558, 350.59]],
      [3, "2", [59.96, 247.48, 285.68, 392.42]],
      [4, "3", [317.88, 72, 558, 161.44]],
      [5, "4", [54, 203.94, 294.12, 369.41]],
      [6, "5", [317.88, 283.59, 558, 448.88]],
      [8, "6", [43.41, 72, 286.88, 169.12]],
      [9, "7", [317.88, 72, 558, 154.52]],
      [10, "8", [58.76, 69.16, 286.87, 169.38]],
      [10, "9", [303.96, 143.23, 558, 277.86]],
      [12, "10", [54, 72, 558.01, 243.66]],
    ];
    const got = survey.flatMap((entry) =>
      entry.accepted.map((region) => [entry.page, region.captionNumber, region.rect]),
    );
    assert.deepEqual(got, pinned);
  });

  it("finds no caption row inside any accepted region", () => {
    // The guard for the split rule: had a caption sat inside one of these
    // regions, the cluster would have been cut in two and the border above
    // would have moved.
    for (const entry of regionEvidence) {
      for (const rect of entry.regions) {
        assert.deepEqual(findInteriorCaptionRows(rect, entry.captions), [], `page ${entry.page}`);
      }
    }
  });
});
