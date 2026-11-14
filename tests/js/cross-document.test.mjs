/**
 * Offline regression tests for cross-document contamination between two readers
 * that share one pdf.js window.
 *
 * The symptom read off the real machine's probe (item 316 = document A,
 * `fcp:bd8e2cda…`; item 483 = document B, `fcp:3e708112…`): reader B's session
 * reports A's document id, its RegionCache key is `item:483|<A fingerprint>`,
 * and the regions painted on B are A's. Toggling the toolbar off and on, or
 * zooming, brings A's regions back, so the contamination survives a repaint.
 *
 * Assertions state the invariant the session has to hold, not today's
 * behaviour: a test current code cannot satisfy is the intended RED, and its
 * failure message records what the code does today.
 *
 *   T-A  the wake path re-keys the session (tab activation, realm re-evaluation)
 *   T-B  a document swap invalidates the PREVIOUS document's cache key
 *   T-C  an overlay inherits neither identity nor paint across a page-view swap
 *   T-D  a zoom repaint does not reuse the previous document's region boxes
 *   T-E  a paint that finishes after the identity changed is dropped
 *   T-F  two readers with the same printed fingerprint stay isolated
 *
 * Deterministic: the shared fake timer queue only, no real sleeping, no Zotero,
 * no pdf.js detection — the RegionCache is pre-seeded so `detect()` takes its
 * cache-hit path.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { RegionCache } from "../../src/core/cache.js";
import { PageOverlay, resetWarnOnce } from "../../src/zotero/overlay.js";
import { ReaderSession } from "../../src/zotero/reader-session.js";
import { fakeTimers } from "./helpers/timers.mjs";

/** Region painted for document A, in user-space units. */
const A_RECT = [100, 600, 300, 700];
/** Region painted for document B. */
const B_RECT = [200, 500, 400, 600];

/** Minimal canvas element: style object plus a class set, no pixels needed. */
function fakeCanvasElement() {
  const classes = new Set();
  return {
    style: {},
    width: 0,
    height: 0,
    dataset: {},
    parentNode: null,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    getContext() {
      return { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
    },
  };
}

/** A rendered pdf.js page view stand-in, with the fields the paint path reads. */
function fakePageView(id) {
  const div = {
    style: {},
    parentNode: null,
    appendChild(canvas) {
      canvas.parentNode = div;
    },
  };
  return {
    id,
    div,
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
      getViewport: ({ scale = 1, rotation = 0 } = {}) => ({
        scale,
        rotation,
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
      }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
    },
  };
}

/**
 * A pdf.js realm stand-in: a viewer window whose document and page views a test
 * can replace, the way Zotero reuses one viewer window for another document.
 *
 * @param {string|null} fingerprint Printed fingerprint of the loaded document.
 */
function fakeRealm(fingerprint) {
  const state = {
    pdfDocument: fingerprint ? { numPages: 1, fingerprints: [fingerprint] } : null,
    eventBus: null,
  };
  const viewer = { _pagesView: [], _pagesCount: 0, currentPageNumber: 1 };
  Object.defineProperty(viewer, "pdfDocument", { get: () => state.pdfDocument, configurable: true });
  const app = { pdfViewer: viewer };
  Object.defineProperty(app, "eventBus", { get: () => state.eventBus, configurable: true });
  const doc = {
    readyState: "complete",
    addEventListener() {},
    removeEventListener() {},
    createElement: () => fakeCanvasElement(),
  };
  const win = { document: doc, devicePixelRatio: 1, PDFViewerApplication: app };
  return { win, viewer, app, state, doc };
}

/**
 * A ready session for one reader, with readiness and realm resolution set
 * directly so no test depends on the readiness poll.
 *
 * @param {{itemID: number, fingerprint: string|null, regionCache?: RegionCache}} input
 */
function readySession(input) {
  const realm = fakeRealm(input.fingerprint);
  const reader = {
    itemID: input.itemID,
    _iframeWindow: null,
    _internalReader: { _primaryView: { _iframeWindow: realm.win } },
  };
  const regionCache = input.regionCache ?? new RegionCache();
  const session = new ReaderSession({ reader, regionCache, tag: `item:${input.itemID}` });
  session.innerWin = realm.win;
  session.realmProvenance = "chain";
  session.ready = true;
  session.syncDocumentId();
  return { realm, reader, session, regionCache };
}

/** Replaces the live document of a realm, as a document swap does. */
function loadDocument(realm, fingerprint) {
  realm.state.pdfDocument = fingerprint ? { numPages: 1, fingerprints: [fingerprint] } : null;
}

/** Pre-seeds one page's detected regions, so `detect()` answers from cache. */
function seed(cache, documentId, pageNumber, rect) {
  cache.set(documentId, pageNumber, { regions: [{ rect }], diagnostics: null });
}

/** Entry key of one page, as `RegionCache` stores it. */
function entryKey(documentId, pageNumber) {
  return RegionCache.key(documentId, pageNumber);
}

/** Records every argument a method was called with, on one instance. */
function record(target, name) {
  const seen = [];
  const original = target[name].bind(target);
  target[name] = (...args) => {
    seen.push(args);
    return original(...args);
  };
  return seen;
}

afterEach(() => resetWarnOnce());

describe("T-A: the wake path re-keys reader B onto its own document", () => {
  it("re-derives the document id and drops the stale key on tab activation", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 483, fingerprint: "aaa" });
      realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:483|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      assert.equal(session.documentId, "fcp:aaa", "the session latched the document it was opened with");
      assert.deepEqual(session.overlays.get(1).regionBoxes, [A_RECT], "document A's regions are painted");

      // Document B replaces the one this window showed. The reader's own session
      // stays, so the scope is right while the latched fingerprint is A's.
      loadDocument(realm, "bbb");
      seed(regionCache, "item:483|fcp:bbb", 1, B_RECT);
      realm.viewer._pagesView = [fakePageView(1)];

      session.onTabActivate();
      await timers.runPending();

      assert.equal(session.documentId, "fcp:bbb", "the wake path re-keys the document id");
      assert.equal(session.cacheKey(), "item:483|fcp:bbb", "the RegionCache key follows the new document");
      assert.equal(
        regionCache.entries.has(entryKey("item:483|fcp:aaa", 1)),
        false,
        "document A's regions must not stay cached under document B's key",
      );
      assert.deepEqual(session.overlays.get(1).regionBoxes, [B_RECT], "the repaint shows document B's regions");
    } finally {
      timers.restore();
    }
  });

  it("re-derives the identity from the realm it adopts", async () => {
    const timers = fakeTimers();
    try {
      const realmA = fakeRealm("aaa");
      const regionCache = new RegionCache();
      const reader = {
        itemID: 483,
        _iframeWindow: null,
        _internalReader: { _primaryView: { _iframeWindow: realmA.win } },
      };
      const session = new ReaderSession({ reader, regionCache, tag: "item:483" });
      session.innerWin = realmA.win;
      session.realmProvenance = "chain";
      session.ready = true;
      session.syncDocumentId();
      realmA.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:483|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      // The reader's own viewer appears: document B lives in another window.
      const realmB = fakeRealm("bbb");
      realmB.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:483|fcp:bbb", 1, B_RECT);
      reader._internalReader._primaryView._iframeWindow = realmB.win;

      const switched = session.reevaluateRealm();
      assert.equal(switched, true, "the reader's own realm is adopted");
      assert.equal(session.innerWin, realmB.win, "the session holds the adopted realm");
      assert.equal(
        session.documentId,
        "fcp:bbb",
        "adopting another realm re-derives the document identity from that realm",
      );
    } finally {
      timers.restore();
    }
  });

  it("repaints the adopted realm under the adopted document's key", async () => {
    const timers = fakeTimers();
    try {
      const realmA = fakeRealm("aaa");
      const regionCache = new RegionCache();
      const reader = {
        itemID: 483,
        _iframeWindow: null,
        _internalReader: { _primaryView: { _iframeWindow: realmA.win } },
      };
      const session = new ReaderSession({ reader, regionCache, tag: "item:483" });
      session.innerWin = realmA.win;
      session.realmProvenance = "chain";
      session.ready = true;
      session.syncDocumentId();
      realmA.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:483|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      const realmB = fakeRealm("bbb");
      realmB.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:483|fcp:bbb", 1, B_RECT);
      reader._internalReader._primaryView._iframeWindow = realmB.win;

      session.onTabActivate();
      await timers.runPending();

      const overlay = session.overlays.get(1);
      assert.ok(overlay, "the adopted realm's page is painted");
      assert.equal(overlay.documentId, "item:483|fcp:bbb", "the paint reads the adopted document's cache key");
      assert.deepEqual(overlay.regionBoxes, [B_RECT], "the page shows document B's regions");
    } finally {
      timers.restore();
    }
  });
});

describe("T-B: a document swap invalidates the previous document's cache key", () => {
  it("drops the regions cached under the key held before the swap", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 523, fingerprint: "aaa" });
      realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:523|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      const invalidated = record(regionCache, "invalidateDocument");

      loadDocument(realm, "printed-2");
      seed(regionCache, "item:523|fcp:printed-2", 1, B_RECT);
      realm.viewer._pagesView = [fakePageView(1)];

      session.queueDocumentCheck();
      await timers.fireNext();

      assert.equal(session.documentId, "fcp:printed-2", "the swap re-keys the session");
      assert.ok(
        invalidated.some(([key]) => key === "item:523|fcp:aaa"),
        `the key held BEFORE the swap is invalidated (invalidated: ${JSON.stringify(invalidated)})`,
      );
      assert.equal(
        regionCache.entries.has(entryKey("item:523|fcp:aaa", 1)),
        false,
        "document A's cached regions do not survive the swap into document B",
      );
    } finally {
      timers.restore();
    }
  });

  it("keeps the cache when the sweep finds the same document", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 524, fingerprint: "aaa" });
      realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:524|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      const invalidated = record(regionCache, "invalidateDocument");

      session.queueDocumentCheck();
      await timers.fireNext();

      assert.equal(session.documentId, "fcp:aaa", "a sweep over the same document keeps the key");
      assert.equal(invalidated.length, 0, "a sweep that found the same document invalidates nothing");
      assert.equal(regionCache.entries.has(entryKey("item:524|fcp:aaa", 1)), true, "the cached regions stay");
    } finally {
      timers.restore();
    }
  });
});

describe("T-C: an overlay inherits neither identity nor paint across a page-view swap", () => {
  it("re-keys the overlay when the rebuilt page view belongs to another document", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 600, fingerprint: "aaa" });
      const first = fakePageView(1);
      realm.viewer._pagesView = [first];
      seed(regionCache, "item:600|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      const inherited = session.overlays.get(1);
      assert.ok(inherited, "document A's page is painted");
      assert.equal(inherited.documentId, "item:600|fcp:aaa", "the overlay reads A's scoped key");
      assert.deepEqual(inherited.regionBoxes, [A_RECT], "document A's regions are mounted");
      assert.equal(inherited.painted, true, "detection is cached for this overlay");

      // Zotero reuses the viewer window, so the swap arrives as a rebuilt page view
      // plus the provisional-to-printed adoption of the new document's fingerprint —
      // a route `applyDocumentId()` treats as a silent adoption that detaches nothing.
      loadDocument(realm, "bbb");
      seed(regionCache, "item:600|fcp:bbb", 1, B_RECT);
      session.documentId = "fcp:doc-7";
      assert.equal(session.applyDocumentId("fcp:bbb"), "adopted", "the printed identity is adopted silently");

      const second = fakePageView(1);
      realm.viewer._pagesView = [second];
      await session.repaintAttached();

      const overlay = session.overlays.get(1);
      assert.equal(overlay.pageView, second, "the record is rebound to the live page view");
      assert.equal(overlay.documentId, "item:600|fcp:bbb", "the rebound overlay reads the new document's cache key");
      assert.deepEqual(overlay.regionBoxes, [B_RECT], "the page shows document B's regions, not document A's");
    } finally {
      timers.restore();
    }
  });

  it("keeps identity and paint when the same document repaints the page", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 601, fingerprint: "aaa" });
      const page = fakePageView(1);
      realm.viewer._pagesView = [page];
      seed(regionCache, "item:601|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();
      await session.repaintAttached();

      const overlay = session.overlays.get(1);
      assert.equal(overlay.documentId, "item:601|fcp:aaa", "a repaint of the same document keeps the cache key");
      assert.deepEqual(overlay.regionBoxes, [A_RECT], "the same document's regions stay painted");
    } finally {
      timers.restore();
    }
  });
});

describe("T-D: a zoom repaint does not reuse the previous document's region boxes", () => {
  it("paints the new document's regions after a swap, at the new scale", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 610, fingerprint: "aaa" });
      realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:610|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      loadDocument(realm, "bbb");
      seed(regionCache, "item:610|fcp:bbb", 1, B_RECT);
      session.documentId = "fcp:doc-8";
      session.applyDocumentId("fcp:bbb");
      realm.viewer._pagesView = [fakePageView(1)];
      await session.repaintAttached();

      const overlay = session.overlays.get(1);
      assert.ok(overlay, "the page still carries an overlay");
      const painted = record(overlay, "paintRegions");

      session.onViewScaleChange();
      await timers.flush();

      assert.equal(session.documentId, "fcp:bbb", "the session holds document B");
      assert.deepEqual(
        painted[0]?.[0],
        [B_RECT],
        `the zoom repaint uses document B's regions (painted: ${JSON.stringify(painted)})`,
      );
      assert.deepEqual(overlay.regionBoxes, [B_RECT], "the mounted boxes belong to document B");
    } finally {
      timers.restore();
    }
  });

  it("repositions the same document's regions without re-detecting", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session, regionCache } = readySession({ itemID: 611, fingerprint: "aaa" });
      realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:611|fcp:aaa", 1, A_RECT);
      await session.repaintAttached();

      const overlay = session.overlays.get(1);
      const detected = record(overlay, "detect");

      session.onViewScaleChange();
      await timers.flush();

      assert.equal(detected.length, 0, "a zoom reuses the cached regions instead of re-detecting");
      assert.deepEqual(overlay.regionBoxes, [A_RECT], "the same document's regions are repositioned");
    } finally {
      timers.restore();
    }
  });
});

describe("T-E: a paint that finishes after the identity changed is dropped", () => {
  /** Detection stub that stays pending until the test releases it. */
  function deferredDetection(rect) {
    const original = PageOverlay.prototype.detect;
    let release;
    PageOverlay.prototype.detect = () =>
      new Promise((resolve) => {
        release = () => resolve({ regions: [rect], regionKinds: ["path"], diagnostics: null });
      });
    return {
      release() {
        release();
      },
      restore() {
        PageOverlay.prototype.detect = original;
      },
    };
  }

  it("does not commit regions detected under the previous document", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session } = readySession({ itemID: 560, fingerprint: "aaa" });
      const page = fakePageView(1);
      realm.viewer._pagesView = [page];
      const detection = deferredDetection(A_RECT);
      try {
        const job = session.attachPageView(page);
        const overlay = session.overlays.get(1);
        assert.ok(overlay, "the page started painting");
        const commits = record(overlay, "paintRegions");

        // The document behind the window is replaced while detection is in flight,
        // and the silent adoption detached nothing, so this overlay is still the
        // session's record for the page when its result arrives.
        session.documentId = "fcp:doc-9";
        session.applyDocumentId("fcp:bbb");

        detection.release();
        await job;
        await timers.flush();

        assert.equal(session.documentId, "fcp:bbb", "the session holds document B");
        assert.equal(
          commits.length,
          0,
          `a paint detected under the previous document must not commit after the identity changed (commits: ${commits.length})`,
        );
      } finally {
        detection.restore();
      }
    } finally {
      timers.restore();
    }
  });

  it("commits a paint whose document did not change", async () => {
    const timers = fakeTimers();
    try {
      const { realm, session } = readySession({ itemID: 561, fingerprint: "aaa" });
      const page = fakePageView(1);
      realm.viewer._pagesView = [page];
      const detection = deferredDetection(A_RECT);
      try {
        const job = session.attachPageView(page);
        const overlay = session.overlays.get(1);
        detection.release();
        await job;
        await timers.flush();

        assert.equal(session.documentId, "fcp:aaa", "the document did not change");
        assert.deepEqual(overlay.regionBoxes, [A_RECT], "the paint of the unchanged document commits");
      } finally {
        detection.restore();
      }
    } finally {
      timers.restore();
    }
  });
});

describe("T-F: two readers with the same printed fingerprint stay isolated", () => {
  it("scopes the RegionCache key per reader", () => {
    const regionCache = new RegionCache();
    const a = readySession({ itemID: 101, fingerprint: "same", regionCache });
    const b = readySession({ itemID: 202, fingerprint: "same", regionCache });

    assert.equal(a.session.documentId, "fcp:same", "both readers print the same identity");
    assert.equal(b.session.documentId, "fcp:same");
    assert.equal(a.session.cacheKey(), "item:101|fcp:same", "reader A's key carries its own scope");
    assert.equal(b.session.cacheKey(), "item:202|fcp:same", "reader B's key carries its own scope");
    assert.notEqual(a.session.cacheKey(), b.session.cacheKey(), "the two readers never share cache entries");
  });

  it("keeps reader B's cached regions when reader A's document drifts", async () => {
    const timers = fakeTimers();
    try {
      const regionCache = new RegionCache();
      const a = readySession({ itemID: 101, fingerprint: "same", regionCache });
      const b = readySession({ itemID: 202, fingerprint: "same", regionCache });
      a.realm.viewer._pagesView = [fakePageView(1)];
      b.realm.viewer._pagesView = [fakePageView(1)];
      seed(regionCache, "item:101|fcp:same", 1, A_RECT);
      seed(regionCache, "item:202|fcp:same", 1, B_RECT);
      await a.session.repaintAttached();
      await b.session.repaintAttached();

      assert.deepEqual(a.session.overlays.get(1).regionBoxes, [A_RECT], "reader A painted its own regions");
      assert.deepEqual(b.session.overlays.get(1).regionBoxes, [B_RECT], "reader B painted its own regions");

      loadDocument(a.realm, "drift");
      a.session.queueDocumentCheck();
      await timers.fireNext();

      assert.equal(a.session.documentId, "fcp:drift", "reader A re-keys onto its new document");
      assert.equal(b.session.documentId, "fcp:same", "reader B keeps its identity");
      assert.equal(b.session.cacheKey(), "item:202|fcp:same", "reader B keeps its cache key");
      assert.equal(
        regionCache.entries.has(entryKey("item:202|fcp:same", 1)),
        true,
        "reader B's cached regions survive reader A's invalidation",
      );
    } finally {
      timers.restore();
    }
  });
});
