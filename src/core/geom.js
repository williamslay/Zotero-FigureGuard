/**
 * Geometry helpers shared by the detector and the region renderer.
 *
 * Coordinates:
 *   - "user space" = PDF user space (origin bottom-left, y grows upwards).
 *   - "viewport space" = CSS/device space produced by a PDF.js PageViewport
 *     (origin top-left, y grows downwards).
 * Matrices use the PDF convention `[a, b, c, d, e, f]`.
 */

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** Coerce an array-like (plain array or typed array) into a 6-number matrix. */
export function toMatrix(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value : Array.from(value);
  if (raw.length < 6) return null;
  const out = [
    Number(raw[0]),
    Number(raw[1]),
    Number(raw[2]),
    Number(raw[3]),
    Number(raw[4]),
    Number(raw[5]),
  ];
  return out.every(Number.isFinite) ? out : null;
}

/** Coerce an array-like into a finite 4-number rect without reordering. */
export function toRect(value) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value : Array.from(value);
  if (raw.length < 4) return null;
  const out = [Number(raw[0]), Number(raw[1]), Number(raw[2]), Number(raw[3])];
  return out.every(Number.isFinite) ? out : null;
}

/** Compose two affine matrices the PDF way: `outer * inner`. */
export function multiplyMatrices(outer, inner) {
  const a = outer;
  const b = inner;
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

/** Axis-aligned bounding box of a rect after an affine transform. */
export function rectFromMatrix(matrix, rect) {
  const corners = [
    transformPoint(matrix, rect[0], rect[1]),
    transformPoint(matrix, rect[2], rect[1]),
    transformPoint(matrix, rect[2], rect[3]),
    transformPoint(matrix, rect[0], rect[3]),
  ];
  return normalizeRect([
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ]);
}

/** Return `[x0, y0, x1, y1]` with sorted corners. */
export function normalizeRect(rect) {
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
}

export function rectWidth(rect) {
  return Math.abs(rect[2] - rect[0]);
}

export function rectHeight(rect) {
  return Math.abs(rect[3] - rect[1]);
}

export function rectArea(rect) {
  return rectWidth(rect) * rectHeight(rect);
}

export function expandRect(rect, padX, padY = padX) {
  return [rect[0] - padX, rect[1] - padY, rect[2] + padX, rect[3] + padY];
}

export function intersectRects(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1];
}

export function intersectionArea(a, b) {
  const inter = intersectRects(a, b);
  return inter ? rectArea(inter) : 0;
}

export function unionRect(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Intersection over union of two rects (0 when disjoint). */
export function iou(a, b) {
  const inter = intersectionArea(a, b);
  if (!inter) return 0;
  const union = rectArea(a) + rectArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Fraction of `inner` covered by `outer` (containment ratio). */
export function coverageOf(inner, outer) {
  const area = rectArea(inner);
  if (!area) return 0;
  return intersectionArea(inner, outer) / area;
}

/** Round to a fixed number of decimals for stable reports and assertions. */
export function roundRect(rect, digits = 4) {
  const factor = 10 ** digits;
  return rect.map((v) => Math.round(v * factor) / factor);
}
