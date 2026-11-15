import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { overlayGeometry, toViewportRect } from "../../src/core/viewport.js";
import { FIXTURE_JSON, openFixture, readJson } from "./helpers/doc.mjs";

const FIG2 = [54, 617.946, 294.1272, 720.0001];

describe("viewport: user space to CSS pixels", () => {
  let doc;
  let close;

  before(async () => {
    ({ doc, close } = await openFixture());
  });
  after(async () => {
    await close();
  });

  it("matches the python oracle's top-left box at scale 1", async () => {
    const fixture = await readJson(FIXTURE_JSON);
    const page = await doc.getPage(fixture.page_number);
    const viewport = page.getViewport({ scale: 1 });
    const got = toViewportRect(FIG2, viewport);
    const want = fixture.xobjects[0].bbox_page_top_left;
    got.forEach((value, i) => assert.ok(Math.abs(value - want[i]) <= 2, `corner ${i}: ${got} vs ${want}`));
  });

  it("scales linearly", async () => {
    const page = await doc.getPage(5);
    const base = toViewportRect(FIG2, page.getViewport({ scale: 1 }));
    const doubled = toViewportRect(FIG2, page.getViewport({ scale: 2 }));
    assert.ok(Math.abs(doubled[0] - base[0] * 2) < 1e-6);
    assert.ok(Math.abs(doubled[2] - base[2] * 2) < 1e-6);
  });

  it("handles the page's own /Rotate", async () => {
    const page = await doc.getPage(5);
    const straight = page.getViewport({ scale: 1 });
    const rotated = page.getViewport({ scale: 1, rotation: 90 });
    assert.equal(rotated.width, straight.height);
    assert.equal(rotated.height, straight.width);
    const box = toViewportRect(FIG2, rotated);
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    assert.ok(Math.abs(width - (FIG2[3] - FIG2[1])) < 1e-3, "width becomes the old height");
    assert.ok(Math.abs(height - (FIG2[2] - FIG2[0])) < 1e-3, "height becomes the old width");
    assert.ok(box[0] >= 0 && box[2] <= rotated.width + 1e-6, "stays inside the painted page");
  });

  it("handles all four rotation quadrants without flipping the rect", async () => {
    const page = await doc.getPage(5);
    for (const rotation of [90, 180, 270]) {
      const viewport = page.getViewport({ scale: 1, rotation });
      const box = toViewportRect(FIG2, viewport);
      assert.ok(box[2] > box[0] && box[3] > box[1], `rotation ${rotation} stays ordered`);
      assert.ok(box[0] >= -1e-6 && box[1] >= -1e-6, `rotation ${rotation} stays non-negative`);
      assert.ok(box[2] <= viewport.width + 1e-6 && box[3] <= viewport.height + 1e-6);
    }
  });

  it("handles a CropBox offset (non-zero MediaBox origin)", () => {
    // CropBox [50,60,500,700] at scale 2: top-left of the crop maps to (0,0).
    const viewport = {
      width: 900,
      height: 1280,
      scale: 2,
      transform: [2, 0, 0, -2, -100, 1400],
      convertToViewportPoint(x, y) {
        const [a, b, c, d, e, f] = this.transform;
        return [a * x + c * y + e, b * x + d * y + f];
      },
    };
    assert.deepEqual(toViewportRect([50, 690, 100, 700], viewport), [0, 0, 100, 20]);
    assert.deepEqual(toViewportRect([450, 60, 500, 70], viewport), [800, 1260, 900, 1280]);
  });

  it("falls back to the viewport transform matrix", async () => {
    const page = await doc.getPage(5);
    const viewport = page.getViewport({ scale: 1 });
    const matrixOnly = { width: viewport.width, height: viewport.height, transform: viewport.transform };
    assert.deepEqual(toViewportRect(FIG2, viewport), toViewportRect(FIG2, matrixOnly));
  });

  it("throws instead of guessing when the viewport is missing", () => {
    assert.throws(() => toViewportRect(FIG2, null), TypeError);
  });
});

describe("viewport: overlay geometry", () => {
  let doc;
  let close;

  before(async () => {
    ({ doc, close } = await openFixture());
  });
  after(async () => {
    await close();
  });

  it("sizes the raster buffer at scale * devicePixelRatio", async () => {
    const page = await doc.getPage(5);
    const viewport = page.getViewport({ scale: 1 });
    const geo = overlayGeometry({ region: FIG2, viewport, padViewport: 1.6, deviceScale: 3 });
    assert.equal(geo.renderScale, 3);
    assert.equal(geo.canvasWidth, 730);
    assert.equal(geo.canvasHeight, 316);
    assert.deepEqual(geo.renderTransform, [1, 0, 0, 1, -geo.left * 3, -geo.top * 3]);
  });

  it("keeps the CSS box inside the painted page", async () => {
    const page = await doc.getPage(5);
    const viewport = page.getViewport({ scale: 1 });
    const edge = [0, 780, 120, 792];
    const geo = overlayGeometry({ region: edge, viewport, padViewport: 10, deviceScale: 1 });
    assert.equal(geo.left, 0);
    assert.equal(geo.top, 0);
    assert.ok(geo.width <= viewport.width);
    assert.ok(geo.height <= viewport.height);
  });

  it("tracks the zoom level", async () => {
    const page = await doc.getPage(5);
    for (const [scale, dpr] of [[1, 1], [1.5, 1], [2, 1], [1, 2]]) {
      const viewport = page.getViewport({ scale });
      const geo = overlayGeometry({ region: FIG2, viewport, padViewport: 1.6, deviceScale: dpr });
      // padViewport is CSS pixels, so it does not grow with the zoom level.
      const expectedWidth = (FIG2[2] - FIG2[0]) * scale + 3.2;
      assert.ok(Math.abs(geo.width - expectedWidth) < 1e-6, `scale ${scale}`);
      assert.equal(geo.canvasWidth, Math.ceil(geo.width * dpr));
      assert.equal(geo.renderScale, scale * dpr);
    }
  });
});
