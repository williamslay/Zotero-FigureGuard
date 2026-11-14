/**
 * Paints one overlay region inside the pdf.js viewer realm.
 *
 * Why this exists (v0.1.14, Zotero 10.0.8 Windows): the sandbox-side render call
 * reached pdf.js `beginDrawing` and died there —
 * `render: Permission denied to access property Symbol.iterator`, thrown at
 * `resource://zotero/reader/pdf/build/pdf.mjs:11490`. The value it iterated is
 * `params.transform`: a `number[]` made in the bootstrap sandbox, so spreading or
 * iterating it from the reader realm is an element access across the boundary,
 * which an Xray wrapper refuses. The two previous rounds fixed the property-write
 * direction (`paramsFactory`, then the `wrappedJSObject` waiver); the array
 * itself stays a foreign object either way, and the wrapper type itself is not
 * stable — `realm.route` measured across restarts drifts between `direct` and
 * `wrapped`. So a structural fix is used instead: the whole render call is moved
 * into the realm, where every value it touches is realm-native.
 *
 * The rule this module enforces: only primitives and realm objects cross the
 * boundary. The signature takes numbers and one background string plus the two
 * realm objects (`pdfPage`, `canvas`); the viewport, the canvas context, the
 * transform array and the render parameters are all built by code that runs in
 * the viewer realm; the result the sandbox reads back is a realm object carrying
 * the task and the promise it awaits.
 *
 * `ensureRenderHelper` installs the helper with `innerWin.eval`, the same channel
 * `main.js` uses for `VIEWER_BRIDGE_SRC`. Existence is verified by evaluating a
 * `typeof` expression in the realm rather than by reading the expando back: an
 * Xray wrapper can hide a JS-defined window property, so a read of
 * `innerWin.__fcpRenderRegion` proves nothing on its own. The function value is
 * then resolved over both read channels (direct, then `wrappedJSObject`), because
 * the wrapper is the thing that drifts.
 */

import { warnOnce } from "./overlay.js";

/** Window property the helper source installs in the viewer realm. */
export const RENDER_HELPER_NAME = "__fcpRenderRegion";

/**
 * The helper source, evaluated inside the viewer realm.
 *
 * Deliberately ES5-shaped with `var` and no closures over sandbox values, in the
 * style of `VIEWER_BRIDGE_SRC`, so it can be exercised against a fake `window`
 * from the sandbox: `new Function("window", RENDER_HELPER_SRC)(winLike)` runs the
 * real string. The canvas size arrives as numbers the sandbox computed, the
 * transform is built here so pdf.js iterates a realm array, and `skipBlender` is
 * set here — a realm-side write on a realm context, which is the only write the
 * fork's blender is sure to see.
 *
 * @type {string}
 */
export const RENDER_HELPER_SRC =
  "window.__fcpRenderRegion = function (pdfPage, canvas, bufWidth, bufHeight, renderScale, rotation, tx, ty, background) {" +
  "if (!pdfPage || !canvas) return null;" +
  "var viewport = pdfPage.getViewport({ scale: renderScale, rotation: rotation });" +
  "if (!viewport) return null;" +
  "canvas.width = bufWidth;" +
  "canvas.height = bufHeight;" +
  "var ctx = canvas.getContext('2d');" +
  "if (!ctx) return null;" +
  "ctx.setTransform(1, 0, 0, 1, 0, 0);" +
  "ctx.clearRect(0, 0, bufWidth, bufHeight);" +
  "if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, bufWidth, bufHeight); }" +
  "var transform = [1, 0, 0, 1, tx, ty];" +
  "var params = { canvasContext: ctx, viewport: viewport, transform: transform };" +
  "ctx.skipBlender = true;" +
  "var task = pdfPage.render(params);" +
  "if (!task) return null;" +
  "return { task: task, done: task.finished ?? task.promise };" +
  "};";

/**
 * The two channels by which the sandbox can read the installed function back,
 * in the order they are tried. `direct` is the plain property read; `wrapped` is
 * `wrappedJSObject`, the documented Xray waiver. One of the two is what a given
 * startup gives, and which one it is has been measured to change between runs,
 * so both are always tried.
 *
 * @type {Array<[string, (win: object) => *]>}
 */
const HELPER_CHANNELS = [
  ["direct", (win) => win[RENDER_HELPER_NAME]],
  ["wrapped", (win) => win.wrappedJSObject?.[RENDER_HELPER_NAME]],
];

/**
 * Per-window injection result: the callable plus the channel it came from, or
 * null when this window is known not to carry the helper. Weakly keyed, so a
 * closed reader releases its entry without teardown code, and a failed injection
 * (blocked `eval`, no realm function) is remembered instead of retried per paint.
 *
 * @type {WeakMap<object, {fn: Function, channel: string}|null>}
 */
let helperCache = new WeakMap();

/**
 * Reads the installed helper back over one channel without throwing.
 *
 * @param {object} innerWin The viewer realm.
 * @param {string} channel One of the names in `HELPER_CHANNELS`.
 * @param {string} tag Reader label for the one-time warning.
 * @returns {{fn: Function, channel: string}|null}
 */
function readHelperChannel(innerWin, channel, tag) {
  const entry = HELPER_CHANNELS.find(([name]) => name === channel);
  if (!entry) return null;
  try {
    const fn = entry[1](innerWin);
    return typeof fn === "function" ? { fn, channel } : null;
  } catch (err) {
    warnOnce(`render-helper-read:${channel}`, err, tag || undefined);
    return null;
  }
}

/**
 * Evaluates the helper source in a realm and resolves the callable.
 *
 * @param {object} innerWin The viewer realm.
 * @param {string} tag Reader label for the one-time warnings.
 * @returns {{fn: Function, channel: string}|null} The helper, or null when this
 *   realm cannot carry it.
 */
function injectRenderHelper(innerWin, tag) {
  try {
    if (typeof innerWin.eval !== "function") {
      warnOnce("render-helper-no-eval", new Error("The viewer realm exposes no eval"), tag || undefined);
      return null;
    }
  } catch (err) {
    warnOnce("render-helper-no-eval", err, tag || undefined);
    return null;
  }
  try {
    innerWin.eval(RENDER_HELPER_SRC);
  } catch (err) {
    // A document Content-Security-Policy without 'unsafe-eval' lands here.
    warnOnce("render-helper-eval", err, tag || undefined);
    return null;
  }
  let present = null;
  try {
    present = innerWin.eval(`typeof window.${RENDER_HELPER_NAME}`);
  } catch (err) {
    warnOnce("render-helper-check", err, tag || undefined);
    return null;
  }
  if (present !== "function") {
    warnOnce(
      "render-helper-missing",
      new Error(`eval ran but ${RENDER_HELPER_NAME} is "${present}" in the viewer realm`),
      tag || undefined,
    );
    return null;
  }
  const direct = readHelperChannel(innerWin, "direct", tag) ?? readHelperChannel(innerWin, "wrapped", tag);
  if (!direct) {
    // The realm has the function and neither read reaches it: an Xray that hides
    // the expando and no usable waiver. The legacy path knows what to do.
    warnOnce("render-helper-unreachable", new Error(`eval installed ${RENDER_HELPER_NAME}, no read channel reaches it`), tag || undefined);
  }
  return direct;
}

/**
 * The paint helper of one viewer realm: injected once per window, resolved over
 * whichever read channel that window's wrapper allows.
 *
 * @param {object|null|undefined} innerWin The pdf.js viewer realm.
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {((...args: *) => object|null)|null} A callable that runs the render
 *   inside the realm, or null when the realm cannot carry it — the caller then
 *   uses `core/render.js renderRegion` with the sandbox-side parameter writes.
 */
export function ensureRenderHelper(innerWin, tag = "") {
  if (!innerWin || typeof innerWin !== "object") return null;
  let cached;
  try {
    cached = helperCache.get(innerWin);
  } catch (ignored) {
    cached = undefined;
  }
  if (cached !== undefined) return cached ? cached.fn : null;
  const resolved = injectRenderHelper(innerWin, tag);
  try {
    helperCache.set(innerWin, resolved);
  } catch (ignored) {
    // Not weakly referenceable; the helper still works for this call.
  }
  return resolved ? resolved.fn : null;
}

/**
 * Forgets every injected realm. Test-only: `WeakMap` has no `clear()`, so the
 * map itself is replaced. Production relies on the weak keys, and a stale entry
 * only ever costs one extra `eval`.
 */
export function resetRenderHelperCache() {
  helperCache = new WeakMap();
}

/**
 * Runs one region through the realm helper.
 *
 * Every argument handed to the helper is a primitive or already a realm object:
 * the sizes and the translation come from the sandbox geometry as numbers, and
 * `pdfPage` and `canvas` are the reader's own objects. The returned realm object
 * carries the render task, so the caller can cancel it, and the promise the
 * caller awaits — a cross-realm `await` is proven by the detection chain.
 *
 * @param {(pdfPage: object, canvas: object, bufWidth: number, bufHeight: number,
 *   renderScale: number, rotation: number, tx: number, ty: number,
 *   background: string|null) => object|null} helper The realm helper.
 * @param {object} input
 * @param {object} input.pdfPage pdf.js `PDFPageProxy` of the page view.
 * @param {object} input.canvas The realm canvas element to paint.
 * @param {object} input.geometry An `overlayGeometry()` result: `canvasWidth`,
 *   `canvasHeight`, `renderScale` and `renderTransform`.
 * @param {number} [input.rotation] Rotation of the display viewport.
 * @param {string|null} [input.background] Canvas background, white by default.
 * @param {(task: object) => void} [input.onTask] Receives the render task so the
 *   caller can cancel it.
 * @returns {Promise<object>} The realm result object (`{task, done}`).
 * @throws {TypeError} When an argument this call cannot work without is missing.
 */
export async function renderRegionViaHelper(helper, input) {
  const { pdfPage, canvas, geometry, rotation = 0, background = "#ffffff", onTask } = input ?? {};
  if (typeof helper !== "function") throw new TypeError("renderRegionViaHelper: helper is required");
  if (!pdfPage) throw new TypeError("renderRegionViaHelper: pdfPage is required");
  if (!canvas) throw new TypeError("renderRegionViaHelper: canvas is required");
  const transform = Array.isArray(geometry?.renderTransform) ? geometry.renderTransform : null;
  if (!transform || transform.length < 6) throw new TypeError("renderRegionViaHelper: geometry is required");

  const result = helper(
    pdfPage,
    canvas,
    Number(geometry.canvasWidth) || 1,
    Number(geometry.canvasHeight) || 1,
    Number(geometry.renderScale) || 1,
    Number(rotation) || 0,
    Number(transform[4]) || 0,
    Number(transform[5]) || 0,
    background ?? null,
  );
  const done = result?.done ?? null;
  if (!done) throw new Error("renderRegionViaHelper: the realm returned no render promise");
  const task = result?.task ?? null;
  if (task && onTask) onTask(task);
  const settled = await done;
  // `RenderTask.finished` resolves instead of rejecting, and reports the failure
  // in its value; `promise` rejects and settles to undefined. Handle both so a
  // render error cannot pass for a success.
  if (settled && typeof settled === "object" && settled.success === false) {
    throw settled.exception ?? new Error("renderRegionViaHelper: pdf.js rejected the render");
  }
  return result;
}
