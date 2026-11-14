/**
 * Paint probe: samples pixels and geometry from the reader realm.
 *
 * The real machine reports every overlay box as a plain white block, which has
 * at least three candidate causes: pdf.js drew nothing, the content landed
 * offset outside the canvas (a transform or devicePixelRatio bug, likely under
 * Windows display scaling), or the raster is there but visually wrong
 * (stacking, transparency, or the dark-mode blender ignoring `skipBlender`).
 *
 * This module reads one `PageOverlay` and answers with plain JSON-able data:
 *   - device scale of the overlay's inner window,
 *   - the pdf.js page canvas's own ink ratio, for contrast,
 *   - per overlay canvas: the CSS box, the buffer size, the fraction of pixels
 *     with visible ink, the mean ink colour and a 5x5 average-RGB grid.
 *
 * A content confined to one edge or corner of the 5x5 grid means the render
 * transform is wrong. An all-white grid with a matching white pdf.js canvas
 * means pdf.js drew nothing here at all.
 *
 * Pixel data crosses the Xray boundary through xray.js `localNumbers`, the
 * same way the detection core does: element access on a TypedArray behind an
 * Xray wrapper throws, so nothing here indexes reader memory directly. Every
 * risky access is guarded and failures are recorded as short strings; the
 * probe itself never throws at the caller.
 */

import { localNumbers, localViewport } from "./xray.js";
import { ERROR_CLASS, warnOnce } from "./overlay.js";

/**
 * Budget for one pixel readback, in pixels. `samplePixels` copies its sample
 * window with a single `getImageData` call, so this cap is also the cost cap of
 * that call: a 3738x4844 page canvas measured 18.1 MP, and copying it whole —
 * one `Uint8ClampedArray` element at a time across the Xray boundary, see
 * `localNumbers` — is what froze the UI while the probe dialog waited.
 */
export const MAX_SAMPLED_PIXELS = 1_000_000;

/** Longest side of the centred sample box used for oversized canvases. */
export const MAX_SAMPLE_SIDE = 2000;

/** Most per-canvas entries a single probe result carries. */
export const MAX_REGION_ENTRIES = 8;

/**
 * Cap on pixels one probe actually analyses, split across the canvases it
 * samples. The sample box is still copied whole (one readback), but the pixel
 * loop walks it with a stride so a megapixel page canvas cannot freeze the UI.
 */
export const MAX_SCAN_PIXELS = 250_000;

/** Side of the average-RGB grid reported per canvas. */
const GRID_SIDE = 5;

/**
 * Finite number or null.
 *
 * @param {*} value Raw property value.
 * @returns {number|null}
 */
function num(value) {
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    warnOnce("probe-scalar", err);
    return null;
  }
}

/**
 * Value rounded to four decimals, for ratios.
 *
 * @param {number} value
 * @returns {number}
 */
function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * CSS property of a canvas as a short string, the way it was written.
 *
 * @param {*} value Raw style property.
 * @returns {string|null}
 */
function cssText(value) {
  try {
    return value === undefined || value === null ? null : String(value);
  } catch (err) {
    warnOnce("probe-style", err);
    return null;
  }
}

/**
 * A CSS custom property of a computed style, read as a number.
 *
 * The reader keeps its zoom factors in custom properties on the page div, and
 * an absent property reads back as the empty string, which must stay null
 * rather than becoming 0 — `--user-unit` is not even defined by Zotero's
 * reader. The `getPropertyValue` call itself crosses the realm and may throw.
 *
 * @param {object|null|undefined} style A `getComputedStyle` result.
 * @param {string} name The custom property name, e.g. `--scale-factor`.
 * @returns {number|null} The parsed number, or null when absent or unreadable.
 */
function cssVarNumber(style, name) {
  try {
    const raw = style?.getPropertyValue?.(name);
    if (raw === undefined || raw === null) return null;
    const trimmed = String(raw).trim();
    return trimmed === "" ? null : num(trimmed);
  } catch (err) {
    warnOnce("probe-css-var", err);
    return null;
  }
}

/**
 * The canvas' positioning host as a short label, `"<tag>.<first class>"`.
 *
 * Comparing this against the page div tells a canvas mounted into the wrong
 * element (the overlay box belongs to another element's coordinate space) from
 * a canvas whose box is merely painted from stale viewport numbers.
 *
 * @param {*} value The raw `offsetParent` value read from the realm.
 * @returns {string|null} The label, or null when there is no host or the read threw.
 */
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

/**
 * A `dataset` field of a reader-realm element as a sandbox string.
 *
 * The provenance stamps are written reader-side, so reading them back hands over
 * a realm string: copied with `String` here, the same way the other realm reads
 * are copied, and a missing field — or a canvas stand-in with no dataset at all —
 * stays null rather than becoming the empty string.
 *
 * @param {object|null} canvas An overlay canvas.
 * @param {string} field The dataset key, e.g. `fcpRealm`.
 * @returns {string|null}
 */
function datasetText(canvas, field) {
  try {
    const value = canvas?.dataset?.[field];
    return typeof value === "string" && value ? value : null;
  } catch (err) {
    warnOnce(`probe-dataset-${field}`, err);
    return null;
  }
}

/**
 * Average of accumulated channel sums as rounded integers.
 *
 * @param {number} sumR Red channel sum.
 * @param {number} sumG Green channel sum.
 * @param {number} sumB Blue channel sum.
 * @param {number} count Number of accumulated pixels.
 * @returns {number[]} An `[r, g, b]` triple.
 */
function averageTriple(sumR, sumG, sumB, count) {
  return [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)];
}

/**
 * Samples one canvas and returns its pixel evidence.
 *
 * A canvas whose buffer covers more than `maxSampledPixels` is sampled through
 * a centred box that fits that budget and stays under `maxSampleSide` per side,
 * and the box is reported as `sampledBox: [x, y, w, h]`. A pixel counts as ink
 * when any RGB channel is below 250 or alpha is below 250, so a transparent
 * pixel is "not white" too. Pixel data is copied into this realm before
 * indexing, because an Xray-wrapped TypedArray forbids element access.
 *
 * @param {object} canvas Canvas element to read from.
 * @param {{maxSampledPixels?: number, maxPaintReadbackPixels?: number,
 *   maxSampleSide?: number, maxScanPixels?: number}} [options]
 * @returns {{nonWhite: number, mean: number[]|null, grid: number[][], stride: number,
 *   scannedPixels: number, readbackPixels: number, sampledBox?: number[]}|{error: string}}
 *   `nonWhite` (0..1, four decimals, over the pixels actually scanned), the
 *   mean ink colour `mean`, the 5x5 average-RGB `grid` row-major (25 triples;
 *   a cell with no sampled pixels is `[0, 0, 0]`), the pixel walk `stride`
 *   (1 = every pixel), the number of analysed pixels `scannedPixels`, the
 *   window the single `getImageData` call copied `readbackPixels` (= w * h of
 *   the sample window), plus `sampledBox` when the sample was clipped; or
 *   `error`.
 */
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
    // The side caps alone do not bound the area — two capped sides are still
    // four megapixels — so the window is shrunk to the readback budget too.
    // Flooring keeps the product under it: floor(bw*f) * floor(bh*f) <= bw*bh*f^2.
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

  // Stride so the analysis loop never walks more than the scan budget: the
  // smallest step whose sampled grid fits. Small canvases keep stride 1.
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
    const cellY = Math.min(GRID_SIDE - 1, Math.floor((py * GRID_SIDE) / h));
    for (let px = 0; px < w; px += stride) {
      const p = (row + px) * 4;
      const r = data[p] === undefined ? 255 : data[p];
      const g = data[p + 1] === undefined ? 255 : data[p + 1];
      const b = data[p + 2] === undefined ? 255 : data[p + 2];
      const a = data[p + 3] === undefined ? 255 : data[p + 3];
      const cell = cellY * GRID_SIDE
        + Math.min(GRID_SIDE - 1, Math.floor((px * GRID_SIDE) / w));
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
    readbackPixels: w * h,
  };
  if (sampledBox) result.sampledBox = sampledBox;
  return result;
}

/**
 * Probes one `PageOverlay` for paint evidence: geometry, device scale, pixel
 * content, and the viewport-vs-paint geometry pair, as a plain JSON-able
 * object that never throws at the caller.
 *
 * @param {object|null|undefined} overlay A `PageOverlay` from overlay.js.
 * @param {object} [options]
 * @param {number} [options.maxRegions] Most region entries kept (default 8).
 * @param {number} [options.maxSampledPixels] Readback budget per canvas, in
 *   pixels (default `MAX_SAMPLED_PIXELS`, one million). The pixel copy is a
 *   single `getImageData` call, so this is also its cost cap.
 * @param {number} [options.maxPaintReadbackPixels] Alias of `maxSampledPixels`.
 * @param {number} [options.maxSampleSide] Longest side of a clipped sample box.
 * @param {number} [options.maxScanPixels] Pixel-analysis cap for the whole
 *   probe, split across the sampled canvases (default 250 000).
 * @returns {object} `{ pageNumber, painted, paintPath, paintError, canvasCount,
 *   deviceScale, page, lastPaintGeometry, liveViewport, hostBox, cssVars,
 *   regions }`, plus `truncated: true` when canvases were dropped from the
 *   region list. Each `regions` entry carries `kind`: "path" (vector art),
 *   "xobject" (image/form), "struct" (tagged) or a combination, and the
 *   canvas' on-screen box (`rectLeft`/`rectTop`/`rectWidth`/`rectHeight`) plus
 *   its `offsetParent` host label. `paintPath` is the route the last paint took:
 *   `"helper"` (rendered inside the pdf.js viewer realm), `"legacy"` (the
 *   sandbox-side render call) or null before the first paint.
 *   `lastPaintGeometry` is the viewport the last paint pass used;
 *   `liveViewport` is the page view's viewport read now, `hostBox` the page
 *   div's own on-screen box and `cssVars` the reader's zoom factors
 *   (`scaleFactor`, `userUnit`, `totalScaleFactor`). Together they prove or
 *   kill the stale-viewport diagnosis for the "displaced after the toolbar
 *   toggle" symptom on one run: paint-time versus probe-time viewport, and
 *   canvas box versus page-div box. Failed reads come
 *   back as null fields or short `error` strings instead of exceptions.
 */
export function probeOverlay(overlay, options = {}) {
  const canvases = Array.isArray(overlay?.canvases) ? overlay.canvases : [];
  const maxRegions = num(options.maxRegions) ?? MAX_REGION_ENTRIES;
  // Split the scan budget across every canvas this probe will sample (page
  // canvas plus kept regions) so the whole probe stays under MAX_SCAN_PIXELS.
  const sampledCanvases = 1 + Math.min(maxRegions, canvases.length);
  const scanBudget = Math.max(
    1,
    Math.floor((num(options.maxScanPixels) ?? MAX_SCAN_PIXELS) / sampledCanvases),
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
      readbackPixels: null,
    },
    regions: [],
    // Paint-time viewport of this overlay (`PageOverlay.lastPaintGeometry`),
    // null before the first paint.
    lastPaintGeometry: null,
    liveViewport: { width: null, height: null, scale: null, rotation: null },
    hostBox: { clientWidth: null, clientHeight: null, rectWidth: null, rectHeight: null },
    cssVars: { scaleFactor: null, userUnit: null, totalScaleFactor: null },
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

    // Stale-geometry evidence, for the "the boxes sit displaced after the
    // toolbar toggle off→on" report: `lastPaintGeometry` says what the last
    // paint pass used, `liveViewport` what the page view has now — a pair that
    // differs means the canvases were painted against a viewport the page
    // already replaced. `hostBox` and the per-canvas rects below separate a
    // mis-mounted canvas from a stale-geometry box, and `cssVars` reports the
    // reader's own zoom factors at probe time.
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
    // Shared between the two blocks below, so a div whose rect read throws is
    // still the div the computed style is asked for.
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
      const hostStyle = hostDiv && typeof innerWin?.getComputedStyle === "function"
        ? innerWin.getComputedStyle(hostDiv)
        : null;
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
        readbackPixels: null,
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
        // The overlay stamps this class when the region's raster failed, which
        // separates "pdf.js rejected" from "pdf.js drew white".
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
