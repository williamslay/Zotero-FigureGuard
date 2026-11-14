import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { RegionCache } from "../../src/core/index.js";
import { getWarnLog, resetWarnOnce } from "../../src/zotero/overlay.js";
import {
  BRIDGE_GUESS_PASSES,
  DOCUMENT_CHECK_MS,
  RECOVERY_INTERVAL_MS,
  RECOVERY_MAX_MS,
  RECOVERY_SLOW_INTERVAL_MS,
  ReaderSession,
  SETTLED_REPAINT_MS,
  realmBelongsToReader,
  resolveInnerRealm,
  resolveInnerWindow,
} from "../../src/zotero/reader-session.js";
import { fakeTimers } from "./helpers/timers.mjs";

/**
 * The real machine (Zotero 10.0.8, three restored tabs) reports
 * `no-event-bus` plus `ready-timeout` for every reader: the document shows up
 * after the 20 s readiness window and the session was left dead. These tests
 * drive the slow recovery loop with a fake timer queue, so no test sleeps.
 *
 * The follow-up report was sharper: `innerWin: true`, `eventBus: false` and 79
 * attempts, i.e. the session latched onto a realm that was not the viewer at
 * all. The realm tests below pin that latch down.
 */

/** An event bus stand-in that records what was subscribed. */
function fakeEventBus() {
  return {
    on(name) {
      (this.bound ??= []).push(name);
    },
    off(name) {
      (this.unbound ??= []).push(name);
    },
  };
}

/**
 * A pdf.js viewer realm stand-in that reads its state live, so a test can make
 * the document or the event bus appear on a later recovery pass. `pageCount`
 * keeps `listPageViews` out of its `pdfDocument.numPages` fallback, so the paint
 * pass never reaches the overlay machinery.
 *
 * @param {{eventBus?: object|null, pdfDocument?: object|null, currentPageNumber?: number}} [state]
 */
function fakeRealm(state = {}) {
  const viewer = { currentPageNumber: state.currentPageNumber ?? 1, _pagesCount: 0 };
  Object.defineProperty(viewer, "pdfDocument", { get: () => state.pdfDocument ?? null, configurable: true });
  const app = { pdfViewer: viewer };
  Object.defineProperty(app, "eventBus", { get: () => state.eventBus ?? null, configurable: true });
  return { PDFViewerApplication: app, document: { readyState: "complete" } };
}

/** A Zotero reader stand-in whose pdf.js realm is attached after `_inner`. */
function fakeReader(itemID, inner = null) {
  return { itemID, _iframeWindow: null, _internalReader: { _primaryView: { _iframeWindow: inner } } };
}

/** A session with the readiness poll stubbed out, so `start()` fails at once. */
function newSession(reader) {
  const session = new ReaderSession({ reader, regionCache: new RegionCache({ maxEntries: 8 }), tag: `item:${reader.itemID}` });
  session.waitUntilReady = async () => false;
  return session;
}

/** Replaces a method with a counting wrapper and returns the call count. */
function spy(session, name) {
  const original = session[name].bind(session);
  const counts = { n: 0, seen: [] };
  session[name] = (...args) => {
    counts.n += 1;
    counts.seen.push(session.eventBus);
    return original(...args);
  };
  return counts;
}

describe("reader session: slow recovery after a failed start", () => {
  afterEach(() => resetWarnOnce());

  it("reaches readiness on the second recovery pass and releases its timer", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(481);
      const session = newSession(reader);
      const bound = spy(session, "bindEvents");
      const repainted = spy(session, "repaintAttached");
      let notified = 0;
      session.addListener(() => {
        notified += 1;
      });

      assert.equal(await session.start(), false, "a failed start still reports false");
      assert.equal(session.ready, false);
      assert.equal(session.recoveryRunning, true, "the failed start armed the recovery loop");
      assert.equal(timers.pending(), 1, "exactly one recovery timer is pending");
      assert.equal(timers.scheduled(), 1, "the readiness poll was stubbed, so nothing else timed");

      // Pass 1: the viewer realm has still not appeared.
      await timers.fireNext();
      assert.equal(session.ready, false);
      assert.equal(session.innerWin, null);
      assert.equal(bound.n, 0, "no realm yet, so nothing to bind");
      assert.equal(repainted.n, 0);
      assert.equal(timers.pending(), 1, "the next pass is scheduled, one timer at a time");

      // Pass 2: realm, event bus and document arrive together.
      const bus = fakeEventBus();
      const state = { eventBus: bus, pdfDocument: { numPages: 2 } };
      const realm = fakeRealm(state);
      reader._internalReader._primaryView._iframeWindow = realm;
      await timers.fireNext();

      assert.equal(session.ready, true, "the late document is picked up");
      assert.equal(session.innerWin, realm);
      assert.equal(bound.n, 1, "bindEvents ran exactly once");
      assert.equal(bound.seen[0], bus, "bindEvents ran with the bus in place");
      assert.ok(bus.bound.includes("pagesloaded"), "document events are subscribed");
      assert.ok(bus.bound.includes("pagerendered"), "page renders are subscribed");
      assert.equal(repainted.n, 1, "the pages that are already rendered get painted");
      assert.equal(notified, 1, "main.js refreshes lastDiagnostics through this");
      assert.match(String(session.documentId), /^fcp:/, "the document key is taken from the loaded document");
      assert.equal(timers.pending(), 0, "recovery stops once it is ready");
      assert.equal(session.timers.size, 0, "the recovery timer was released");
      assert.equal(session.recoveryRunning, false);
      assert.ok(
        getWarnLog().some((line) => line.startsWith("recovered:item:481")),
        "the recovery is logged per reader for Zotero.debug",
      );
    } finally {
      timers.restore();
    }
  });

  it("binds the event bus on a later pass when only the bus was missing", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(483);
      const session = newSession(reader);
      const bound = spy(session, "bindEvents");
      // The realm is there from the start; its event bus is not.
      const state = { eventBus: null, pdfDocument: null };
      const realm = fakeRealm(state);
      reader._internalReader._primaryView._iframeWindow = realm;
      session.innerWin = realm;
      session.eventBus = null;

      assert.equal(await session.start(), false);
      assert.equal(bound.n, 0);
      assert.equal(timers.pending(), 1);

      await timers.fireNext();
      assert.equal(session.ready, false, "no document yet, so recovery keeps going");
      assert.equal(bound.n, 0, "still no bus to bind");

      state.eventBus = fakeEventBus();
      state.pdfDocument = { numPages: 1 };
      await timers.fireNext();

      assert.equal(session.ready, true);
      assert.equal(session.eventBus, state.eventBus);
      assert.equal(bound.n, 1, "bindEvents ran again, now with a bus");
      assert.ok(state.eventBus.bound.includes("pagesloaded"), "the bus really got subscribed");
      assert.equal(timers.pending(), 0);
      assert.equal(session.timers.size, 0);
    } finally {
      timers.restore();
    }
  });

  it("switches to the slow heartbeat when the fast budget runs out", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(485);
      const session = newSession(reader);
      const bound = spy(session, "bindEvents");

      assert.equal(await session.start(), false);
      const passes = RECOVERY_MAX_MS / RECOVERY_INTERVAL_MS;
      for (let pass = 0; pass < passes; pass += 1) await timers.fireNext();

      assert.equal(
        timers.delays().filter((ms) => ms === RECOVERY_INTERVAL_MS).length,
        passes,
        `one fast timer per pass for ${passes} passes`,
      );
      assert.equal(timers.pending(), 1, "the loop keeps a timer alive past the budget");
      assert.equal(timers.lastDelay(), RECOVERY_SLOW_INTERVAL_MS, "the next sleep is the slow heartbeat");
      assert.equal(session.ready, false, "a reader that never loaded is still waiting");
      assert.equal(session.innerWin, null);
      assert.equal(bound.n, 0);
      assert.equal(session.recoveryRunning, true, "the heartbeat is still live, not abandoned");
      assert.ok(
        getWarnLog().some((line) => line.startsWith("recovery-slow:item:485")),
        "the switch to the heartbeat is logged once per reader",
      );

      // A viewer that appears long after the fast window is still picked up.
      const realm = fakeRealm({ eventBus: fakeEventBus(), pdfDocument: { numPages: 1 } });
      reader._internalReader._primaryView._iframeWindow = realm;
      await timers.fireNext();

      assert.equal(session.ready, true, "the heartbeat still recovers");
      assert.equal(timers.pending(), 0, "a successful pass ends the loop");
      assert.equal(session.timers.size, 0, "the heartbeat timer was released");
      assert.equal(session.recoveryRunning, false);
    } finally {
      timers.restore();
    }
  });

  it("replaces a realm that is not the viewer and rebinds its events", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(489);
      // The session latched onto a realm that has no document and no bus of its
      // own, the shape of an `about:blank` iframe taken before the navigation.
      const oldBus = fakeEventBus();
      const dead = fakeRealm({ eventBus: oldBus, pdfDocument: null });
      const session = newSession(reader);
      session.innerWin = dead;
      session.eventBus = oldBus;
      session.bindEvents();
      const bound = spy(session, "bindEvents");

      assert.equal(await session.start(), false);
      assert.equal(bound.n, 0, "the armed loop has not run a pass yet");

      // The reader chain now points at the viewer realm that really loaded.
      const bus = fakeEventBus();
      const viewer = fakeRealm({ eventBus: bus, pdfDocument: { numPages: 1 } });
      reader._internalReader._primaryView._iframeWindow = viewer;
      await timers.fireNext();

      assert.equal(session.innerWin, viewer, "the dead realm is swapped for the viewer realm");
      assert.equal(session.eventBus, bus, "the bus of the new realm is used");
      assert.equal(bound.n, 1, "the new bus is bound exactly once");
      assert.ok(bus.bound.includes("pagesloaded"), "the new bus really got subscribed");
      assert.ok(oldBus.unbound.includes("pagesloaded"), "the old realm's subscriptions were dropped");
      assert.equal(session.ready, true);
      assert.equal(timers.pending(), 0, "the loop ends on the successful pass");
    } finally {
      timers.restore();
    }
  });

  it("keeps the cached realm and does not rebind while the realm is unchanged", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(491);
      const bus = fakeEventBus();
      const realm = fakeRealm({ eventBus: bus, pdfDocument: null });
      reader._internalReader._primaryView._iframeWindow = realm;
      const session = newSession(reader);
      session.innerWin = realm;
      session.eventBus = bus;
      session.bindEvents();
      const bound = spy(session, "bindEvents");

      assert.equal(await session.start(), false);
      await timers.fireNext();

      assert.equal(session.innerWin, realm, "the same realm object is kept");
      assert.equal(bound.n, 0, "re-resolving the same realm must not subscribe twice");
      assert.equal(timers.pending(), 1, "no document yet, so the loop keeps going");
    } finally {
      timers.restore();
    }
  });

  it("clears the recovery timer on destroy and does not retry afterwards", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(487);
      const session = newSession(reader);
      const repainted = spy(session, "repaintAttached");

      assert.equal(await session.start(), false);
      assert.equal(timers.pending(), 1);
      const realm = fakeRealm({ eventBus: fakeEventBus(), pdfDocument: { numPages: 1 } });
      reader._internalReader._primaryView._iframeWindow = realm;

      session.destroy();
      assert.equal(timers.pending(), 0, "destroy released the pending recovery sleep");
      assert.equal(session.timers.size, 0);

      await timers.flush();
      assert.equal(repainted.n, 0, "a destroyed session never runs another pass");
      assert.equal(timers.pending(), 0);
      assert.equal(session.recoveryRunning, false);
      assert.equal(session.ready, false);
      assert.equal(session.startRecovery(), null, "a destroyed session cannot re-arm recovery");
    } finally {
      timers.restore();
    }
  });
});

/**
 * The iframe scan of `resolveInnerWindow`. Its single-frame fallback used to take
 * whatever the one iframe was, and on the real machine that was an `about:blank`
 * realm before the viewer had navigated: the session latched, the realm never
 * gained a `PDFViewerApplication`, and nothing re-resolved it afterwards.
 */
describe("resolveInnerWindow: only latches a viewer realm", () => {
  afterEach(() => resetWarnOnce());

  /** One iframe stand-in: `src` is its attribute value, `content` its content window. */
  function iframe(src, content) {
    return { contentWindow: content, getAttribute: (name) => (name === "src" ? src : null) };
  }

  /** A reader with no documented chain, whose window exposes exactly these iframes. */
  function scannedReader(frames) {
    return {
      _internalReader: null,
      _iframeWindow: { document: { querySelectorAll: (selector) => (selector === "iframe" ? frames : []) } },
    };
  }

  it("does not latch a lone about:blank frame", () => {
    const blank = { location: { href: "about:blank" } };
    const reader = scannedReader([iframe("", blank)]);
    assert.equal(resolveInnerWindow(reader), null, "one frame without a marker or a viewer src is not a realm");
  });

  it("returns the frame whose src is viewer.html", () => {
    const realm = { PDFViewerApplication: undefined };
    const reader = scannedReader([iframe("pdf/web/viewer.html", realm)]);
    assert.equal(resolveInnerWindow(reader), realm, "an exact src match is enough");
  });

  it("prefers the frame carrying PDFViewerApplication", () => {
    const bySrc = {};
    const byMarker = { PDFViewerApplication: {} };
    const reader = scannedReader([iframe("pdf/web/viewer.html", bySrc), iframe("", byMarker)]);
    assert.equal(resolveInnerWindow(reader), byMarker, "the marker outranks a src match");
  });

  it("returns null while the reader window has no frames", () => {
    assert.equal(resolveInnerWindow(scannedReader([])), null);
  });

  it("still takes the documented chain first", () => {
    const chained = { PDFViewerApplication: {} };
    const reader = { _internalReader: { _primaryView: { _iframeWindow: chained } }, _iframeWindow: null };
    assert.equal(resolveInnerWindow(reader), chained);
  });
});

/**
 * An overlay stand-in for the settled re-check. Only the fields the check reads
 * exist: the paint itself is stubbed on the session, so the check's routing —
 * which pages it re-paints — is what these tests pin down.
 *
 * @param {number} pageNumber
 * @param {{stale?: boolean, destroyed?: boolean, regions?: Array<*>}} [state]
 */
function settledOverlay(pageNumber, { stale = false, destroyed = false, regions = [[10, 20, 300, 400]] } = {}) {
  return {
    pageNumber,
    regionBoxes: regions,
    destroyed,
    cleared: 0,
    geometryStaleCalls: 0,
    geometryStale() {
      this.geometryStaleCalls += 1;
      return stale;
    },
    clear() {
      this.cleared += 1;
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** Wraps `paintOverlay` and records the overlay argument of every call. */
function paintSpy(session) {
  const calls = [];
  session.paintOverlay = async (overlay) => {
    calls.push(overlay);
  };
  return calls;
}

describe("reader session: settled geometry re-check after a toolbar toggle", () => {
  afterEach(() => resetWarnOnce());

  it("arms exactly one settled check when the feature is turned on", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(501));
      const painted = paintSpy(session);

      assert.equal(session.setEnabled(true), true);
      assert.equal(timers.pending(), 1, "one settled check is armed");
      assert.equal(timers.lastDelay(), SETTLED_REPAINT_MS, "it waits for the viewer relayout, not for the next paint tick");
      assert.equal(painted.length, 0, "nothing is corrected before the viewer has settled");

      session.destroy();
      assert.equal(timers.pending(), 0, "destroy releases the pending settled check");
      assert.equal(session.settledCheckTimer, null);
    } finally {
      timers.restore();
    }
  });

  it("arms one settled check after the first paint of a document", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(509));
      // The first-open case: readiness resolves and the session paints the
      // document once, exactly what `start()` ends with on a warm RegionCache.
      session.waitUntilReady = async () => true;
      // A bus already in place keeps `start()` out of the recovery loop, so the
      // only timer left afterwards can be the settled check.
      session.eventBus = fakeEventBus();
      const painted = paintSpy(session);

      assert.equal(await session.start(), true);
      assert.equal(timers.pending(), 1, "the first-document paint arms exactly one settled check");
      assert.equal(timers.lastDelay(), SETTLED_REPAINT_MS, "it waits for the relayout, like the enable pass does");
      assert.equal(painted.length, 0, "nothing is corrected before the timer fires");

      session.destroy();
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });

  it("arms a settled check after a document swap", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(511));
      const painted = paintSpy(session);
      // The viewer loads a second document under the running session, which
      // still carries the id of the first one.
      session.innerWin = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["second"] } });
      session.documentId = "fcp:first";

      session.queueDocumentCheck();
      assert.equal(timers.pending(), 1, "the swap starts as a single document check");
      assert.equal(timers.lastDelay(), DOCUMENT_CHECK_MS);

      await timers.fireNext();
      assert.equal(session.documentId, "fcp:second", "the swap branch ran and took the new document id");
      assert.notEqual(session.settledCheckTimer, null, "the swapped-in paint re-armed the settled check");
      assert.ok(timers.delays().includes(SETTLED_REPAINT_MS), "armed with the settled delay");
      assert.equal(painted.length, 0, "nothing is corrected before the settled timer fires");

      // The queue now holds the settled check and the follow-up document check;
      // firing the settled one runs an empty pass (the swap detached every page).
      await timers.fireNext();
      assert.equal(session.settledCheckTimer, null, "the settled pass ran and released its timer");
      assert.equal(painted.length, 0);

      session.destroy();
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });

  it("counts the overlays the settled pass re-paints, and stays 0 when none moved", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(513));
      const painted = paintSpy(session);
      assert.equal(session.settledRepaints, 0, "the counter starts at zero");

      session.overlays.set(1, settledOverlay(1, { stale: true }));
      session.overlays.set(2, settledOverlay(2));
      session.setEnabled(true);
      await timers.fireNext();

      assert.equal(painted.length, 1);
      assert.equal(session.settledRepaints, 1, "only the healed page is counted, not the aligned one");
      session.destroy();

      // A session whose pages never moved: the pass runs and adds nothing.
      const idle = newSession(fakeReader(515));
      const idlePainted = paintSpy(idle);
      idle.overlays.set(1, settledOverlay(1));
      idle.setEnabled(true);
      await timers.fireNext();

      assert.equal(idlePainted.length, 0);
      assert.equal(idle.settledRepaints, 0, "nothing stale, so nothing counted");
      idle.destroy();
    } finally {
      timers.restore();
    }
  });

  it("re-paints only the overlays whose painted viewport moved", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(503));
      const painted = paintSpy(session);
      const stale = settledOverlay(1, { stale: true });
      const fresh = settledOverlay(2);
      const dead = settledOverlay(3, { stale: true, destroyed: true });
      const unpainted = settledOverlay(4, { regions: [] });
      session.overlays.set(1, stale);
      session.overlays.set(2, fresh);
      session.overlays.set(3, dead);
      session.overlays.set(4, unpainted);

      session.setEnabled(true);
      await timers.fireNext();

      assert.deepEqual(painted, [stale], "the stale page is corrected, the aligned pages are left alone");
      assert.equal(dead.geometryStaleCalls, 0, "a destroyed overlay is skipped before its geometry is read");
      assert.equal(unpainted.geometryStaleCalls, 0, "a page without regions has nothing to correct");
      assert.equal(session.timers.size, 0, "the check releases its timer when it runs");
      assert.equal(session.settledCheckTimer, null);
    } finally {
      timers.restore();
    }
  });

  it("replaces the pending check instead of stacking one per toggle", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(505));
      const painted = paintSpy(session);
      const stale = settledOverlay(1, { stale: true });
      session.overlays.set(1, stale);

      session.setEnabled(true);
      session.setEnabled(false);
      assert.equal(session.overlays.size, 0, "turning the feature off detaches every page");
      assert.equal(timers.pending(), 1, "the check armed before the off pass is still the only one");

      // The on pass re-attaches the pages that have cached regions, then re-arms.
      session.overlays.set(1, stale);
      session.setEnabled(true);
      assert.equal(timers.pending(), 1, "toggling twice in a row keeps a single settled check");
      assert.equal(timers.lastDelay(), SETTLED_REPAINT_MS);

      await timers.fireNext();
      assert.equal(painted.length, 1, "the cancelled pass never ran, so exactly one correction happens");
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });

  it("never runs the check after destroy", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(507));
      const painted = paintSpy(session);
      session.overlays.set(1, settledOverlay(1, { stale: true }));

      session.setEnabled(true);
      session.destroy();
      await timers.flush();

      assert.equal(painted.length, 0, "a destroyed session does not paint into detached pages");
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });
});

/**
 * The fresh-open report of v0.1.22: opening a PDF paints nothing at all, and the
 * toolbar toggle that follows paints the pages in the wrong place. Four causes,
 * pinned one test each: recovery declaring readiness without an event bus (so no
 * `pagerendered` subscription was ever made), the first paint landing before the
 * page views existed, the WeakMap fallback key churning into `detachAll`, and the
 * page-at-a-time route never arming the settled pass.
 */
describe("reader session: fresh-open paint gaps", () => {
  afterEach(() => resetWarnOnce());

  /** Count of `no-event-bus` lines in the ring, for the once-per-realm checks. */
  function busWarnings() {
    return getWarnLog().filter((line) => line.startsWith("no-event-bus")).length;
  }

  /** A page view that has a rendered page, a div and a viewport, i.e. paintable. */
  function renderedPageView(id) {
    return {
      id,
      pdfPage: {},
      div: { style: {}, appendChild() {} },
      viewport: {
        scale: 1,
        width: 612,
        height: 792,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 792],
        convertToViewportPoint: (x, y) => [x, 792 - y],
      },
    };
  }

  it("does not declare readiness while the event bus is unresolved", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(517);
      // The shape of the real machine: realm and document readable, bus hidden.
      const state = { eventBus: null, pdfDocument: { numPages: 2 } };
      const realm = fakeRealm(state);
      reader._internalReader._primaryView._iframeWindow = realm;
      const session = newSession(reader);
      session.innerWin = realm;
      const repainted = spy(session, "repaintAttached");
      let notified = 0;
      session.addListener(() => {
        notified += 1;
      });

      assert.equal(await session.start(), false);
      assert.equal(session.ready, false);

      await timers.fireNext();
      assert.equal(session.ready, false, "a document alone does not make the session ready");
      assert.equal(repainted.n, 1, "the pages that do exist are painted while waiting");
      assert.equal(notified, 1, "the waiting state still reaches the diagnostics");
      assert.equal(timers.pending(), 1, "the loop keeps going for the bus, one timer at a time");

      await timers.fireNext();
      assert.equal(session.ready, false, "still no bus, so still not ready");
      assert.equal(busWarnings(), 0, "waiting on the bus is not an error worth repeating per pass");

      // The bus becomes readable: this pass binds it and ends the loop.
      const bus = fakeEventBus();
      state.eventBus = bus;
      await timers.fireNext();

      assert.equal(session.ready, true, "readiness now means the bus is bound too");
      assert.equal(session.eventBus, bus);
      assert.ok(bus.bound.includes("pagesloaded"), "document events are subscribed");
      assert.ok(bus.bound.includes("pagerendered"), "late pages finally have a painter");
      assert.equal(repainted.n, 3, "two waiting passes plus the pass that bound the bus, each painted");
      assert.equal(timers.pending(), 0, "a session with a bus ends the loop");
      assert.equal(session.recoveryRunning, false);
      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("warns about a missing bus once per realm instead of once per pass", () => {
    resetWarnOnce();
    const session = newSession(fakeReader(529));
    assert.equal(session.eventBus, null);

    for (let pass = 0; pass < 5; pass += 1) session.bindEvents();
    assert.equal(busWarnings(), 1, "the first bind without a bus logs, the rest stay quiet");

    session.releaseRealm();
    session.bindEvents();
    assert.equal(busWarnings(), 1, "a realm swap does not reopen the flood");
    session.destroy();
  });

  it("catches up once when nothing mounted, and not again when pages are painted", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(519));
      session.waitUntilReady = async () => true;
      session.eventBus = fakeEventBus();
      const repainted = spy(session, "repaintAttached");
      // The paint itself is not the subject: how often the catch-up dares to run.
      let mounted = 0;
      session.overlayCount = () => mounted;

      assert.equal(await session.start(), true);
      assert.equal(repainted.n, 2, "one extra pass runs because the first paint mounted nothing");
      assert.equal(timers.pending(), 1, "the catch-up arms no timer of its own");
      assert.equal(timers.lastDelay(), SETTLED_REPAINT_MS, "the only timer left is the settled check");

      // A healthy document: the sweep sees mounted pages and leaves them alone.
      mounted = 3;
      session.queueDocumentCheck();
      assert.equal(timers.pending(), 2, "the document check plus the settled check");
      await timers.fireNext();
      await timers.fireNext();
      assert.equal(repainted.n, 2, "a sweep over painted pages runs no catch-up");
      assert.equal(timers.pending(), 0);

      // Pages gone again, but this trigger already spent its one pass.
      mounted = 0;
      session.queueDocumentCheck();
      await timers.fireNext();
      assert.equal(repainted.n, 2, "at most one catch-up pass per trigger");
      assert.equal(timers.pending(), 0);

      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("skips the catch-up while the feature is off or the session is gone", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(521));
      const repainted = spy(session, "repaintAttached");
      session.overlayCount = () => 0;

      session.ready = false;
      assert.equal(session.catchUpPaint("pagesloaded"), false, "a session that never became ready does not paint");

      session.ready = true;
      session.enabled = false;
      assert.equal(session.catchUpPaint("pagesloaded"), false, "a disabled session does not paint");
      assert.equal(repainted.n, 0, "neither gate painted");

      session.enabled = true;
      assert.equal(session.catchUpPaint("pagesloaded"), true, "an enabled session with nothing mounted gets its pass");
      assert.equal(repainted.n, 1, "the pass painted once");
      assert.equal(session.catchUpPaint("pagesloaded"), false, "the trigger is spent");
      assert.equal(repainted.n, 1, "a spent trigger paints nothing new");

      session.destroy();
      assert.equal(session.catchUpPaint("start"), false, "a destroyed session never catches up");
      assert.equal(repainted.n, 1, "teardown ends the painting");
    } finally {
      timers.restore();
    }
  });

  it("adopts a printed document id without invalidating or detaching", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(523));
      const invalidated = [];
      session.regionCache.invalidateDocument = (id) => {
        invalidated.push(id);
      };
      const repainted = spy(session, "repaintAttached");
      const detached = spy(session, "detachAll");
      const state = { pdfDocument: { numPages: 1 } };
      session.innerWin = fakeRealm(state);
      // The first open ran with the Xrays hiding both printed fields.
      session.documentId = "fcp:doc-7";

      // The fingerprint becomes readable for the same live document.
      state.pdfDocument = { numPages: 1, fingerprints: ["printed-1"] };
      session.queueDocumentCheck();
      await timers.fireNext();

      assert.equal(session.documentId, "fcp:printed-1", "the printed key is adopted");
      assert.equal(session.documentIdAdopted, true, "the one-time transition is visible in diagnostics");
      assert.deepEqual(invalidated, [], "adopting a printed key does not invalidate the cache");
      assert.equal(detached.n, 0, "the mounted canvases are not wiped by the adoption");
      assert.equal(repainted.n, 0, "the adoption runs no repaint of its own");
      assert.equal(
        timers.delays().filter((ms) => ms === DOCUMENT_CHECK_MS).length,
        1,
        "the adoption does not requeue itself, so it cannot churn",
      );

      // A printed key facing a re-minted fallback key: no swap, no wipe.
      state.pdfDocument = { numPages: 1 };
      session.queueDocumentCheck();
      await timers.fireNext();
      assert.equal(session.documentId, "fcp:printed-1", "a printed key never regresses to a provisional one");
      assert.deepEqual(invalidated, []);
      assert.equal(detached.n, 0);

      // A different document with its own printed id is still a real swap.
      state.pdfDocument = { numPages: 1, fingerprints: ["printed-2"] };
      session.queueDocumentCheck();
      await timers.fireNext();
      assert.equal(session.documentId, "fcp:printed-2");
      // The key carries the reader's scope, so a swap in one reader cannot wipe the
      // cache entries another reader is still using, and it names the document whose
      // regions were cached — the one held before the swap, not the one just adopted.
      assert.deepEqual(
        invalidated,
        ["item:523|fcp:printed-1"],
        "a printed-to-printed swap invalidates the key held before the swap",
      );
      assert.equal(detached.n, 1, "and it drops the pages of the closed document");
      assert.equal(repainted.n, 1, "and it repaints the new one");

      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("holds a provisional key that the WeakMap fallback re-mints", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(525));
      const invalidated = [];
      session.regionCache.invalidateDocument = (id) => {
        invalidated.push(id);
      };
      const detached = spy(session, "detachAll");
      const state = { pdfDocument: { numPages: 1 } };
      session.innerWin = fakeRealm(state);
      session.ready = true;
      session.documentId = "fcp:doc-3";

      // Every read hands back a fresh wrapper, so the fallback mints a new number.
      state.pdfDocument = { numPages: 1 };
      session.queueDocumentCheck();
      await timers.fireNext();

      assert.equal(session.documentId, "fcp:doc-3", "a re-minted fallback key is not a document swap");
      assert.deepEqual(invalidated, [], "so it invalidates nothing");
      assert.equal(detached.n, 0, "and it wipes no canvases: the detachAll flapping is gone");
      assert.equal(timers.pending(), 0, "and it does not requeue itself");

      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("arms the settled check after a pagerendered paint", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(527));
      const realm = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["pr"] } });
      realm.PDFViewerApplication.pdfViewer._pagesView = [renderedPageView(1)];
      session.innerWin = realm;
      session.documentId = "fcp:pr";
      const painted = paintSpy(session);
      const settled = spy(session, "scheduleSettledCheck");

      session.onPageRenderedEvent({ pageNumber: 1 });
      assert.equal(painted.length, 1, "the rendered page is painted through the proven path");
      assert.equal(settled.n, 1, "and the paint arms the settled re-check");
      assert.equal(timers.lastDelay(), SETTLED_REPAINT_MS, "it waits out the viewer relayout");

      // A page the session cannot paint starts nothing, so nothing is armed.
      session.onPageRenderedEvent({ pageNumber: 42 });
      assert.equal(settled.n, 1, "an unpaintable page arms no check");

      // A burst of finished pages keeps a single check instead of one per page.
      session.onPageRenderedEvent({ pageNumber: 1 });
      session.onPageRenderedEvent({ pageNumber: 1 });
      assert.equal(timers.pending(), 1, "repeat arming replaces the pending check");

      // The pass heals the page whose painted viewport moved, exactly once.
      painted.length = 0;
      const stale = settledOverlay(1, { stale: true });
      session.overlays.set(1, stale);
      await timers.fireNext();
      assert.deepEqual(painted, [stale], "the displaced page is re-painted from its cached regions");
      assert.equal(session.settledRepaints, 1, "and the heal is counted for the probe");

      session.destroy();
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });

  it("keys the region cache by reader, not by document alone", () => {
    const session = newSession(fakeReader(531));
    const other = newSession(fakeReader(533));
    session.documentId = "fcp:same";
    other.documentId = "fcp:same";

    assert.equal(session.cacheKey(), "item:531|fcp:same", "the key carries the reader the regions belong to");
    assert.notEqual(session.cacheKey(), other.cacheKey(), "two readers of one file never share a cache entry");
    assert.equal(session.documentId, "fcp:same", "the reported document id stays the printed one");

    session.destroy();
    other.destroy();
  });

  it("wakes the reader behind the selected tab", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(535));
      const checks = spy(session, "queueDocumentCheck");
      const realms = spy(session, "reevaluateRealm");
      const detached = spy(session, "detachAll");

      session.onTabActivate();

      assert.equal(checks.n, 1, "activation queues a document check for the page in view");
      assert.equal(realms.n, 1, "activation re-derives which pdf.js realm this reader paints");
      assert.equal(
        timers.delays().filter((ms) => ms === DOCUMENT_CHECK_MS).length,
        1,
        "the check is debounced like every other trigger",
      );
      assert.equal(detached.n, 0, "a wake wipes nothing by itself");

      session.destroy();
      assert.equal(timers.pending(), 0, "the pending wake went with the session");
    } finally {
      timers.restore();
    }
  });

  it("keeps a background wake from queueing the paint sweep", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const session = newSession(fakeReader(536));
      const checks = spy(session, "queueDocumentCheck");
      const realms = spy(session, "reevaluateRealm");

      session.onTabActivate({ paint: false });

      assert.equal(realms.n, 1, "a background wake still re-validates the realm and document identity");
      assert.equal(checks.n, 0, "a background wake queues no document check");
      assert.equal(
        timers.delays().filter((ms) => ms === DOCUMENT_CHECK_MS).length,
        0,
        "no debounced sweep is armed for the hidden page",
      );
      assert.equal(session.lastValidation?.trigger, "tab-activate", "the verify wake is recorded like any other");
      assert.equal(session.paintOnSelectPending, true, "the next paint-driving wake is flagged to repaint");

      session.onTabActivate();

      assert.equal(checks.n, 1, "the selected wake queues the sweep again");
      assert.equal(session.paintOnSelectPending, false, "and the pending flag goes with it");

      session.destroy();
      assert.equal(timers.pending(), 0, "the pending wake went with the session");
    } finally {
      timers.restore();
    }
  });

  it("keeps a connected overlay across an activation over the same realm", () => {
    resetWarnOnce();
    const reader = fakeReader(537);
    const realm = fakeRealm({ pdfDocument: { numPages: 2, fingerprints: ["keep"] } });
    reader._internalReader._primaryView._iframeWindow = realm;
    const session = newSession(reader);
    session.innerWin = realm;
    session.documentId = "fcp:keep";
    const released = spy(session, "releaseRealm");
    const mounted = settledOverlay(1);
    session.overlays.set(1, mounted);

    session.onTabActivate();

    assert.equal(released.n, 0, "the realm this reader already has is not swapped out");
    assert.equal(session.realmSwitches, 0, "so no realm switch is recorded");
    assert.equal(session.overlays.get(1), mounted, "the mounted canvas keeps its place");
    assert.equal(mounted.destroyed, false, "and it is not destroyed by the wake");
    session.destroy();
  });

  it("counts only the overlays that are still connected", () => {
    const session = newSession(fakeReader(539));
    session.overlays.set(1, { canvasCount: 1, connectedCount: 1, destroy() {} });
    session.overlays.set(2, { canvasCount: 2, connectedCount: 0, destroy() {} });

    assert.equal(session.overlayCount(), 1, "the canvases that left the live page count as nothing");

    session.overlays.set(3, { canvasCount: 3, connectedCount: 3, destroy() {} });
    assert.equal(session.overlayCount(), 4, "the pages that are connected count their canvases");

    session.overlays.delete(2);
    session.overlays.set(1, { canvasCount: 2, destroy() {} });
    assert.equal(session.overlayCount(), 5, "an overlay that reports no connection falls back to its own count");

    session.destroy();
    assert.equal(session.overlayCount(), 0, "teardown leaves nothing mounted");
  });

  it("re-keys a session that latched the other tab's document on activation", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(541);
      const realm = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["own"] } });
      reader._internalReader._primaryView._iframeWindow = realm;
      const session = newSession(reader);
      session.innerWin = realm;
      // Startup latched the *other* reader's key while the bridge had this tab's
      // realm pointing at the wrong `PDFViewerApplication`.
      session.documentId = "fcp:other";
      const invalidated = [];
      session.regionCache.invalidateDocument = (key) => {
        invalidated.push(key);
      };
      const detached = spy(session, "detachAll");
      paintSpy(session);

      session.onTabActivate();

      assert.equal(session.documentId, "fcp:own", "activation re-derives the id from the live document");
      assert.deepEqual(invalidated, ["item:541|fcp:other"], "the wrong document's entries go under the old key");
      assert.equal(detached.n, 1, "the canvases painted from the wrong document are dropped");
      assert.ok(
        getWarnLog().some((line) => line.startsWith("doc-drift")),
        "the correction is visible in the warning ring",
      );

      // The debounced sweep agrees with the correction instead of churning.
      await timers.fireNext();
      assert.deepEqual(invalidated, ["item:541|fcp:other"], "the sweep invalidates nothing new");
      assert.equal(session.documentId, "fcp:own");

      // A second activation over the same document is a no-op.
      session.onTabActivate();
      assert.equal(session.documentId, "fcp:own", "the correction is stable across wakes");
      assert.deepEqual(invalidated, ["item:541|fcp:other"]);

      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("leaves a provisional latch to the silent adoption, not the drift check", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(543);
      const realm = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["own"] } });
      reader._internalReader._primaryView._iframeWindow = realm;
      const session = newSession(reader);
      session.innerWin = realm;
      // Xrays hid the printed fields at startup, so the latch is provisional.
      session.documentId = "fcp:doc-7";
      const invalidated = [];
      session.regionCache.invalidateDocument = (key) => {
        invalidated.push(key);
      };
      const detached = spy(session, "detachAll");
      paintSpy(session);

      session.onTabActivate();

      assert.equal(session.documentId, "fcp:doc-7", "the drift check never churns a re-minted provisional key");
      assert.equal(detached.n, 0, "so it wipes no canvases and keeps the regions of the first paint");

      await timers.fireNext();
      assert.equal(session.documentId, "fcp:own", "the debounced sweep adopts the printed key as before");
      assert.equal(session.documentIdAdopted, true, "and the adoption stays visible in diagnostics");
      assert.deepEqual(invalidated, [], "the silent adoption invalidates nothing");

      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("re-keys a wrong-realm latch during a recovery pass", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(545);
      const realm = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["own"] }, eventBus: fakeEventBus() });
      reader._internalReader._primaryView._iframeWindow = realm;
      const session = newSession(reader);
      session.innerWin = realm;
      session.documentId = "fcp:other";
      const invalidated = [];
      session.regionCache.invalidateDocument = (key) => {
        invalidated.push(key);
      };
      paintSpy(session);

      assert.equal(session.recoveryPass(), true, "the pass finds the session ready");
      assert.equal(session.documentId, "fcp:own", "and heals the wrong-realm id on the same pass");
      assert.deepEqual(invalidated, ["item:545|fcp:other"], "the stale key is dropped before the new one lands");
      assert.equal(
        timers.lastDelay(),
        SETTLED_REPAINT_MS,
        "the rebuilt canvases get the settled re-check, as after a document swap",
      );

      session.destroy();
      assert.equal(timers.pending(), 0);
    } finally {
      timers.restore();
    }
  });
});

/**
 * Realm ownership: a realm resolved from the reader's own chain, src or frame
 * scan is this reader's; the window-level bridge is a guess that can name the
 * other reader's viewer on tab re-activation. These tests pin the provenance
 * reporting, the membership check that refuses to certify the guess, and the
 * bounded acceptance budget that stops a wrong guess from delaying paint.
 */
describe("realm ownership and bridge guesses", () => {
  afterEach(() => resetWarnOnce());

  /** One iframe stand-in: `src` is its attribute value, `content` its content window. */
  function iframe(src, content) {
    return { contentWindow: content, getAttribute: (name) => (name === "src" ? src : null) };
  }

  /** A reader with no documented chain, whose window exposes exactly these iframes. */
  function scannedReader(frames) {
    return {
      _internalReader: null,
      _iframeWindow: { document: { querySelectorAll: (selector) => (selector === "iframe" ? frames : []) } },
    };
  }

  /**
   * Stands in for the realm bridge main.js installs on the browser window.
   * `resolver` answers the window-level call (given the reader) and the per-frame
   * call (given a frame's content window). Returns the restore function.
   */
  function stubBridge(resolver) {
    const previous = globalThis.Services;
    globalThis.Services = {
      wm: { getMostRecentWindow: () => ({ FigureColorResolveViewer: resolver }) },
    };
    return () => {
      if (previous === undefined) delete globalThis.Services;
      else globalThis.Services = previous;
    };
  }

  it("names the documented chain as trusted provenance", () => {
    const chained = { PDFViewerApplication: {} };
    const reader = { _internalReader: { _primaryView: { _iframeWindow: chained } }, _iframeWindow: null };
    const resolution = resolveInnerRealm(reader);
    assert.equal(resolution.win, chained);
    assert.equal(resolution.provenance, "chain", "the reader's own view window is authoritative");
  });

  it("names the frame scan and the src match by their route", () => {
    const bySrc = {};
    const byMarker = { PDFViewerApplication: {} };
    const both = resolveInnerRealm(scannedReader([iframe("pdf/web/viewer.html", bySrc), iframe("", byMarker)]));
    assert.equal(both.win, byMarker, "the marker still outranks the src match");
    assert.equal(both.provenance, "scan", "the marker was found by scanning this reader's own window");

    const onlySrc = resolveInnerRealm(scannedReader([iframe("pdf/web/viewer.html", bySrc)]));
    assert.equal(onlySrc.win, bySrc);
    assert.equal(onlySrc.provenance, "src", "a viewer.html src inside this reader's window is a trusted frame");
  });

  it("realmBelongsToReader accepts chain, view list and host frames", () => {
    const chainWin = {};
    const reader = fakeReader(600, chainWin);
    assert.equal(realmBelongsToReader(chainWin, reader), true, "the primary view's window belongs to the reader");

    const viewWin = {};
    reader._internalReader._views = [{ _iframeWindow: null }, { _iframeWindow: viewWin }];
    assert.equal(realmBelongsToReader(viewWin, reader), true, "a listed view is the reader's too");

    const frameWin = {};
    reader._iframeWindow = { document: { querySelectorAll: (selector) => (selector === "iframe" ? [iframe("", frameWin)] : []) } };
    assert.equal(realmBelongsToReader(frameWin, reader), true, "a mounted iframe of the reader's host window counts");

    assert.equal(realmBelongsToReader({}, reader), false, "a window no route lists is foreign");
    assert.equal(realmBelongsToReader(null, reader), false, "no window is nobody's realm");
  });

  it("the window-level bridge guess cannot certify itself", () => {
    const foreign = { PDFViewerApplication: {} };
    const reader = scannedReader([]);
    const restore = stubBridge((target) => (target === reader ? foreign : null));
    try {
      const resolution = resolveInnerRealm(reader);
      assert.equal(resolution.win, foreign, "the bridge answers when both own routes come up empty");
      assert.equal(resolution.provenance, "bridge");
      assert.equal(
        realmBelongsToReader(foreign, reader),
        false,
        "the membership check reads the chain directly, so it never certifies the bridge's own guess",
      );
    } finally {
      restore();
    }
  });

  it("an unconfirmed bridge realm reports no document drift", () => {
    const reader = fakeReader(602);
    const foreign = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["foreign"] } });
    const session = newSession(reader);
    session.innerWin = foreign;
    session.realmProvenance = "bridge";
    session.documentId = "fcp:mine";

    assert.equal(session.realmConfirmed(), false);
    assert.equal(
      session.docIdentityDrift(),
      null,
      "the foreign window's fingerprint is the guess, not a drift; re-resolution heals it",
    );

    session.realmProvenance = "bridge-guessed";
    assert.equal(session.docIdentityDrift(), "fcp:foreign", "once accepted, the window serves identity again");
    session.destroy();
  });

  it("membership certifies a realm no matter how it was stamped", () => {
    const reader = fakeReader(604);
    const realm = fakeRealm();
    reader._internalReader._primaryView._iframeWindow = realm;
    const session = newSession(reader);
    session.innerWin = realm;
    assert.equal(session.realmConfirmed(), true, "the chain still lists the held window, so it is owned");

    const foreign = fakeRealm();
    session.innerWin = foreign;
    session.realmProvenance = "bridge-guessed";
    assert.equal(session.realmConfirmed(), true, "a spent and accepted guess counts as owned");
    session.realmProvenance = "bridge";
    assert.equal(session.realmConfirmed(), false, "an unspent guess on a foreign window does not");
    session.destroy();
  });

  it("recovery accepts the bridge guess once its budget is spent", () => {
    const reader = fakeReader(606);
    const foreign = fakeRealm({
      pdfDocument: { numPages: 1, fingerprints: ["foreign"] },
      eventBus: fakeEventBus(),
    });
    const session = newSession(reader);
    session.innerWin = foreign;
    session.realmProvenance = "bridge";

    let done = false;
    for (let pass = 0; pass < BRIDGE_GUESS_PASSES; pass += 1) done = session.recoveryPass();

    assert.equal(done, true, "the last pass of the budget ends recovery");
    assert.equal(session.ready, true);
    assert.equal(session.realmProvenance, "bridge-guessed", "the guess becomes the accepted realm");
    assert.equal(session.documentId, "fcp:foreign", "identity is minted from the visible document");
    session.destroy();
  });

  it("recovery adopts the reader's own window as soon as it appears", () => {
    const reader = fakeReader(608);
    const foreign = fakeRealm({
      pdfDocument: { numPages: 1, fingerprints: ["foreign"] },
      eventBus: fakeEventBus(),
    });
    const ownBus = fakeEventBus();
    const own = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["own"] }, eventBus: ownBus });
    const session = newSession(reader);
    session.innerWin = foreign;
    session.realmProvenance = "bridge";
    session.bridgeGuessPasses = 3;

    reader._internalReader._primaryView._iframeWindow = own;
    const done = session.recoveryPass();

    assert.equal(session.innerWin, own, "the own window replaces the foreign guess mid-budget");
    assert.equal(session.realmProvenance, "chain", "and adoption resets trust to the authoritative route");
    assert.equal(session.bridgeGuessPasses, 0, "the spent part of the budget starts over for a new guess");
    assert.equal(done, true, "the own document ends recovery on the adoption pass");
    assert.equal(session.documentId, "fcp:own", "identity comes from the own document, not the guess");
    session.destroy();
  });

  it("waitUntilReady adopts the own window that appears mid-poll", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(610);
      const foreign = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["foreign"] } });
      const own = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["own"] } });
      const session = newSession(reader);
      delete session.waitUntilReady;
      session.innerWin = foreign;
      session.realmProvenance = "bridge";

      const waiting = session.waitUntilReady();
      await timers.fireNext();
      assert.equal(session.bridgeGuessPasses, 2, "the guess is polled instead of served immediately");
      assert.equal(session.innerWin, foreign, "nothing adoptable has appeared yet");

      reader._internalReader._primaryView._iframeWindow = own;
      await timers.fireNext();
      assert.equal(session.innerWin, own, "the poll adopts the own window the pass it appears");
      assert.equal(await waiting, true, "the own document ends the wait");
      assert.equal(session.realmProvenance, "chain");
      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("waitUntilReady serves the guess when the own window never appears", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const reader = fakeReader(612);
      const foreign = fakeRealm({ pdfDocument: { numPages: 1, fingerprints: ["foreign"] } });
      const session = newSession(reader);
      delete session.waitUntilReady;
      session.innerWin = foreign;
      session.realmProvenance = "bridge";

      const waiting = session.waitUntilReady();
      for (let poll = 1; poll < BRIDGE_GUESS_PASSES; poll += 1) await timers.fireNext();

      assert.equal(await waiting, true, "the spent budget ends the wait long before the 20 s timeout");
      assert.equal(session.realmProvenance, "bridge-guessed");
      assert.equal(session.innerWin, foreign, "the visible window keeps serving: a painted guess beats none");
      session.destroy();
    } finally {
      timers.restore();
    }
  });
});

describe("reader session: healing after a tab is hidden and shown again", () => {
  afterEach(() => resetWarnOnce());

  it("rebinds to the realm the reactivated tab hands out", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const firstBus = fakeEventBus();
      const reader = fakeReader(521, fakeRealm({ eventBus: firstBus, pdfDocument: { numPages: 1 } }));
      const session = newSession(reader);
      session.adoptRealm(resolveInnerRealm(reader, session.tag));
      assert.ok(firstBus.bound.includes("pagesloaded"), "the first realm is subscribed");
      assert.ok(firstBus.bound.includes("pagerendered"), "the first realm paints late pages");

      // Zotero tears the PDF.js window down when the tab goes away and hands the
      // reader a new one when it comes back: the old bus died with that window, so
      // a session that keeps the dead realm never hears about a page render again.
      const secondBus = fakeEventBus();
      const second = fakeRealm({ eventBus: secondBus, pdfDocument: { numPages: 1 } });
      reader._internalReader._primaryView._iframeWindow = second;

      session.onTabActivate();

      assert.equal(session.innerWin, second, "the dead realm is replaced by the live window");
      assert.equal(session.eventBus, secondBus, "the session is bound to the new bus");
      assert.ok(firstBus.unbound.includes("pagesloaded"), "the dead bus is unsubscribed");
      assert.ok(firstBus.unbound.includes("pagerendered"), "the dead repaint observer is dropped");
      assert.ok(secondBus.bound.includes("pagesloaded"), "the new bus is subscribed");
      assert.ok(secondBus.bound.includes("pagerendered"), "the new pages get a repaint observer");
      assert.equal(session.realmSwitches, 1, "the switch is counted for the probe");
      assert.ok(
        getWarnLog().some((line) => line.startsWith("realm-switched")),
        "the switch is logged for Zotero.debug",
      );
      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("repaints a zoom on a proven realm, and defers it while the realm is unproven", () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const realm = fakeRealm({ eventBus: fakeEventBus(), pdfDocument: { numPages: 1 } });
      const session = newSession(fakeReader(523, realm));
      const settled = spy(session, "scheduleSettledCheck");
      const paints = [];
      session.paintOverlay = async (overlay) => {
        paints.push(overlay);
      };
      session.adoptRealm(resolveInnerRealm(session.reader, session.tag));
      session.documentId = "fcp:item:523:1:aaa";
      session.overlays.set(1, settledOverlay(1));
      const mounted = session.overlays.get(1);

      session.ensureCurrentDocument = () => "wait";
      session.onViewScaleChange();
      assert.equal(settled.n, 1, "a pass that could not run is re-armed, not lost");
      assert.equal(paints.length, 0, "nothing is painted under an identity the session cannot prove");
      assert.equal(session.documentId, "fcp:item:523:1:aaa", "the proven key is not thrown away");

      session.ensureCurrentDocument = () => "rekeyed";
      session.onViewScaleChange();
      assert.equal(settled.n, 1, "a re-key re-arms the settled check itself, so no second arming");
      assert.equal(paints.length, 0, "a re-key paints through its own pass, not through the zoom");

      session.ensureCurrentDocument = () => "ok";
      session.onViewScaleChange();
      assert.equal(settled.n, 1, "a clean zoom needs no retry");
      assert.deepEqual(paints, [mounted], "a proven realm gets its colours back on the spot");
      session.destroy();
    } finally {
      timers.restore();
    }
  });

  it("keeps the document sweep retrying when its pass lands on an unproven realm", async () => {
    const timers = fakeTimers();
    try {
      resetWarnOnce();
      const realm = fakeRealm({ eventBus: fakeEventBus(), pdfDocument: { numPages: 1 } });
      const session = newSession(fakeReader(525, realm));
      const settled = spy(session, "scheduleSettledCheck");
      const detach = spy(session, "detachAll");
      session.adoptRealm(resolveInnerRealm(session.reader, session.tag));
      session.documentId = "fcp:item:525:1:bbb";
      session.ensureCurrentDocument = () => "wait";

      session.queueDocumentCheck();
      assert.equal(timers.lastDelay(), DOCUMENT_CHECK_MS, "the sweep is armed");

      await timers.fireNext();

      assert.equal(settled.n, 1, "the sweep re-arms the settled check instead of parking");
      assert.ok(timers.delays().includes(SETTLED_REPAINT_MS), "a retry really is queued");
      assert.equal(detach.n, 0, "nothing is detached while the realm is unproven");
      assert.equal(session.documentId, "fcp:item:525:1:bbb", "a wait is not a re-key");
      assert.equal(session.documentCheckTimer, null, "the sweep released its own timer");
      session.destroy();
    } finally {
      timers.restore();
    }
  });
});
