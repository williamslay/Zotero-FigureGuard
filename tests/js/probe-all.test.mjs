import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  addZoteroNotifier,
  getSessions,
  probeAll,
  probePaint,
  REALM_HREF_MAX,
  shutdown,
  startup,
  wakeStats,
  wakeTabSessions,
} from "../../src/zotero/main.js";

/**
 * `Zotero_Tabs.selectedID` is not readable from the bootstrap sandbox, so a
 * single-session probe can report an unloaded background reader. `probeAll`
 * answers for every live session instead, which is what these tests pin down.
 */

/** @type {Map<string, Function>} Handlers the fake Zotero.Reader recorded. */
const handlers = new Map();

/** A `Zotero` global with just the reader event registration main.js uses. */
function installFakeZotero() {
  globalThis.Zotero = {
    debug() {},
    getMainWindow() {
      return null;
    },
    getMainWindows() {
      return [];
    },
    Reader: {
      _readers: [],
      registerEventListener(type, handler) {
        handlers.set(type, handler);
      },
      unregisterEventListener(type) {
        handlers.delete(type);
      },
      getByTabID() {
        return null;
      },
    },
  };
}

/**
 * A pdf.js realm stand-in whose `currentPageNumber` can be made to throw, to
 * show a hostile cross-realm read cannot break the probe. `iframes` sizes the
 * realm's own frame list and `href` its location, both reported by `realm`.
 * `wrappedOnly` is the shape the bootstrap sandbox sees on the real machine: no
 * directly visible `PDFViewerApplication`, only one behind `wrappedJSObject`.
 *
 * @param {{currentPageNumber?: number, throwsPage?: boolean, throwsRealm?: boolean,
 *   noMarker?: boolean, wrappedOnly?: boolean, iframes?: number, href?: string,
 *   currentScale?: number, currentScaleValue?: string, defaultZoomValue?: string,
 *   throwsScale?: boolean}} [state]
 */
function fakeRealm(state = {}) {
  const viewer = {
    _pagesCount: 0,
    // The zoom numbers `describeSession` reports: a fit-width value plus the
    // scale it resolved to, which is the pair a stale paint is read against.
    currentScale: state.currentScale ?? 1,
    currentScaleValue: state.currentScaleValue ?? "auto",
    defaultZoomValue: state.defaultZoomValue ?? "",
  };
  Object.defineProperty(viewer, "currentPageNumber", {
    get: () => {
      if (state.throwsPage) throw new Error("currentPageNumber blocked");
      return state.currentPageNumber ?? 1;
    },
    configurable: true,
  });
  Object.defineProperty(viewer, "pdfDocument", {
    get: () => ({ fingerprints: ["seed"] }),
    configurable: true,
  });
  if (state.throwsScale) {
    Object.defineProperty(viewer, "currentScale", {
      get() {
        throw new Error("currentScale blocked");
      },
      configurable: true,
    });
  }
  const realm = {
    PDFViewerApplication: { pdfViewer: viewer, eventBus: { on() {}, off() {} } },
    document: {
      readyState: "complete",
      querySelectorAll: (selector) =>
        selector === "iframe" ? Array.from({ length: state.iframes ?? 0 }, () => ({})) : [],
    },
    location: { href: state.href ?? "resource://zotero/pdf/web/viewer.html" },
  };
  if (state.throwsRealm) {
    Object.defineProperty(realm, "PDFViewerApplication", {
      get() {
        throw new Error("realm blocked");
      },
      configurable: true,
    });
  }
  if (state.noMarker) delete realm.PDFViewerApplication;
  if (state.wrappedOnly) {
    realm.wrappedJSObject = { PDFViewerApplication: { pdfViewer: viewer, eventBus: { on() {}, off() {} } } };
    delete realm.PDFViewerApplication;
  }
  return realm;
}

/** A canvas whose pixel read is all white, small enough to sample whole. */
function fakeCanvas() {
  return {
    width: 2,
    height: 2,
    style: { left: "1px", top: "2px", width: "10px", height: "20px" },
    getContext: () => ({
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    }),
  };
}

/** A `PageOverlay` stand-in for one page, with a single white canvas. */
function fakeOverlay(pageNumber) {
  return {
    pageNumber,
    painted: true,
    canvases: [fakeCanvas()],
    innerWin: { devicePixelRatio: 1.5 },
    pageView: { div: { clientWidth: 612, clientHeight: 792 } },
  };
}

/** A minimal toolbar-document stand-in. */
function fakeDoc() {
  return {
    createElement: () => ({
      style: {},
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

/** Lets the `start()` promises of the opened readers settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Opens one reader through the `renderToolbar` handler, which is what creates
 * and starts its session.
 *
 * @param {number} itemID
 * @param {{currentPageNumber?: number, throwsPage?: boolean, throwsRealm?: boolean,
 *   noMarker?: boolean, wrappedOnly?: boolean, iframes?: number, href?: string,
 *   currentScale?: number, currentScaleValue?: string, defaultZoomValue?: string,
 *   throwsScale?: boolean, overlayPages?: number[]}} [options]
 * @returns {Promise<object>} The live session.
 */
async function openReader(itemID, options = {}) {
  const before = new Set(getSessions());
  const reader = {
    itemID,
    _iframeWindow: null,
    _internalReader: { _primaryView: { _iframeWindow: fakeRealm(options) } },
  };
  handlers.get("renderToolbar")({
    type: "renderToolbar",
    reader,
    doc: fakeDoc(),
    params: {},
    append() {},
  });
  await tick();
  const created = getSessions().filter((session) => !before.has(session));
  const session = created[created.length - 1];
  for (const page of options.overlayPages ?? [options.currentPageNumber ?? 1]) {
    session.overlays.set(page, fakeOverlay(page));
  }
  return session;
}

/** Destroys every session this file opened. */
function closeAll() {
  for (const session of getSessions()) {
    if (!session.destroyed) session.destroy();
  }
}

describe("probeAll: reports every live reader", () => {
  before(() => installFakeZotero());
  after(() => {
    shutdown();
    closeAll();
    handlers.clear();
    delete globalThis.Zotero;
  });

  it("reports an empty field when no reader is open", async () => {
    closeAll();
    const result = probeAll();
    assert.equal(typeof result.at, "string");
    assert.deepEqual(result.sessions, []);
    assert.equal(result.active, null);
    assert.equal(result.count, 0);
    assert.equal(result.truncated, undefined);
    assert.ok(Array.isArray(result.log), "the warning ring is part of the report");
  });

  it("reports one entry per reader, with the documented keys", async () => {
    closeAll();
    startup({ id: "probe-all-test" });
    await openReader(481, { currentPageNumber: 3 });
    await openReader(483, { currentPageNumber: 2 });
    await openReader(485, { currentPageNumber: 1 });

    const result = probeAll();
    assert.equal(result.count, 3);
    assert.equal(result.sessions.length, 3);
    assert.deepEqual(result.sessions.map((entry) => entry.key), ["item:481", "item:483", "item:485"]);
    assert.equal(result.active, "item:481", "active is the session the single-session lookup picks");

    const entry = result.sessions[0];
    assert.deepEqual(
      Object.keys(entry),
      [
        "key",
        "ready",
        "attempts",
        "settledRepaints",
        "innerWin",
        "realm",
        "eventBus",
        "docId",
        "cacheKey",
        "realmId",
        "freshDocId",
        "realmSwitches",
        "realmProvenance",
        "realmOwned",
        "documentIdAdopted",
        "overlays",
        "enabled",
        "currentPage",
        "target",
        "mountDetached",
        "scale",
      ],
    );
    assert.equal(entry.ready, true);
    assert.ok(entry.attempts >= 1, "the readiness poll count is reported");
    assert.equal(entry.settledRepaints, 0, "a session that never healed a page reports 0 settled repaints");
    assert.equal(entry.innerWin, true);
    assert.equal(entry.realm.pva, "object", "the latched realm really is a pdf.js viewer window");
    assert.equal(entry.realm.route, "direct", "the plain read was the route that resolved the application");
    assert.equal(entry.realm.wrappedPva, "undefined", "a realm with no wrappedJSObject says so");
    assert.equal(entry.realm.frames, 0, "the realm's own iframe count is reported");
    assert.equal(entry.realm.href, "resource://zotero/pdf/web/viewer.html", "the realm says where it points");
    assert.equal(entry.realmError, undefined);
    assert.equal(entry.eventBus, true);
    assert.equal(entry.docId, "fcp:seed");
    assert.equal(entry.realmProvenance, "chain", "the realm came from the reader's own documented chain");
    assert.equal(entry.realmOwned, true, "and the reader's chain still lists that realm");
    assert.equal(entry.overlays, 1);
    assert.equal(entry.enabled, true);
    assert.equal(entry.currentPage, 3, "the page in view comes from the reader realm");
    assert.equal(entry.currentPageError, undefined);
    assert.equal(entry.scale.currentScale, 1, "the zoom the realm resolved is reported next to the paint evidence");
    assert.equal(entry.scale.currentScaleValue, "auto");
    assert.equal(entry.scale.defaultZoomValue, null, "an unset default zoom is null, not an empty string");
    assert.equal(entry.target.pageNumber, 3, "the overlay of the page in view is probed");
    assert.equal(entry.target.canvasCount, 1);
    assert.equal(entry.target.lastPaintGeometry, null, "an overlay that never painted carries no paint-time viewport");
    assert.deepEqual(entry.target.liveViewport, { width: null, height: null, scale: null, rotation: null });
    assert.equal(entry.target.hostBox.clientWidth, 612, "the positioning host box is reported");
    assert.equal(entry.target.regions[0].offsetParent, null, "a canvas with no host element has no label");

    assert.ok(result.log.every((line) => typeof line === "string" && !line.includes("\n")));
    assert.equal(result.sessions[2].currentPage, 1);
    assert.equal(result.sessions[2].target.pageNumber, 1);
    assert.equal(probePaint().currentPage, 3, "probePaint still works next to probeAll");
  });

  it("reports null zoom numbers when the realm blocks the scale read", async () => {
    closeAll();
    await openReader(955, { throwsScale: true });

    const [entry] = probeAll().sessions;
    assert.deepEqual(
      entry.scale,
      { currentScale: null, currentScaleValue: null, defaultZoomValue: null },
      "a hostile cross-realm read leaves the zoom block as nulls",
    );
    assert.equal(entry.currentPage, 1, "the page number is still read on its own");
    assert.equal(entry.target.pageNumber, 1, "and the overlay probe still runs");
  });

  it("caps the list at eight entries and flags truncation", async () => {
    closeAll();
    for (let index = 0; index < 10; index += 1) await openReader(900 + index, { currentPageNumber: 1 });

    const result = probeAll();
    assert.equal(result.count, 10, "count is the live readers, not the reported ones");
    assert.equal(result.sessions.length, 8);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.sessions.map((entry) => entry.key), [
      "item:900",
      "item:901",
      "item:902",
      "item:903",
      "item:904",
      "item:905",
      "item:906",
      "item:907",
    ]);
  });

  it("records a throwing current-page read instead of failing the probe", async () => {
    closeAll();
    await openReader(950, { throwsPage: true });
    await openReader(951, { currentPageNumber: 4 });

    const result = probeAll();
    assert.equal(result.count, 2);
    const broken = result.sessions[0];
    assert.equal(broken.key, "item:950");
    assert.equal(broken.currentPage, null);
    assert.equal(broken.currentPageError, "currentPageNumber blocked");
    assert.equal(broken.target.pageNumber, 1, "the overlay probe still runs for that reader");
    assert.equal(result.sessions[1].currentPage, 4);
  });

  it("self-reports the latched realm, and a realm that refuses to be read", async () => {
    closeAll();
    const longHref = "resource://zotero/pdf/web/viewer.html?file=" + "x".repeat(200);
    // The shape the real machine reported: a realm that is not the viewer at all.
    await openReader(980, { noMarker: true, iframes: 2, href: "about:blank" });
    await openReader(981, { href: longHref });
    await openReader(982, { throwsRealm: true });

    const [wrong, truncated, broken] = probeAll().sessions;
    assert.equal(wrong.key, "item:980");
    assert.equal(wrong.realm.pva, "undefined", "a realm without the marker says so instead of lying");
    assert.equal(wrong.realm.route, null, "no route resolved that realm");
    assert.equal(wrong.realm.wrappedPva, "undefined");
    assert.equal(
      wrong.realm.hasCuUnwrap,
      "undefined",
      "the report says whether Components.utils.unwrap exists here, so route:null is not ambiguous",
    );
    assert.equal(wrong.realm.frames, 2, "the frames of the wrong realm are counted");
    assert.equal(wrong.realm.href, "about:blank");
    assert.equal(truncated.realm.href.length, REALM_HREF_MAX, "a long href is cut to the documented length");
    assert.equal(broken.realmError, "realm blocked", "a throwing cross-realm read is reported");
    assert.deepEqual(
      broken.realm,
      { pva: null, route: null, wrappedPva: "undefined", hasCuUnwrap: "undefined", frames: null, href: null },
      "the entry stays JSON-able",
    );
  });

  it("works on a realm whose application is only behind wrappedJSObject", async () => {
    closeAll();
    // The sandbox shape of the real machine: the plain read sees nothing, the
    // Xray escape hatch carries the viewer.
    const session = await openReader(984, { wrappedOnly: true, currentPageNumber: 2 });

    const [entry] = probeAll().sessions;
    assert.equal(entry.realm.pva, "undefined", "the direct read is still blind");
    assert.equal(entry.realm.route, "wrapped", "the wrappedJSObject route is what the probe reports");
    assert.equal(entry.realm.wrappedPva, "object");
    assert.equal(entry.ready, true, "the session reaches readiness through that route");
    assert.equal(entry.eventBus, true, "the event bus was resolved through the same route");
    assert.equal(entry.docId, "fcp:seed");
    assert.equal(entry.currentPage, 2, "the viewer object came from the unwrapped application");
    assert.equal(session.destroyed, false);
  });

  it("leaves a destroyed reader out of the report", async () => {
    closeAll();
    const first = await openReader(960, { currentPageNumber: 1 });
    await openReader(961, { currentPageNumber: 1 });
    assert.equal(probeAll().count, 2);

    first.destroy();
    const result = probeAll();
    assert.equal(result.count, 1);
    assert.deepEqual(result.sessions.map((entry) => entry.key), ["item:961"]);
  });
});


describe("probeAll: per-reader identity", () => {
  before(() => installFakeZotero());
  after(() => {
    shutdown();
    closeAll();
    handlers.clear();
    delete globalThis.Zotero;
  });

  it("keeps two readers of one fingerprint apart", async () => {
    closeAll();
    startup({ id: "probe-all-test" });
    const first = await openReader(491, { currentPageNumber: 1 });
    const second = await openReader(492, { currentPageNumber: 6 });

    const result = probeAll();
    assert.deepEqual(
      result.sessions.map((entry) => entry.docId),
      ["fcp:seed", "fcp:seed"],
      "pdf.js reports the same fingerprint for both readers",
    );
    assert.deepEqual(
      result.sessions.map((entry) => entry.freshDocId),
      ["fcp:seed", "fcp:seed"],
      "the live documents are the same as far as the fingerprint goes",
    );
    assert.deepEqual(
      result.sessions.map((entry) => entry.cacheKey),
      ["item:491|fcp:seed", "item:492|fcp:seed"],
      "the cache key carries the reader the regions belong to",
    );
    assert.notEqual(first.cacheKey(), second.cacheKey(), "two readers never share one region cache entry");
    assert.equal(result.docIdentityDistinct, false, "the report says the two documents collide");
  });

  it("reports the mount state of the overlay it probed", async () => {
    closeAll();
    startup({ id: "probe-all-test" });
    const session = await openReader(493, { currentPageNumber: 1 });

    const entry = probeAll().sessions[0];
    assert.equal(entry.mountDetached, false, "an overlay that reports nothing is not reported detached");
    assert.equal(entry.target.mountDetached, false, "the overlay stand-in says its mount is intact");

    session.destroy();
  });

  it("wakes the session behind the selected tab", async () => {
    closeAll();
    startup({ id: "probe-all-test" });
    const session = await openReader(494, { currentPageNumber: 1 });
    const seen = [];
    session.reevaluateRealm = () => {
      seen.push("realm");
    };
    session.queueDocumentCheck = () => {
      seen.push("check");
    };

    session.onTabActivate();

    assert.deepEqual(seen, ["realm", "check"], "activation re-derives the realm before re-deriving the document");
    session.destroy();
  });

  it("re-keys a document id latched from the other reader's document on activation", async () => {
    closeAll();
    startup({ id: "probe-drift-test" });
    // The reported startup shape: the realm object is this reader's own, but the
    // bridge answers with the other tab's `PDFViewerApplication` while the tab is
    // inactive, so the session latches the other document's key.
    const otherApp = {
      pdfViewer: { currentPageNumber: 1, pdfDocument: { fingerprints: ["other"] }, isViewerReady: () => true, pageViews: [] },
      eventBus: { on() {}, off() {} },
    };
    const ownApp = {
      pdfViewer: { currentPageNumber: 1, pdfDocument: { fingerprints: ["own"] }, isViewerReady: () => true, pageViews: [] },
      eventBus: { on() {}, off() {} },
    };
    const realm = {
      active: false,
      document: { readyState: "complete", querySelectorAll: () => [] },
      location: { href: "https://pdf.example/own/viewer.html" },
      get PDFViewerApplication() {
        return this.active ? ownApp : otherApp;
      },
    };
    const before = new Set(getSessions());
    handlers.get("renderToolbar")({
      type: "renderToolbar",
      reader: { itemID: 920, _iframeWindow: null, _internalReader: { _primaryView: { _iframeWindow: realm } } },
      doc: fakeDoc(),
      params: {},
      append() {},
    });
    await tick();
    const created = getSessions().filter((session) => !before.has(session));
    const session = created[created.length - 1];

    assert.equal(session.documentId, "fcp:other", "startup latched the document the bridge handed over");
    let entry = probeAll().sessions.find((e) => e.key === "item:920");
    assert.equal(entry.docId, "fcp:other");
    assert.equal(entry.freshDocId, "fcp:other", "while the tab is inactive the probe reads the same foreign app");

    realm.active = true;
    session.onTabActivate();

    entry = probeAll().sessions.find((e) => e.key === "item:920");
    assert.equal(entry.docId, "fcp:own", "activation re-keys onto the document this tab shows");
    assert.equal(entry.cacheKey, "item:920|fcp:own", "and the region cache follows the fresh key");
    assert.equal(entry.freshDocId, "fcp:own", "the reported pair agrees again");
    assert.equal(entry.documentIdAdopted, false, "a wrong-realm key is a drift, not the provisional adoption");
    assert.ok(entry.realmId, "the session reports the realm identity its canvases are stamped against");

    // A second activation over the same document is a no-op: no re-key churn.
    session.onTabActivate();
    entry = probeAll().sessions.find((e) => e.key === "item:920");
    assert.equal(entry.docId, "fcp:own", "the correction is stable across wakes");
    session.destroy();
  });

  it("routes a Zotero tab notification to the matching reader session", async () => {
    closeAll();
    startup({ id: "probe-notify-test" });
    const first = await openReader(930, { currentPageNumber: 1 });
    const second = await openReader(931, { currentPageNumber: 1 });
    let firstWakes = 0;
    let secondWakes = 0;
    first.onTabActivate = () => {
      firstWakes += 1;
    };
    second.onTabActivate = () => {
      secondWakes += 1;
    };
    const zotero = globalThis.Zotero;
    let registered = null;
    zotero.Notifier = {
      registerObserver(notifierID, types, callback) {
        registered = { notifierID, types, callback };
        return 7;
      },
      unregisterObserver() {},
    };
    zotero.Reader.getByTabID = (tabId) => (tabId === 931 ? second.reader : null);

    const notifierId = addZoteroNotifier(zotero);
    assert.equal(notifierId, 7, "the notifier id is kept for unregistering");
    assert.equal(registered.types, "tab", "the subscription is for tab events");

    // Zotero calls observers as (event, type, ids, extra, id): the tab id is in `ids`.
    registered.callback("select", "tab", [931], undefined, 7);
    assert.equal(secondWakes, 1, "the session behind the resolved tab wakes");
    assert.equal(firstWakes, 0, "and the other session is left alone");

    // A tab id Zotero cannot resolve wakes every session, so nothing stays asleep.
    registered.callback("select", "tab", [999], undefined, 7);
    assert.equal(firstWakes, 1, "an unresolvable tab falls back to waking all");
    assert.equal(secondWakes, 2);

    registered.callback("modify", "tab", [931], undefined, 7);
    assert.equal(secondWakes, 2, "a non-select event wakes nobody");

    delete zotero.Notifier;
    first.destroy();
    second.destroy();
  });

  it("tallies notifier wakes so the wake-all fallback is visible", async () => {
    closeAll();
    startup({ id: "probe-wake-stats-test" });
    const session = await openReader(940, { currentPageNumber: 1 });
    globalThis.Zotero.Reader.getByTabID = () => null;
    let wakes = 0;
    session.onTabActivate = () => {
      wakes += 1;
    };
    const before = { count: wakeStats.count, nullTarget: wakeStats.nullTarget };

    wakeTabSessions("select", [404], undefined);
    assert.equal(wakeStats.count - before.count, 1, "one select event tallies exactly one wake pass");
    assert.equal(wakeStats.nullTarget - before.nullTarget, 1, "an unresolvable tab id counts as a null target");
    assert.equal(wakes, 1, "the fallback wakes every live session");

    globalThis.Zotero.Reader.getByTabID = () => session.reader;
    wakeTabSessions("select", [404], undefined);
    assert.equal(wakeStats.count - before.count, 2, "a resolved select is tallied too");
    assert.equal(wakeStats.nullTarget - before.nullTarget, 1, "a resolved tab is not a null target");
    assert.equal(wakes, 2, "the resolved session still wakes, and only it");

    wakeTabSessions("modify", [404], undefined);
    assert.equal(wakeStats.count - before.count, 2, "a non-select event is not tallied");

    const wake = probeAll().wake;
    assert.equal(wake.count - before.count, 2, "the probe carries the notifier tally");
    assert.equal(wake.nullTarget - before.nullTarget, 1, "and the fallback count with it");

    globalThis.Zotero.Reader.getByTabID = () => null;
    session.destroy();
  });
});
