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
      // Zotero 7+ answers this; the null default keeps every woken tab on the full
      // paint wake, so a test only sets it when it pins the lazy-wake gate.
      getActive() {
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
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      style: {},
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  };
}

/**
 * Zotero 10's real `Zotero.Notifier` contract, read out of Zotero's own reader:
 * `registerObserver(ref, types, id, priority)` takes an observer OBJECT that
 * carries a `notify(event, type, ids, extraData)` method, and hands back a
 * string hash that unregisters it. `trigger()` is the dispatcher: it calls the
 * ref the way Zotero's dispatch does, so a registration that handed in a bare
 * function — the wrong contract that hid the tab-switch regression — throws
 * here instead of being silently swallowed and never called.
 *
 * @returns {{api: {registerObserver: Function, unregisterObserver: Function},
 *   registered: Array<{ref: object, types: unknown, name: unknown, hash: string}>,
 *   unregistered: Array<*>,
 *   trigger: (event: string, type: string, ids: Array<*>, extraData?: object) => void}}
 */
function fakeNotifier() {
  /** @type {Array<{ref: object, types: unknown, name: unknown, hash: string}>} */
  const registered = [];
  /** @type {Array<*>} Ids teardown passed to `unregisterObserver`. */
  const unregistered = [];
  const api = {
    registerObserver(ref, types, name) {
      const hash = `notifier-${registered.length + 1}`;
      registered.push({ ref, types, name, hash });
      return hash;
    },
    unregisterObserver(id) {
      unregistered.push(id);
    },
  };
  return {
    api,
    registered,
    unregistered,
    trigger(event, type, ids, extraData) {
      for (const entry of registered) {
        if (typeof entry.ref?.notify !== "function") {
          throw new TypeError("Zotero.Notifier dispatches ref.notify(): the observer is not an object with a notify method");
        }
        entry.ref.notify(event, type, ids, extraData);
      }
    },
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
    startup({ id: "probe-all-test", version: "0.1.27-probe" });
    await openReader(481, { currentPageNumber: 3 });
    await openReader(483, { currentPageNumber: 2 });
    await openReader(485, { currentPageNumber: 1 });

    const result = probeAll();
    assert.equal(result.count, 3);
    assert.equal(
      result.version,
      "0.1.27-probe",
      "the report names the installed add-on version the bootstrap supplied, so a machine report proves which build is loaded",
    );
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
        "realmUnproven",
        "documentIdAdopted",
        "lastValidation",
        "docIdStale",
        "lastStaleKey",
        "staleKeyPresent",
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
    assert.equal(entry.realmUnproven, false, "a realm named by the chain is proven, so wakes are free to paint");
    assert.equal(entry.docIdStale, false, "the session's own drift read finds the document it holds");
    assert.equal(entry.lastStaleKey, null, "no re-key has released a key yet");
    assert.equal(entry.staleKeyPresent, false, "with no released key, no stale regions can be held");
    assert.ok(
      entry.lastValidation === null || ["ok", "rekeyed", "wait"].includes(entry.lastValidation.decision),
      "the last wake's decision is reported as one of the three states, or absent before the first wake",
    );
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
    assert.deepEqual(
      { trigger: entry.lastValidation?.trigger, decision: entry.lastValidation?.decision, after: entry.lastValidation?.after },
      { trigger: "tab-activate", decision: "rekeyed", after: "fcp:own" },
      "the wake reports what it decided and the identity it left the reader on",
    );
    assert.equal(entry.lastStaleKey, "item:920|fcp:other", "and names the cache key it released");
    assert.equal(entry.docIdStale, false, "the latched key now agrees with the document");
    assert.equal(entry.staleKeyPresent, false, "the released key holds no regions after the re-key");

    // A live read, not a snapshot taken at the re-key: a region that lands back under
    // the released key is reported again, so a survivor cannot hide.
    session.regionCache.set("item:920|fcp:other", 1, [{ rect: [0, 0, 1, 1] }]);
    assert.equal(
      probeAll().sessions.find((e) => e.key === "item:920").staleKeyPresent,
      true,
      "regions surviving under the released key are reported",
    );
    session.regionCache.invalidateDocument("item:920|fcp:other");

    // A second activation over the same document is a no-op: no re-key churn.
    session.onTabActivate();
    entry = probeAll().sessions.find((e) => e.key === "item:920");
    assert.equal(entry.docId, "fcp:own", "the correction is stable across wakes");
    assert.equal(entry.lastValidation?.decision, "ok", "and a wake over its own document decides `ok`");
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
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;
    zotero.Reader.getByTabID = (tabId) => (tabId === 931 ? second.reader : null);

    const notifierId = addZoteroNotifier(zotero);
    assert.equal(typeof notifierId, "string", "the id Zotero returns is a string hash, and it is kept for teardown");
    assert.equal(notifier.registered.length, 1, "one subscription per registration");
    assert.deepEqual(notifier.registered[0].types, ["tab"], "the subscription is for tab events");
    assert.equal(notifier.registered[0].name, "figure-color", "under the plugin's own observer name");
    assert.equal(notifier.registered[0].hash, notifierId, "the id reported back is the one Zotero generated");

    const before = { count: wakeStats.count, nullTarget: wakeStats.nullTarget };

    // Zotero dispatches as `ref.notify(event, type, ids, extraData)`: the tab id is in `ids`.
    notifier.trigger("select", "tab", [931]);
    assert.equal(secondWakes, 1, "the session behind the resolved tab wakes");
    assert.equal(firstWakes, 0, "and the other session is left alone");
    assert.equal(
      wakeStats.count - before.count,
      1,
      "the dispatch really reached the wake tally: a subscription Zotero cannot call leaves it at 0 forever",
    );
    assert.equal(wakeStats.nullTarget - before.nullTarget, 0, "the tab id resolved, so no wake-all fallback");

    // A tab id Zotero cannot resolve wakes every session, so nothing stays asleep.
    notifier.trigger("select", "tab", [999]);
    assert.equal(firstWakes, 1, "an unresolvable tab falls back to waking all");
    assert.equal(secondWakes, 2);
    assert.equal(wakeStats.nullTarget - before.nullTarget, 1, "and the fallback is tallied");

    notifier.trigger("modify", "tab", [931]);
    assert.equal(secondWakes, 2, "a non-select event wakes nobody");
    assert.equal(wakeStats.count - before.count, 2, "a non-select event is not tallied");

    delete zotero.Notifier;
    first.destroy();
    second.destroy();
  });

  it("wakes every session a coalesced startup select names", async () => {
    closeAll();
    startup({ id: "probe-coalesced-select" });
    const first = await openReader(960, { currentPageNumber: 1 });
    const second = await openReader(961, { currentPageNumber: 1 });
    let firstWakes = 0;
    let secondWakes = 0;
    first.onTabActivate = () => {
      firstWakes += 1;
    };
    second.onTabActivate = () => {
      secondWakes += 1;
    };
    const zotero = globalThis.Zotero;
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;
    zotero.Reader.getByTabID = (tabId) =>
      tabId === 1001 ? first.reader : tabId === 1002 ? second.reader : null;
    addZoteroNotifier(zotero);

    const before = { count: wakeStats.count, nullTarget: wakeStats.nullTarget };

    // The reported startup shape: Zotero's Notifier queues the switches fired while
    // the app boots and dispatches them as ONE notification carrying every merged
    // tab id. Reading `ids[0]` woke one tab and left the one on screen asleep.
    notifier.trigger("select", "tab", [1001, 1002]);
    assert.equal(firstWakes, 1, "the first tab of the merged notification wakes");
    assert.equal(secondWakes, 1, "and so does the second: a merged batch wakes both readers");
    assert.equal(wakeStats.count - before.count, 1, "the merged batch is one wake pass");
    assert.equal(wakeStats.nullTarget - before.nullTarget, 0, "both ids resolved, so no wake-all fallback");

    firstWakes = 0;
    secondWakes = 0;
    notifier.trigger("select", "tab", [1002, 1003]);
    assert.equal(secondWakes, 1, "a batch still wakes the reader its resolvable id names");
    assert.equal(firstWakes, 0, "and a batch that resolved an id does not fall back to waking all");
    assert.equal(wakeStats.count - before.count, 2, "one notification, one wake pass");
    assert.equal(wakeStats.nullTarget - before.nullTarget, 0, "a partly resolvable batch is not the fallback path");

    delete zotero.Notifier;
    first.destroy();
    second.destroy();
  });

  it("wakes on a load notification for the tab, not only on select", async () => {
    closeAll();
    startup({ id: "probe-load-wake" });
    const session = await openReader(962, { currentPageNumber: 1 });
    let wakes = 0;
    session.onTabActivate = () => {
      wakes += 1;
    };
    const zotero = globalThis.Zotero;
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;
    zotero.Reader.getByTabID = (tabId) => (tabId === 2001 ? session.reader : null);
    addZoteroNotifier(zotero);

    const before = { count: wakeStats.count, nullTarget: wakeStats.nullTarget };

    // `load:tab` is the deterministic wake for a tab whose content finished loading
    // during the startup storm, when the select for it was merged into another batch.
    notifier.trigger("load", "tab", [2001]);
    assert.equal(wakes, 1, "the load notification wakes the session for that tab");
    assert.equal(wakeStats.count - before.count, 1, "a load wake is tallied like a select");
    assert.equal(wakeStats.nullTarget - before.nullTarget, 0, "the tab id resolved, so no wake-all fallback");

    notifier.trigger("modify", "tab", [2001]);
    assert.equal(wakes, 1, "an unrelated event still wakes nobody");
    assert.equal(wakeStats.count - before.count, 1, "and it is not tallied");

    delete zotero.Notifier;
    session.destroy();
  });

  it("wakes the startup batch but paints only the on-screen tab", async () => {
    closeAll();
    startup({ id: "probe-lazy-wake" });
    const first = await openReader(970, { currentPageNumber: 1 });
    const second = await openReader(971, { currentPageNumber: 1 });
    const zotero = globalThis.Zotero;
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;
    zotero.Reader.getByTabID = (tabId) =>
      tabId === 3001 ? first.reader : tabId === 3002 ? second.reader : null;
    zotero.Reader.getActive = () => first.reader;
    addZoteroNotifier(zotero);
    assert.equal(first.paintOnSelectPending, false, "a fresh session starts with no pending repaint");

    // Counting stands in for the sweep: replacing the method keeps the test from
    // arming a real debounce timer, so "no sweep" is an empty list, not a missed fire.
    const sweeps = [];
    first.queueDocumentCheck = () => {
      sweeps.push("first");
    };
    second.queueDocumentCheck = () => {
      sweeps.push("second");
    };

    // The merged startup batch, with the first tab on screen: both identities are
    // re-validated, only the visible one queues the detection and canvas work.
    notifier.trigger("select", "tab", [3001, 3002]);
    assert.deepEqual(sweeps, ["first"], "only the on-screen reader queues the paint sweep");
    assert.equal(second.paintOnSelectPending, true, "the hidden tab flags the repaint for its own select wake");
    assert.equal(
      second.lastValidation?.trigger,
      "tab-activate",
      "the hidden tab still re-validated its document identity",
    );

    // A `load` for the hidden tab is verify-only as well.
    sweeps.length = 0;
    second.paintOnSelectPending = false;
    notifier.trigger("load", "tab", [3002]);
    assert.deepEqual(sweeps, [], "a load wake for the hidden tab queues no sweep");
    assert.equal(second.paintOnSelectPending, true, "and it leaves the repaint pending, not painted");

    // The steady-state per-switch select, now naming the visible reader: full wake.
    zotero.Reader.getActive = () => second.reader;
    notifier.trigger("select", "tab", [3002]);
    assert.deepEqual(sweeps, ["second"], "the select for the now-visible tab paints");
    assert.equal(second.paintOnSelectPending, false, "and clears the pending flag");

    delete zotero.Notifier;
    zotero.Reader.getActive = () => null;
    first.destroy();
    second.destroy();
  });

  it("paints every woken tab when the active reader cannot be resolved", async () => {
    closeAll();
    startup({ id: "probe-lazy-wake-null" });
    const first = await openReader(972, { currentPageNumber: 1 });
    const second = await openReader(973, { currentPageNumber: 1 });
    const zotero = globalThis.Zotero;
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;
    zotero.Reader.getByTabID = (tabId) =>
      tabId === 3003 ? first.reader : tabId === 3004 ? second.reader : null;
    addZoteroNotifier(zotero);

    const sweeps = [];
    first.queueDocumentCheck = () => {
      sweeps.push("first");
    };
    second.queueDocumentCheck = () => {
      sweeps.push("second");
    };

    // The stub's default: `getActive` answers null — the gate stays open.
    notifier.trigger("select", "tab", [3003, 3004]);
    assert.deepEqual(sweeps, ["first", "second"], "a null active reader paints every named tab, as before the gate");

    // A Reader without the getActive read at all: same backward-compatible wake.
    sweeps.length = 0;
    delete zotero.Reader.getActive;
    notifier.trigger("select", "tab", [3003, 3004]);
    assert.deepEqual(sweeps, ["first", "second"], "a Reader without getActive also wakes every tab to paint");

    delete zotero.Notifier;
    first.destroy();
    second.destroy();
  });

  it("unregisters the observer with the exact id Zotero returned", () => {
    closeAll();
    shutdown();
    const zotero = globalThis.Zotero;
    const notifier = fakeNotifier();
    zotero.Notifier = notifier.api;

    // `startup()` is what holds the id across the plugin's life, so the teardown
    // proof goes through it: start with the notifier in place, then shut down.
    startup({ id: "probe-notifier-teardown" });
    assert.equal(notifier.registered.length, 1, "startup subscribes to the tab notifier");
    const hash = notifier.registered[0].hash;
    assert.equal(typeof hash, "string", "the id is the string hash Zotero generated");

    shutdown();
    assert.deepEqual(
      notifier.unregistered,
      [hash],
      "teardown hands that same hash back to unregisterObserver: a check on the id's type that rejects a string leaves the observer registered for good",
    );

    delete zotero.Notifier;
  });

  it("heals a session whose pdf.js window was replaced, on the next toolbar render", async () => {
    closeAll();
    startup({ id: "probe-toolbar-realm-heal" });
    const opened = getSessions().length;
    const session = await openReader(940);
    assert.ok(session.ready, "the reader opened ready");
    assert.ok(session.innerWin, "the session paints the realm the reader opened with");

    // Zotero throws the reader panel away while its tab is hidden and builds a new
    // one on the way back: the same reader object, a brand new pdf.js window. The
    // dead realm's event bus dies with it, so nothing tells the session to repaint
    // — `renderToolbar` is the one event this route always gets.
    const fresh = fakeRealm();
    session.reader._internalReader._primaryView._iframeWindow = fresh;

    handlers.get("renderToolbar")({
      type: "renderToolbar",
      reader: session.reader,
      doc: fakeDoc(),
      params: {},
      append() {},
    });
    await tick();

    assert.equal(getSessions().length, opened + 1, "the render reused this reader's session");
    assert.equal(session.innerWin, fresh, "the render is the moment the session learns the realm moved");
    assert.equal(session.realmSwitches, 1, "the switch is counted for the probe");
    session.destroy();
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
    assert.equal(
      probeAll().version,
      probeAll().coreVersion,
      "a startup that supplied no add-on version falls back to the core version",
    );
    assert.equal(wake.count - before.count, 2, "the probe carries the notifier tally");
    assert.equal(wake.nullTarget - before.nullTarget, 1, "and the fallback count with it");

    globalThis.Zotero.Reader.getByTabID = () => null;
    session.destroy();
  });
});
