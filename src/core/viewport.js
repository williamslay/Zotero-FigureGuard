/**
 * User space -> viewport (CSS pixel) geometry.
 *
 * pdf.js changed this API: `convertToViewportRectangle()` exists up to pdf.js 5
 * and is gone in 6.x, while `convertToViewportPoint()` has been stable. The
 * overlay therefore uses its own rect conversion on top of the point helper and
 * falls back to the viewport transform matrix when needed.
 */

import { normalizeRect } from "./geom.js";

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
