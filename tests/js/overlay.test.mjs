import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RegionCache } from "../../src/core/cache.js";
import { RENDER_HELPER_NAME } from "../../src/zotero/realm-render.js";
import {
  canvasConnected,
  ERROR_CLASS,
  PageOverlay,
  getWarnLog,
  isProvisionalDocumentId,
  realmStamp,
  resetWarnOnce,
  resolveDocumentId,
  warnOnce,
} from "../../src/zotero/overlay.js";

/** Minimal canvas element: style object plus a class set, no pixels needed. */
function fakeCanvasElement() {
  const classes = new Set();
  return {
    style: {},
    width: 0,
    height: 0,
    parentNode: null,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    getContext() {
      return {
        setTransform() {},
        clearRect() {},
        fillRect() {},
        fillStyle: "",
      };
    },
  };
}

/**
 * A page overlay whose pdf.js render either resolves or rejects, so the paint
 * error handling can be asserted without a browser.
 */
function fakeOverlay({ rejectWith = null, host = null } = {}) {
  const innerWin = {
    devicePixelRatio: 2,
    document: { createElement: () => fakeCanvasElement() },
  };
  const pageView = {
    id: 5,
    div: host ?? { style: {}, appendChild() {} },
    viewport: {
      scale: 1,
      width: 612,
      height: 792,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      transform: [1, 0, 0, -1, 0, 792],
      convertToViewportPoint: (x, y) => [x, 792 - y],
    },
    pdfPage: {
      getViewport: ({ scale = 1, rotation = 0 }) => ({
        scale,
        rotation,
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
      }),
      render: () => ({
        promise: rejectWith ? Promise.reject(rejectWith) : Promise.resolve(),
        cancel() {},
      }),
    },
  };
  const overlay = new PageOverlay({
    pageView,
    innerWin,
    documentId: "doc-test",
    regionCache: new RegionCache(),
  });
  return overlay;
}

describe("overlay: failed region paint", () => {
  it("hides the canvas and records the reason when the render task rejects", async () => {
    resetWarnOnce();
    const overlay = fakeOverlay({ rejectWith: new Error("boom") });
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(overlay.canvases.length, 1);
    assert.equal(overlay.canvases[0].classList.contains(ERROR_CLASS), true);
    assert.equal(overlay.canvases[0].style.visibility, "hidden", "a white block must not cover the figure");
    assert.equal(overlay.lastPaintError, "render: boom");
  });

  it("shows the canvas and clears nothing when the render task resolves", async () => {
    resetWarnOnce();
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(overlay.canvases[0].classList.contains(ERROR_CLASS), false);
    assert.equal(overlay.canvases[0].style.visibility, "visible");
    assert.equal(overlay.lastPaintError, null);
  });
});

describe("overlay: realm handoff", () => {
  /** Stand-ins for the reader realm: objects minted here are "realm-native". */
  class RealmObject {}

  class RealmElement {
    constructor() {
      this.style = {};
      this.width = 0;
      this.height = 0;
      this.dataset = {};
      this.parentNode = null;
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        contains: (name) => this.classes.has(name),
      };
    }

    getContext() {
      return { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
    }
  }

  function realmOverlay({ withRealmObject = true } = {}) {
    const events = [];
    const seen = { tags: [], elements: [], viewportOptions: [], params: [], rawViewports: [] };
    const innerWin = {
      devicePixelRatio: 1,
      Object: withRealmObject ? RealmObject : undefined,
      document: {
        createElement: (tag) => {
          seen.tags.push(tag);
          const element = new RealmElement();
          seen.elements.push(element);
          return element;
        },
      },
    };
    let renders = 0;
    const pageView = {
      id: 5,
      div: { style: {}, appendChild(child) { child.parentNode = this; } },
      viewport: {
        scale: 1,
        width: 612,
        height: 792,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: [1, 0, 0, -1, 0, 792],
        convertToViewportPoint: (x, y) => [x, 792 - y],
      },
      pdfPage: {
        getViewport(options) {
          seen.viewportOptions.push(options);
          const viewport = {
            scale: options.scale,
            rotation: options.rotation ?? 0,
            width: 612,
            height: 792,
            transform: [1, 0, 0, -1, 0, 792],
          };
          seen.rawViewports.push(viewport);
          return viewport;
        },
        render(params) {
          const index = renders;
          renders += 1;
          seen.params.push(params);
          events.push(`render-start:${index}`);
          // The first task settles last, so a parallel paint would interleave.
          const waitMs = Math.max(0, (2 - index) * 5);
          return {
            promise: new Promise((resolve) => {
              setTimeout(() => {
                events.push(`settle:${index}`);
                resolve();
              }, waitMs);
            }),
            cancel() {},
          };
        },
      },
    };
    const overlay = new PageOverlay({
      pageView,
      innerWin,
      documentId: "doc-realm",
      regionCache: new RegionCache(),
    });
    return { overlay, events, seen };
  }

  it("mints overlay canvases in the reader realm document", async () => {
    resetWarnOnce();
    const { overlay, seen } = realmOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.deepEqual(seen.tags, ["canvas"], "createElement runs on the realm document");
    assert.equal(overlay.canvases[0], seen.elements[0]);
    assert.equal(overlay.canvases[0] instanceof RealmElement, true, "the render target is a realm element");
  });

  it("hands pdf.js realm-built parameter objects", async () => {
    resetWarnOnce();
    const { overlay, seen } = realmOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(seen.viewportOptions.length, 1);
    assert.equal(seen.viewportOptions[0] instanceof RealmObject, true, "viewport options carry the realm Object");
    assert.equal(Number.isFinite(seen.viewportOptions[0].scale), true);
    assert.equal(seen.params.length, 1);
    const params = seen.params[0];
    assert.equal(params instanceof RealmObject, true, "params must be readable by pdf.js in its own realm");
    assert.ok(params.canvasContext, "canvasContext reaches the render call");
    assert.ok(params.viewport);
    assert.equal(params.transform.length, 6);
    assert.equal(params.viewport, seen.rawViewports[0],
      "params.viewport is the realm viewport pdfPage.getViewport returned, never the local copy");
  });

  it("falls back to a sandbox object when the realm exposes no Object", async () => {
    resetWarnOnce();
    const { overlay, seen } = realmOverlay({ withRealmObject: false });
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(seen.params.length, 1);
    assert.equal(seen.params[0] instanceof RealmObject, false);
    assert.equal(typeof seen.params[0], "object");
    assert.ok(seen.params[0].canvasContext);
  });

  it("waits for each render task before starting the next region", async () => {
    resetWarnOnce();
    const { overlay, events } = realmOverlay();
    await overlay.paintRegions([[100, 600, 300, 700], [100, 480, 300, 580]]);
    assert.deepEqual(events, ["render-start:0", "settle:0", "render-start:1", "settle:1"],
      "one render task at a time, even when the first settles last");
    assert.equal(overlay.lastPaintError, null);
    assert.equal(overlay.canvases[0].classList.contains(ERROR_CLASS), false);
    assert.equal(overlay.canvases[1].classList.contains(ERROR_CLASS), false);
  });

  it("stamps painted canvases with the realm and document provenance", async () => {
    resetWarnOnce();
    const { overlay } = realmOverlay();
    overlay.docId = "fcp:stamp";
    await overlay.paintRegions([[100, 600, 300, 700]]);
    const canvas = overlay.canvases[0];
    assert.equal(canvas.dataset.fcpRealm, realmStamp(overlay.innerWin), "the canvas says which realm handed it out");
    assert.equal(canvas.dataset.fcpDoc, "fcp:stamp", "and which document's regions it shows");

    // Write-once: a reused canvas keeps the provenance of the pass that created it.
    overlay.docId = "fcp:later";
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(overlay.canvases[0], canvas, "the second pass reuses the canvas");
    assert.equal(canvas.dataset.fcpDoc, "fcp:stamp", "so the stamp still names the creating document");

    // Rewrite: a stale realm stamp is corrected in place, the document stamp is not.
    canvas.dataset.fcpRealm = "fcp:realm-stale";
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(canvas.dataset.fcpRealm, realmStamp(overlay.innerWin), "the stale realm stamp is rewritten to the realm that paints now");
    assert.equal(canvas.dataset.fcpDoc, "fcp:stamp", "the document stamp survives the rewrite unchanged");
  });
});

describe("overlay: warnOnce diagnostics", () => {
  it("names the throw site in the ring entry", () => {
    resetWarnOnce();
    warnOnce("page-paint", new Error("boom"));
    const log = getWarnLog();
    assert.equal(log.length, 1);
    assert.match(log[0], /^page-paint: boom @ \S/);
    assert.equal(log[0].includes("\n"), false, "one ring entry stays one line");
  });

  it("reads the SpiderMonkey stack format too", () => {
    resetWarnOnce();
    const err = { message: "forbidden", stack: "TypeError: forbidden\npaintOverlay@resource://zotero/x.js:10:3\n" };
    warnOnce("page-paint", err);
    assert.deepEqual(getWarnLog(), ["page-paint: forbidden @ paintOverlay@resource://zotero/x.js:10:3"]);
  });

  it("keeps a plain entry without a stack and clears on reset", () => {
    resetWarnOnce();
    warnOnce("render-region", { message: "no stack" });
    assert.deepEqual(getWarnLog(), ["render-region: no stack"]);
    resetWarnOnce();
    assert.deepEqual(getWarnLog(), []);
  });
});

describe("overlay: viewer-realm helper paint", () => {
  /**
   * An overlay whose inner window can carry the realm helper. `eval` is a real
   * direct eval, so `RENDER_HELPER_SRC` compiles and the realm ends up owning the
   * function; `withEval: false` stands in for a realm that refuses it (no
   * `'unsafe-eval'`), which must keep the legacy route working.
   */
  function realmOverlay({ rejectWith = null, withEval = true, onRender = null } = {}) {
    const contexts = [];
    const innerWin = {
      devicePixelRatio: 2,
      document: {
        createElement: () => {
          const canvas = fakeCanvasElement();
          let context = null;
          // Like a real canvas: the same 2D context on every call.
          canvas.getContext = () => {
            if (!context) {
              context = { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
              contexts.push(context);
            }
            return context;
          };
          return canvas;
        },
      },
    };
    if (withEval) {
      innerWin.eval = (source) => {
        const window = innerWin;
        return eval(source);
      };
    }
    const renderCalls = [];
    let renders = 0;
    const pageView = {
      id: 5,
      div: { style: {}, appendChild() {} },
      viewport: {
        scale: 1,
        width: 612,
        height: 792,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: [1, 0, 0, -1, 0, 792],
        convertToViewportPoint: (x, y) => [x, 792 - y],
      },
      pdfPage: {
        getViewport: ({ scale = 1, rotation = 0 }) => ({
          scale,
          rotation,
          width: 612 * scale,
          height: 792 * scale,
          transform: [scale, 0, 0, -scale, 0, 792 * scale],
        }),
        render(params) {
          renders += 1;
          renderCalls.push(params);
          if (rejectWith) return { promise: Promise.reject(rejectWith), cancel() {} };
          if (onRender) return onRender(renders);
          return { promise: Promise.resolve(), cancel() {} };
        },
      },
    };
    const overlay = new PageOverlay({
      pageView,
      innerWin,
      documentId: "doc-realm",
      regionCache: new RegionCache(),
      tag: "realm-test",
    });
    return { overlay, innerWin, renderCalls, contexts };
  }

  const REGION = [100, 600, 300, 700];

  it("paints through the realm helper and reports the path", async () => {
    resetWarnOnce();
    const { overlay, innerWin, renderCalls, contexts } = realmOverlay();
    await overlay.paintRegions([REGION]);

    assert.equal(overlay.paintPath, "helper", "the render call ran inside the viewer realm");
    assert.equal(overlay.lastPaintError, null);
    assert.equal(typeof innerWin[RENDER_HELPER_NAME], "function", "the realm owns the helper");

    assert.equal(renderCalls.length, 1);
    const params = renderCalls[0];
    assert.equal(params.canvasContext, contexts[0], "the context was created in the realm");
    assert.ok(Array.isArray(params.transform), "the transform must be a realm-native array");
    assert.deepEqual(params.transform.slice(0, 4), [1, 0, 0, 1]);
    assert.equal(Number.isFinite(params.transform[4]) && Number.isFinite(params.transform[5]), true);
    assert.equal(params.canvasContext.skipBlender, true, "skipBlender is set inside the realm before render()");
    assert.equal(overlay.canvases[0].classList.contains(ERROR_CLASS), false);
    assert.equal(overlay.canvases[0].style.visibility, "visible");
  });

  it("awaits each realm task before starting the next region", async () => {
    resetWarnOnce();
    const events = [];
    const { overlay } = realmOverlay({
      onRender: (count) => ({
        cancel() {},
        promise: Promise.resolve().then(() => { events.push(`settled:${count}`); }),
        started: (events.push(`start:${count}`), count),
      }),
    });
    await overlay.paintRegions([REGION, [100, 500, 300, 600]]);
    assert.deepEqual(events, ["start:1", "settled:1", "start:2", "settled:2"], "one render task at a time per page");
  });

  it("hands the realm task to the cancel list", async () => {
    resetWarnOnce();
    let cancelled = 0;
    const { overlay } = realmOverlay({ onRender: () => ({ cancel: () => { cancelled += 1; }, promise: Promise.resolve() }) });
    await overlay.paintRegions([REGION]);
    assert.equal(overlay.tasks.length, 1);
    overlay.cancel();
    assert.equal(cancelled, 1, "the realm's RenderTask is cancellable");
  });

  it("records the failure and hides the canvas when the realm task rejects", async () => {
    resetWarnOnce();
    const { overlay } = realmOverlay({ rejectWith: new Error("realm boom") });
    await overlay.paintRegions([REGION]);
    assert.equal(overlay.paintPath, "helper");
    assert.equal(overlay.lastPaintError, "render: realm boom");
    assert.equal(overlay.canvases[0].classList.contains(ERROR_CLASS), true);
    assert.equal(overlay.canvases[0].style.visibility, "hidden");
  });

  it("falls back to the legacy path when the realm refuses eval", async () => {
    resetWarnOnce();
    const { overlay, innerWin, renderCalls, contexts } = realmOverlay({ withEval: false });
    await overlay.paintRegions([REGION]);

    assert.equal(overlay.paintPath, "legacy", "no helper, so core/render.js paints");
    assert.equal(innerWin[RENDER_HELPER_NAME], undefined, "nothing was injected");
    assert.equal(renderCalls.length, 1);
    assert.equal(overlay.lastPaintError, null);
    assert.equal(contexts[0].skipBlender, true, "the legacy path still writes skipBlender before render()");
    assert.equal(overlay.canvases[0].style.visibility, "visible");
  });
});

describe("overlay: stale geometry after a toolbar toggle", () => {
  it("reports nothing stale before the first paint", () => {
    const overlay = fakeOverlay();
    assert.equal(overlay.lastPaintGeometry, null);
    assert.equal(overlay.geometryStale(), false, "no snapshot, so a settled re-paint would be wasted work");
  });

  it("reports nothing stale while the viewport is unchanged", async () => {
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    assert.equal(overlay.lastPaintGeometry.viewportWidth, 612);
    assert.equal(overlay.lastPaintGeometry.viewportHeight, 792);
    assert.equal(overlay.lastPaintGeometry.viewportScale, 1);
    assert.equal(overlay.lastPaintGeometry.viewportRotation, 0);
    assert.equal(overlay.lastPaintGeometry.deviceScale, 2);
    assert.equal(overlay.geometryStale(), false);
  });

  it("reports stale when a relayout changed the viewport size", async () => {
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    overlay.pageView.viewport.width = 700;
    assert.equal(overlay.geometryStale(), true, "fit-width grew the page, so the canvases are the wrong size");
  });

  it("reports stale when the scale changed at the same size", async () => {
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    overlay.pageView.viewport.scale = 1.5;
    assert.equal(overlay.geometryStale(), true, "the scale is compared too, so a compensated rotation cannot hide a stale paint");
  });

  it("treats unreadable geometry as fresh instead of forcing a re-paint", async () => {
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);

    overlay.pageView.viewport = undefined;
    assert.equal(overlay.geometryStale(), false, "a missing viewport must not be read as a change");

    Object.defineProperty(overlay.pageView, "viewport", {
      get() {
        throw new Error("cross-realm read failed");
      },
    });
    assert.equal(overlay.geometryStale(), false, "a throwing read must not be read as a change either");
  });
});

describe("overlay: provisional document ids", () => {
  it("reads the WeakMap fallback as provisional and printed keys as final", () => {
    assert.equal(isProvisionalDocumentId("fcp:doc-1"), true, "the fallback mints fcp:doc-N");
    assert.equal(isProvisionalDocumentId("fcp:doc-42"), true);
    assert.equal(isProvisionalDocumentId("fcp:8a2fe8c9a3c84b0e9e1e3f8a9b0c1d2e"), false, "a fingerprint is final");
    assert.equal(isProvisionalDocumentId("fcp:pdfjs_file.pdf:1:1"), false, "a loading-task doc id is final");
    assert.equal(isProvisionalDocumentId("fcp:doc-1x"), false, "the key must be the whole string");
    assert.equal(isProvisionalDocumentId(null), false, "no key is not a provisional key");
    assert.equal(isProvisionalDocumentId(undefined), false);
  });

  it("keys the fallback per document object, so a fresh wrapper re-mints", () => {
    const first = {};
    const second = {};
    const id = resolveDocumentId(first);
    assert.equal(isProvisionalDocumentId(id), true, "an object-only document gets a fallback key");
    assert.equal(resolveDocumentId(first), id, "the same object keeps its key");
    assert.notEqual(resolveDocumentId(second), id, "a fresh wrapper object mints a new key");
    assert.equal(resolveDocumentId(null), null, "no document, no key");
  });
});


describe("overlay: mount integrity", () => {
  it("treats an unknown connectivity flag as connected", () => {
    assert.equal(canvasConnected(null, null), true, "a stand-in that reports nothing must not look detached");
    assert.equal(canvasConnected({ isConnected: false }, { isConnected: true }), false, "the canvas answer wins");
    assert.equal(canvasConnected({}, { isConnected: false }), false, "otherwise the host answer is used");
    assert.equal(canvasConnected({}, {}), true, "and no flag at all is no alarm");
  });

  it("reports a detached host instead of a clean paint", async () => {
    resetWarnOnce();
    const host = { style: {}, isConnected: false, appendChild() {} };
    const overlay = fakeOverlay({ host });

    await overlay.paintRegions([[100, 600, 300, 700]]);

    assert.equal(overlay.lastPaintError, "mount: host detached", "pixels nobody can see are not a clean paint");
    assert.equal(overlay.mountDetached, true, "the pass says its canvases were out of the live DOM");
    assert.equal(overlay.connectedCount, 0, "so no canvas of this page counts as mounted");
    assert.equal(overlay.isMounted(), false);
  });

  it("re-mounts a canvas the viewer threw out and reports a clean paint", async () => {
    resetWarnOnce();
    const overlay = fakeOverlay();
    await overlay.paintRegions([[100, 600, 300, 700]]);
    const canvas = overlay.canvases[0];
    assert.equal(overlay.isMounted(), true, "the connected host keeps its canvas mounted");

    canvas.isConnected = false;
    assert.equal(overlay.isMounted(), false, "a canvas the viewer dropped is out of the live page");
    assert.equal(overlay.connectedCount, 0, "and it counts as nothing");

    overlay.pageView.div = {
      style: {},
      isConnected: true,
      appendChild(element) {
        element.isConnected = true;
      },
    };
    await overlay.paintRegions(overlay.regionBoxes);

    assert.equal(overlay.lastPaintError, null, "the repaint put the canvas back and stayed clean");
    assert.equal(overlay.mountDetached, false, "so the mount is whole again");
    assert.equal(overlay.isMounted(), true, "the visible page has the canvas again");
    assert.equal(overlay.connectedCount, 1);
  });

  it("refuses a host that left the document as a positioning context", () => {
    resetWarnOnce();
    const overlay = fakeOverlay();
    assert.equal(overlay.ensureHostPositioning(), true, "a connected div accepts the positioning write");
    overlay.pageView.div.isConnected = false;
    assert.equal(overlay.ensureHostPositioning(), false, "a div out of the DOM is not a usable host");
  });

  it("deduplicates concurrent in-flight detect() calls for the same document key", async () => {
    resetWarnOnce();
    let opCalls = 0;
    let releaseOps;
    const gate = new Promise((resolve) => {
      releaseOps = resolve;
    });
    const overlay = fakeOverlay();
    overlay.pageView.pdfPage.getOperatorList = async () => {
      opCalls += 1;
      await gate;
      return { fnArray: [], argsArray: [] };
    };
    overlay.pageView.pdfPage.getTextContent = async () => ({ items: [] });

    const first = overlay.detect();
    const second = overlay.detect();
    releaseOps();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(opCalls, 1, "getOperatorList runs once instead of invalidating and repeating");
    assert.deepEqual(a.regions, b.regions);
  });
});
