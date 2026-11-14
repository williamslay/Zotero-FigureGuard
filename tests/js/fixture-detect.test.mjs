/**
 * A1 acceptance evidence: the automatic detector, run against the real fixture
 * PDF, must reproduce the Python oracle's page-5 boxes and must not invent
 * regions for body text, columns or captions.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { toViewportRect } from "../../src/core/viewport.js";
import { detectPageRegions } from "../../src/core/index.js";
import { findInteriorCaptionRows } from "../../src/core/detector.js";
import { OPS, FIXTURE_JSON, openFixture, readJson } from "./helpers/doc.mjs";

const PAGE = [0, 0, 612, 792];

describe("A1 fixture: page 5 detection", () => {
  let doc;
  let close;
  let result;
  let viewport;
  let fixture;

  before(async () => {
    ({ doc, close } = await openFixture());
    fixture = await readJson(FIXTURE_JSON);
    const page = await doc.getPage(fixture.page_number);
    viewport = page.getViewport({ scale: 1 });
    result = await detectPageRegions({ pdfPage: page, OPS });
  });
  after(async () => {
    await close();
  });

  it("finds exactly two regions", () => {
    assert.equal(result.regions.length, 2);
  });

  it("matches the oracle boxes within 2 pt", () => {
    const got = result.regions.map((region) => toViewportRect(region.rect, viewport));
    const want = fixture.xobjects.map((xobj) => xobj.bbox_page_top_left);
    assert.equal(got.length, want.length);
    for (const [index, expected] of want.entries()) {
      for (let corner = 0; corner < 4; corner++) {
        const diff = Math.abs(got[index][corner] - expected[corner]);
        assert.ok(diff <= 2, `figure ${index + 2} corner ${corner}: ${got[index]} vs ${expected}`);
      }
    }
  });

  it("grows no border from text on the oracle page", () => {
    // The oracle boxes are the reference here, so the text-driven width growth
    // must leave page 5's accepted borders exactly where they were.
    assert.equal(result.diagnostics.textExpandedRegions, 0);
  });

  it("labels the regions with the caption numbers below them", () => {
    assert.deepEqual(
      result.regions.map((region) => region.captionNumber),
      ["2", "3"],
    );
  });

  it("does not treat the whole page or the two-column body as a region", () => {
    for (const region of result.regions) {
      assert.ok(region.pageAreaRatio < 0.25, `region ${region.rect} covers ${region.pageAreaRatio}`);
    }
  });

  it("keeps captions out of the covered regions", () => {
    const captions = result.captions.filter((caption) => ["2", "3"].includes(String(caption.number)));
    assert.equal(captions.length, 2);
    for (const caption of captions) {
      for (const region of result.regions) {
        // A caption sits below its figure with a visible gap; none of the
        // region boxes may contain the caption's own text box.
        const contains =
          caption.rect[1] > region.rect[1] &&
          caption.rect[3] < region.rect[3] &&
          caption.rect[0] >= region.rect[0] &&
          caption.rect[2] <= region.rect[2];
        assert.equal(contains, false, `caption ${caption.number} inside region ${region.rect}`);
      }
    }
  });

  it("reports a confidence above the acceptance threshold for both figures", () => {
    for (const region of result.regions) {
      assert.ok(region.confidence >= 0.6);
      assert.ok(region.evidence.some((entry) => entry.startsWith("caption:")));
    }
  });
});

describe("A1 fixture: whole document survey", () => {
  let doc;
  let close;
  let survey;
  /** Off-page drops and interior-caption splits per page, kept out of the report shape. */
  let pathCounters;
  /** Accepted regions in user space, for the interior-caption-row guard. */
  let regionEvidence;

  before(async () => {
    ({ doc, close } = await openFixture());
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
      const diagnostics = result.diagnostics;
      survey.push({
        page: pageNumber,
        placements: diagnostics.placementCount,
        xobjects: diagnostics.rawPlacementCount - diagnostics.rawPathBoxCount,
        pathBoxes: diagnostics.rawPathBoxCount,
        pathClusters: diagnostics.pathBoxCount,
        captions: captionNumbers,
        accepted: result.regions.map((region) => ({
          rect: toPageTopLeft(region.rect),
          caption: region.captionNumber,
          kind: region.sourceKinds.join("+"),
          placements: region.placementCount,
          confidence: region.confidence,
          pageAreaRatio: region.pageAreaRatio,
        })),
        rejectedReasons: result.rejected.map((entry) => entry.reason),
        uncoveredCaptions: captionNumbers.filter(
          (number) => !result.regions.some((region) => region.captionNumber === number),
        ),
      });
      pathCounters.push({
        offPage: result.diagnostics.pathBoxesOffPage,
        splits: result.diagnostics.pathClusterSplits,
        textGrowth: result.diagnostics.textExpandedRegions,
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

  it("finds no region on the text-only pages", () => {
    for (const pageNumber of [2, 8, 14, 15, 16]) {
      const entry = survey[pageNumber - 1];
      assert.equal(entry.xobjects, 0, `page ${pageNumber} has no XObject evidence`);
      assert.deepEqual(entry.accepted, [], `page ${pageNumber}`);
    }
  });

  it("keeps the marginal vector marks on a body-text page unaccepted", () => {
    // Page 4 carries a few small decorative vector marks and no figure. Their
    // clusters stay far below the area gate, so the page still yields nothing.
    const page4 = survey[3];
    assert.equal(page4.xobjects, 0);
    assert.ok(page4.pathBoxes > 0, "page 4 does carry raw vector marks");
    assert.deepEqual(page4.accepted, []);
  });

  it("covers every figure on the page", () => {
    const uncovered = survey.flatMap((entry) =>
      entry.uncoveredCaptions.map((number) => `page ${entry.page} Figure ${number}`),
    );
    // Pure vector art used to be invisible to the detector: page 7 draws both
    // Figure 5 and Figure 6a with fill/stroke operators only. Merged path
    // placements now carry them, so nothing is left uncovered.
    assert.deepEqual(uncovered, []);
  });

  it("never returns a region larger than a quarter of the page", () => {
    for (const entry of survey) {
      for (const region of entry.accepted) {
        assert.ok(region.pageAreaRatio <= 0.35, `page ${entry.page} region ${region.rect}`);
      }
    }
  });

  it("covers every caption that has a matching XObject placement", () => {
    const page5 = survey[4];
    assert.deepEqual(page5.uncoveredCaptions, []);
  });

  it("finds the caption that shares a baseline with the other column", () => {
    // Page 9 draws Figure 8 in the right column while the left column's body
    // text ends on the same baseline; the caption is only visible once that
    // baseline is cut into segments.
    const page9 = survey[8];
    assert.deepEqual(page9.captions, ["7", "8", "9"]);
    assert.deepEqual(
      page9.accepted.map((region) => region.caption),
      ["7", "8", "9"],
    );
    const figure8 = page9.accepted.find((region) => region.caption === "8");
    assert.ok(figure8, "Figure 8 gets an accepted region");
    assert.ok(figure8.confidence >= 0.6);
    assert.deepEqual(page9.uncoveredCaptions, []);
  });

  it("keeps the segmented caption out of its own region box", () => {
    // The Figure 8 region stops above the caption text, so the caption keeps
    // the dark theme, and it starts at the right column, not at the body text.
    const page9 = survey[8];
    const figure8 = page9.accepted.find((region) => region.caption === "8");
    assert.ok(figure8.rect[0] > 300, `region starts at ${figure8.rect[0]}`);
    assert.ok(figure8.rect[3] < 340, `region bottom ${figure8.rect[3]} stays above the caption row`);
  });

  it("matches exactly the fifteen captions of the document", () => {
    // Segmentation must not invent captions either: mid-line body text that
    // happens to start a segment would show up here as a duplicate number.
    const numbers = survey.flatMap((entry) => entry.captions);
    assert.equal(numbers.length, 15);
    assert.deepEqual(
      [...numbers].map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    );
    assert.deepEqual(
      survey.map((entry) => entry.accepted.length),
      [0, 0, 1, 0, 2, 1, 2, 0, 3, 1, 6, 1, 1, 0, 0, 0],
    );
  });

  it("keeps Figure 5 on page 7 although its forms carry no /BBox", () => {
    // Three forms without a /BBox hold 51 of the paths that draw Figure 5.
    // A bbox-less form must inherit the parent clip unchanged (pdf.js applies
    // no clip when the /BBox is missing); pushing an empty clip instead would
    // drop all 51 paths (213 placements -> 162, min evidence x0 57.46 ->
    // 320.37, 2 regions -> 1) and erase the figure. Real ink starts at 57.25.
    const page7 = survey[6];
    assert.equal(page7.accepted.length, 2, "both page-7 figures survive the clip change");
    const figure5 = page7.accepted.find((region) => region.caption === "5");
    assert.ok(figure5, "Figure 5 gets an accepted region");
    assert.ok(
      Math.abs(figure5.rect[0] - 57.46) <= 1,
      `Figure 5 left edge ${figure5.rect[0]} within 1 pt of 57.46`,
    );
  });

  it("clips the page-13 Figure 15 region at the form /BBox", () => {
    // The side-by-side figure's union used to reach 157.84 through content
    // drawn outside its form's /BBox; the rendered ink bottom is 157.0, so
    // the clipped border 157.05 is both tighter and correct.
    const page13 = survey[12];
    assert.equal(page13.accepted.length, 1);
    assert.ok(
      Math.abs(page13.accepted[0].rect[3] - 157.05) <= 0.5,
      `Figure 15 bottom ${page13.accepted[0].rect[3]} stops at the form clip`,
    );
  });

  it("drops no path box as off-page, splits no cluster, grows no border", () => {
    // Round 21 added the off-page filter and the interior-caption split; round
    // 22 added the text-driven width growth. Every figure here is drawn inside
    // the page, every caption sits below its own artwork, and every legend is
    // vector art, so all three rules must be no-ops: the accepted borders
    // recorded in reports/A1-detection.json are unchanged.
    const offPage = pathCounters.flatMap((c, index) =>
      c.offPage ? [`page ${index + 1} dropped ${c.offPage}`] : [],
    );
    const splits = pathCounters.flatMap((c, index) =>
      c.splits ? [`page ${index + 1} split ${c.splits}`] : [],
    );
    const textGrowth = pathCounters.flatMap((c, index) =>
      c.textGrowth ? [`page ${index + 1} grew ${c.textGrowth}`] : [],
    );
    assert.deepEqual(offPage, []);
    assert.deepEqual(splits, []);
    assert.deepEqual(textGrowth, []);
  });

  it("keeps every accepted border pinned against the oracle", () => {
    const pinned = [
      [3, "1", [317.88, 72, 557.99, 241.68]],
      [5, "2", [54, 72, 294.13, 174.05]],
      [5, "3", [317.88, 72, 558, 214.52]],
      [6, "4", [317.88, 72, 558, 135.12]],
      [7, "6", [320.37, 72.45, 560.49, 165.43]],
      [7, "5", [57.46, 75.19, 291.55, 305.04]],
      [9, "7", [56.55, 81.96, 555.45, 180.45]],
      [9, "8", [317.88, 235.75, 558.01, 331.51]],
      [9, "9", [317.88, 356.42, 558.01, 452.18]],
      [10, "10", [54, 72, 294.13, 167.76]],
      [11, null, [60.29, 84.35, 209.43, 163.92]],
      [11, null, [231.68, 84.35, 380.82, 163.92]],
      [11, null, [403.07, 84.35, 552.21, 163.92]],
      [11, "11", [56.49, 189.55, 555.51, 272.74]],
      [11, "12", [56.49, 320.06, 555.51, 403.24]],
      [11, "13", [341.89, 448.57, 534, 554.72]],
      [12, "14", [54, 72, 558.01, 220.24]],
      [13, "15", [54, 72, 555.52, 157.05]],
    ];
    const got = survey.flatMap((entry) =>
      entry.accepted.map((region) => [entry.page, region.caption, region.rect]),
    );
    assert.deepEqual(got, pinned);
  });

  it("finds no caption row inside any accepted region", () => {
    // The guard for the split rule: a caption buried in one of these clusters
    // would have cut the region in two and moved the border above.
    for (const entry of regionEvidence) {
      for (const rect of entry.regions) {
        assert.deepEqual(findInteriorCaptionRows(rect, entry.captions), [], `page ${entry.page}`);
      }
    }
  });

  it("writes the survey for the A1 report", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "reports", "A1-detection.json");
    await fs.writeFile(file, `${JSON.stringify(survey, null, 2)}\n`);
    assert.ok(survey.length >= 16);
  });
});
