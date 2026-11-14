/**
 * Renders one page region into its own canvas with original PDF colors.
 *
 * The overlay canvas is painted by a normal `PDFPageProxy.render()` call using a
 * translated viewport, so pdf.js clips the page to the requested region without
 * any modification of the PDF.
 */

import { overlayGeometry } from "./viewport.js";

/**
 * The object property writes should target for one minted parameter object.
 *
 * A realm object built through `paramsFactory` reaches the sandbox behind an
 * Xray wrapper, and Gecko refuses to define a cross-origin object value on
 * that wrapper: "Not allowed to define cross-origin object as property on
 * [Object] or [Array] XrayWrapper". Primitive writes are always accepted, but
 * the render parameters carry object values (canvas context, viewport,
 * transform array), so the writes go through `wrappedJSObject` — the
 * documented Xray waiver — when it exists. A plain sandbox object has none
 * and keeps the direct write, so the offline path is unchanged.
 *
 * @param {object} paramsObj A freshly minted parameter object.
 * @returns {object} The object property writes should target.
 */
function paramsSink(paramsObj) {
  try {
    const inner = paramsObj?.wrappedJSObject;
    if (inner) return inner;
  } catch (err) {
    // A locked-down object can throw on reading the waiver itself.
  }
  return paramsObj;
}

/**
 * @param {object} input
 * @param {object} input.pdfPage pdf.js `PDFPageProxy`.
 * @param {object} [input.canvas] Target canvas; resized to the region raster size.
 * @param {number[]} input.region User-space rect.
 * @param {object} input.viewport Viewport at display scale (CSS pixels).
 * @param {number} [input.deviceScale]
 * @param {number} [input.padViewport] Padding in CSS pixels.
 * @param {string|null} [input.background] Canvas background, white by default.
 * @param {object} [input.renderOptions] Extra pdf.js render parameters.
 * @param {() => object} [input.paramsFactory] Builds the objects pdf.js reads
 *   (viewport options, render params). pdf.js runs in the reader realm and only
 *   sees native properties there, so a Zotero overlay passes a factory that
 *   mints realm objects; the sandbox default keeps the old plain-object shape.
 * @param {(task: object) => void} [input.onTask] Receives the render task so the
 *   caller can cancel it.
 * @returns {Promise<{geometry: object, viewport: object, task: object}>}
 */
export async function renderRegion(input) {
  const {
    pdfPage,
    canvas,
    region,
    viewport,
    deviceScale = 1,
    padViewport = 0,
    rotation = 0,
    background = "#ffffff",
    renderOptions = {},
    paramsFactory = null,
    onTask,
  } = input;
  const newParams = paramsFactory ?? (() => ({}));

  if (!pdfPage) throw new TypeError("renderRegion: pdfPage is required");
  if (!Array.isArray(region)) throw new TypeError("renderRegion: region is required");

  const geometry = overlayGeometry({ region, viewport, padViewport, deviceScale, rotation });
  // The render viewport must carry the same rotation as the display viewport,
  // otherwise a rotated page renders unrotated into a swapped-size canvas.
  // Both option objects come from `newParams` so a Zotero overlay can hand
  // pdf.js realm-native objects instead of sandbox plain objects.
  const viewportOptions = newParams();
  viewportOptions.scale = geometry.renderScale;
  viewportOptions.rotation = viewport.rotation ?? rotation;
  const renderViewport = pdfPage.getViewport(viewportOptions);
  let target = canvas;
  if (!target) {
    throw new TypeError("renderRegion: canvas is required");
  }
  if (target.width !== geometry.canvasWidth) target.width = geometry.canvasWidth;
  if (target.height !== geometry.canvasHeight) target.height = geometry.canvasHeight;

  const ctx = target.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, target.width, target.height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, target.width, target.height);
  }

  const params = newParams();
  // Every value written here goes through the waived channel: the canvas
  // context and the sandbox-side transform are foreign objects for a realm
  // Xray wrapper, and defining them directly is what v0.1.13 threw on.
  const sink = paramsSink(params);
  sink.canvasContext = ctx;
  sink.viewport = renderViewport;
  sink.transform = geometry.renderTransform;
  for (const [key, value] of Object.entries(renderOptions)) sink[key] = value;
  const task = pdfPage.render(params);
  onTask?.(task);
  await task.promise;
  return { geometry, viewport: renderViewport, task, context: ctx };
}
