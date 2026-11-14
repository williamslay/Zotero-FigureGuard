import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getWarnLog, resetWarnOnce } from "../../src/zotero/overlay.js";
import {
  forgetViewerRoute,
  openReaderRecords,
  resolveEventBus,
  resolveInnerWindow,
  resolveOPS,
  resolvePDFViewer,
  unwrapViewerApplication,
} from "../../src/zotero/reader-session.js";

/**
 * The real machine (v0.1.10 report): the latched realm is the pdf.js viewer
 * (`href` is viewer.html) while the bootstrap sandbox reads
 * `PDFViewerApplication: "undefined"` on it, because the viewer assigns that
 * property from its own script and a Gecko Xray wrapper hides JS-defined
 * properties. The user's main-window probe adds the second half of the picture:
 * there the plain read is `"object"` and `wrappedJSObject` does not exist at all,
 * so `Components.utils.unwrap` is the route expected to work from a sandbox, and
 * the main-window realm bridge is the one left when even that is missing.
 *
 * These tests drive the four routes with counted property reads, so they pin
 * which route resolved, which routes a cached hit stops reading, and that a
 * hostile or missing route is a miss rather than a throw.
 */

/**
 * A realm stand-in whose four unwrap routes are counted property reads.
 *
 * @param {{direct?: *, wrapped?: *, unwrap?: *, bridge?: *, throws?: string[],
 *   noComponents?: boolean, noServices?: boolean}} [apps] `wrapped` is the
 *   `wrappedJSObject` object, `unwrap` what `Components.utils.unwrap` returns,
 *   `bridge` what the main-window realm bridge hands back as the realm's
 *   application object, `throws` the route names that throw, `noComponents` and
 *   `noServices` leave that global untouched (a sandbox that has none at all).
 * @returns {{win: object, counts: object, state: object, seen: object, restore: () => void}}
 *   `state` stays writable, so a test can make a value appear or disappear later,
 *   and `seen` records what the unwrapping routes were handed.
 */
function routeRealm(apps = {}) {
  const counts = { direct: 0, wrapped: 0, unwrapped: 0, bridge: 0 };
  const seen = { unwrap: null, bridge: null };
  const state = {
    direct: "direct" in apps ? apps.direct : undefined,
    wrapped: "wrapped" in apps ? apps.wrapped : undefined,
    unwrap: "unwrap" in apps ? apps.unwrap : undefined,
    bridge: "bridge" in apps ? apps.bridge : undefined,
    throws: new Set(apps.throws ?? []),
  };
  const win = {};
  Object.defineProperty(win, "PDFViewerApplication", {
    get() {
      counts.direct += 1;
      if (state.throws.has("direct")) throw new Error("direct blocked");
      return state.direct;
    },
    configurable: true,
  });
  Object.defineProperty(win, "wrappedJSObject", {
    get() {
      counts.wrapped += 1;
      if (state.throws.has("wrapped")) throw new Error("wrapped blocked");
      return state.wrapped;
    },
    configurable: true,
  });
  const previous = globalThis.Components;
  if (!apps.noComponents) {
    globalThis.Components = {
      utils: {
        unwrap(target) {
          counts.unwrapped += 1;
          if (state.throws.has("unwrapped")) throw new Error("unwrap blocked");
          seen.unwrap = target;
          return typeof state.unwrap === "function" ? state.unwrap(target) : state.unwrap;
        },
      },
    };
  }
  const previousServices = globalThis.Services;
  if (!apps.noServices) {
    globalThis.Services = {
      wm: {
        getMostRecentWindow(kind) {
          counts.bridge += 1;
          if (state.throws.has("bridge")) throw new Error("bridge blocked");
          return {
            FigureColorResolveViewer(target, wantApp) {
              seen.bridge = { kind, target, wantApp };
              if (!wantApp) return null;
              return typeof state.bridge === "function" ? state.bridge(target) : state.bridge ?? null;
            },
          };
        },
      },
    };
  }
  return {
    win,
    counts,
    state,
    seen,
    restore() {
      if (previous === undefined) delete globalThis.Components;
      else globalThis.Components = previous;
      if (previousServices === undefined) delete globalThis.Services;
      else globalThis.Services = previousServices;
      forgetViewerRoute(win);
    },
  };
}

describe("unwrapViewerApplication: four routes, cached", () => {
  afterEach(() => resetWarnOnce());

  it("takes the direct read before the other routes", () => {
    const direct = { pdfViewer: {} };
    const realm = routeRealm({ direct, wrapped: { PDFViewerApplication: { other: true } } });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "direct", "the plain read keeps priority");
      assert.equal(out.app, direct);
      assert.equal(realm.counts.wrapped, 0, "a direct hit must not probe wrappedJSObject");
      assert.equal(realm.counts.unwrapped, 0, "nor Components");
    } finally {
      realm.restore();
    }
  });

  it("falls back to wrappedJSObject when the direct read is blind", () => {
    const app = { eventBus: {} };
    const realm = routeRealm({ direct: undefined, wrapped: { PDFViewerApplication: app } });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "wrapped");
      assert.equal(out.app, app);
      assert.equal(realm.counts.direct, 1);
      assert.equal(realm.counts.unwrapped, 0, "a hit ends the scan");
    } finally {
      realm.restore();
    }
  });

  it("falls back to Components.utils.unwrap when both property reads are blind", () => {
    const app = { pdfViewer: {} };
    const realm = routeRealm({ direct: undefined, wrapped: undefined, unwrap: { PDFViewerApplication: app } });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "cu-unwrap", "the expected fix route for a chrome sandbox");
      assert.equal(out.app, app);
      assert.equal(realm.counts.unwrapped, 1);
    } finally {
      realm.restore();
    }
  });

  it("passes the realm window to Components.utils.unwrap", () => {
    const app = { pdfViewer: {} };
    let seen = null;
    const realm = routeRealm({
      direct: undefined,
      wrapped: undefined,
      unwrap: (win) => {
        seen = win;
        return { PDFViewerApplication: app };
      },
    });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "cu-unwrap");
      assert.equal(out.app, app);
      assert.equal(seen, realm.win, "the realm window itself is what gets unwrapped");
    } finally {
      realm.restore();
    }
  });

  it("takes the main-window realm bridge when the three sandbox reads are blind", () => {
    const app = { pdfViewer: {} };
    const realm = routeRealm({ direct: undefined, wrapped: undefined, unwrap: undefined, bridge: app });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "bridge", "the last route keeps a blind sandbox alive instead of route:null");
      assert.equal(out.app, app);
      assert.equal(realm.counts.bridge, 1, "the bridge is asked once");
      assert.deepEqual(realm.seen.bridge, { kind: "navigator:browser", target: realm.win, wantApp: true });
    } finally {
      realm.restore();
    }
  });

  it("reads pdfViewer through the application the bridge handed back", () => {
    const viewer = { _pagesCount: 3 };
    const realm = routeRealm({ bridge: { pdfViewer: viewer } });
    try {
      assert.equal(resolvePDFViewer(realm.win), viewer, "an application object crosses as a plain object");
      assert.equal(unwrapViewerApplication(realm.win).route, "bridge", "and the route is cached");
      const first = { ...realm.counts };
      assert.equal(resolvePDFViewer(realm.win), viewer);
      assert.equal(realm.counts.bridge, first.bridge + 1, "only the cached bridge route is read again");
      assert.equal(realm.counts.direct, first.direct, "and no other route is read at all");
      assert.equal(realm.counts.unwrapped, first.unwrapped);
    } finally {
      realm.restore();
    }
  });

  it("does not ask the bridge when an earlier route resolved", () => {
    const realm = routeRealm({ direct: { pdfViewer: {} }, bridge: { pdfViewer: {} } });
    try {
      assert.equal(unwrapViewerApplication(realm.win).route, "direct");
      assert.equal(realm.counts.bridge, 0, "the last route costs nothing once a property read works");
    } finally {
      realm.restore();
    }
  });

  it("treats a missing bridge and a throwing one alike, and logs the throw", () => {
    const missing = routeRealm({ bridge: null, noServices: true });
    try {
      assert.deepEqual(unwrapViewerApplication(missing.win), { app: null, route: null });
      assert.equal(missing.counts.bridge, 0, "a sandbox without Services simply skips the route");
    } finally {
      missing.restore();
    }
    const realm = routeRealm({ throws: ["bridge"] });
    try {
      assert.deepEqual(unwrapViewerApplication(realm.win), { app: null, route: null });
      assert.ok(
        getWarnLog().some((line) => line.startsWith("unwrap-bridge")),
        "the throw on the last route is logged once too",
      );
    } finally {
      realm.restore();
    }
  });

  it("keys the one-time warning by reader tag, so readers do not swallow each other", () => {
    const realm = routeRealm({ throws: ["direct"] });
    try {
      unwrapViewerApplication(realm.win, "item:1");
      unwrapViewerApplication(realm.win, "item:2");
      unwrapViewerApplication(realm.win, "item:1");
      const lines = getWarnLog().filter((line) => line.startsWith("unwrap-direct"));
      assert.equal(lines.length, 2, "one line per reader, and no repeat for the same reader");
      assert.ok(lines.every((line) => line.startsWith("unwrap-direct:item:")), lines.join("\n"));
    } finally {
      realm.restore();
    }
  });

  it("reports route null when every route misses, without throwing", () => {
    const realm = routeRealm({ direct: undefined, wrapped: undefined, unwrap: undefined });
    try {
      assert.deepEqual(unwrapViewerApplication(realm.win), { app: null, route: null });
      assert.equal(realm.counts.unwrapped, 1, "all four routes were tried before giving up");
      assert.equal(realm.counts.bridge, 1, "including the bridge");
    } finally {
      realm.restore();
    }
  });

  it("reports route null when the sandbox has no Components at all", () => {
    const realm = routeRealm({ direct: undefined, wrapped: undefined, noComponents: true });
    try {
      assert.equal(globalThis.Components, undefined, "the stand-in really has no Components");
      assert.deepEqual(unwrapViewerApplication(realm.win), { app: null, route: null });
    } finally {
      realm.restore();
    }
  });

  it("treats a throwing route as a miss", () => {
    const app = { eventBus: {} };
    const realm = routeRealm({
      direct: undefined,
      wrapped: { PDFViewerApplication: app },
      throws: ["direct"],
    });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "wrapped", "a throw on one route does not abort the scan");
      assert.equal(out.app, app);
      assert.ok(
        getWarnLog().some((line) => line.startsWith("unwrap-direct")),
        "the throw is still logged once",
      );
    } finally {
      realm.restore();
    }
  });

  it("reports route null when all four routes throw", () => {
    const realm = routeRealm({ throws: ["direct", "wrapped", "unwrapped", "bridge"] });
    try {
      assert.deepEqual(unwrapViewerApplication(realm.win), { app: null, route: null });
    } finally {
      realm.restore();
    }
  });

  it("rejects an application value that is not an object", () => {
    const app = { pdfViewer: {} };
    const realm = routeRealm({ direct: "yes", wrapped: { PDFViewerApplication: app } });
    try {
      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "wrapped", "a string is not an application object");
      assert.equal(out.app, app);
    } finally {
      realm.restore();
    }
  });

  it("reports null for a missing or non-object realm", () => {
    assert.deepEqual(unwrapViewerApplication(null), { app: null, route: null });
    assert.deepEqual(unwrapViewerApplication(undefined), { app: null, route: null });
    assert.deepEqual(unwrapViewerApplication("viewer.html"), { app: null, route: null });
  });

  it("caches the route and stops reading the other two", () => {
    const app = { eventBus: {} };
    const realm = routeRealm({ direct: undefined, wrapped: { PDFViewerApplication: app } });
    try {
      assert.equal(unwrapViewerApplication(realm.win).route, "wrapped");
      const first = { ...realm.counts };
      assert.equal(unwrapViewerApplication(realm.win).route, "wrapped");
      assert.equal(realm.counts.direct, first.direct, "the cached hit must not re-read the direct route");
      assert.equal(realm.counts.unwrapped, first.unwrapped, "nor the Components route");
      assert.equal(realm.counts.wrapped, first.wrapped + 1, "only the cached route is read again");
    } finally {
      realm.restore();
    }
  });

  it("re-scans when the cached route stops resolving, and adopts the new route", () => {
    const app = { eventBus: {} };
    const other = { pdfViewer: {} };
    const realm = routeRealm({ direct: undefined, wrapped: { PDFViewerApplication: app } });
    try {
      assert.equal(unwrapViewerApplication(realm.win).route, "wrapped");
      realm.state.wrapped = null;
      realm.state.direct = other;

      const out = unwrapViewerApplication(realm.win);
      assert.equal(out.route, "direct", "a stale cached route falls back to the full scan");
      assert.equal(out.app, other);

      const after = { ...realm.counts };
      assert.equal(unwrapViewerApplication(realm.win).app, other);
      assert.equal(realm.counts.direct, after.direct + 1, "the new route is cached too");
      assert.equal(realm.counts.wrapped, after.wrapped, "the dead route is not read again");
    } finally {
      realm.restore();
    }
  });

  it("reads eventBus, pdfViewer and OPS through the resolved route", () => {
    const bus = { on() {}, off() {} };
    const viewer = { _pagesCount: 1 };
    const ops = { fill: 1 };
    const realm = routeRealm({
      direct: undefined,
      wrapped: { PDFViewerApplication: { eventBus: bus, pdfViewer: viewer, pdfjsLib: { OPS: ops } } },
    });
    try {
      assert.equal(resolveEventBus(realm.win), bus);
      assert.equal(resolvePDFViewer(realm.win), viewer);
      assert.equal(resolveOPS(realm.win), ops);
      assert.equal(resolveEventBus(null), null, "a missing realm is null, never a throw");
      assert.equal(resolvePDFViewer(undefined), null);
    } finally {
      realm.restore();
    }
  });
});

/**
 * `resolveInnerWindow` decides which iframe to latch. Its marker test used to be
 * the plain property read, so on the real machine a genuine viewer frame scored
 * zero and the frame was only picked up by its `src`.
 */
describe("resolveInnerWindow: the marker through an unwrap route", () => {
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

  it("latches a frame whose marker is only behind wrappedJSObject", () => {
    const wrapped = { wrappedJSObject: { PDFViewerApplication: {} } };
    const reader = scannedReader([iframe("", {}), iframe("", wrapped)]);
    assert.equal(resolveInnerWindow(reader), wrapped, "the marker counts through the unwrap routes");
  });

  it("latches a frame whose marker only Components can unwrap", () => {
    let target = null;
    const realm = routeRealm({
      direct: undefined,
      wrapped: undefined,
      unwrap: (win) => (win === target ? { PDFViewerApplication: {} } : null),
    });
    target = realm.win;
    try {
      const reader = scannedReader([iframe("", {}), iframe("", realm.win)]);
      assert.equal(resolveInnerWindow(reader), realm.win, "the blank frame must not unwrap to a marker");
    } finally {
      realm.restore();
    }
  });

  it("ranks a bridge-only marker below an exact viewer.html src", () => {
    const realm = routeRealm({ direct: undefined, wrapped: undefined, bridge: { pdfViewer: {} } });
    try {
      const blank = {};
      const bySrc = {};
      const reader = scannedReader([iframe("", blank), iframe("pdf/web/viewer.html", bySrc)]);
      assert.equal(
        resolveInnerWindow(reader),
        bySrc,
        "the bridge answers for the one reader that has a frame, so a frame it claims is a weaker signal",
      );
    } finally {
      realm.restore();
    }
  });

  it("latches a frame whose marker only the bridge can resolve", () => {
    const realm = routeRealm({ direct: undefined, wrapped: undefined, bridge: { pdfViewer: {} } });
    try {
      const blank = {};
      const reader = scannedReader([iframe("", blank)]);
      assert.equal(resolveInnerWindow(reader), blank, "no src and no sandbox-side marker: the bridge marker latches");
    } finally {
      realm.restore();
    }
  });

  it("still ranks the marker above an exact viewer.html src", () => {
    const wrapped = { wrappedJSObject: { PDFViewerApplication: {} } };
    const bySrc = {};
    const reader = scannedReader([iframe("pdf/web/viewer.html", bySrc), iframe("", wrapped)]);
    assert.equal(resolveInnerWindow(reader), wrapped, "the priority is unchanged");
  });

  it("keeps the src fallback when no route resolves a marker", () => {
    const bySrc = {};
    const reader = scannedReader([iframe("pdf/web/viewer.html", bySrc), iframe("", {})]);
    assert.equal(resolveInnerWindow(reader), bySrc);
  });
});

/**
 * The list of open readers that both the realm bridge and the probe read.
 * `Zotero.Reader.getOpenReaders()` is missing on the user's build ("getOpenReaders
 * is not a function"), so `_readers` is the fallback, in whichever shape the build
 * keeps it.
 */
describe("openReaderRecords: the reader list of the bridge", () => {
  afterEach(() => resetWarnOnce());

  it("uses getOpenReaders when the build has it", () => {
    const records = [{ tabID: "tab-1" }];
    const list = openReaderRecords({ getOpenReaders: () => records, _readers: { other: {} } });
    assert.deepEqual(list, records);
  });

  it("falls back to a _readers object when getOpenReaders is missing", () => {
    const first = { itemID: 1 };
    const second = { itemID: 2 };
    assert.deepEqual(openReaderRecords({ _readers: { "tab-1": first, "tab-2": second } }), [first, second]);
  });

  it("takes _readers when getOpenReaders exists but is not callable", () => {
    const first = { itemID: 3 };
    assert.deepEqual(openReaderRecords({ getOpenReaders: "nope", _readers: { "tab-1": first } }), [first]);
  });

  it("takes the values of a Map-shaped _readers", () => {
    const first = { itemID: 4 };
    assert.deepEqual(openReaderRecords({ _readers: new Map([["tab-1", first]]) }), [first]);
  });

  it("copies an Array-shaped _readers instead of handing out the same array", () => {
    const first = { itemID: 5 };
    const records = [first];
    const list = openReaderRecords({ _readers: records });
    assert.deepEqual(list, records);
    assert.notEqual(list, records);
  });

  it("falls back to _readers when getOpenReaders throws", () => {
    const first = { itemID: 6 };
    const api = {
      getOpenReaders() {
        throw new Error("Zotero.Reader.getOpenReaders is not a function");
      },
      _readers: { "tab-1": first },
    };
    assert.deepEqual(openReaderRecords(api), [first]);
  });

  it("is an empty list when the API has neither source", () => {
    assert.deepEqual(openReaderRecords(undefined), []);
    assert.deepEqual(openReaderRecords({}), []);
    assert.deepEqual(openReaderRecords({ getOpenReaders: null, _readers: null }), []);
  });
});
