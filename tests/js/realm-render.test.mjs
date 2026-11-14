import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RENDER_HELPER_NAME,
  RENDER_HELPER_SRC,
  ensureRenderHelper,
  renderRegionViaHelper,
  resetRenderHelperCache,
} from "../../src/zotero/realm-render.js";
import { getWarnLog, resetWarnOnce } from "../../src/zotero/overlay.js";

/**
 * Viewer-realm stand-in. `eval` compiles the real helper source with `window`
 * bound to `realm`, so the expando lands on `realm` — the split Zotero's Xray
 * wrapper creates. `injectCount` counts source evaluations, so caching is visible.
 *
 * @param {object} [options] `realm`: where the expando goes (defaults to the
 *   window itself, i.e. no wrapper). `evalThrows`: no `'unsafe-eval'`.
 */
function makeWindow({ realm = null, evalThrows = false } = {}) {
  const target = realm ?? undefined;
  const win = { injectCount: 0, typeofCount: 0 };
  const store = () => (target === undefined ? win : target);
  win.eval = (source) => {
    win.injectCount += 1;
    if (evalThrows) {
      const error = new Error("Content Security Policy: script evaluation refused");
      error.name = "EvalError";
      throw error;
    }
    if (source.startsWith("typeof")) {
      win.typeofCount += 1;
      win.injectCount -= 1;
      return typeof store()[RENDER_HELPER_NAME];
    }
    new Function("window", source)(store());
    return undefined;
  };
  return { win, realm: store() };
}

/** Canvas stand-in that records the calls the realm makes on it. */
function makeCanvas({ context = {} } = {}) {
  const ctx = {
    ops: [],
    save() {},
    restore() {},
    clearRect(...a) { this.ops.push(`clearRect:${a.join(",")}`); },
    setTransform(...a) { this.ops.push(`setTransform:${a.join(",")}`); },
    fillRect(...a) { this.ops.push(`fillRect:${a.join(",")}`); },
    ...context,
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return { canvas, ctx };
}

/** pdf.js `PDFPageProxy` stand-in; records the parameter object it receives. */
function makePage({ task = null, renderThrows = false } = {}) {
  const page = {
    viewportCalls: [],
    params: null,
    getViewport(options) {
      page.viewportCalls.push(options);
      return { width: options.scale, height: options.scale, rotation: options.rotation ?? 0 };
    },
    render(params) {
      page.params = params;
      if (renderThrows) throw new Error("nope");
      return task;
    },
  };
  return page;
}

const GEOMETRY = { canvasWidth: 120, canvasHeight: 90, renderScale: 2, renderTransform: [1, 0, 0, 1, 4.5, 0] };

describe("realm-render: helper injection", () => {
  it("injects the source once and hands back a callable", () => {
    resetRenderHelperCache();
    const { win, realm } = makeWindow();

    const helper = ensureRenderHelper(win, "probe");
    assert.equal(typeof helper, "function");
    assert.equal(realm[RENDER_HELPER_NAME], helper);
    assert.equal(win.injectCount, 1, "one source evaluation");
    assert.equal(win.typeofCount, 1, "existence proven by typeof, not by reading the expando");

    assert.equal(ensureRenderHelper(win, "probe"), helper);
    assert.equal(win.injectCount, 1, "the second call comes from the per-window cache");
  });

  it("proves existence with typeof rather than an expando read", () => {
    resetRenderHelperCache();
    const { win, realm } = makeWindow();
    // An Xray surface: `eval` and the waiver are visible, the expando is not.
    const view = { eval: win.eval, wrappedJSObject: realm };
    view.eval = win.eval;

    const helper = ensureRenderHelper(view, "paint");
    assert.equal(typeof helper, "function", "the realm has the function even where the read is wrapped");
    assert.equal(realm[RENDER_HELPER_NAME], helper);
  });

  it("returns null and logs once when the realm refuses eval", () => {
    resetRenderHelperCache();
    resetWarnOnce();
    const { win } = makeWindow({ evalThrows: true });
    assert.equal(ensureRenderHelper(win, "probeAll"), null);
    assert.equal(ensureRenderHelper(win, "probeAll"), null);
    assert.equal(win.injectCount, 1, "a refused eval is remembered, not retried per paint");

    const logs = getWarnLog();
    assert.equal(logs.length, 1, "the Content-Security-Policy refusal is logged once per window");
    assert.match(logs[0], /render-helper-eval:probeAll/);
    assert.match(logs[0], /Content Security Policy/);
  });

  it("returns null when no read channel reaches the injected function", () => {
    resetRenderHelperCache();
    resetWarnOnce();
    const { win } = makeWindow();
    // A realm that has the function but exposes neither the property nor a waiver.
    const view = { eval: win.eval };
    assert.equal(ensureRenderHelper(view, "paint"), null);

    const logs = getWarnLog();
    assert.equal(logs.length, 1);
    assert.match(logs[0], /render-helper-unreachable:paint/);
    assert.match(logs[0], /no read channel/);
  });

  it("returns null without a window", () => {
    resetRenderHelperCache();
    assert.equal(ensureRenderHelper(null), null);
    assert.equal(ensureRenderHelper(undefined), null);
    assert.equal(ensureRenderHelper(42), null);
  });
});

describe("realm-render: helper signature", () => {
  it("takes only primitives plus the pdfPage and the canvas", () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    assert.equal(helper.length, 9, "pdfPage, canvas, then seven primitives");
    assert.match(RENDER_HELPER_SRC, /^window\.__fcpRenderRegion = function \(pdfPage, canvas, /);
  });

  it("builds the render parameters inside the realm and starts the task", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas, ctx } = makeCanvas();
    const task = { promise: Promise.resolve() };
    const page = makePage({ task });

    const result = await renderRegionViaHelper(helper, {
      pdfPage: page,
      canvas,
      geometry: GEOMETRY,
      rotation: 90,
      background: "#fff",
    });

    assert.equal(page.viewportCalls.length, 1);
    assert.deepEqual(page.viewportCalls[0], { scale: 2, rotation: 90 });
    assert.equal(canvas.width, 120, "the buffer size comes from the sandbox geometry as a number");
    assert.equal(canvas.height, 90);
    assert.deepEqual(ctx.ops, [
      "setTransform:1,0,0,1,0,0",
      "clearRect:0,0,120,90",
      "fillRect:0,0,120,90",
    ], "the canvas is reset by realm-side code");

    const params = page.params;
    assert.equal(params.canvasContext, ctx, "the context was created inside the realm");
    assert.equal(params.viewport.width, 2, "the viewport came from pdfPage.getViewport");
    assert.equal(params.viewport.rotation, 90);
    assert.ok(Array.isArray(params.transform), "the transform must be a realm-native array");
    assert.equal(params.transform.constructor.name, "Array");
    assert.deepEqual(params.transform, [1, 0, 0, 1, 4.5, 0], "the translation comes in as two numbers");
    assert.equal(ctx.skipBlender, true, "skipBlender is set before pdfPage.render runs");

    assert.equal(result.task, task);
    assert.equal(result.done, task.promise, "the awaited value is the task's own promise");
  });

  it("awaits task.finished when the fork exposes it", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas } = makeCanvas();
    const finished = Promise.resolve({ success: true });
    const page = makePage({ task: { finished, promise: Promise.resolve() } });

    const result = await renderRegionViaHelper(helper, { pdfPage: page, canvas, geometry: GEOMETRY });
    assert.equal(result.done, finished, "a settling `finished` is preferred over a rejecting `promise`");
  });

  it("surfaces a render failure instead of a white canvas", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas } = makeCanvas();
    const failure = new Error("too much drawing");
    const page = makePage({ task: { promise: Promise.resolve({ success: false, exception: failure }) } });

    await assert.rejects(
      renderRegionViaHelper(helper, { pdfPage: page, canvas, geometry: GEOMETRY }),
      /too much drawing/,
    );
  });

  it("rejects when the realm could not start a task", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas } = makeCanvas();

    await assert.rejects(
      renderRegionViaHelper(helper, { pdfPage: makePage({ task: null }), canvas, geometry: GEOMETRY }),
      /no render promise/,
    );
  });

  it("hands the task to the caller so it can be cancelled", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas } = makeCanvas();
    const task = { promise: Promise.resolve() };
    const seen = [];

    await renderRegionViaHelper(helper, {
      pdfPage: makePage({ task }),
      canvas,
      geometry: GEOMETRY,
      onTask: (value) => seen.push(value),
    });
    assert.deepEqual(seen, [task]);
  });

  it("rejects on arguments the call cannot work without", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas } = makeCanvas();
    const page = makePage({ task: { promise: Promise.resolve() } });

    await assert.rejects(renderRegionViaHelper(null, { pdfPage: page, canvas, geometry: GEOMETRY }), /helper/);
    await assert.rejects(renderRegionViaHelper(helper, { canvas, geometry: GEOMETRY }), /pdfPage/);
    await assert.rejects(renderRegionViaHelper(helper, { pdfPage: page, geometry: GEOMETRY }), /canvas/);
    await assert.rejects(
      renderRegionViaHelper(helper, { pdfPage: page, canvas, geometry: { ...GEOMETRY, renderTransform: [1, 0] } }),
      /geometry/,
    );
  });

  it("defaults the background to white", async () => {
    resetRenderHelperCache();
    const { win } = makeWindow();
    const helper = ensureRenderHelper(win);
    const { canvas, ctx } = makeCanvas();
    const page = makePage({ task: { promise: Promise.resolve() } });

    await renderRegionViaHelper(helper, { pdfPage: page, canvas, geometry: GEOMETRY });
    assert.ok(ctx.ops.some((op) => op.startsWith("fillRect:")), "a blank canvas would read as a white figure");
    assert.equal(ctx.fillStyle, "#ffffff");
  });
});
