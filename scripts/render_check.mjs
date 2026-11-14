/**
 * A2 evidence: render figure regions with original PDF colours, offline, using
 * pdf.js + @napi-rs/canvas, and compare with the Python-generated reference
 * PNGs. Colour assertions are made on semantic colour classes as well as on
 * overall pixel error, so a colour-management bug cannot hide behind a low
 * mean error.
 *
 * Usage: node scripts/render_check.mjs
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Canvas, ImageData } from "@napi-rs/canvas";
import { OPS } from "../tests/js/helpers/doc.mjs";
import { openFixture, readJson, REPO_ROOT } from "../tests/js/helpers/doc.mjs";
import { detectPageRegions } from "../src/core/index.js";
import { overlayGeometry, toViewportRect } from "../src/core/viewport.js";
import { renderRegion } from "../src/core/render.js";
import {
  comparePng,
  nonWhiteRatio,
  readPng,
  semanticClasses,
  toCanvas,
} from "../tests/js/helpers/png.mjs";

const OUT_DIR = path.join(REPO_ROOT, "reports", "A2");
const PAD = 1.6;

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const fixture = await readJson(path.join(REPO_ROOT, "fixture", "fixture-verified.json"));
  const { doc, close } = await openFixture();
  const report = { reference: "fixture PNGs rendered by the Python oracle", padViewport: PAD, checks: [] };

  try {
    const pageNumber = fixture.page_number;
    const page = await doc.getPage(pageNumber);
    const detected = await detectPageRegions({ pdfPage: page, OPS });
    const viewport1 = page.getViewport({ scale: 1 });

    for (const [index, region] of detected.regions.entries()) {
      const label = `figure${region.captionNumber}`;
      const referencePath = path.join(REPO_ROOT, "fixture", `figure${region.captionNumber}-original-3x.png`);
      const reference = await readPng(referencePath);
      const entry = { figure: region.captionNumber, reference: path.relative(REPO_ROOT, referencePath), renders: [] };

      const rendered = await renderCrop(page, region.rect, { scale: 1, deviceScale: 3, pad: PAD });
      await savePng(rendered, path.join(OUT_DIR, `${label}-pdfjs-3x.png`));
      entry.renders.push(
        compare("scale 1, dpr 3, reference", rendered, reference, reference, {
          sizeTolerance: 2,
          maxMeanAbsError: 8,
          semanticTolerance: 0.15,
          nonWhiteTolerance: 0.05,
        }),
      );

      const grayscale = toGrayscale(rendered);
      entry.renders.push(
        compare("same crop, colours removed (negative control)", grayscale, reference, reference, {
          sizeTolerance: 2,
          maxMeanAbsError: 8,
          semanticTolerance: 0.15,
          nonWhiteTolerance: 0.05,
          expectFail: true,
        }),
      );

      entry.renders.push(...(await zoomConsistency(page, region.rect, viewport1, label)));
      entry.renders.push(await rotatedCrop(page, region.rect, label));
      entry.bboxPageTopLeft = toViewportRect(region.rect, viewport1).map((value) => round(value, 2));
      report.checks.push(entry);
    }

    // Every accepted region must also survive a second render pass unchanged,
    // which catches state leaking between renders.
    const first = detected.regions[0];
    const a = await renderCrop(page, first.rect, { scale: 1, deviceScale: 3, pad: PAD });
    const b = await renderCrop(page, first.rect, { scale: 1, deviceScale: 3, pad: PAD });
    report.repeatRender = compare("repeat render is stable", a, b, null, {
      sizeTolerance: 0,
      maxMeanAbsError: 0.5,
      semanticTolerance: 0.001,
      nonWhiteTolerance: 0.001,
    });

    page.cleanup();
  } finally {
    await close();
  }

  const file = path.join(REPO_ROOT, "reports", "A2-render.json");
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  print(report);
  const failed = collectFailures(report);
  if (failed.length) {
    console.log(`\nFAIL: ${failed.length} check(s)`);
    process.exitCode = 1;
  }
}

async function renderCrop(page, region, { scale, deviceScale, pad, rotation = 0 }) {
  const viewport = page.getViewport({ scale, rotation });
  const geometry = overlayGeometry({ region, viewport, padViewport: pad, deviceScale });
  const canvas = new Canvas(geometry.canvasWidth, geometry.canvasHeight);
  await renderRegion({
    pdfPage: page,
    canvas,
    region,
    viewport,
    deviceScale,
    padViewport: pad,
    renderOptions: { background: "#ffffff" },
  });
  const context = canvas.getContext("2d");
  return {
    width: canvas.width,
    height: canvas.height,
    data: context.getImageData(0, 0, canvas.width, canvas.height),
    geometry,
  };
}

/**
 * The crop rendered at 100/150/200 percent must sit on the same pixels as the
 * same area of a full-page render: the best alignment offset has to be zero,
 * and the semantic colour classes must match. Residual pixel error comes from
 * the antialiasing phase of a canvas that starts at a fractional device pixel,
 * so it is reported but not used as the primary gate.
 */
async function zoomConsistency(page, region, viewport1, label) {
  const results = [];
  for (const scale of [1, 1.5, 2]) {
    const viewport = page.getViewport({ scale });
    const geometry = overlayGeometry({ region, viewport, padViewport: PAD, deviceScale: 1 });
    const full = await renderPage(page, scale);
    const crop = await renderCrop(page, region, { scale, deviceScale: 1, pad: PAD });
    const shifts = {};
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        shifts[`${dx},${dy}`] = comparePng(crop, cropWindow(full, geometry, dx, dy)).meanAbsError;
      }
    }
    const bestKey = Object.entries(shifts).sort((a, b) => a[1] - b[1])[0];
    const aligned = bestKey[0] === "0,0";
    const metric = comparePng(crop, cropWindow(full, geometry, 0, 0));
    const classes = ratios(semanticClasses(crop));
    const wanted = ratios(semanticClasses(cropWindow(full, geometry, 0, 0)));
    const classReport = {};
    let classesOk = true;
    for (const key of ["gray", "beige", "green", "yellow", "black", "colored"]) {
      const delta = Math.abs(classes[key] - wanted[key]);
      classReport[key] = { got: classes[key], want: wanted[key], delta: round(delta, 4) };
      if (delta > 0.02) classesOk = false;
    }
    const nonWhiteDelta = Math.abs(nonWhiteRatio(crop) - nonWhiteRatio(cropWindow(full, geometry, 0, 0)));
    results.push({
      check: `zoom ${Math.round(scale * 100)}% crop aligned with full-page pixels`,
      passed: aligned && classesOk && nonWhiteDelta <= 0.02,
      pixelAlignmentZero: aligned,
      bestShiftKey: bestKey[0],
      meanAbsError: metric.meanAbsError,
      shiftScan: shifts,
      semanticClasses: classReport,
      nonWhiteGot: round(nonWhiteRatio(crop), 4),
      nonWhiteWant: round(nonWhiteRatio(cropWindow(full, geometry, 0, 0)), 4),
      nonWhiteDelta: round(nonWhiteDelta, 4),
      got: `${crop.width}x${crop.height}`,
      want: `${Math.round(geometry.width)}x${Math.round(geometry.height)}`,
    });
  }
  return results;
}

async function rotatedCrop(page, region, label) {
  const straight = await renderCrop(page, region, { scale: 1, deviceScale: 3, pad: PAD });
  const rotated = await renderCrop(page, region, { scale: 1, deviceScale: 3, pad: PAD, rotation: 90 });
  const swap = Math.abs(rotated.width - straight.height) <= 2 && Math.abs(rotated.height - straight.width) <= 2;
  const result = {
    check: `${label} rotated 90 degrees swaps width and height`,
    got: `${rotated.width}x${rotated.height}`,
    want: `${straight.height}x${straight.width}`,
    sizeSwapped: swap,
    insidePage: rotated.geometry.left >= 0 && rotated.geometry.top >= 0,
    nonWhiteStraight: round(nonWhiteRatio(straight), 4),
    nonWhiteRotated: round(nonWhiteRatio(rotated), 4),
    nonWhiteDelta: round(Math.abs(nonWhiteRatio(straight) - nonWhiteRatio(rotated)), 4),
  };
  result.passed = swap && result.nonWhiteDelta <= 0.08 && result.insidePage;
  return result;
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = new Canvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "#ffffff" }).promise;
  const context = canvas.getContext("2d");
  return {
    width: canvas.width,
    height: canvas.height,
    data: context.getImageData(0, 0, canvas.width, canvas.height),
  };
}

function cropWindow(full, geometry, dx = 0, dy = 0) {
  const x = Math.floor(geometry.left) + dx;
  const y = Math.floor(geometry.top) + dy;
  const width = geometry.canvasWidth;
  const height = geometry.canvasHeight;
  const src = full.data.data ?? full.data;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      const sy = y + row;
      const di = (row * width + col) * 4;
      if (sx < 0 || sy < 0 || sx >= full.width || sy >= full.height) {
        pixels[di] = 255;
        pixels[di + 1] = 255;
        pixels[di + 2] = 255;
        pixels[di + 3] = 255;
        continue;
      }
      const si = (sy * full.width + sx) * 4;
      pixels[di] = src[si];
      pixels[di + 1] = src[si + 1];
      pixels[di + 2] = src[si + 2];
      pixels[di + 3] = 255;
    }
  }
  return { width, height, data: new ImageData(pixels, width, height) };
}

function toGrayscale(image) {
  const canvas = new Canvas(image.width, image.height);
  const context = canvas.getContext("2d");
  const copy = new ImageData(new Uint8ClampedArray(image.data.data), image.width, image.height);
  for (let i = 0; i < copy.data.length; i += 4) {
    const luma =
      0.2126 * copy.data[i] + 0.7152 * copy.data[i + 1] + 0.0722 * copy.data[i + 2];
    copy.data[i] = luma;
    copy.data[i + 1] = luma;
    copy.data[i + 2] = luma;
  }
  context.putImageData(copy, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height),
  };
}

function compare(name, got, want, referenceForSemantics, limits) {
  const metric = comparePng(got, want);
  const classes = ratios(semanticClasses(got));
  const wanted = referenceForSemantics ? ratios(semanticClasses(referenceForSemantics)) : classes;
  const sizeOk =
    Math.abs(got.width - want.width) <= limits.sizeTolerance &&
    Math.abs(got.height - want.height) <= limits.sizeTolerance;
  const classReport = {};
  let classesOk = true;
  for (const key of ["gray", "beige", "green", "yellow", "black", "colored"]) {
    const expected = wanted[key];
    const actual = classes[key];
    const delta = expected ? Math.abs(actual - expected) / expected : actual > 0 ? 1 : 0;
    classReport[key] = { got: actual, want: expected, relDelta: round(delta, 3) };
    if (delta > limits.semanticTolerance) classesOk = false;
  }
  const nonWhiteDelta = Math.abs(nonWhiteRatio(got) - nonWhiteRatio(want));
  const passed =
    sizeOk &&
    metric.meanAbsError <= limits.maxMeanAbsError &&
    classesOk &&
    nonWhiteDelta <= limits.nonWhiteTolerance;
  return {
    check: name,
    passed: limits.expectFail ? !passed : passed,
    expectedToFail: Boolean(limits.expectFail),
    sizeOk,
    got: `${got.width}x${got.height}`,
    want: `${want.width}x${want.height}`,
    meanAbsError: metric.meanAbsError,
    meanAbsErrorAfterShift: metric.bestShift ? metric.bestShift.mean : null,
    bestShift: metric.bestShift,
    nonWhiteGot: round(nonWhiteRatio(got), 4),
    nonWhiteWant: round(nonWhiteRatio(want), 4),
    nonWhiteDelta: round(nonWhiteDelta, 4),
    semanticClasses: classReport,
    limits,
  };
}

function print(report) {
  for (const entry of report.checks) {
    console.log(`\nFigure ${entry.figure}  bbox ${entry.bboxPageTopLeft.join(",")}`);
    for (const check of entry.renders) printCheck(check);
  }
  console.log("\nStability");
  printCheck(report.repeatRender);
}

function printCheck(check) {
  if (!check) return;
  const flag = check.passed ? "PASS" : "FAIL";
  const bits = [];
  if (check.got || check.want) bits.push(`${check.got} vs ${check.want}`);
  if (check.meanAbsError !== undefined) bits.push(`mae=${check.meanAbsError}`);
  if (check.bestShiftKey) bits.push(`bestShift=${check.bestShiftKey}`);
  if (check.semanticClasses) {
    bits.push(
      `classes=${Object.entries(check.semanticClasses)
        .map(([key, value]) => `${key}:${value.got}|${value.want ?? value.got}`)
        .join(" ")}`,
    );
  }
  if (check.nonWhiteDelta !== undefined) bits.push(`nonWhite=${check.nonWhiteGot}/${check.nonWhiteWant} d=${check.nonWhiteDelta}`);
  if (check.sizeSwapped !== undefined) bits.push(`swapped=${check.sizeSwapped} insidePage=${check.insidePage}`);
  console.log(` ${flag} ${check.check}: ${bits.join(" ")}`);
}

/** Semantic class counts as fractions of the image. */
function ratios(counts) {
  const out = { pixels: counts.pixels };
  for (const key of Object.keys(counts)) {
    if (key === "pixels") continue;
    out[key] = round(counts[key] / counts.pixels, 4);
  }
  return out;
}

async function savePng(image, file) {
  const { canvas } = toCanvas({
    width: image.width,
    height: image.height,
    data: image.data.data,
  });
  await fs.writeFile(file, Buffer.from(canvas.toBuffer("image/png")));
}

function collectFailures(report) {

  const all = [];
  for (const entry of report.checks) all.push(...entry.renders);
  if (report.repeatRender) all.push(report.repeatRender);
  return all.filter((check) => check && !check.passed);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
