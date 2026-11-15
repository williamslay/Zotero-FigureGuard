/** Small PNG helpers built on @napi-rs/canvas, for the offline test harness. */
import { readFile } from "node:fs/promises";
import { Canvas, ImageData, loadImage } from "@napi-rs/canvas";

export async function readPng(path) {
  const buf = await readFile(path);
  const img = await loadImage(new Uint8Array(buf));
  const canvas = new Canvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height) };
}

export function toCanvas({ width, height, data }) {
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  return { canvas, ctx };
}

/** Mean absolute error per channel over the overlapping area. */
export function comparePng(a, b) {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  let total = 0;
  let counted = 0;
  const channel = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(a.data.data[ia + c] - b.data.data[ib + c]);
        total += diff;
        channel[c] += diff;
      }
      counted += 1;
    }
  }
  const mean = counted ? total / (counted * 3) : Infinity;
  let maxAt = null;
  let shifted = null;
  if (mean > 8) {
    shifted = bestShiftedMetric(a, b, width, height);
  }
  if (shifted) {
    maxAt = { dx: shifted.dx, dy: shifted.dy, mean: shifted.mean };
  }
  return {
    sizeMismatch,
    width,
    height,
    meanAbsError: round(mean, 3),
    meanAbsErrorR: round(channel[0] / counted, 3),
    meanAbsErrorG: round(channel[1] / counted, 3),
    meanAbsErrorB: round(channel[2] / counted, 3),
    maxErrorWithin: 255,
    bestShift: maxAt,
  };
}

/** Re-compare the same crops after allowing a small integer translation. */
function bestShiftedMetric(a, b, width, height, radius = 3) {
  let best = { dx: 0, dy: 0, mean: compareWindow(a, b, width, height, 0, 0) };
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (!dx && !dy) continue;
      const mean = compareWindow(a, b, width, height, dx, dy);
      if (mean < best.mean) best = { dx, dy, mean };
    }
  }
  return best;
}

function compareWindow(a, b, width, height, dx, dy) {
  let total = 0;
  let counted = 0;
  for (let y = 0; y < height; y++) {
    const by = y + dy;
    if (by < 0 || by >= b.height) continue;
    for (let x = 0; x < width; x++) {
      const bx = x + dx;
      if (bx < 0 || bx >= b.width) continue;
      const ia = (y * a.width + x) * 4;
      const ib = (by * b.width + bx) * 4;
      for (let c = 0; c < 3; c++) total += Math.abs(a.data.data[ia + c] - b.data.data[ib + c]);
      counted += 1;
    }
  }
  return counted ? total / (counted * 3) : Infinity;
}

/** Fraction of pixels differing from white by more than `threshold`. */
export function nonWhiteRatio(img, threshold = 8) {
  let count = 0;
  const px = img.width * img.height;
  for (let i = 0; i < px; i++) {
    const off = i * 4;
    const r = img.data.data[off];
    const g = img.data.data[off + 1];
    const b = img.data.data[off + 2];
    if (r < 255 - threshold || g < 255 - threshold || b < 255 - threshold) count += 1;
  }
  return count / px;
}

/**
 * Counts of semantic colour classes, so a colouring bug cannot hide behind an
 * overall pixel-similarity score.
 */
export function semanticClasses(img) {
  const counts = { gray: 0, beige: 0, green: 0, yellow: 0, cyan: 0, magenta: 0, black: 0, colored: 0, pixels: 0 };
  const px = img.width * img.height;
  for (let i = 0; i < px; i++) {
    const off = i * 4;
    const r = img.data.data[off];
    const g = img.data.data[off + 1];
    const b = img.data.data[off + 2];
    counts.pixels += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min > 20) counts.colored += 1;
    if (max < 64) counts.black += 1;
    if (Math.abs(r - g) <= 8 && Math.abs(g - b) <= 8 && r >= 200 && r <= 235) counts.gray += 1;
    if (r >= 235 && g >= 220 && r - b >= 10 && r - b <= 45 && g - b >= 5) counts.beige += 1;
    if (g - r >= 12 && g - b >= 12) counts.green += 1;
    if (r >= 200 && g >= 190 && b <= 170 && r - b >= 45 && g - b >= 30) counts.yellow += 1;
    if (b - r >= 12 && g - r >= 8) counts.cyan += 1;
    if (r - g >= 12 && b - g >= 12) counts.magenta += 1;
  }
  return counts;
}

/** Pixel histogram buckets, used to prove original colours are preserved. */
export function colorBuckets(img, step = 32, limit = 12) {
  const buckets = new Map();
  const px = img.width * img.height;
  for (let i = 0; i < px; i++) {
    const off = i * 4;
    const key = [
      Math.min(255, Math.floor(img.data.data[off] / step) * step),
      Math.min(255, Math.floor(img.data.data[off + 1] / step) * step),
      Math.min(255, Math.floor(img.data.data[off + 2] / step) * step),
    ].join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([rgb, count]) => ({ rgb, count, ratio: round(count / px, 4) }));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
