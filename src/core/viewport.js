/**
 * User space -> viewport (CSS pixel) geometry.
 *
 * pdf.js changed this API: `convertToViewportRectangle()` exists up to pdf.js 5
 * and is gone in 6.x, while `convertToViewportPoint()` has been stable. The
 * overlay therefore uses its own rect conversion on top of the point helper and
 * falls back to the viewport transform matrix when needed.
 */

import { intersectRects, normalizeRect, roundRect, toRect } from "./geom.js";

/**
 * @param {number[]} rect User-space rect.
 * @param {object} viewport A pdf.js PageViewport (any version).
 * @returns {number[]} Normalised rect in viewport pixels (origin top-left).
 */
export function toViewportRect(rect, viewport) {
  if (!viewport) throw new TypeError("toViewportRect: viewport is required");
  const corners = [
    [rect[0], rect[1]],
    [rect[2], rect[3]],
  ];
  let points;
  if (typeof viewport.convertToViewportPoint === "function") {
    points = corners.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  } else if (Array.isArray(viewport.transform)) {
    const m = viewport.transform;
    points = corners.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  } else {
    throw new TypeError("toViewportRect: unsupported viewport");
  }
  const rect2 = normalizeRect([
    points[0][0],
    points[0][1],
    points[1][0],
    points[1][1],
  ]);
  return rect2;
}

/**
 * CSS box plus the pdf.js render parameters for one overlay canvas.
 *
 * @param {object} input
 * @param {number[]} input.region User-space rect to cover.
 * @param {object} input.viewport Viewport at the *display* scale (CSS pixels).
 * @param {number} [input.padViewport] Extra padding in CSS pixels.
 * @param {number} [input.deviceScale] Device pixel ratio for the raster buffer.
 * @returns {{left: number, top: number, width: number, height: number,
 *            canvasWidth: number, canvasHeight: number,
 *            renderScale: number, renderTransform: number[]}}
 */
export function overlayGeometry({ region, viewport, padViewport = 0, deviceScale = 1, rotation = 0 }) {
  const vp = toViewportRect(region, viewport);
  let left = vp[0] - padViewport;
  let top = vp[1] - padViewport;
  let right = vp[2] + padViewport;
  let bottom = vp[3] + padViewport;

  // Never draw outside the painted page.
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(viewport.width, right);
  bottom = Math.min(viewport.height, bottom);

  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const canvasWidth = Math.max(1, Math.ceil(width * deviceScale));
  const canvasHeight = Math.max(1, Math.ceil(height * deviceScale));

  return {
    left,
    top,
    width,
    height,
    canvasWidth,
    canvasHeight,
    // Build the render viewport with `viewport.scale * deviceScale`; the
    // translation below is expressed in that (higher resolution) space.
    renderScale: viewport.scale * deviceScale,
    renderTransform: [1, 0, 0, 1, -left * deviceScale, -top * deviceScale],
  };
}

/**
 * Converts one viewport CSS-pixel point `[vx, vy]` back into PDF user space.
 * Prefers pdf.js `viewport.convertToPdfPoint()` and falls back to exact affine
 * matrix inversion of `viewport.transform`.
 *
 * @param {number[]|{x: number, y: number}} point
 * @param {object} viewport
 * @returns {number[]}
 */
export function toPdfPoint(point, viewport) {
  if (!viewport) throw new TypeError("toPdfPoint: viewport is required");
  const vx = Number(Array.isArray(point) || ArrayBuffer.isView(point) ? point[0] : point?.x);
  const vy = Number(Array.isArray(point) || ArrayBuffer.isView(point) ? point[1] : point?.y);
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    throw new TypeError("toPdfPoint: finite coordinates are required");
  }

  if (typeof viewport.convertToPdfPoint === "function") {
    const out = viewport.convertToPdfPoint(vx, vy);
    const px = Number(out?.[0]);
    const py = Number(out?.[1]);
    if (Number.isFinite(px) && Number.isFinite(py)) return [px, py];
  }

  const m = viewport.transform;
  if (m && typeof m.length === "number" && m.length >= 6) {
    const a = Number(m[0]);
    const b = Number(m[1]);
    const c = Number(m[2]);
    const d = Number(m[3]);
    const e = Number(m[4]);
    const f = Number(m[5]);
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      throw new Error("toPdfPoint: singular viewport transform");
    }
    const tx = vx - e;
    const ty = vy - f;
    return [(d * tx - c * ty) / det, (-b * tx + a * ty) / det];
  }

  throw new TypeError("toPdfPoint: unsupported viewport");
}

/**
 * Converts a viewport CSS-pixel rectangle back into a normalized PDF user-space
 * bounding box `[x0, y0, x1, y1]`, optionally clamped to `pageBounds` (`pdfPage.view`).
 *
 * @param {number[]} viewportRect
 * @param {object} viewport
 * @param {number[]|null} [pageBounds]
 * @param {{digits?: number|null}} [options]
 * @returns {number[]|null}
 */
export function toPdfRect(viewportRect, viewport, pageBounds = null, { digits = 4 } = {}) {
  if (!viewport) throw new TypeError("toPdfRect: viewport is required");
  const coerced = toRect(viewportRect);
  if (!coerced) return null;
  const [vx0, vy0, vx1, vy1] = normalizeRect(coerced);
  if (!(vx1 > vx0 && vy1 > vy0)) return null;

  const corners = [
    toPdfPoint([vx0, vy0], viewport),
    toPdfPoint([vx1, vy0], viewport),
    toPdfPoint([vx1, vy1], viewport),
    toPdfPoint([vx0, vy1], viewport),
  ];
  let rect = normalizeRect([
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ]);

  if (pageBounds) {
    const bounds = toRect(pageBounds);
    if (bounds) {
      rect = intersectRects(rect, normalizeRect(bounds));
      if (!rect) return null;
    }
  }

  if (digits !== null && digits !== undefined && Number.isFinite(Number(digits))) {
    rect = roundRect(rect, Number(digits));
  }
  return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

/**
 * Maps browser client pointer coordinates (`event.clientX`, `event.clientY`) to
 * page-local viewport CSS-pixel coordinates `[vx, vy]`, accounting for page
 * container offsets, scroll, and any CSS/viewport size ratio (never DPR).
 *
 * @param {object} input
 * @param {number} input.clientX
 * @param {number} input.clientY
 * @param {{left: number, top: number, width?: number, height?: number}} input.pageRect
 * @param {number} [input.scrollLeft]
 * @param {number} [input.scrollTop]
 * @param {object|null} [input.viewport]
 * @returns {number[]|null}
 */
export function clientPointToViewportPoint({
  clientX,
  clientY,
  pageRect,
  scrollLeft = 0,
  scrollTop = 0,
  viewport = null,
}) {
  const cx = Number(clientX);
  const cy = Number(clientY);
  const left = Number(pageRect?.left);
  const top = Number(pageRect?.top);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }
  const sLeft = Number.isFinite(Number(scrollLeft)) ? Number(scrollLeft) : 0;
  const sTop = Number.isFinite(Number(scrollTop)) ? Number(scrollTop) : 0;
  const pageWidth = Number(pageRect?.width);
  const pageHeight = Number(pageRect?.height);
  const vpWidth = Number(viewport?.width);
  const vpHeight = Number(viewport?.height);
  const scaleX = Number.isFinite(vpWidth) && vpWidth > 0 && Number.isFinite(pageWidth) && pageWidth > 0
    ? vpWidth / pageWidth
    : 1;
  const scaleY = Number.isFinite(vpHeight) && vpHeight > 0 && Number.isFinite(pageHeight) && pageHeight > 0
    ? vpHeight / pageHeight
    : 1;
  return [(cx - left + sLeft) * scaleX, (cy - top + sTop) * scaleY];
}

/**
 * Normalizes and clamps a viewport-space rectangle to `[0, viewport.width] x [0, viewport.height]`
 * without padding or devicePixelRatio scaling, returning CSS box metrics.
 *
 * @param {number[]} viewportRect
 * @param {object|null} [viewport]
 * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}|null}
 */
export function cssBoxFromViewportRect(viewportRect, viewport = null) {
  const coerced = toRect(viewportRect);
  if (!coerced) return null;
  let [left, top, right, bottom] = normalizeRect(coerced);
  const maxW = Number(viewport?.width);
  const maxH = Number(viewport?.height);
  if (Number.isFinite(maxW) && maxW > 0) {
    left = Math.max(0, Math.min(maxW, left));
    right = Math.max(0, Math.min(maxW, right));
  }
  if (Number.isFinite(maxH) && maxH > 0) {
    top = Math.max(0, Math.min(maxH, top));
    bottom = Math.max(0, Math.min(maxH, bottom));
  }
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height };
}
