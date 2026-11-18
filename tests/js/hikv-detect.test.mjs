/**
 * Fifth fixture: "HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory
 * Systems" — a 15-page USENIX paper whose figures 7, 8 and 9 are grids and
 * rows of equal-size plot panels. Before the panel-grid rule every panel was
 * its own cluster: each was 0.0127-0.0140 of the page, under the 0.015
 * anchored-area gate, and the figure captions sat 46.7-51.1 pt below the
 * artwork, past the 27.6 pt caption-gap allowance. Figure 7 (six panels in
 * 3x2, page 9) and figure 8 (three panels, page 10) went entirely unpainted;
 * figure 9 (three panels, page 10) painted only its middle panel, which was
 * stolen by figure 8's caption sitting 23.85 pt above that row.
 * `mergePanelGrids` chains small equal-size axis-aligned panels within 60 pt,
 * so each grid becomes one candidate above the area gate. The 80.55 pt row
 * gap between figures 8 and 9 - caption 8 is set inside it - stays unbridged.
 * All rects in the assertions are page top-left coordinates.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { detectPageRegions } from "../../src/core/index.js";
import { OPS, REPO_ROOT, openFixture } from "./helpers/doc.mjs";

const HIKV_PDF = path.join(
  REPO_ROOT,
  "HiKV - A Hybrid Index Key-Value Store for DRAM-NVM Memory Systems.pdf",
);

const round2 = (rect) => rect.map((value) => Math.round(value * 100) / 100);

describe("hikv fixture: panel-grid figures", () => {
  let doc;
  let close;
  /** page -> { accepted, smallPathRejects } in page top-left coordinates. */
  let pages;

  before(async () => {
    ({ doc, close } = await openFixture(HIKV_PDF));
    pages = new Map();
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const result = await detectPageRegions({ pdfPage: page, OPS });
      const viewport = page.getViewport({ scale: 1 });
      const toPageTopLeft = (rect) => {
        const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[3]);
        const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[1]);
        return round2([x1, y1, x2, y2]);
      };
      pages.set(pageNumber, {
        accepted: result.regions.map((region) => ({
          rect: toPageTopLeft(region.rect),
          caption: region.captionNumber,
          confidence: region.confidence,
        })),
        smallPathRejects: result.rejected
          .filter((entry) => entry.reason === "path-below-area-threshold")
          .map((entry) => toPageTopLeft(entry.rect)),
      });
    }
  });
  after(async () => {
    await close();
  });

  it("paints figure 7 as one grid of six panels with axis and subfigure labels", () => {
    const { accepted, smallPathRejects } = pages.get(9);
    assert.deepEqual(accepted, [
      { rect: [88.37, 76.72, 523.14, 280.76], caption: null, confidence: 0.65 },
    ]);
    assert.deepEqual(smallPathRejects, []);
  });

  it("paints figures 8 and 9 as their two panel rows, unbridged and rightly captioned", () => {
    const { accepted, smallPathRejects } = pages.get(10);
    assert.deepEqual(accepted, [
      { rect: [89.01, 81.74, 517.61, 172.53], caption: "8", confidence: 0.85 },
      { rect: [89.01, 218.85, 516.03, 309.64], caption: "9", confidence: 0.85 },
    ]);
    assert.deepEqual(smallPathRejects, []);
  });

  it("keeps the single-figure pages exactly as before", () => {
    for (const pageNumber of [2, 7, 12, 13, 14, 15]) {
      assert.deepEqual(pages.get(pageNumber).accepted, [], `page ${pageNumber}`);
    }
    const figureCounts = new Map([
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [8, 2],
      [11, 4],
    ]);
    for (const [pageNumber, count] of figureCounts) {
      assert.equal(pages.get(pageNumber).accepted.length, count, `page ${pageNumber}`);
    }
    // 4-way label expansion pulls Y-axis ticks, X-axis ticks, and top legend labels in.
    assert.deepEqual(pages.get(8).accepted[0].rect, [108.36, 71.74, 292.07, 171.88]);
    assert.deepEqual(pages.get(11).accepted[1].rect, [325.97, 191.02, 516.1, 286.64]);
    assert.equal(pages.get(11).accepted[1].caption, "12");
  });

  it("still rejects the title-page logo panel, which has no peers", () => {
    assert.deepEqual(pages.get(1).smallPathRejects, [[143.41, 147.17, 270, 186.97]]);
  });
});
