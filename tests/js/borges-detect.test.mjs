/**
 * Third fixture: "Borges: A Low-Latency Distributed Shared Log on a CXL
 * Memory/SSD Hybrid" — an 18-page IEEE paper with no StructTreeRoot, whose
 * figures are pure vector art. Page 12 is the reason round 21 exists: two
 * stacked figure bands sit 13.19 pt apart (below the 18.02 pt merge tolerance)
 * and 15 degenerate paths are painted down to y0 = -13846.3, so the whole page
 * chained into one cluster that the page-sized gate threw away and the seven
 * captions there stayed uncovered. All rects in the assertions are page top-left
 * coordinates unless stated otherwise.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { detectPageRegions } from "../../src/core/index.js";
import { findInteriorCaptionRows } from "../../src/core/detector.js";
import { OPS, REPO_ROOT, openFixture } from "./helpers/doc.mjs";

const BORGES_PDF = path.join(
  REPO_ROOT,
  "Borges_ A Low-Latency Distributed Shared Log on a CXL Memory_SSD Hybrid.pdf",
);

describe("borges fixture: whole document survey", () => {
  let doc;
  let close;
  let survey;
  /** Off-page drops and interior-caption splits per page. */
  let pathCounters;
  /** Accepted regions in user space, for the interior-caption-row guard. */
  let regionEvidence;

  before(async () => {
    ({ doc, close } = await openFixture(BORGES_PDF));
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
        pathBoxesOffPage: diagnostics.pathBoxesOffPage,
        pathClusterSplits: diagnostics.pathClusterSplits,
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
      pathCounters.push({
        offPage: diagnostics.pathBoxesOffPage,
        splits: diagnostics.pathClusterSplits,
        expanded: diagnostics.textExpandedRegions,
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

  it("reads the fourteen captions of the document", () => {
    const numbers = survey.flatMap((entry) => entry.captions);
    assert.deepEqual(
      [...numbers].map(Number).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    );
  });

  it("accepts one figure on every page that has a reachable caption", () => {
    assert.deepEqual(
      survey.map((entry) => entry.accepted.length),
      [0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0],
    );
  });

  it("drops the fifteen degenerate page-12 paths as off-page", () => {
    // 11.4 x 14455 pt boxes: 4.2 % of their own area on the page. Without the
    // filter the cluster covers the body text between the bands and is rejected
    // `page-sized`, so page 12 yields nothing at all.
    const page12 = survey[11];
    assert.equal(page12.pathBoxesOffPage, 15, "15 boxes dropped");
    assert.equal(page12.pathBoxes, 72, "page 12 carries 72 raw vector boxes");
    assert.equal(page12.pathClusters, 2, "the two figure bands end up as two clusters");
  });

  it("splits the page-12 cluster once, at the caption row between the bands", () => {
    // The 13.19 pt between the figure 6-9 and figure 10-12 bands is below the
    // 18.02 pt merge tolerance; the caption rows at y 634.669-644.632 and
    // y 544.819-554.782 (user space) are the seam evidence.
    assert.equal(survey[11].pathClusterSplits, 1);
  });

  it("recovers exactly the two page-12 figure bands", () => {
    const got = survey[11].accepted;
    assert.equal(got.length, 2, `page 12 accepted ${got.length}`);
    assert.deepEqual(got.map((region) => region.caption), ["6", "10"]);
    assert.deepEqual(got.map((region) => region.kind), ["path", "path"]);
    for (const region of got) {
      assert.ok(region.confidence >= 0.85, `confidence ${region.confidence}`);
      assert.ok(region.pageAreaRatio <= 0.35, `covers ${region.pageAreaRatio}`);
    }
    // Page top-left. In user space these are [54, 644.63, 557.99, 720] and
    // [54, 554.42, 558, 631.08]: the two bands, each ending just above its own
    // caption row, neither one reaching into the body text between them. The
    // upper band's lower edge sits on the caption box top (644.63) rather than
    // 0.36 pt inside it, because a member that overlapped the caption slab now
    // keeps only the part above the slab (`splitMembersAtSlab`).
    assert.deepEqual(got.map((region) => region.rect), [
      [54, 72, 557.99, 147.37],
      [54, 160.92, 558, 237.58],
    ]);
    // Same two bands in PDF user space, the numbers the rule was tuned against.
    assert.deepEqual(
      regionEvidence[11].regions.map((rect) => rect.map((value) => Math.round(value * 10) / 10)),
      [
        [54, 644.6, 558, 720],
        [54, 554.4, 558, 631.1],
      ],
    );
  });

  it("keeps the page-12 bands out of the caption rows below them", () => {
    // Figures 7-9 and 11-12 are sub-captions of the two recovered panels: the
    // panel is bound to the first caption of its group, and none of the seven
    // caption boxes may sit inside the region painted over it.
    const page12 = regionEvidence[11];
    for (const rect of page12.regions) {
      for (const caption of page12.captions) {
        const inside =
          caption.rect[1] > rect[1] &&
          caption.rect[3] < rect[3] &&
          caption.rect[0] >= rect[0] &&
          caption.rect[2] <= rect[2];
        assert.equal(inside, false, `caption ${caption.number} inside region ${rect}`);
      }
      assert.deepEqual(findInteriorCaptionRows(rect, page12.captions), []);
    }
    assert.deepEqual(survey[11].uncoveredCaptions, ["7", "8", "9", "11", "12"]);
  });

  it("keeps the sixteen tiny page-12 forms rejected on area alone", () => {
    // The page's inline formulas and rules must not be pulled in by the split:
    // the only reason recorded for page 12 is still `below-min-area`.
    assert.deepEqual([...new Set(survey[11].rejectedReasons)], ["below-min-area"]);
    assert.equal(survey[11].rejectedReasons.length, 16);
  });

  it("leaves page 13 with its two side-by-side figures untouched", () => {
    // 37 forms and 51 paths, two clusters, no off-page box and no split: the
    // rules must not move a page that was already correct.
    const page13 = survey[12];
    assert.equal(page13.pathBoxesOffPage, 0);
    assert.equal(page13.pathClusterSplits, 0);
    // Page 13 expands figure 13 upward to capture the full rotated Y-axis label.
    assert.deepEqual(page13.accepted, [
      { rect: [54, 59.89, 294.05, 127.62], caption: "13", kind: "path", confidence: 0.9, pageAreaRatio: 0.0335 },
      { rect: [317.96, 72, 558, 166.15], caption: "14", kind: "path", confidence: 0.9, pageAreaRatio: 0.0466 },
    ]);
    assert.deepEqual(page13.uncoveredCaptions, []);
  });

  it("fires no border rule outside the pages it was measured on", () => {
    const offPage = pathCounters.flatMap((c, index) =>
      c.offPage && index !== 11 ? [`page ${index + 1} dropped ${c.offPage}`] : [],
    );
    const splits = pathCounters.flatMap((c, index) =>
      c.splits && index !== 11 ? [`page ${index + 1} split ${c.splits}`] : [],
    );
    // 4-way clear-sight expansion pulls diagram headers ("Data plane",
    // "Control plane") on page 2 and diagram labels on page 8 into their figures.
    const grown = pathCounters.flatMap((c, index) =>
      c.expanded ? [`page ${index + 1} grew ${c.expanded}`] : [],
    );
    assert.deepEqual(offPage, []);
    assert.deepEqual(splits, []);
    assert.deepEqual(grown, ["page 2 grew 1", "page 8 grew 1", "page 13 grew 1"]);
  });

  it("finds no caption row left inside any accepted region", () => {
    for (const entry of regionEvidence) {
      for (const rect of entry.regions) {
        assert.deepEqual(findInteriorCaptionRows(rect, entry.captions), [], `page ${entry.page}`);
      }
    }
  });

  it("writes the survey for the Borges report", async () => {
    const fs = await import("node:fs/promises");
    const file = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "reports",
      "borges-detection.json",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(survey, null, 2)}\n`);
    assert.equal(survey.length, 18);
  });
});
