/**
 * A2 acceptance evidence: crops rendered by pdf.js must keep the original PDF
 * colours. Checks are made against the Python-generated reference PNGs on size,
 * pixel error, semantic colour classes and ink coverage, plus a grayscale
 * negative control so a colour-management bug cannot pass on overall similarity.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import { Canvas, ImageData } from "@napi-rs/canvas";
import { OPS, FIXTURE_PDF, REPO_ROOT, openFixture } from "./helpers/doc.mjs";
import { detectPageRegions } from "../../src/core/index.js";
import { overlayGeometry } from "../../src/core/viewport.js";
import { renderRegion } from "../../src/core/render.js";
import {
  comparePng,
  nonWhiteRatio,
  readPng,
  semanticClasses,
} from "./helpers/png.mjs";

const PAD = 1.6;
const CLASSES = ["gray", "beige", "green", "yellow", "black", "colored"];

async function renderCrop(page, region, { scale = 1, deviceScale = 3, pad = PAD, rotation = 0 } = {}) {
  const viewport = page.getViewport({ scale, rotation });
  const geometry = overlayGeometry({ region, viewport, padViewport: pad, deviceScale, rotation });
  const canvas = new Canvas(geometry.canvasWidth, geometry.canvasHeight);
  await renderRegion({
    pdfPage: page,
    canvas,
    region,
    viewport,
    deviceScale,
    padViewport: pad,
    rotation,
    renderOptions: { background: "#ffffff" },
  });
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data, geometry };
}

async function renderFullPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = new Canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "#ffffff" }).promise;
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data };
}

/** The full-page pixels that sit under one overlay box. */
function windowOf(full, geometry) {
  const x = Math.floor(geometry.left);
  const y = Math.floor(geometry.top);
  const width = geometry.canvasWidth;
  const height = geometry.canvasHeight;
  const src = full.data.data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const si = ((y + row) * full.width + (x + col)) * 4;
      const di = (row * width + col) * 4;
      pixels[di] = src[si];
      pixels[di + 1] = src[si + 1];
      pixels[di + 2] = src[si + 2];
      pixels[di + 3] = 255;
    }
  }
  return { width, height, data: new ImageData(pixels, width, height) };
}

function grayscale(image) {
  const pixels = new Uint8ClampedArray(image.data.data);
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    pixels[i] = luma;
    pixels[i + 1] = luma;
    pixels[i + 2] = luma;
  }
  return { width: image.width, height: image.height, data: new ImageData(pixels, image.width, image.height) };
}

function ratios(image) {
  const counts = semanticClasses(image);
  const out = {};
  for (const key of CLASSES) out[key] = counts[key] / counts.pixels;
  return out;
}

/**
 * The page pixels under one overlay box when the page raster is `dpr` times the
 * CSS scale, i.e. the full-page render at `scale * dpr`. `dx`/`dy` shift the
 * window for the sub-pixel alignment search.
 */
function windowOfScale(full, geometry, dpr, dx = 0, dy = 0) {
  const x = Math.round(geometry.left * dpr) + dx;
  const y = Math.round(geometry.top * dpr) + dy;
  const width = geometry.canvasWidth;
  const height = geometry.canvasHeight;
  const src = full.data.data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const si = ((y + row) * full.width + (x + col)) * 4;
      const di = (row * width + col) * 4;
      pixels[di] = src[si];
      pixels[di + 1] = src[si + 1];
      pixels[di + 2] = src[si + 2];
      pixels[di + 3] = 255;
    }
  }
  return { width, height, data: new ImageData(pixels, width, height) };
}

describe("A2 fixture: original colour crops", () => {
  let doc;
  let close;
  let page;
  let regions;

  before(async () => {
    ({ doc, close } = await openFixture(FIXTURE_PDF));
    page = await doc.getPage(5);
    const detected = await detectPageRegions({ pdfPage: page, OPS });
    regions = detected.regions;
  });
  after(async () => {
    await close();
  });

  it("renders each figure at 3x within 2 px of the reference size", async () => {
    for (const [index, region] of regions.entries()) {
      const reference = await readPng(path.join(REPO_ROOT, "fixture", `figure${index + 2}-original-3x.png`));
      const crop = await renderCrop(page, region.rect);
      assert.ok(Math.abs(crop.width - reference.width) <= 2, `figure ${index + 2} width ${crop.width} vs ${reference.width}`);
      assert.ok(Math.abs(crop.height - reference.height) <= 2, `figure ${index + 2} height ${crop.height} vs ${reference.height}`);
    }
  });

  it("matches the reference pixels with mean absolute error below 8", async () => {
    for (const [index, region] of regions.entries()) {
      const reference = await readPng(path.join(REPO_ROOT, "fixture", `figure${index + 2}-original-3x.png`));
      const crop = await renderCrop(page, region.rect);
      const metric = comparePng(crop, reference);
      assert.ok(metric.meanAbsError <= 8, `figure ${index + 2} mae ${metric.meanAbsError}`);
    }
  });

  it("keeps every semantic colour class within 15 % of the reference", async () => {
    for (const [index, region] of regions.entries()) {
      const reference = await readPng(path.join(REPO_ROOT, "fixture", `figure${index + 2}-original-3x.png`));
      const crop = await renderCrop(page, region.rect);
      const got = ratios(crop);
      const want = ratios(reference);
      for (const key of CLASSES) {
        const delta = want[key] ? Math.abs(got[key] - want[key]) / want[key] : got[key] > 0.001 ? 1 : 0;
        assert.ok(delta <= 0.15, `figure ${index + 2} ${key}: ${got[key].toFixed(4)} vs ${want[key].toFixed(4)}`);
      }
      assert.ok(Math.abs(nonWhiteRatio(crop) - nonWhiteRatio(reference)) <= 0.05);
    }
  });

  it("preserves the grey and beige fills and the coloured series, not just pixels", async () => {
    const figure2 = await renderCrop(page, regions[0].rect);
    const figure3 = await renderCrop(page, regions[1].rect);
    const two = ratios(figure2);
    const three = ratios(figure3);
    // Figure 2 is grey plus beige bars; Figure 3 adds a green data series.
    assert.ok(two.gray > 0.3, `figure 2 grey ${two.gray}`);
    assert.ok(two.beige > 0.2, `figure 2 beige ${two.beige}`);
    assert.ok(three.beige > 0.2, `figure 3 beige ${three.beige}`);
    assert.ok(three.green > 0.01, `figure 3 green ${three.green}`);
    assert.ok(two.green < 0.001, `figure 2 must not gain colour ${two.green}`);
  });

  it("fails the check when the same crop is converted to grayscale", async () => {
    const reference = await readPng(path.join(REPO_ROOT, "fixture", "figure2-original-3x.png"));
    const grey = grayscale(await renderCrop(page, regions[0].rect));
    const classes = ratios(grey);
    const want = ratios(reference);
    assert.equal(classes.beige, 0, "a grayscale crop has no beige");
    assert.ok(Math.abs(classes.gray - want.gray) > 0.15, "grey class share must drift past the tolerance");
    assert.ok(comparePng(grey, reference).meanAbsError > 0, "grayscale is not identical to the reference");
  });

  it("lands on the same pixels as a full-page render at 150 % and 200 %", async () => {
    for (const scale of [1.5, 2]) {
      const region = regions[0].rect;
      const viewport = page.getViewport({ scale });
      const geometry = overlayGeometry({ region, viewport, padViewport: PAD, deviceScale: 1 });
      const crop = await renderCrop(page, region, { scale, deviceScale: 1 });
      const full = await renderFullPage(page, scale);
      const window = windowOf(full, geometry);
      const scores = {};
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const shifted = { ...geometry, left: Math.floor(geometry.left) + dx, top: Math.floor(geometry.top) + dy };
          scores[`${dx},${dy}`] = comparePng(crop, windowOf(full, shifted)).meanAbsError;
        }
      }
      const best = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
      assert.equal(best, "0,0", `scale ${scale}: best alignment ${best} scores ${JSON.stringify(scores)}`);
      assert.ok(Math.abs(nonWhiteRatio(crop) - nonWhiteRatio(window)) <= 0.02);
    }
  });

  // Windows displays run at 125 % / 150 % scaling, so the raster buffer is
  // ceil(css * dpr) with a fractional translate. Real-machine overlays once
  // looked empty, so the fractional path is asserted, not assumed.
  it("keeps ink coverage and alignment at fractional device pixel ratios", async () => {
    const region = regions[0].rect;
    for (const [scale, dpr] of [[1, 1.25], [1.25, 1.5], [1.3, 1.5], [1.75, 1.25]]) {
      const crop = await renderCrop(page, region, { scale, deviceScale: dpr });
      const full = await renderFullPage(page, scale * dpr);
      const window = windowOfScale(full, crop.geometry, dpr);
      const scores = {};
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          scores[`${dx},${dy}`] = comparePng(crop, windowOfScale(full, crop.geometry, dpr, dx, dy)).meanAbsError;
        }
      }
      const best = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
      assert.equal(best, "0,0", `scale ${scale} dpr ${dpr}: best alignment ${best} scores ${JSON.stringify(scores)}`);
      assert.ok(Math.abs(nonWhiteRatio(crop) - nonWhiteRatio(window)) <= 0.02, `scale ${scale} dpr ${dpr}`);
    }
  });

  it("renders a rotated page into a swapped canvas with the same ink coverage", async () => {
    const straight = await renderCrop(page, regions[0].rect, { rotation: 0 });
    const rotated = await renderCrop(page, regions[0].rect, { rotation: 90 });
    assert.ok(Math.abs(rotated.width - straight.height) <= 2, `${rotated.width} vs ${straight.height}`);
    assert.ok(Math.abs(rotated.height - straight.width) <= 2, `${rotated.height} vs ${straight.width}`);
    assert.ok(rotated.geometry.left >= 0 && rotated.geometry.top >= 0);
    assert.ok(Math.abs(nonWhiteRatio(rotated) - nonWhiteRatio(straight)) <= 0.08);
  });

  it("paints the same pixels twice, so no state leaks between renders", async () => {
    const a = await renderCrop(page, regions[0].rect);
    const b = await renderCrop(page, regions[0].rect);
    assert.equal(comparePng(a, b).meanAbsError, 0);
  });
});

describe("renderRegion: realm params write channel (Xray waiver)", () => {
  /** Stand-in for the reader realm's Object; instances are "realm-native". */
  class RealmObject {}

  /** The display-side viewport, a local copy like xray.js localViewport(). */
  const LOCAL_VIEWPORT = {
    scale: 1,
    width: 612,
    height: 792,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    transform: [1, 0, 0, -1, 0, 792],
    convertToViewportPoint: (x, y) => [x, 792 - y],
  };

  function fakeCanvas() {
    const context = { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
    return { width: 0, height: 0, context, getContext: () => context };
  }

  function fakePage(seen) {
    return {
      getViewport(options) {
        const viewport = { fromRealmGetViewport: true, scale: options.scale };
        seen.rawViewports.push(viewport);
        return viewport;
      },
      render(params) {
        seen.params.push(params);
        return { promise: Promise.resolve(), cancel() {} };
      },
    };
  }

  /**
   * A parameter object that behaves like a Gecko Xray wrapper: defining a
   * cross-origin object value directly on the wrapper throws the v0.1.13
   * error, primitives pass, and `wrappedJSObject` exposes the raw object.
   */
  function xrayWrapperFactory(captured) {
    return () => {
      const raw = new RealmObject();
      const wrapper = new RealmObject();
      Object.defineProperty(wrapper, "wrappedJSObject", { value: raw });
      captured.push({ raw, wrapper });
      return new Proxy(wrapper, {
        set(target, key, value) {
          if (typeof value === "object" && value !== null) {
            throw new TypeError(
              'Not allowed to define cross-origin object as property on [Object] or [Array] XrayWrapper',
            );
          }
          target[key] = value;
          return true;
        },
      });
    };
  }

  async function renderWithFactory(paramsFactory, renderOptions = {}) {
    const seen = { rawViewports: [], params: [] };
    const canvas = fakeCanvas();
    await renderRegion({
      pdfPage: fakePage(seen),
      canvas,
      region: [100, 600, 300, 700],
      viewport: LOCAL_VIEWPORT,
      deviceScale: 2,
      renderOptions,
      paramsFactory,
    });
    return { seen, canvas };
  }

  it("writes canvasContext, viewport and transform onto the raw realm object", async () => {
    const captured = [];
    const marker = { nested: true };
    const { seen, canvas } = await renderWithFactory(
      xrayWrapperFactory(captured),
      { objectOption: marker },
    );
    // The first minted object carries the getViewport options, the second the
    // render params; both are Xray wrappers here.
    assert.equal(captured.length, 2);
    const { raw, wrapper } = captured[1];
    assert.equal(seen.params.length, 1);
    assert.equal(seen.params[0] instanceof RealmObject, true, "pdf.js still receives the realm object");
    assert.equal(raw.canvasContext, canvas.context, "canvasContext lands on the raw object");
    assert.equal(raw.viewport, seen.rawViewports[0], "the raw getViewport result lands on the raw object");
    assert.equal(Array.isArray(raw.transform) && raw.transform.length === 6, true,
      "transform stays a plain number[] on the raw object");
    assert.equal(raw.objectOption, marker, "object-valued renderOptions also go through the waiver");
    assert.equal(wrapper.canvasContext, undefined,
      "no direct define on the wrapper: that is the path that throws 'Not allowed to define cross-origin object'");
  });

  it("writes directly onto the object when wrappedJSObject is absent", async () => {
    const made = [];
    const { seen, canvas } = await renderWithFactory(() => {
      const params = new RealmObject();
      made.push(params);
      return params;
    });
    const params = made[1];
    assert.equal(seen.params[0], params);
    assert.equal(params.canvasContext, canvas.context, "offline/plain path keeps the direct write");
    assert.equal(params.viewport, seen.rawViewports[0]);
    assert.equal(params.transform.length, 6);
  });

  it("hands pdf.js the raw getViewport result, not the local viewport copy", async () => {
    const { seen } = await renderWithFactory(() => ({}));
    const params = seen.params[0];
    assert.equal(params.viewport, seen.rawViewports[0],
      "params.viewport is exactly what pdfPage.getViewport returned");
    assert.notEqual(params.viewport, LOCAL_VIEWPORT, "the sandbox-side copy never reaches pdf.js render");
  });
});
