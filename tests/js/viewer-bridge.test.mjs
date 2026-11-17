import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getWarnLog, resetWarnOnce } from "../../src/zotero/overlay.js";
import { VIEWER_BRIDGE_SRC, shutdown, startup } from "../../src/zotero/main.js";
import { chainProbe } from "../../src/zotero/reader-session.js";

/**
 * The realm bridge. `installViewerBridge` evaluates `VIEWER_BRIDGE_SRC` with
 * `win.eval`, so the resolver function is created in the main window realm and its
 * property reads see the reader objects without Xrays. These tests run that same
 * string against a stand-in window, which is the only way to test the body: the
 * function it installs is not reachable from the sandbox as source.
 *
 * Three facts from the real machine and the Zotero sources shape the expectations:
 *   - `Zotero.Reader.getOpenReaders is not a function`, so `_readers` is the list
 *     source that actually runs. Where it does exist it hands back a generator, so
 *     the list is materialised first, and one that throws falls through to
 *     `_readers` the way `openReaderRecords()` does.
 *   - `c === r` compares a reader handed in from the bootstrap sandbox with the one
 *     the main window holds; across a realm boundary identity never holds, which is
 *     why the bridge falls back to "exactly one reader has an iframe window".
 *   - A shallow `tabID` read does survive the boundary, so it is tried before that
 *     guess: with two readers open and only one of them mounted, the guess alone
 *     would hand back the frame of the other reader.
 */

/**
 * Runs the bridge source against a stand-in window realm.
 *
 * @param {object} windowLike The `window` the source sees: `Zotero`, and anything
 *   else the resolver reads.
 * @returns {Function} The installed `FigureColorResolveViewer`.
 */
function evaluateBridge(windowLike) {
  new Function("window", VIEWER_BRIDGE_SRC)(windowLike);
  assert.equal(typeof windowLike.FigureColorResolveViewer, "function", "the source installs the resolver");
  return windowLike.FigureColorResolveViewer;
}

/** A reader stand-in carrying the documented iframe-window chain. */
function readerWithFrame(iframeWindow) {
  return { _internalReader: { _primaryView: { _iframeWindow: iframeWindow } } };
}

describe("VIEWER_BRIDGE_SRC: the list source", () => {
  afterEach(() => resetWarnOnce());

  it("uses getOpenReaders when the build has it", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: { Reader: { getOpenReaders: () => [{ tabID: "tab-1" }], getByTabID: () => read } },
    };
    assert.equal(evaluateBridge(win)(read), frame, "the identity test resolves the frame");
  });

  it("takes the records of a generator-shaped getOpenReaders", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    // Zotero 7 returns a generator here: no `length`, so an index loop over the
    // raw return value runs zero times and the bridge is blind to every reader.
    function* openReaders() {
      yield { tabID: "tab-1" };
    }
    const win = { Zotero: { Reader: { getOpenReaders: openReaders, getByTabID: () => read } } };
    assert.equal(evaluateBridge(win)(read), frame, "the generator is materialised before the scan");
  });

  it("takes the records of a Set-shaped getOpenReaders", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: { Reader: { getOpenReaders: () => new Set([{ tabID: "tab-1" }]), getByTabID: () => read } },
    };
    assert.equal(evaluateBridge(win)(read), frame, "any iterable is the list the scan wants");
  });

  it("falls back to _readers when getOpenReaders exists but throws", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: {
        Reader: {
          getOpenReaders() {
            throw new Error("getOpenReaders is not a function");
          },
          _readers: { "tab-1": { tabID: "tab-1", reader: read } },
          getByTabID: () => read,
        },
      },
    };
    assert.equal(evaluateBridge(win)(read), frame, "the throw falls through instead of ending the lookup");
  });

  it("uses _readers when getOpenReaders is missing, as on the real machine", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    // The measured failure is "getOpenReaders is not a function", i.e. the
    // property is absent, and `_readers` is keyed by tab id.
    const win = {
      Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1", reader: read } }, getByTabID: () => read } },
    };
    assert.equal(evaluateBridge(win)(read), frame);
  });

  it("takes the values of a Map-shaped _readers", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: {
        Reader: { _readers: new Map([["tab-1", { tabID: "tab-1", reader: read }]]), getByTabID: () => read },
      },
    };
    assert.equal(evaluateBridge(win)(read), frame);
  });

  it("takes the entries of an Array-shaped _readers", () => {
    const frame = { PDFViewerApplication: {} };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: { Reader: { _readers: [{ tabID: "tab-1", reader: read }], getByTabID: () => read } },
    };
    assert.equal(evaluateBridge(win)(read), frame);
  });

  it("is null without a Zotero.Reader", () => {
    assert.equal(evaluateBridge({})(null), null);
    assert.equal(evaluateBridge({ Zotero: {} })(null), null);
  });

  it("is null when the reader API throws", () => {
    const win = {
      Zotero: {
        Reader: {
          get _readers() {
            throw new Error("Xray blocked _readers");
          },
        },
      },
    };
    assert.equal(evaluateBridge(win)({}), null, "the try/catch turns the throw into a miss");
  });
});

describe("VIEWER_BRIDGE_SRC: the identity miss and the single-reader fallback", () => {
  afterEach(() => resetWarnOnce());

  /** A window with one reader per frame, reachable only through `_readers`. */
  function windowWith(frames, tabIDs) {
    const readers = frames.map((frame, index) => readerWithFrame(frame));
    const byTab = new Map((tabIDs ?? frames.map((_, index) => `tab-${index}`)).map((id, index) => [id, readers[index]]));
    const records = [...byTab.entries()].map(([tabID, reader]) => ({ tabID, reader }));
    const api = { _readers: Object.fromEntries(records.map((rec) => [rec.tabID, rec])), getByTabID: (id) => byTab.get(id) };
    return { Zotero: { Reader: api }, readers };
  }

  it("returns the frame of the only reader when the identity test cannot match", () => {
    const frame = { PDFViewerApplication: {} };
    const win = windowWith([frame]);
    // A copy, the way the sandbox's cross-realm stand-in of the same reader looks:
    // same shape, different object, so `c === r` is false.
    assert.equal(evaluateBridge(win)({ ...win.readers[0] }), frame);
  });

  it("is null when two readers each have an iframe window and none matched by identity", () => {
    const win = windowWith([{ PDFViewerApplication: {} }, { PDFViewerApplication: {} }]);
    assert.equal(evaluateBridge(win)({ _internalReader: {} }), null, "guessing the wrong reader is worse than nothing");
  });

  it("returns null for an identity match whose reader has no primary view", () => {
    const matched = {};
    const win = { Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1" } }, getByTabID: () => matched } } };
    assert.equal(evaluateBridge(win)(matched), null, "an identity match ends the scan, frame or not");
  });

  it("is null when no reader has an iframe window", () => {
    const win = { Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1" } }, getByTabID: () => ({ _internalReader: null }) } } };
    assert.equal(evaluateBridge(win)({}), null);
  });

  it("stops at the identity match instead of the single-reader fallback", () => {
    const matchedFrame = { PDFViewerApplication: { matched: true } };
    const win = windowWith([{ PDFViewerApplication: {} }, matchedFrame]);
    assert.equal(evaluateBridge(win)(win.readers[1]), matchedFrame, "two candidates but an exact match");
  });

  it("matches on tabID when the identity test cannot, instead of guessing", () => {
    const frames = [{ PDFViewerApplication: { first: true } }, { PDFViewerApplication: { second: true } }];
    const win = windowWith(frames, ["tab-a", "tab-b"]);
    // A cross-realm stand-in that carries its shallow `tabID`, the way the reader
    // object does: two framed readers and no identity match, but the tab says which.
    assert.equal(evaluateBridge(win)({ tabID: "tab-b" }), frames[1], "the tabID picks the second reader");
    assert.equal(evaluateBridge(win)({ tabID: "tab-a" }), frames[0], "and the first one likewise");
  });

  it("is null when the tabID match has no frame, not the other reader's", () => {
    const framed = { PDFViewerApplication: {} };
    const win = windowWith([framed, null], ["tab-a", "tab-b"]);
    assert.equal(evaluateBridge(win)({ tabID: "tab-b" }), null, "the only mounted frame belongs to the wrong reader");
    assert.equal(evaluateBridge(win)({ tabID: "tab-a" }), framed, "the reader named by the tab is the one with a frame");
  });

  it("is null with wantApp when two readers are open and a booting iframe window has no match yet", () => {
    const foreignApp = { pdfViewer: { foreign: true } };
    const win = windowWith([{ PDFViewerApplication: foreignApp }, null], ["tab-a", "tab-b"]);
    const bootingIframe = { PDFViewerApplication: undefined };
    assert.equal(
      evaluateBridge(win)(bootingIframe, true),
      null,
      "a booting second tab's iframe must never inherit the first tab's PDFViewerApplication",
    );
  });

  it("still resolves an identity match when the argument's tabID read throws", () => {
    const frame = { PDFViewerApplication: {} };
    const arg = { _internalReader: { _primaryView: { _iframeWindow: frame } } };
    Object.defineProperty(arg, "tabID", {
      get() {
        throw new Error("tabID blocked");
      },
      configurable: true,
    });
    const win = { Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1" } }, getByTabID: () => arg } } };
    assert.equal(evaluateBridge(win)(arg), frame, "a blind tabID only loses the tabID route");
  });
});

describe("VIEWER_BRIDGE_SRC: the application object for the bridge route", () => {
  afterEach(() => resetWarnOnce());

  /** A window holding one reader, reachable only through `_readers`. */
  function windowWithFrame(frame) {
    const read = { _internalReader: { _primaryView: { _iframeWindow: frame } } };
    return {
      Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1", reader: read } }, getByTabID: () => read } },
      read,
    };
  }

  it("returns the application object read in this realm", () => {
    const app = { pdfViewer: {}, eventBus: {} };
    const win = windowWithFrame({ PDFViewerApplication: app });
    // The realm window crosses back into the sandbox as a window wrapper whose
    // JS-defined properties are blind, so `app` has to be read here, not there.
    assert.equal(evaluateBridge(win)({ ...win.read }, true), app);
  });

  it("resolves the application through frame identity", () => {
    const app = { pdfViewer: {} };
    const frame = { PDFViewerApplication: app };
    const win = windowWithFrame(frame);
    assert.equal(evaluateBridge(win)(frame, true), app, "the realm window is a legitimate argument");
  });

  it("is null with wantApp when the realm has no application object yet", () => {
    const win = windowWithFrame({ PDFViewerApplication: undefined });
    assert.equal(evaluateBridge(win)({ tabID: "unrelated" }, true), null);
  });
});

describe("the bridge as the probe sees it", () => {
  afterEach(() => {
    shutdown();
    resetWarnOnce();
    delete globalThis.Zotero;
    delete globalThis.Services;
  });

  it("reports bridgeRoute through the installed resolver", () => {
    const frame = { PDFViewerApplication: { pdfViewer: null } };
    const read = readerWithFrame(frame);
    const win = {
      Zotero: { Reader: { _readers: { "tab-1": { tabID: "tab-1", reader: read } }, getByTabID: () => read } },
      eval(source) {
        new Function("window", source)(this);
      },
    };
    globalThis.Zotero = {
      debug() {},
      getMainWindow: () => win,
      getMainWindows: () => [],
      Reader: {
        registerEventListener() {},
        unregisterEventListener() {},
        _readers: { "tab-1": { tabID: "tab-1", reader: read } },
      },
    };
    globalThis.Services = { wm: { getMostRecentWindow: () => win } };

    startup({ id: "test" });
    const out = chainProbe({ ...read });

    assert.equal(out.readersSrc, "_readers", "the probe names the list source it fell back to");
    assert.equal(out.readers, 1, "the fallback list is what the probe counts");
    assert.equal(out.bridgeType, "function", "startup installed the resolver on the window");
    assert.equal(out.bridgeWin, "object", "the bridge handed back the viewer realm");
    assert.equal(out.bridgeRoute, "direct", "and the probe says which unwrap route read it");
  });

  it("is inert when no window was published", () => {
    globalThis.Zotero = {
      debug() {},
      getMainWindow: () => null,
      getMainWindows: () => [],
      Reader: { registerEventListener() {}, unregisterEventListener() {}, _readers: [] },
    };
    globalThis.Services = { wm: { getMostRecentWindow: () => null } };

    startup({ id: "test" });
    const out = chainProbe({ _internalReader: null });

    assert.equal(out.bridgeType, "undefined", "no bridge, no realm");
    assert.equal(out.bridgeRoute, null);
  });

  it("does not die when a window has no eval", () => {
    const win = { Zotero: {} };
    globalThis.Zotero = {
      debug() {},
      getMainWindow: () => win,
      getMainWindows: () => [],
      Reader: { registerEventListener() {}, unregisterEventListener() {}, _readers: [] },
    };
    globalThis.Services = { wm: { getMostRecentWindow: () => win } };

    startup({ id: "test" });

    assert.equal(win.FigureColorResolveViewer, undefined, "no eval means no bridge, and no throw");
    assert.equal(
      getWarnLog().some((line) => line.startsWith("bridge-install")),
      false,
      "a missing eval is not an error worth logging",
    );
  });
});


describe("VIEWER_BRIDGE_SRC: the tab id Zotero reports", () => {
  afterEach(() => resetWarnOnce());

  it("matches the tab id from Zotero.Viewer.getTabID when the record keeps none", () => {
    const shown = { PDFViewerApplication: {} };
    const hidden = { PDFViewerApplication: {} };
    const shownRec = readerWithFrame(shown);
    const hiddenRec = readerWithFrame(hidden);
    const ids = new Map([
      [hiddenRec, "tab-8"],
      [shownRec, "tab-9"],
    ]);
    const win = {
      Zotero: {
        Reader: { _readers: [hiddenRec, shownRec] },
        Viewer: { getTabID: (rec) => (ids.has(rec) ? ids.get(rec) : null) },
      },
    };
    const resolve = evaluateBridge(win);

    assert.equal(resolve({ tabID: "tab-9" }), shown, "the tab id Zotero itself reports routes the lookup");
    assert.equal(resolve({ tabID: "tab-8" }), hidden, "and the reader behind the other tab keeps its own frame");
  });

  it("answers for the right reader however many readers are open", () => {
    const frames = { "tab-1": { PDFViewerApplication: {} }, "tab-2": { PDFViewerApplication: {} } };
    const recs = [readerWithFrame(frames["tab-1"]), readerWithFrame(frames["tab-2"])];
    const windowWith = (list) => ({
      Zotero: {
        Reader: { _readers: list },
        Viewer: { getTabID: (rec) => (rec === recs[0] ? "tab-1" : rec === recs[1] ? "tab-2" : null) },
      },
    });

    assert.equal(evaluateBridge(windowWith(recs))({ tabID: "tab-2" }), frames["tab-2"], "two readers open");
    assert.equal(
      evaluateBridge(windowWith([recs[1], recs[0]]))({ tabID: "tab-1" }),
      frames["tab-1"],
      "the order of the list changes nothing",
    );
    assert.equal(
      evaluateBridge(windowWith([recs[1], recs[0]]))({ tabID: "tab-2" }),
      frames["tab-2"],
      "for either of the two readers",
    );
    assert.equal(evaluateBridge(windowWith([recs[0]]))({ tabID: "tab-1" }), frames["tab-1"], "and one reader open");
  });

  it("survives a Zotero.Viewer whose getTabID throws across the realm", () => {
    const frame = { PDFViewerApplication: {} };
    const rec = readerWithFrame(frame);
    const win = {
      Zotero: {
        Reader: { _readers: [rec] },
        Viewer: {
          getTabID() {
            throw new Error("getTabID blocked");
          },
        },
      },
    };

    assert.equal(evaluateBridge(win)({ tabID: "tab-1" }), frame, "a hostile Viewer read falls back to the frame");
  });
});
