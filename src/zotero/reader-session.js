/**
 * One session per open PDF reader.
 *
 * Facts this layer is written against (verified against Zotero 7.0.24 and
 * 10.0.8 sources):
 *   - Reader instances come from Zotero.Reader.getByTabID(tabID); main windows
 *     come from Zotero.getMainWindows(). There are no Zotero-level
 *     render/zoom/pagesloaded/selected events any more, those were Zotero 6.
 *   - The pdf.js viewer runs in an inner iframe reachable through
 *     reader._internalReader._primaryView._iframeWindow, with a fallback of an
 *     iframe element pointing at pdf/web/viewer.html.
 *   - Everything below that window (PDFViewerApplication, pdfViewer,
 *     pdfDocument, eventBus) is pdf.js internals and is therefore read through
 *     optional chaining inside try/catch. `PDFViewerApplication` itself is
 *     JS-defined, so it is reached through `unwrapViewerApplication()`, which
 *     tries the plain read, `wrappedJSObject`, `Components.utils.unwrap` and, last,
 *     the main-window realm bridge.
 *
 * A session owns: the inner window, its event-bus subscriptions, the per-page
 * overlay objects, and the enabled flag used by the toolbar toggle. Detection
 * results live in the shared RegionCache that main.js passes in.
 */

import { PageOverlay, isProvisionalDocumentId, resolveDocumentId, warnOnce } from "./overlay.js";
import { normalizeAttachmentIdentity, resolveAttachmentIdentity } from "./persistent-figure-store.js";
import { RegionEditorController } from "./region-editor.js";
import { createZoomWatcher } from "./zoom.js";
import { scopedDocumentId } from "../core/cache.js";
import {
  findSuppressedTargetAtPoint,
  hitTestRegions,
  resolveEffectiveRegions,
  serializeAutoRegions,
} from "../core/region-overrides.js";
import { clientPointToViewportPoint, toPdfPoint } from "../core/viewport.js";

/** Readiness poll interval, in milliseconds. */
export const READY_POLL_MS = 250;

/** Readiness timeout for a reader that never loads a document, in ms. */
export const READY_TIMEOUT_MS = 20000;

/** Slow recovery poll interval after a start that did not reach readiness. */
export const RECOVERY_INTERVAL_MS = 5000;

/** Fast-budget time the recovery keeps retrying before the slow heartbeat, in ms. */
export const RECOVERY_MAX_MS = 180000;

/**
 * How many fast recovery passes `RECOVERY_MAX_MS` buys. The budget is counted in
 * passes instead of wall-clock time so a test with faked timers reaches the same
 * end state as the reader on a machine: 5 s x 36 = 180 s.
 */
const RECOVERY_MAX_PASSES = Math.max(1, Math.ceil(RECOVERY_MAX_MS / RECOVERY_INTERVAL_MS));

/**
 * Heartbeat interval once the fast budget is spent, in milliseconds. Recovery
 * does not stop there: a restored tab whose viewer appears after three minutes
 * was still worth picking up, so the loop keeps asking at this lower rate until
 * it succeeds or the reader is closed.
 */
export const RECOVERY_SLOW_INTERVAL_MS = 20000;

/** Debounce for the document-change sweep, in milliseconds. */
export const DOCUMENT_CHECK_MS = 300;

/**
 * Delay of the settled re-check after a full-document paint, in milliseconds.
 *
 * On the real machine the toggle-off-then-on paint runs in the same tick as
 * the toolbar/button state change, so the viewer may still relayout its
 * controls — and re-zoom for fit-width — right after that pass finished, and
 * the canvases keep the box painted against the mid-relayout viewport. One
 * settled pass later, any page whose painted viewport differs from the page's
 * current one is re-painted from its cached regions; nothing else re-corrects
 * by itself until the next zoom.
 */
export const SETTLED_REPAINT_MS = 350;

/** Event bus names that signal a (re)loaded document. Unknown names are skipped. */
export const DOCUMENT_EVENTS = ["pagesloaded", "documentloaded", "documentinit"];

/** Event bus name that reports one finished page render. */
export const PAGE_RENDERED_EVENT = "pagerendered";

/**
 * Subscribes a handler to every event name it accepts.
 *
 * @param {object|null} eventBus
 * @param {string[]} names
 * @param {(event: object) => void} handler
 * @param {string} site Label used for per-name warnings.
 * @returns {string[]} The names that were actually subscribed.
 */
function subscribe(eventBus, names, handler, site) {
  const bound = [];
  if (!eventBus || typeof eventBus.on !== "function") return bound;
  for (const name of names) {
    try {
      eventBus.on(name, handler);
      bound.push(name);
    } catch (err) {
      warnOnce(`subscribe:${site}:${name}`, err);
    }
  }
  return bound;
}

/**
 * Mirrors subscribe(), never throwing.
 *
 * @param {object|null} eventBus
 * @param {string[]} names
 * @param {(event: object) => void} handler
 * @param {string} site
 */
function unsubscribe(eventBus, names, handler, site) {
  if (!eventBus || typeof eventBus.off !== "function") return;
  for (const name of names) {
    try {
      eventBus.off(name, handler);
    } catch (err) {
      warnOnce(`unsubscribe:${site}:${name}`, err);
    }
  }
}

/**
 * The four routes by which a bootstrap sandbox can reach `PDFViewerApplication`
 * of a reader realm, in the order they are tried:
 *   - `direct`: the plain property read. Works in the main-window realm, and on
 *     the real machine it returns `undefined` from the bootstrap sandbox: the
 *     viewer assigns `window.PDFViewerApplication = ...` from its own script, and
 *     a Gecko Xray wrapper hides JS-defined properties from a chrome sandbox.
 *   - `wrapped`: `wrappedJSObject`, the documented Xray escape hatch. Only
 *     present when the wrapper really is an Xray; measured on the user's build the
 *     property is absent there, so this route is kept as a cheap second guess.
 *   - `cu-unwrap`: `Components.utils.unwrap(window)`, which hands back the
 *     unwrapped JS object of any cross-compartment wrapper. This is the route
 *     expected to work in a chrome sandbox pointing at a chrome iframe; it is
 *     guarded because a sandbox may have no `Components` at all.
 *   - `bridge`: the resolver `installViewerBridge` evaluated in the main window
 *     realm (`FigureColorResolveViewer`). Called as `resolver(realm, true)` it
 *     reads `PDFViewerApplication` in that realm, where the plain read is proven
 *     to work, and hands the application object back. An application object is a
 *     plain object, so the sandbox receives a plain cross-compartment wrapper for
 *     it rather than a window one, which is what keeps `app.pdfViewer` readable
 *     from here. Last resort: `Services` may be missing, and with more than one
 *     reader open the bridge cannot tell which one the realm belongs to.
 *
 * @type {Array<[string, (win: object) => *]>}
 */
const VIEWER_ROUTES = [
  ["direct", (win) => win.PDFViewerApplication],
  ["wrapped", (win) => win.wrappedJSObject?.PDFViewerApplication],
  ["cu-unwrap", (win) => globalThis.Components?.utils?.unwrap?.(win)?.PDFViewerApplication],
  [
    "bridge",
    (win) => {
      const resolver = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser")
        ?.FigureColorResolveViewer;
      return typeof resolver === "function" ? resolver(win, true) : null;
    },
  ],
];

/**
 * Realm window to the route that resolved its application object. Lets a session
 * that found the viewer stop re-trying all three routes on every readiness poll
 * and every paint. Weakly keyed, so a closed reader releases its entry without
 * any teardown code.
 *
 * @type {WeakMap<object, string>}
 */
const realmRoutes = new WeakMap();

/**
 * True for a value that can be a pdf.js application object.
 *
 * @param {*} value Raw property value read over a realm boundary.
 * @returns {boolean}
 */
function isApplication(value) {
  try {
    return Boolean(value) && typeof value === "object";
  } catch (ignored) {
    // A hostile wrapper whose read threw is a miss, not an application object.
    return false;
  }
}

/**
 * Reads one named route, swallowing a cross-realm throw as a miss.
 *
 * @param {object} innerWin Candidate viewer realm.
 * @param {string} route One of the names in `VIEWER_ROUTES`.
 * @param {string} [tag] Reader label appended to the one-time warning key, so two
 *   readers do not swallow each other's diagnostics.
 * @returns {object|null} The application object, or null.
 */
function readViewerRoute(innerWin, route, tag = "") {
  const entry = VIEWER_ROUTES.find(([name]) => name === route);
  if (!entry) return null;
  try {
    const app = entry[1](innerWin);
    return isApplication(app) ? app : null;
  } catch (err) {
    warnOnce(`unwrap-${route}`, err, tag || undefined);
    return null;
  }
}

/**
 * The pdf.js application object of a realm, plus the route that produced it.
 *
 * Every read of a viewer internal (`pdfViewer`, `eventBus`, `pdfjsLib`) goes
 * through here, so one fix covers all of them. A route that worked once is cached
 * per window: a cache hit reads that one route only, and a hit that no longer
 * resolves re-runs the full scan.
 *
 * @param {object|null} innerWin A candidate pdf.js viewer realm.
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {{app: object|null, route: "direct"|"wrapped"|"cu-unwrap"|"bridge"|null}}
 *   `app` is the application object or null, `route` the name that produced it,
 *   null when all four routes missed. Never throws.
 */
export function unwrapViewerApplication(innerWin, tag = "") {
  if (!innerWin || typeof innerWin !== "object") return { app: null, route: null };
  let cached = null;
  try {
    cached = realmRoutes.get(innerWin) ?? null;
  } catch (ignored) {
    cached = null;
  }
  if (cached) {
    const app = readViewerRoute(innerWin, cached, tag);
    if (app) return { app, route: cached };
  }
  for (const [route] of VIEWER_ROUTES) {
    const app = readViewerRoute(innerWin, route, tag);
    if (!app) continue;
    try {
      realmRoutes.set(innerWin, route);
    } catch (ignored) {
      // Not weakly referenceable; the read still succeeded, only caching is lost.
    }
    return { app, route };
  }
  return { app: null, route: null };
}

/**
 * Forgets the cached route of a realm. Test-only: production never clears it, the
 * cache is weakly keyed so a closed reader releases its entry by itself. Exposed
 * so a test can reuse one realm stand-in without leaking a cached route into the
 * next case.
 *
 * @param {object} innerWin
 */
export function forgetViewerRoute(innerWin) {
  try {
    realmRoutes.delete(innerWin);
  } catch (ignored) {
    // Nothing cached for a value the WeakMap cannot hold.
  }
}

/**
 * The open-reader records of the Zotero reader API, for the realm bridge and the
 * probe. `Zotero.Reader.getOpenReaders` is not in every Zotero build (measured on
 * the user's: "getOpenReaders is not a function"), so `_readers` is the fallback.
 * That field is a keyed object in some builds and a Map in others, hence the
 * three normalising branches.
 *
 * @param {object|null|undefined} readerAPI A `Zotero.Reader`.
 * @returns {Array<object>} Records or reader instances, never null.
 */
export function openReaderRecords(readerAPI) {
  try {
    if (typeof readerAPI?.getOpenReaders === "function") return [...readerAPI.getOpenReaders()];
  } catch (err) {
    warnOnce("open-readers", err);
  }
  const records = readerAPI?._readers;
  if (!records) return [];
  try {
    if (Array.isArray(records)) return [...records];
    if (typeof records.values === "function") return [...records.values()];
    return Object.values(records);
  } catch (err) {
    warnOnce("open-readers-field", err);
    return [];
  }
}

/**
 * Which viewer window `resolveInnerRealm()` picked, and whether the session
 * may treat it as its own realm:
 * - `chain`: the reader's own documented view/iframe window — authoritative;
 * - `src`: a frame inside the reader's own window whose `src` names the
 *   viewer — trusted;
 * - `scan`: a viewer-carrying frame found inside the reader's own window —
 *   trusted, the frame lives in this reader's host window;
 * - `bridge`: the last-resort guess — the most recent browser window's one
 *   visible viewer. It is NOT known to be this reader's realm: on tab
 *   re-activation Zotero re-creates the hidden panel's viewer, and the guess
 *   latches onto the other reader's still-live window while this reader's
 *   iframe is briefly unresolvable. Adopt it provisionally, keep
 *   re-resolving, and read document identity only from a trusted realm —
 *   otherwise every readiness poll runs against the foreign window and its
 *   document fingerprint looks like a permanent identity drift.
 * @typedef {{ win: object | null, provenance: "chain" | "src" | "scan" | "bridge" | "bridge-guessed" | "none" }} RealmResolution
 */

const OWN_REALM_PROVENANCE = new Set(["chain", "src", "scan", "bridge-guessed"]);

/**
 * Number of readiness/recovery polls a bridged realm guess may serve as this
 * session's document source before its document is accepted as this reader's.
 * ~2 s at the 250 ms poll — far below the 20 s readiness timeout, so a wrong
 * guess never delays activation, and long enough to cover a slow re-load of
 * the reader's own viewer.
 */
export const BRIDGE_GUESS_PASSES = 8;

/**
 * Whether `win` is `reader`'s own viewer window — checked through the
 * instance chain (primary view, every view, `_iframeWindow`) and then the
 * reader's mounted iframe elements (which survive a view reset while the new
 * viewer loads). Used to reject a realm adopted from the last-resort guess
 * when it belongs to a different reader's viewer. The chain is read directly
 * here, without the bridge fallback, so the membership test can never certify
 * the bridge's own guess.
 * @param {object | null} win
 * @param {object | null} reader
 * @returns {boolean}
 */
export function realmBelongsToReader(win, reader) {
  if (!win || !reader) return false;
  try {
    if (reader?._internalReader?._primaryView?._iframeWindow === win) return true;
  } catch {}
  try {
    const views = reader?._internalReader?._views;
    if (Array.isArray(views)) {
      for (const view of views) {
        try {
          if (view?._iframeWindow === win) return true;
        } catch {}
      }
    }
  } catch {}
  try {
    const host = reader?._iframeWindow ?? null;
    if (host === win) return true;
    const frames = host?.document?.querySelectorAll?.("iframe") ?? [];
    for (const frame of frames) {
      try {
        if (frame?.contentWindow === win) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * The pdf.js viewer realm of a reader, or null.
 *
 * On the real machine (Zotero 10) the documented chain
 * `_internalReader._primaryView._iframeWindow` resolved to nothing from the
 * plugin realm, so three routes are tried: the chain, an exact `src` match, and
 * a scan of every iframe in the reader window whose content window carries
 * `PDFViewerApplication`. The scan must see `PDFViewerApplication` or an exact
 * `viewer.html` src: an `about:blank` iframe exists before the viewer has
 * navigated, and latching onto it would give a dead realm with no event bus.
 *
 * @param {object} reader A Zotero reader instance.
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {object|null}
 */
export function resolveInnerWindow(reader, tag = "") {
  return resolveInnerRealm(reader, tag).win;
}

/**
 * Same resolution as `resolveInnerWindow()`, reporting where the window came
 * from — see the provenance notes above.
 * @param {object} reader A Zotero reader instance.
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {RealmResolution}
 */
export function resolveInnerRealm(reader, tag = "") {
  let tried = false;
  try {
    const viewWindow = reader?._internalReader?._primaryView?._iframeWindow;
    if (viewWindow) return { win: viewWindow, provenance: "chain" };
    tried = true;
  } catch (err) {
    warnOnce("inner-window-chain", err);
  }
  try {
    const win = reader?._iframeWindow ?? null;
    const frames = win?.document?.querySelectorAll?.("iframe") ?? [];
    let exact = null;
    let viewer = null;
    let html = null;
    let viaBridge = null;
    for (const frame of frames) {
      const content = frame?.contentWindow ?? null;
      if (!content) continue;
      const src = String(frame.getAttribute?.("src") ?? "");
      if (!exact && (src === "pdf/web/viewer.html" || src.endsWith("/viewer.html"))) exact = content;
      if (!html && /(?:reader|viewer)\.html/.test(src)) html = content;
      if (!viewer) {
        const { app, route } = unwrapViewerApplication(content, tag);
        if (!app) continue;
        // The bridge route resolves the one reader that has a frame, so on a window
        // holding several iframes it can hand the same application object to a frame
        // that does not carry it. Such a marker therefore ranks below a src match;
        // the three sandbox-side routes stay first.
        if (route === "bridge") viaBridge = viaBridge ?? content;
        else viewer = content;
      }
    }
    // Cross-realm reads can hide `PDFViewerApplication` behind Xrays, so a
    // viewer.html/src match outranks a missing marker. There is deliberately no
    // "only one frame, take it" fallback: before the viewer navigates its lone
    // iframe is an `about:blank` realm, and the caller latches whatever this
    // returns, so guessing there would pin the session to a dead window that
    // never gains a document. Returning null keeps the poll and the realm
    // bridge working, and the same call is retried by the recovery loop.
    // Every candidate here lives inside this reader's own host window, so a
    // marker or src hit is this reader's realm; the per-frame `bridge` route
    // inside `unwrapViewerApplication()` is the window-level guess and stays
    // untrusted.
    if (viewer) return { win: viewer, provenance: "scan" };
    if (exact) return { win: exact, provenance: "src" };
    if (html) return { win: html, provenance: "src" };
    if (viaBridge) return { win: viaBridge, provenance: "bridge" };
    tried = Boolean(win);
  } catch (err) {
    warnOnce("inner-window-scan", err);
  }
  // Only report once the reader window exists and both routes came up empty:
  // before the reader has mounted its iframe there is nothing to complain about.
  if (tried) warnOnce("inner-window-missing", new Error("No pdf.js viewer window: reader left untouched"), tag);
  // Realm bridge, last resort: reading the reader's own underscore properties
  // from the bootstrap sandbox timed out on the real machine, while the same
  // chain reads fine in the main window realm. main.js installs this resolver
  // onto the browser window; it evaluates the lookup there.
  try {
    const bridge = typeof globalThis.Services?.wm?.getMostRecentWindow === "function"
      ? globalThis.Services.wm.getMostRecentWindow("navigator:browser")?.FigureColorResolveViewer
      : null;
    if (typeof bridge === "function") {
      const viaBridge = bridge(reader);
      if (viaBridge) return { win: viaBridge, provenance: "bridge" };
    }
  } catch (err) {
    warnOnce("inner-window-bridge", err);
  }
  return { win: null, provenance: "none" };
}

/**
 * Re-runs every inner-window route without short-circuiting, and reports what
 * each one saw from this realm. The result is handed to Run JavaScript through
 * `runProbe`, because the sandbox may have no usable console.
 *
 * @param {object} reader A Zotero reader instance.
 * @returns {object} Plain, JSON-able per-route results.
 */
export function chainProbe(reader) {
  const out = {
    at: Date.now(),
    k1: null,
    k2: null,
    k3: null,
    frames: null,
    readersSrc: null,
    readers: null,
    bridgeType: null,
    bridgeWin: null,
    bridgeRoute: null,
  };
  try {
    out.k1 = typeof reader?._internalReader;
  } catch (err) {
    out.k1 = "throw:" + (err?.message ?? err);
  }
  try {
    out.k2 = typeof reader?._internalReader?._primaryView;
  } catch (err) {
    out.k2 = "throw:" + (err?.message ?? err);
  }
  try {
    out.k3 = typeof reader?._internalReader?._primaryView?._iframeWindow;
  } catch (err) {
    out.k3 = "throw:" + (err?.message ?? err);
  }
  try {
    out.frames = reader?._iframeWindow?.document?.querySelectorAll?.("iframe")?.length ?? null;
  } catch (err) {
    out.frames = "throw:" + (err?.message ?? err);
  }
  // Which list source the bridge would see: `getOpenReaders` is missing on some
  // Zotero builds, so `_readers` is the fallback it uses instead.
  try {
    const readerAPI = globalThis.Zotero?.Reader ?? null;
    out.readersSrc = typeof readerAPI?.getOpenReaders === "function"
      ? "getOpenReaders"
      : readerAPI ? "_readers" : "none";
    out.readers = openReaderRecords(readerAPI).length;
  } catch (err) {
    out.readersSrc = "throw:" + (err?.message ?? err);
  }
  try {
    const bridge = globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser")?.FigureColorResolveViewer;
    out.bridgeType = typeof bridge;
    if (typeof bridge === "function") {
      const w = bridge(reader);
      out.bridgeWin = w ? typeof w.PDFViewerApplication : "null";
      // `bridgeRoute` is one of `direct`/`wrapped`/`cu-unwrap`/`bridge`/`null`. The
      // sandbox read above can be blind while a route resolves, which is the whole
      // point of reporting both.
      out.bridgeRoute = w ? unwrapViewerApplication(w).route : null;
    }
  } catch (err) {
    out.bridgeType = "throw:" + (err?.message ?? err);
  }
  return out;
}

/**
 * The pdf.js viewer object of a realm, or null.
 *
 * @param {object|null} innerWin
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {object|null}
 */
export function resolvePDFViewer(innerWin, tag = "") {
  try {
    return unwrapViewerApplication(innerWin, tag).app?.pdfViewer ?? null;
  } catch (err) {
    warnOnce("pdf-viewer", err, tag || undefined);
    return null;
  }
}

/**
 * The pdf.js event bus of a realm, or null.
 *
 * @param {object|null} innerWin
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {object|null}
 */
export function resolveEventBus(innerWin, tag = "") {
  try {
    return unwrapViewerApplication(innerWin, tag).app?.eventBus ?? null;
  } catch (err) {
    warnOnce("event-bus", err, tag || undefined);
    return null;
  }
}

/**
 * The pdf.js `OPS` table of a realm, or null so the core falls back to the
 * measured operator codes.
 *
 * @param {object|null} innerWin
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {object|null}
 */
export function resolveOPS(innerWin, tag = "") {
  try {
    return (
      innerWin?.OPS ??
      innerWin?.pdfjsLib?.OPS ??
      unwrapViewerApplication(innerWin, tag).app?.pdfjsLib?.OPS ??
      null
    );
  } catch (err) {
    warnOnce("ops-table", err, tag || undefined);
    return null;
  }
}

/**
 * All page views of the current document, as a plain array.
 *
 * `_pagesView` is private and not always populated, so `getPages()` and finally
 * `getPageView(i)` are tried in turn.
 *
 * @param {object|null} pdfViewer
 * @returns {Array<object>}
 */
export function listPageViews(pdfViewer) {
  if (!pdfViewer) return [];
  try {
    // `_pagesView` in Zotero's fork, `_pages` in recent upstream pdf.js.
    const pagesView = pdfViewer._pagesView ?? pdfViewer._pages;
    if (Array.isArray(pagesView)) return pagesView.filter((view) => Boolean(view));
  } catch (err) {
    warnOnce("pages-view", err);
  }
  try {
    if (typeof pdfViewer.getPages === "function") {
      const pages = pdfViewer.getPages();
      const list = Array.isArray(pages) ? [...pages] : Array.from(pages ?? []);
      if (list.length) return list.filter((view) => Boolean(view));
    }
  } catch (err) {
    warnOnce("get-pages", err);
  }
  const views = [];
  try {
    const count = Number(pdfViewer._pagesCount ?? pdfViewer.pagesCount ?? pdfViewer?.pdfDocument?.numPages ?? 0);
    for (let index = 0; index < count; index += 1) {
      const view = pdfViewer.getPageView?.(index);
      if (view) views.push(view);
    }
  } catch (err) {
    warnOnce("page-view-loop", err);
  }
  return views;
}

/**
 * Per-reader session.
 */
export class ReaderSession {
  /**
   * @param {object} input
   * @param {object} input.reader A Zotero reader instance.
   * @param {object} input.regionCache The shared `RegionCache`.
   * @param {object|null} [input.persistentStore] Optional persistent figure store.
   * @param {(() => Promise<object|null>)|null} [input.resolveAttachmentMeta] Optional file stat resolver.
   * @param {string} [input.tag] Short reader label used in warnings.
   * @param {boolean} [input.enabled] Auto mode, on by default.
   */
  constructor({
    reader,
    regionCache,
    persistentStore = null,
    resolveAttachmentMeta = null,
    tag = "",
    enabled = true,
    isChineseLocale = null,
    onEditorCommit = null,
  }) {
    this.reader = reader;
    this.regionCache = regionCache;
    this.persistentStore = persistentStore ?? null;
    this.resolveAttachmentMeta = typeof resolveAttachmentMeta === "function" ? resolveAttachmentMeta : null;
    /** @type {Map<string, Promise<object|null>>} Per-document identity lookup cache. */
    this.identityPromises = new Map();
    this.tag = tag;
    this.enabled = Boolean(enabled);
    this.isChineseLocale = typeof isChineseLocale === "function" ? isChineseLocale : () => false;
    this.editor = new RegionEditorController({
      isChinese: (doc) => this.isChineseLocale(doc ?? this.reader?._iframeWindow?.document ?? this.innerWin?.document),
      onCommit: onEditorCommit,
      onStateChange: () => this.notify(),
    });
    /** @type {Map<number, PageOverlay>} Page number to overlay group. */
    this.overlays = new Map();
    /** @type {Set<Promise<void>>} Paint jobs, so teardown can wait conceptually. */
    this.pending = new Set();
    /** @type {Set<() => void>} Resolvers of a pending readiness wait, resolved on teardown. */
    this.readyWakes = new Set();
    /** @type {Set<*>} Every timer this session owns. */
    this.timers = new Set();
    /** @type {Set<(session: ReaderSession) => void>} */
    this.listeners = new Set();
    this.innerWin = null;
    this.eventBus = null;
    this.documentId = null;
    /**
     * Per-reader half of the RegionCache key, taken from the reader's own item. The
     * printed fingerprint is not unique per file — two PDFs on the real machine
     * printed `fcp:3e708112401a3e23` — so with two reader tabs open both sessions
     * read the same cache entries and painted the other document's regions. Empty
     * when the item id is unreadable, which leaves the key as the bare document id.
     * @type {string}
     */
    this.cacheScope =
      reader?.itemID === undefined || reader?.itemID === null ? "" : `item:${String(reader.itemID)}`;
    /**
     * @type {number} How many times `reevaluateRealm()` adopted another pdf.js
     * realm. A count that grows while the user only switched tabs is the proof of a
     * realm mixup; a count that stays 0 across a real document swap is not.
     */
    this.realmSwitches = 0;
    /**
     * Where the latched realm came from — see `resolveInnerRealm()`'s
     * provenance values, or `bridge-guessed` once an untrusted guess has
     * served enough polls to be accepted as this reader's document source.
     * @type {string}
     */
    this.realmProvenance = "none";
    /**
     * Polls served by an unconfirmed (bridged) realm while waiting for this
     * reader's own viewer to appear; see `BRIDGE_GUESS_PASSES`.
     * @type {number}
     */
    this.bridgeGuessPasses = 0;
    this.ready = false;
    /** @type {number} Readiness polls performed; exposed for diagnostics. */
    this.attempts = 0;
    this.destroyed = false;
    /** @type {object|null} Zoom watcher handle. */
    this.zoom = null;
    this.documentCheckTimer = null;
    /** @type {*} Pending settled re-check timer, see `scheduleSettledCheck()`. */
    this.settledCheckTimer = null;
    /**
     * How many overlays the settled pass has re-painted. A non-zero count, seen
     * together with the offset disappearing on the real machine, is the evidence
     * that the paint raced the viewer's relayout: without the settled pass those
     * pages would have stayed displaced. Plain number, never reset.
     * @type {number}
     */
    this.settledRepaints = 0;
    /** @type {boolean} True while the slow recovery loop owns its sleep timer. */
    this.recoveryRunning = false;
    /** @type {Promise<void>|null} Live recovery loop, for tests and diagnostics. */
    this.recoveryPromise = null;
    this.loadEventNames = [];
    this.renderEventNames = [];
    /**
     * Triggers that already ran their one catch-up paint, see `catchUpPaint()`.
     * @type {Set<string>}
     */
    this.catchUpDone = new Set();
    /**
     * True once a WeakMap-fallback key was replaced by a printed one, so the
     * one-time adoption can be read back from the diagnostics. Plain flag.
     * @type {boolean}
     */
    this.documentIdAdopted = false;
    /**
     * True once the missing event bus was warned about for the realm the session
     * holds. Reset when a realm is released, so the warning stays once per realm
     * instead of once per recovery pass.
     * @type {boolean}
     */
    this.noBusWarned = false;
    /**
     * What the last identity validation decided, for `probeAll()`: the wake that
     * asked, the decision of `ensureCurrentDocument()`, the document identity left
     * behind, and the time. Written by the validation alone, read by nobody, so it
     * cannot change behaviour.
     * @type {{trigger: string, decision: string, after: string|null, at: string}|null}
     */
    this.lastValidation = null;
    /**
     * The scoped cache key the last re-key released, so a report can name the
     * document whose regions were dropped. Plain string.
     * @type {string|null}
     */
    this.lastStaleKey = null;
    /**
     * A background wake asked this session to re-validate; the next paint-driving
     * wake must repaint. Set by `onTabActivate({ paint: false })` — the startup
     * batch path for a tab that is not on screen — and cleared by the next wake
     * that paints. Plain flag, read back by the probe tests.
     * @type {boolean}
     */
    this.paintOnSelectPending = false;
    /** Incremented when a repaint sweep starts or pauses so stale loops stop cleanly. */
    this.paintEpoch = 0;
    /** True when work was deferred or paused while the tab was in the background. */
    this.workPausedInBackground = false;

    // Arrow handlers so the event bus can keep its own references.
    this.onDocumentEvent = () => this.queueDocumentCheck();
    this.onPageRenderedEvent = (event) => {
      try {
        if (this.destroyed || !this.enabled) return;
        if (!this.isForeground()) {
          this.workPausedInBackground = true;
          this.paintOnSelectPending = true;
          return;
        }
        const wasPaused = this.workPausedInBackground || this.paintOnSelectPending;
        if (wasPaused) {
          this.workPausedInBackground = false;
          this.paintOnSelectPending = false;
          this.ensureCurrentDocument("pagerendered");
        }
        const pageNumber = Number(event?.pageNumber ?? event?.pageView?.id ?? 0);
        if (!pageNumber) return;
        const job = this.attachPageNumber(pageNumber);
        if (wasPaused) void this.repaintAttached();
        if (!job) return;
        // A page painted while the viewer is still loading is painted against a
        // viewport the page replaces a moment later, and the page-at-a-time route
        // armed nothing: only the three full-document sites did, so those pages
        // stayed displaced until the next zoom. Arming here hands them to the
        // settled pass, which re-paints exactly the pages whose viewport moved.
        this.scheduleSettledCheck();
      } catch (err) {
        warnOnce("pagerendered-handler", err);
      }
    };
  }

  /** Subscribes a state listener, used by the toolbar button. */
  addListener(listener) {
    if (typeof listener === "function") this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells every listener the session state changed. */
  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener(this);
      } catch (err) {
        warnOnce("state-listener", err);
      }
    }
  }

  /**
   * Resolves the inner window, wires the event bus and waits for the document.
   *
   * @returns {Promise<boolean>} False when this reader is left untouched.
   */
  async start() {
    if (this.destroyed) return false;
    this.bindOuterVisibility();
    // The pdf.js iframe is mounted a tick after `reader-opened`, so resolution
    // must poll instead of giving up on the first miss.
    const ready = await this.waitUntilReady();
    if (this.destroyed) return false;
    if (!ready) {
      // Tabs restored at startup and background tabs load their document minutes
      // later, so a readiness timeout must not leave the reader dead forever.
      this.startRecovery();
      return false;
    }
    this.ready = true;
    // The document id must come from the document that is actually loaded. When
    // the event bus was not up yet there were no document-change events to
    // learn it from, so this is the first reliable chance.
    this.syncDocumentId();
    this.syncEditorContextRealm();
    void this.warmPersistentStore();
    if (!this.eventBus) {
      this.eventBus = resolveEventBus(this.innerWin, this.tag);
      if (this.eventBus) this.bindEvents();
    }
    // A document without an event bus paints once but never learns about a
    // reload, so keep watching for the bus in the background.
    if (!this.eventBus) this.startRecovery();
    if (!this.isForeground()) {
      this.workPausedInBackground = true;
      this.paintOnSelectPending = true;
      return true;
    }
    await this.repaintAttached();
    // The first-open case on the real machine: this pass paints nothing because
    // the pages are not built yet, and with no event bus there was no
    // `pagerendered` to catch them either. One extra pass, only while nothing is
    // mounted, catches the pages that appeared while the paint above ran.
    this.catchUpPaint("start");
    // The shared RegionCache lives for the whole plugin run, so on a second open
    // of the same PDF this paint answers from a warm cache and lands in the same
    // tick as the viewer's relayout, exactly like the enable paint does. The
    // settled pass has to cover the first paint of a document, not just the
    // toolbar enable.
    this.scheduleSettledCheck();
    return true;
  }

  /**
   * Starts the recovery loop, at most one at a time per session. A session
   * whose document or event bus arrived after `READY_TIMEOUT_MS` is picked up
   * there instead of staying dead until the reader is reopened. The loop ends on
   * the first successful pass or on `destroy()`, never on its own.
   *
   * @returns {Promise<void>|null} The live loop, or null when nothing started.
   */
  startRecovery() {
    if (this.destroyed) return null;
    if (this.recoveryRunning) return this.recoveryPromise;
    this.recoveryRunning = true;
    this.recoveryPromise = this.runRecovery();
    return this.recoveryPromise;
  }

  /**
   * Sleeps `RECOVERY_INTERVAL_MS` between passes for `RECOVERY_MAX_MS`, then
   * keeps going on `RECOVERY_SLOW_INTERVAL_MS` forever. Out of budget the loop
   * slows down instead of stopping: on the real machine the viewer of a restored
   * tab showed up well after the fast window, and a session that gave up stayed
   * dead until the reader was reopened.
   * The sleep is a tracked `sleep()`, so `destroy()` resolves it and the loop
   * stops by itself; the next pass is never scheduled before the previous one
   * finished, so recovery timers cannot stack.
   *
   * @returns {Promise<void>}
   */
  async runRecovery() {
    try {
      for (let pass = 0; ; pass += 1) {
        const slow = pass >= RECOVERY_MAX_PASSES;
        if (pass === RECOVERY_MAX_PASSES) {
          warnOnce(
            "recovery-slow",
            new Error("Fast recovery budget exhausted, continuing on the slow heartbeat"),
            this.tag,
          );
        }
        await this.sleep(slow ? RECOVERY_SLOW_INTERVAL_MS : RECOVERY_INTERVAL_MS);
        if (this.destroyed) return;
        if (this.recoveryPass()) return;
      }
    } finally {
      this.recoveryRunning = false;
    }
  }

  /**
   * One recovery pass: re-resolve what was missing during `start()`, and settle
   * the session once a document exists.
   *
   * @returns {boolean} True when recovery is done, so the loop stops.
   */
  recoveryPass() {
    if (this.destroyed) return true;
    try {
      // The realm is re-resolved on every pass, not only while it is missing. A
      // realm latched from a stale reader chain, or one that pointed at an
      // iframe before the viewer navigated, carries no `PDFViewerApplication`
      // for good; adopting the new window is the only way such a reader recovers.
      // A realm the session does not trust stays replaceable: while an
      // unconfirmed bridge guess is held, the reader's own window appearing on
      // a later pass is adopted, because a guess that belongs to a different
      // reader's viewer must not pin this session to a foreign document.
      const resolution = resolveInnerRealm(this.reader, this.tag);
      if (resolution.win && resolution.win !== this.innerWin &&
          (!this.innerWin || !this.realmConfirmed())) {
        this.adoptRealm(resolution);
      }
      if (this.innerWin && !this.eventBus) {
        this.eventBus = resolveEventBus(this.innerWin, this.tag);
        if (this.eventBus) this.bindEvents();
      }
      // The document this reader shows can differ from the one its session
      // latched, even on a pass that found the realm it already held: the realm was
      // resolved from a stale reader chain that pointed at the other tab's viewer.
      // Corrected before the branches below, so a drift does not stop recovery and
      // a ready session heals its paint on the pass that finds the drift. The pass
      // keeps its own guess budget afterwards: a `wait` here only means this pass
      // painted nothing, and the loop below is what re-tries it.
      this.ensureCurrentDocument("recovery");
      if (!this.currentPDFDocument()) return false;
      // A document on its own is not a ready session. With no bus there is no
      // `pagerendered` subscription, so the pages that arrive after this single
      // pass have no painter left: that is the fresh-open symptom "nothing paints
      // at all". Readiness, the success warning and the loop's end now all wait
      // for `bindEvents()` to have succeeded; the fast budget and the slow
      // heartbeat are unchanged, so recovery still cannot spin.
      if (!this.eventBus) {
        // Paint what exists while waiting — but only while nothing is mounted, so
        // a reader whose bus never shows up does not re-render the document on
        // every 20 s heartbeat forever. The pass that binds the bus repaints the
        // whole document, which covers the pages this pass left out.
        this.syncDocumentId();
        if (!this.isForeground()) {
          this.workPausedInBackground = true;
          this.paintOnSelectPending = true;
        } else if (this.overlayCount() === 0) {
          void this.repaintAttached();
        }
        this.notify();
        return false;
      }
      // A bridged realm guess must not end recovery: the document behind it can
      // belong to the other reader's viewer. Count the pass and keep looping so
      // the own window stays adoptable; once the guess has served
      // `BRIDGE_GUESS_PASSES` polls, accept it — the reader's own viewer was not
      // coming back, and a painted document from the visible window beats none.
      if (!this.realmConfirmed()) {
        this.bridgeGuessPasses += 1;
        if (this.bridgeGuessPasses < BRIDGE_GUESS_PASSES) {
          this.notify();
          return false;
        }
        this.realmProvenance = "bridge-guessed";
      }
      this.ready = true;
      this.syncDocumentId();
      if (this.isForeground()) void this.repaintAttached();
      else {
        this.workPausedInBackground = true;
        this.paintOnSelectPending = true;
      }
      // The state listener in main.js refreshes lastDiagnostics here, so the
      // recovery is visible in the diagnostics without a second code path.
      this.notify();
      warnOnce("recovered", new Error("pdf.js became available after the readiness timeout"), this.tag);
      return true;
    } catch (err) {
      warnOnce(`recovery-pass:${this.tag}`, err);
      return false;
    }
  }

  /**
   * Wakes the session after its tab became the visible one.
   *
   * The wake is the moment the newly visible document can be told apart from the
   * one this session latched, so it goes through `ensureCurrentDocument()`: that
   * re-resolves the realm (a session that latched onto the other reader's realm
   * paints the visible page of the hidden document), re-derives the document
   * identity from whatever realm is held afterwards, and releases the cache key and
   * the overlays of the document that is no longer shown. `queueDocumentCheck()`
   * stays behind it: the sweep picks up a document that finishes loading while the
   * tab is in the background, which the validation above cannot see because the
   * document was not there yet.
   *
   * The startup storm makes wakes cheap: a coalesced notification wakes every tab
   * the user switched through, but only the one on screen needs to paint, so a
   * background wake passes `paint: false`. It keeps the identity validation — the
   * re-key it can trigger is rare and has to run wherever it lands — and leaves the
   * sweep out: the detection and canvas work of a hidden page would stall the app
   * for a document nobody is looking at. The session marks itself with
   * `paintOnSelectPending` so its own future select wake (or a toolbar render)
   * repaints it.
   *
   * @param {{paint?: boolean}} [options] `paint: false` verifies the identity only,
   * for a tab that is not the one on screen. Default true: the wake paints.
   */
  /**
   * Whether this reader tab is currently in the foreground (visible to the user).
   * Background tabs defer detection and rendering until activated.
   *
   * @returns {boolean}
   */
  isForeground() {
    try {
      if (this.innerWin?.document?.visibilityState === "hidden") return false;
    } catch (ignored) {
      // Unreadable visibility falls through.
    }
    try {
      if (this.reader?._iframeWindow?.document?.visibilityState === "hidden") return false;
    } catch (ignored) {
      // Unreadable outer visibility falls through.
    }
    try {
      const zotero = globalThis.Zotero;
      const readerAPI = zotero?.Reader;
      const mainWin = typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null;
      const selectedTabID = mainWin?.Zotero_Tabs?.selectedID ?? globalThis.Zotero_Tabs?.selectedID ?? null;
      const ownTab = this.reader?.tabID ?? null;
      if (selectedTabID !== null && selectedTabID !== undefined && ownTab !== null && ownTab !== undefined) {
        return selectedTabID === ownTab;
      }
      const active = typeof readerAPI?.getActive === "function" ? readerAPI.getActive() : null;
      if (active && this.reader) {
        if (active === this.reader) return true;
        const activeTab = active.tabID;
        if (activeTab !== undefined && activeTab !== null && ownTab !== null && ownTab !== undefined) {
          return activeTab === ownTab;
        }
        return false;
      }
    } catch (ignored) {
      // Reader API optional in unit tests and cross-realm sandboxes.
    }
    return true;
  }

  /**
   * Stops queued/in-flight detection and rendering while this tab is in the
   * background so foreground tabs never compete with hidden ones. Completed
   * overlays and RegionCache entries stay intact.
   */
  pauseBackgroundWork() {
    this.paintEpoch += 1;
    this.workPausedInBackground = true;
    this.paintOnSelectPending = true;
    this.editor?.cancel("tab-switch");
    if (this.documentCheckTimer !== null) {
      clearTimeout(this.documentCheckTimer);
      this.timers.delete(this.documentCheckTimer);
      this.documentCheckTimer = null;
    }
    if (this.settledCheckTimer !== null) {
      clearTimeout(this.settledCheckTimer);
      this.timers.delete(this.settledCheckTimer);
      this.settledCheckTimer = null;
    }
    for (const overlay of this.overlays.values()) {
      if (!overlay || overlay.destroyed) continue;
      if (overlay.tasks?.length > 0 || overlay.inFlightPaint) {
        try {
          overlay.cancel?.();
          overlay.paintIncomplete = true;
        } catch (ignored) {
          // Best-effort cancellation of background work.
        }
      }
    }
  }

  onTabActivate({ paint = true } = {}) {
    if (this.destroyed) return;
    this.syncEditorContextRealm();
    this.ensureCurrentDocument("tab-activate");
    if (!paint) {
      this.pauseBackgroundWork();
      return;
    }
    this.paintOnSelectPending = false;
    this.queueDocumentCheck();
  }

  /**
   * The document this reader's live viewer shows, when its printed identity is not
   * the one the session latched.
   *
   * The startup latch bug: the inactive tab's realm is unresolved, the bridge
   * answers with the other reader's `PDFViewerApplication`, and the session stores
   * that document's key. Later `currentPDFDocument()` resolves to this tab's own
   * document, but nothing re-derives the id, so detection, the cache key and every
   * paint keep running under the other document's key. Only a printed key counts:
   * a provisional `fcp:doc-N` is re-minted per read under Xrays, which would turn
   * this check into a churn loop — the rule `applyDocumentId()` already enforces.
   *
   * @returns {string|null} The fresh key, or null when the identity did not drift.
   */
  docIdentityDrift() {
    try {
      if (!this.documentId) return null;
      // A realm the session does not trust serves the other reader's viewer:
      // reading identity there compares the foreign document against this
      // session's own key and would report a drift that is really the guess,
      // wiping correct overlays on every wake. The guess path is healed by
      // realm re-resolution, not by drift re-keying.
      if (!this.realmConfirmed()) return null;
      // The provisional-to-printed transition is the silent adoption
      // `applyDocumentId()` was written for: the regions stay, the canvases stay,
      // and a drift check that re-mints a provisional key on every read under Xrays
      // would wipe them once per wake.
      if (isProvisionalDocumentId(this.documentId)) return null;
      const fresh = resolveDocumentId(this.currentPDFDocument());
      if (!fresh || isProvisionalDocumentId(fresh)) return null;
      return fresh === this.documentId ? null : fresh;
    } catch (err) {
      warnOnce("doc-drift-read", err, this.tag);
      return null;
    }
  }

  /**
   * Re-keys the session onto a document identity a caller already read: the named
   * manual entry of the repair route, for a Run-Javascript fix or a diagnostic that
   * holds the fresh key and wants the pages and cache released in one call.
   *
   * No wake calls it any more. `ensureCurrentDocument()` owns the decision of when a
   * document changed, and `commitRekey()` is the half that releases the previous
   * document, so keeping a second decision point here would put the identity logic
   * back in two places.
   *
   * @param {string} freshId Printed key of the live document, from `docIdentityDrift()`.
   * @returns {void}
   */
  applyDocDrift(freshId) {
    if (this.destroyed || !freshId) return;
    this.commitRekey(freshId, "drift");
  }

  /**
   * Whether the realm this session paints is proven to be this reader's own.
   *
   * A realm named by the reader's chain, its `src` match or its frame scan is its
   * own; so is a guess whose budget was spent and accepted, and any window the
   * reader's own chain or iframe set still lists. Only the last-resort bridge guess
   * with budget left is still a guess: its document can belong to the other tab's
   * viewer, and comparing that document against this session's key proves nothing.
   *
   * @returns {boolean}
   */
  realmUnproven() {
    if (!this.innerWin) return true;
    if (this.realmConfirmed()) return false;
    return this.realmProvenance === "bridge" && this.bridgeGuessPasses < BRIDGE_GUESS_PASSES;
  }

  /**
   * Decides what a document identity that no longer matches the latched one costs.
   *
   * The single place that compares the latched key against the identity the live
   * document prints. `docIdentityDrift()` is the read: it reports a fresh key only
   * for a realm the session trusts and only printed-against-printed, so a
   * re-minted provisional key cannot turn this into a re-key loop, and the silent
   * provisional-to-printed adoption stays with `applyDocumentId()`.
   *
   * @param {string} trigger Site asking, recorded for diagnostics.
   * @returns {"ok"|"rekeyed"|"wait"} `wait` means the identity is unproven: the
   *   caller must neither paint nor drop anything.
   */
  validateDocumentIdentity(trigger) {
    if (this.destroyed) return "wait";
    if (!this.documentId) return this.recordValidation(trigger, "ok");
    const fresh = this.docIdentityDrift();
    if (!fresh) return this.recordValidation(trigger, "ok");
    if (this.realmUnproven()) {
      // Fail-safe: nothing is painted and nothing is dropped. A guessed realm that
      // is about to be replaced must not have this reader's own regions invalidated
      // because the foreign window printed another fingerprint.
      return this.recordValidation(trigger, "wait");
    }
    this.commitRekey(fresh, trigger);
    return this.recordValidation(trigger, "rekeyed");
  }

  /**
   * The one entry every wake goes through before it reads the cache, paints or
   * re-keys: make sure the realm is the one this reader shows, then make sure the
   * document identity the session holds is the identity of that realm's document.
   *
   * Order matters, and it is the whole bug. Identity is printed by the document
   * object, the document object is reached through the realm, so a wake that skips
   * the realm step compares the new document against a realm that still answers with
   * the old one — and reads "same document" out of the other tab's viewer.
   *
   * @param {string} [trigger] Name of the wake, recorded for `probeAll()`.
   * @returns {"ok"|"rekeyed"|"wait"} `wait` means the caller must paint nothing.
   */
  ensureCurrentDocument(trigger = "wake") {
    if (this.destroyed) return "wait";
    // Always re-resolve: the reader's own viewer appears late after a tab restore or
    // a panel re-create, and `reevaluateRealm()` adopts only a genuine change, so a
    // wake over an unchanged realm costs one resolution and no repaint.
    this.reevaluateRealm();
    return this.validateDocumentIdentity(trigger);
  }

  /**
   * Moves the session onto a new document identity and releases everything that
   * belonged to the previous one: the cached regions of the old key, the overlays
   * that carry the old key's regions, and their paint.
   *
   * The stale entries go out under the *old* key, before the fresh one is installed:
   * after the assignment `cacheKey()` names the new document, and the regions parsed
   * from the wrong one would stay in the shared cache for the whole plugin run.
   *
   * @param {string} freshId Printed key of the document the realm shows now.
   * @param {string} [trigger] Wake that asked, recorded for diagnostics.
   * @returns {void}
   */
  commitRekey(freshId, trigger = "manual") {
    if (this.destroyed || !freshId || freshId === this.documentId) return;
    const staleKey = this.cacheKey();
    this.documentId = freshId;
    this.identityPromises.clear();
    this.regionCache.invalidateDocument(staleKey);
    this.lastStaleKey = staleKey;
    this.editor?.cancel("rekeyed");
    this.detachAll();
    this.syncEditorContextRealm();
    void this.warmPersistentStore();
    void this.repaintAttached();
    // Same race as a document swap: the canvases this pass rebuilds can land while
    // the viewer is still laying out, so the page gets its own settled re-check.
    this.scheduleSettledCheck();
    warnOnce(
      "doc-drift",
      new Error("the document this reader shows is not the one its session latched"),
      this.tag,
    );
    this.notify();
  }

  /**
   * Records what the last identity validation decided, for `probeAll()`.
   *
   * @param {string} trigger Site asking for the validation.
   * @param {"ok"|"rekeyed"|"wait"} decision What the validation concluded.
   * @returns {string} The decision, so callers can return it through one expression.
   */
  recordValidation(trigger, decision) {
    this.lastValidation = {
      trigger: String(trigger ?? "wake"),
      decision,
      // The identity the session holds after the validation, so a report says both
      // what the wake decided and what document it left the reader on. For
      // `rekeyed` this is the fresh key, since `commitRekey()` ran first.
      after: this.documentId ?? null,
      at: new Date().toISOString(),
    };
    return decision;
  }

  /**
   * Re-stamps one overlay with the identity this session holds now.
   *
   * The viewer rebuilds a page view on a zoom, a toolbar toggle and a tab switch,
   * and the session reuses the overlay record for the live view. Without this, the
   * record a page got while document A was loaded keeps reading A's cached regions
   * and keeps its `painted` flag after the window started showing document B, which
   * is how the other document's boxes come back on every repaint.
   *
   * @param {PageOverlay} overlay
   * @returns {void}
   */
  restampOverlay(overlay) {
    if (!overlay) return;
    overlay.docId = this.documentId ?? null;
    const key = this.cacheKey();
    if (overlay.documentId === key) return;
    overlay.documentId = key;
    // The mounted boxes were parsed for the previous document: drop them, plus the
    // "already detected" flag, so the next paint reads the cache of the document the
    // overlay is stamped with now.
    overlay.painted = false;
    overlay.paintIncomplete = false;
    overlay.detectPromise = null;
    overlay.detectDocumentId = null;
    overlay.inFlightPaint = null;
    overlay.regionBoxes = [];
  }

  /**
   * Adopts the pdf.js realm this reader points at now, when it is not the one the
   * session holds.
   *
   * @returns {boolean} True when another realm was adopted.
   */
  reevaluateRealm() {
    if (this.destroyed || !this.reader) return false;
    let resolution = null;
    try {
      resolution = resolveInnerRealm(this.reader, this.tag);
    } catch (err) {
      warnOnce("realm-reevaluate", err, this.tag);
      return false;
    }
    if (!resolution.win || resolution.win === this.innerWin) return false;
    // A trusted realm always replaces the held one: the instance chain names
    // this reader's own viewer, so a change there is a real viewer swap.
    // While the session holds an unconfirmed bridge guess, any resolution is
    // usable — the guess is a guess, and the reader's own window appearing is
    // exactly the correction being waited for.
    const own = OWN_REALM_PROVENANCE.has(resolution.provenance) ||
      realmBelongsToReader(resolution.win, this.reader);
    if (!own && this.innerWin && this.realmConfirmed()) return false;
    const previous = this.innerWin;
    this.adoptRealm(resolution);
    this.realmSwitches += 1;
    this.editor?.cancel("realm-switched");
    this.syncEditorContextRealm();
    // Identity is a property of the realm it was read from, so adopting another realm
    // makes the latched key foreign: the new realm's document is a different
    // document, and the overlays carry the old realm's window either way. The
    // decision of what that costs stays in one place — `validateDocumentIdentity()`
    // — and a re-key there already detaches, repaints and notifies.
    if (this.validateDocumentIdentity("realm-adopted") !== "rekeyed") {
      this.detachAll();
      void this.repaintAttached();
      this.notify();
    }
    warnOnce(
      "realm-switched",
      new Error("session moved to another pdf.js realm"),
      `${this.tag} from ${previous ? "realm" : "no realm"}`,
    );
    return true;
  }

  /**
   * Whether the latched realm may serve as this session's document source: a
   * trusted resolution route, a guess whose budget was spent and accepted, or
   * a window the reader's own chain or iframe set still lists.
   *
   * @returns {boolean}
   */
  realmConfirmed() {
    if (!this.innerWin) return false;
    if (this.realmProvenance === "bridge-guessed") return true;
    return realmBelongsToReader(this.innerWin, this.reader);
  }

  /**
   * Latches a freshly resolved realm: releases the old window's handlers first,
   * then binds the new one. `releaseRealm()` before the bus is nulled, so the
   * old subscriptions are dropped from the bus they live on.
   *
   * @param {RealmResolution} resolution
   * @param {{ keepGuessPasses?: boolean }} [opts] Keep the guess budget when a
   *   bridge guess is only re-confirmed; a new adoption always resets it.
   * @returns {void}
   */
  adoptRealm(resolution, opts = {}) {
    this.releaseRealm();
    this.innerWin = resolution.win;
    this.realmProvenance = resolution.provenance;
    if (!opts.keepGuessPasses) this.bridgeGuessPasses = 0;
    this.eventBus = resolveEventBus(resolution.win, this.tag);
    this.bindEvents();
  }

  /**
   * Drops the event-bus subscriptions and the zoom watcher of the realm the
   * session holds, so switching realms cannot leave handlers on the old window.
   * The overlays are left alone: they are rebuilt by the repaint that follows a
   * successful pass.
   */
  releaseRealm() {
    if (this.visHandler && this.visChangeTarget) {
      try {
        this.visChangeTarget.removeEventListener?.("visibilitychange", this.visHandler);
      } catch (err) {
        warnOnce("visibility-unbind", err, this.tag);
      }
      this.visChangeTarget = null;
    }
    unsubscribe(this.eventBus, this.loadEventNames, this.onDocumentEvent, this.tag);
    unsubscribe(this.eventBus, this.renderEventNames, this.onPageRenderedEvent, this.tag);
    this.loadEventNames = [];
    this.renderEventNames = [];
    try {
      this.zoom?.destroy();
    } catch (err) {
      warnOnce("zoom-destroy", err);
    }
    this.zoom = null;
    this.eventBus = null;
    // Another realm gets its own one-time `no-event-bus` warning.
    this.noBusWarned = false;
  }

  /**
   * Refreshes the RegionCache document key from the loaded document.
   *
   * A printed key never regresses: when the viewer stops reporting the
   * fingerprint or the loading-task doc id — a wrapper that hides the field, a
   * reader that swaps its realm — the fallback key would replace a printed one
   * and strand every detection cached under it, so the printed key is kept.
   *
   * @returns {string|null}
   */
  syncDocumentId() {
    try {
      const documentId = resolveDocumentId(this.currentPDFDocument());
      if (!documentId) return this.documentId;
      if (this.documentId && !isProvisionalDocumentId(this.documentId) && isProvisionalDocumentId(documentId)) {
        return this.documentId;
      }
      this.documentId = documentId;
    } catch (err) {
      warnOnce("sync-document-id", err);
    }
    return this.documentId;
  }

  /**
   * The RegionCache key of this session's document: the document id scoped to this
   * reader, so two readers showing two documents never share cache entries.
   *
   * @returns {string}
   */
  cacheKey() {
    return scopedDocumentId(this.cacheScope, this.documentId ?? "");
  }

  /**
   * Resolves the persistent attachment identity (`attachmentItemID`,
   * non-provisional `fingerprint`, optional `fileSize` / `fileMtime`) once per
   * open document in this session. Returns `null` when unavailable or provisional.
   *
   * @param {string|null} [overlayDocId]
   * @returns {Promise<object|null>}
   */
  resolvePersistentIdentity(overlayDocId = this.documentId) {
    if (this.destroyed || !this.persistentStore) return Promise.resolve(null);
    const targetDocId = overlayDocId ?? this.documentId ?? null;
    const itemID = this.reader?.itemID;
    if (itemID === undefined || itemID === null || !targetDocId || isProvisionalDocumentId(targetDocId)) {
      return Promise.resolve(null);
    }
    const cacheId = `${String(itemID)}|${targetDocId}`;
    const cached = this.identityPromises.get(cacheId);
    if (cached) return cached;

    const task = resolveAttachmentIdentity({
      reader: this.reader,
      pdfDocument: this.currentPDFDocument(),
      docId: targetDocId,
      itemID,
      io: this.persistentStore.io,
      includeFileStat: !this.resolveAttachmentMeta,
    })
      .then(async (base) => {
        if (!base || !this.resolveAttachmentMeta) return base;
        try {
          const meta = await this.resolveAttachmentMeta(base);
          if (!meta || typeof meta !== "object") return base;
          return {
            ...base,
            fileSize: meta.fileSize ?? base.fileSize,
            fileMtime: meta.fileMtime ?? base.fileMtime,
          };
        } catch {
          return base;
        }
      })
      .catch(() => null);

    this.identityPromises.set(cacheId, task);
    return task;
  }

  /**
   * Resolves `{ attachmentItemID, storageKey, fingerprint }` synchronously when
   * both `reader.itemID` and a non-provisional `documentId` are already known.
   */
  resolveSyncIdentity(overlayDocId = this.documentId) {
    const targetDocId = overlayDocId ?? this.documentId ?? null;
    const itemID = this.reader?.itemID;
    return normalizeAttachmentIdentity({ itemID, docId: targetDocId });
  }

  /**
   * Starts warming the attachment's persistent record in memory so synchronous
   * context-menu queries have saved overrides immediately available.
   */
  warmPersistentStore() {
    const store = this.persistentStore;
    if (this.destroyed || !store) return Promise.resolve(null);
    const identity = this.resolveSyncIdentity();
    if (!identity) return Promise.resolve(null);
    return this.resolvePersistentIdentity(this.documentId)
      .then((fullId) => {
        if (this.destroyed || this.persistentStore !== store || !fullId) return null;
        return store.loadDocument(fullId);
      })
      .catch(() => null);
  }

  /** Ensures passive right-click coordinate capture follows the live inner realm. */
  syncEditorContextRealm() {
    if (this.destroyed || !this.editor) return;
    try {
      this.editor.attachContextListener(this.innerWin?.document ?? null);
    } catch (err) {
      warnOnce("editor-context-bind", err, this.tag);
    }
  }

  /**
   * Synchronously reads effective regions, cached auto regions, and overrides
   * for one page without disk IO or detection (for `createViewContextMenu`).
   */
  getPageEffectiveStateSync(pageNumber) {
    const pageNum = Number(pageNumber);
    const identity = this.resolveSyncIdentity();
    const key = this.cacheKey();
    const memCached = key ? this.regionCache?.get?.(key, pageNum) : null;
    const diskState =
      this.persistentStore && identity ? this.persistentStore.getPageStateSync(identity, pageNum) : null;

    const overrides = diskState?.loaded ? diskState.overrides : [];
    let autoRegions = null;
    if (diskState?.loaded && diskState.hit) {
      autoRegions = serializeAutoRegions(diskState.autoRegions);
    } else if (memCached && memCached.autoRegions !== undefined) {
      autoRegions = serializeAutoRegions(memCached.autoRegions);
    }

    let effective;
    if (autoRegions !== null) {
      effective = resolveEffectiveRegions(autoRegions, overrides);
    } else if (memCached?.regions) {
      const baseRegions = serializeAutoRegions(memCached.regions);
      autoRegions = baseRegions;
      effective = resolveEffectiveRegions(baseRegions, overrides);
    } else {
      const overlay = this.overlays.get(pageNum);
      const fallbackAuto = overlay?.regionBoxes?.length
        ? serializeAutoRegions(
            overlay.regionBoxes.map((rect, idx) => ({
              rect,
              sourceKinds: [overlay.regionKinds?.[idx] ?? "figure"],
            })),
          )
        : [];
      autoRegions = fallbackAuto;
      effective = resolveEffectiveRegions(fallbackAuto, overrides);
    }

    return {
      identity,
      loaded: Boolean(diskState?.loaded),
      autoRegions,
      overrides,
      effective,
    };
  }

  /**
   * Maps a right-click event (captured from inner `contextmenu` or synthesized
   * from Zotero's `createViewContextMenu` `params.{x, y}`) onto the rendered
   * page view, effective region, or suppressed auto region.
   */
  resolveContextHit(params = {}) {
    if (this.destroyed || !this.innerWin) return null;
    this.syncEditorContextRealm();

    const snap = this.editor?.consumeContextEvent?.() ?? null;
    const views = listPageViews(resolvePDFViewer(this.innerWin, this.tag));
    if (!views.length) return null;

    let clientX = snap ? Number(snap.clientX) : Number.NaN;
    let clientY = snap ? Number(snap.clientY) : Number.NaN;
    const targetNode = snap?.target ?? null;

    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      const rawX = Number(params?.x);
      const rawY = Number(params?.y);
      if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
      let offX = 0;
      let offY = 0;
      try {
        const frameEl = this.reader?._internalReader?._primaryView?._iframe ?? this.innerWin?.frameElement ?? null;
        const frameRect = frameEl?.getBoundingClientRect?.() ?? null;
        if (frameRect) {
          offX = Number(frameRect.left) || 0;
          offY = Number(frameRect.top) || 0;
        }
      } catch {
        // Unreadable frame rect defaults to zero offset.
      }
      clientX = rawX - offX;
      clientY = rawY - offY;
    }

    let pageView = null;
    let pageRect = null;
    if (targetNode) {
      for (const view of views) {
        const div = view?.div;
        if (!div) continue;
        if (div === targetNode || div.contains?.(targetNode)) {
          pageView = view;
          pageRect = div.getBoundingClientRect?.() ?? null;
          break;
        }
      }
    }
    if (!pageView) {
      for (const view of views) {
        const div = view?.div;
        if (!div || typeof div.getBoundingClientRect !== "function") continue;
        const rect = div.getBoundingClientRect();
        if (!rect || !(rect.width > 0 && rect.height > 0)) continue;
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          pageView = view;
          pageRect = rect;
          break;
        }
      }
    }

    const pageNumber = Number(pageView?.id) || 0;
    const viewport = pageView?.viewport ?? null;
    if (!pageView || !pageNumber || !viewport || !pageRect) return null;

    const vpPoint = clientPointToViewportPoint({
      clientX,
      clientY,
      pageRect,
      scrollLeft: Number(pageView.div?.scrollLeft) || 0,
      scrollTop: Number(pageView.div?.scrollTop) || 0,
      viewport,
    });
    if (!vpPoint) return null;
    const [vx, vy] = vpPoint;
    if (vx < -1e-3 || vy < -1e-3 || vx > viewport.width + 1e-3 || vy > viewport.height + 1e-3) {
      return null;
    }

    let pdfPoint;
    try {
      pdfPoint = toPdfPoint(vpPoint, viewport);
    } catch {
      return null;
    }

    const pageState = this.getPageEffectiveStateSync(pageNumber);
    const hit = hitTestRegions(pdfPoint, pageState.effective.regions);
    const suppressedHit = hit
      ? null
      : findSuppressedTargetAtPoint(pdfPoint, {
          overrides: pageState.overrides,
          autoRegions: pageState.autoRegions,
        });

    return {
      pageNumber,
      pageView,
      viewportPoint: vpPoint,
      pdfPoint,
      pageState,
      hit,
      suppressedHit,
    };
  }

  /** Opens interactive 4-corner adjustment for `region` on `pageNumber`/`pageView`. */
  startAdjustRegion({ pageNumber, pageView = null, region }) {
    if (this.destroyed || !this.enabled || !this.editor) return false;
    const targetView =
      pageView ??
      listPageViews(resolvePDFViewer(this.innerWin, this.tag)).find((v) => Number(v?.id) === Number(pageNumber)) ??
      null;
    if (!targetView) return false;
    return this.editor.startAdjust({ pageView: targetView, pageNumber, region });
  }

  /** Opens interactive draw + corner adjustment for adding a new region on `pageNumber`. */
  startAddRegion({ pageNumber, pageView = null }) {
    if (this.destroyed || !this.enabled || !this.editor) return false;
    const targetView =
      pageView ??
      listPageViews(resolvePDFViewer(this.innerWin, this.tag)).find((v) => Number(v?.id) === Number(pageNumber)) ??
      null;
    if (!targetView) return false;
    return this.editor.startAdd({ pageView: targetView, pageNumber });
  }

  /** Cancels any active uncommitted edit without writing to persistent storage. */
  cancelEditor(reason = "cancel") {
    return Boolean(this.editor?.cancel(reason));
  }

  /** Ensures a shared visibilitychange handler is created and bound to the reader's outer document. */
  ensureVisHandler() {
    if (!this.visHandler) {
      this.visHandler = (event) => {
        const targetDoc =
          event?.currentTarget ?? event?.target ?? this.innerWin?.document ?? this.reader?._iframeWindow?.document;
        if (targetDoc?.visibilityState === "hidden") {
          this.pauseBackgroundWork();
          return;
        }
        this.onTabActivate();
      };
    }
    return this.visHandler;
  }

  /** Binds visibilitychange on the reader's own outer iframe document (never a foreign tab). */
  bindOuterVisibility() {
    try {
      const outerDoc = this.reader?._iframeWindow?.document ?? null;
      if (!outerDoc || typeof outerDoc.addEventListener !== "function" || this.outerVisTarget === outerDoc) return;
      if (this.outerVisTarget && this.visHandler) {
        try {
          this.outerVisTarget.removeEventListener?.("visibilitychange", this.visHandler);
        } catch (ignored) {}
      }
      outerDoc.addEventListener("visibilitychange", this.ensureVisHandler());
      this.outerVisTarget = outerDoc;
    } catch (err) {
      warnOnce("visibility-bind-outer", err, this.tag);
    }
  }

  /** Subscribes to the event bus and starts the zoom watcher. */
  bindEvents() {
    this.bindOuterVisibility();
    // A tab the user comes back to is the one moment the newly visible document can
    // be re-checked, and the realm it belongs to re-resolved. Bound per realm like
    // the bus subscriptions, so releaseRealm() and destroy() drop it with the rest.
    // Never bind visibilitychange onto an unconfirmed bridge-guessed realm, since
    // that window belongs to another tab and its hide event would pause this tab.
    const ownResolution = resolveInnerRealm(this.reader);
    const trustedWin =
      ownResolution.provenance !== "bridge" && ownResolution.provenance !== "none"
        ? ownResolution.win
        : this.realmConfirmed()
          ? this.innerWin
          : null;
    const realmDocument = trustedWin?.document ?? null;
    if (realmDocument && typeof realmDocument.addEventListener === "function") {
      try {
        realmDocument.addEventListener("visibilitychange", this.ensureVisHandler());
        this.visChangeTarget = realmDocument;
      } catch (err) {
        warnOnce("visibility-bind", err, this.tag);
      }
    }
    if (!this.eventBus) {
      // The recovery loop now keeps asking for the bus pass after pass, so the
      // warning is bounded per realm instead of per pass: `releaseRealm()` clears
      // the flag when the session adopts another realm.
      if (!this.noBusWarned) {
        this.noBusWarned = true;
        warnOnce("no-event-bus", new Error("pdf.js event bus unavailable"), this.tag);
      }
      return;
    }
    this.loadEventNames = subscribe(this.eventBus, DOCUMENT_EVENTS, this.onDocumentEvent, this.tag);
    this.renderEventNames = subscribe(this.eventBus, [PAGE_RENDERED_EVENT], this.onPageRenderedEvent, this.tag);
    this.zoom = createZoomWatcher({
      eventBus: this.eventBus,
      onChange: () => this.onViewScaleChange(),
      timers: this.timers,
    });
  }

  /** @returns {object|null} The pdfDocument currently shown by this reader. */
  currentPDFDocument() {
    try {
      return resolvePDFViewer(this.innerWin, this.tag)?.pdfDocument ?? null;
    } catch (err) {
      warnOnce("current-document", err);
      return null;
    }
  }

  /**
   * Sleeps on a tracked timer, so destroy() can release a caller that is
   * waiting for the document.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        this.timers.delete(timer);
        this.readyWakes.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.timers.add(timer);
      // Tracked so destroy() can resolve a pending wait instead of leaving the
      // start() promise hanging on a timer that will never fire again.
      this.readyWakes.add(wake);
    });
  }

  /**
   * Polls until the pdf.js document object exists, with a bounded wait. The
   * inner window is re-resolved on every pass because the chain can be missing
   * while the toolbar renders and appear a moment later.
   *
   * @returns {Promise<boolean>}
   */
  async waitUntilReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (this.destroyed) return false;
      this.attempts += 1;
      // Keep re-resolving while the held realm is an unconfirmed bridge guess:
      // on tab re-activation Zotero re-creates the panel's viewer, and the own
      // window appearing mid-poll must replace the foreign one the bridge
      // handed over — otherwise every remaining poll reads the wrong window's
      // document and the session latches a foreign identity.
      if (!this.innerWin || !this.realmConfirmed()) {
        const resolution = resolveInnerRealm(this.reader, this.tag);
        if (resolution.win && resolution.win !== this.innerWin) {
          const own = OWN_REALM_PROVENANCE.has(resolution.provenance) ||
            realmBelongsToReader(resolution.win, this.reader);
          if (own || !this.innerWin) this.adoptRealm(resolution);
        }
      }
      if (this.currentPDFDocument()) {
        // A document on a realm the session does not trust is the other
        // reader's viewer: poll a bounded number of passes for the reader's
        // own window before serving the guess, so a wrong bridge pick cannot
        // mint this session's identity on a foreign document.
        if (!this.realmConfirmed()) {
          this.bridgeGuessPasses += 1;
          if (this.bridgeGuessPasses >= BRIDGE_GUESS_PASSES) this.realmProvenance = "bridge-guessed";
          else {
            await this.sleep(READY_POLL_MS);
            continue;
          }
        }
        return true;
      }
      if (Date.now() > deadline) {
        warnOnce("ready-timeout", new Error("Timed out waiting for the pdf.js viewer window and document"), this.tag);
        return false;
      }
      await this.sleep(READY_POLL_MS);
    }
  }

  /**
   * Handles a document swap inside the same iframe. Zotero keeps the viewer
   * window alive, so a reload or a "switch to this PDF" has to invalidate the
   * cache and drop the old overlays.
   */
  queueDocumentCheck() {
    if (this.destroyed) return;
    if (this.documentCheckTimer !== null) {
      clearTimeout(this.documentCheckTimer);
      this.timers.delete(this.documentCheckTimer);
    }
    const run = () => {
      this.documentCheckTimer = null;
      this.timers.delete(timer);
      // Identity goes through the one entry before anything is read or painted: the
      // realm this window answers with can have been replaced while the sweep waited,
      // and a drift has to release the previous key and the mounted pages before this
      // pass reads the live document. A `rekeyed` sweep already detached, repainted
      // and re-armed the settled check; a `wait` paints nothing rather than painting
      // an unproven realm's regions under this reader's key — so it re-arms the
      // settled check instead of dropping the pass, otherwise a realm that stays
      // unproven here parks for good with nothing left to re-try it.
      const identity = this.ensureCurrentDocument("document-check");
      if (identity === "wait") {
        this.scheduleSettledCheck();
        return;
      }
      if (identity !== "ok") return;
      if (!this.isForeground()) {
        this.pauseBackgroundWork();
        return;
      }
      const pdfDocument = this.currentPDFDocument();
      // Read before `applyDocumentId()`: after a swap `cacheKey()` names the new
      // document, and invalidating that leaves the regions parsed from the previous
      // one in the shared cache for the whole plugin run.
      const staleKey = this.cacheKey();
      const decision = this.applyDocumentId(resolveDocumentId(pdfDocument));
      if (decision !== "changed") {
        if (!pdfDocument && this.documentId) {
          this.documentId = null;
          this.detachAll();
        }
        if (pdfDocument && this.workPausedInBackground) {
          this.workPausedInBackground = false;
          void this.repaintAttached();
          this.scheduleSettledCheck();
          return;
        }
        // The pages this sweep left unpainted get exactly one extra pass: a real
        // machine's first `pagesloaded` arrives while the page views are still
        // being built, and this is the only sweep that notices.
        this.catchUpPaint("pagesloaded");
        return;
      }
      this.identityPromises.clear();
      this.regionCache.invalidateDocument(staleKey);
      this.detachAll();
      this.syncEditorContextRealm();
      void this.warmPersistentStore();
      void this.repaintAttached();
      // The same race as the first open and the same reason: with a warm
      // RegionCache this paint lands while the swapped-in document is still
      // laying out, so it needs its own settled pass.
      this.scheduleSettledCheck();
      // One more pass catches pages that are still being created.
      this.queueDocumentCheck();
    };
    const timer = setTimeout(run, DOCUMENT_CHECK_MS);
    this.documentCheckTimer = timer;
    this.timers.add(timer);
  }

  /**
   * Re-checks every painted page once the viewer has settled, `SETTLED_REPAINT_MS`
   * after a full-document paint.
   *
   * Armed after every full-document paint: the first open of a document
   * (`start()`), a document swap (`queueDocumentCheck()`) and the toolbar enable
   * (`setEnabled(true)`). The reason all three is the shared RegionCache: it
   * lives for the whole plugin run, so with a warm cache the detection returns in
   * one microtask and the paint lands in the same tick as the viewer's own
   * relayout, while a cold cache parses the page for tens or hundreds of
   * milliseconds and therefore paints after the layout has settled. That is why
   * the same PDF is fine on one open and displaced on another. `scheduleSettledCheck()`
   * replaces a pending timer, so repeat arming cannot stack passes.
   *
   * The real-machine symptom is "correct on first open, displaced after the
   * toolbar toggle goes off then on": the enable paint races the viewer's own
   * relayout (toolbar state change, fit-width re-zoom) and paints against a
   * viewport the page replaces moments later. When the timer fires, each page
   * that still has cached regions and whose `geometryStale()` says the painted
   * viewport moved is re-painted through the proven `paintOverlay` path. A page
   * whose geometry did not move is left alone, so a settled pass is free for
   * every page that aligned correctly. `paintOverlay` reuses the cached regions
   * and reads the page's current viewport inside itself, so a warm RegionCache
   * means no new detection.
   *
   * The second thing this pass has to heal is a page that lost its canvases
   * without anything moving. Scrolling recycles a page view and the viewer builds
   * a new one, and the canvases that hung in the old `pageView.div` go out of the
   * document with it. Nothing a geometry check reads changes in that moment — same
   * viewport, same scale, same rotation — so a pass that looked only at
   * `geometryStale()` skipped the page and left the record reading `painted` over
   * canvases nobody would mount again: grey figures until the next toolbar toggle.
   * Each page is therefore asked about both conditions, `geometryStale()` and
   * `isMounted()`, and the ones that fail either are healed through
   * `attachPageNumber()` rather than a bare `paintOverlay()`, because the usual
   * reason the canvases are gone is that the page view itself was replaced and
   * only `attachPageView()` re-binds the record to the live view. A page that
   * failed neither is skipped, which is what keeps a settled pass free for the
   * pages that aligned correctly.
   */
  scheduleSettledCheck() {
    if (this.destroyed) return;
    if (this.settledCheckTimer !== null) {
      clearTimeout(this.settledCheckTimer);
      this.timers.delete(this.settledCheckTimer);
    }
    const run = () => {
      this.settledCheckTimer = null;
      this.timers.delete(timer);
      if (this.destroyed) return;
      for (const overlay of [...this.overlays.values()]) {
        try {
          if (!overlay || overlay.destroyed) continue;
          if (!overlay.regionBoxes.length) continue;
          // Two ways a painted page stops being correct: the viewport it was painted
          // for moved, or the canvases are no longer in the document the viewer shows
          // now. Neither: the page aligned and is still visible, so the pass costs it
          // nothing. An overlay that does not report mounting is taken at its word.
          const mounted = typeof overlay.isMounted === "function" ? overlay.isMounted() : true;
          if (overlay.geometryStale() !== true && mounted !== false) continue;
          // The re-attach route, not a bare repaint: a page whose canvases left
          // usually left because the viewer rebuilt its page view, and only
          // `attachPageView()` re-binds the record to the live one. Null means there
          // is no page view to attach to yet — `pagerendered` paints it when it comes.
          const job = this.attachPageNumber(overlay.pageNumber);
          if (!job) continue;
          this.track(overlay, job);
          // Counting here, not inside `paintOverlay`, so the number means exactly
          // "a page the settled pass had to heal".
          this.settledRepaints += 1;
        } catch (err) {
          // One broken page must not stop the rest of the settled pass.
          warnOnce("settled-repaint", err);
        }
      }
    };
    const timer = setTimeout(run, SETTLED_REPAINT_MS);
    this.settledCheckTimer = timer;
    this.timers.add(timer);
  }

  /**
   * One extra paint pass per trigger, for the pages a full-document paint missed.
   *
   * The fresh-open symptom on the real machine is "nothing paints at all": the
   * paint at the end of `start()` runs before pdf.js has built the page views,
   * and the late pages are normally caught by `pagerendered`, which a session
   * without an event bus never gets. A trigger therefore gets one bounded
   * catch-up pass, and only while the session has painted nothing, so a healthy
   * session — overlays already mounted — never pays for it twice.
   *
   * @param {"start"|"pagesloaded"} trigger Site asking for the pass; each one is
   *   honoured at most once per session, so a churning document event cannot turn
   *   the catch-up into a repaint loop.
   * @returns {boolean} True when the extra pass ran.
   */
  catchUpPaint(trigger) {
    if (this.destroyed || !this.enabled || !this.ready) return false;
    if (this.catchUpDone.has(trigger)) return false;
    this.catchUpDone.add(trigger);
    // Counts the canvases that are in the live DOM: a document whose tab is in the
    // background keeps its mount records while its canvases are detached, and that
    // must not read as "already painted".
    if (this.overlayCount() > 0) return false;
    void this.repaintAttached();
    return true;
  }

  /**
   * Re-keys the session's document id under the provisional-id rules.
   *
   * `resolveDocumentId()` prefers the printed identity (fingerprint, then
   * loading-task doc id) and falls back to a WeakMap key when Zotero's Xrays hide
   * both. That fallback is provisional: a read that hands back a fresh wrapper
   * object mints a new `fcp:doc-N`, and the old code read the new string as a
   * document swap — `invalidateDocument` plus `detachAll` on every document event,
   * wiping the canvases that had just been mounted.
   *
   * Rules: printed to another printed key is the only real swap; a provisional key
   * is replaced by a printed one silently, so the one-time transition keeps the
   * mounted paints; a printed key never regresses to a provisional one, and a
   * re-minted provisional key carries no new identity, so neither re-keys.
   *
   * @param {string|null} candidate Key `resolveDocumentId()` produced for the live document.
   * @returns {"same"|"adopted"|"changed"} `changed` is the only case whose caller
   *   has to invalidate the cache and detach the pages.
   */
  applyDocumentId(candidate) {
    const current = this.documentId;
    if (!candidate) return "same";
    const candidatePrinted = !isProvisionalDocumentId(candidate);
    if (!current) {
      this.documentId = candidate;
      return candidatePrinted ? "changed" : "same";
    }
    if (candidate === current) return "same";
    const currentPrinted = !isProvisionalDocumentId(current);
    if (currentPrinted && candidatePrinted) {
      this.documentId = candidate;
      return "changed";
    }
    if (!currentPrinted && candidatePrinted) {
      // Silent adoption: the RegionCache keeps what it holds under the fallback
      // key, the pages keep their canvases, and the next detection runs under the
      // printed key. Nothing is wiped, which is the point.
      this.documentId = candidate;
      this.documentIdAdopted = true;
      return "adopted";
    }
    return "same";
  }

  /**
   * Attaches the overlay of one page, given its 1-based page number.
   *
   * @param {number} pageNumber
   */
  attachPageNumber(pageNumber) {
    for (const view of listPageViews(resolvePDFViewer(this.innerWin, this.tag))) {
      if (Number(view?.id) === Number(pageNumber)) return this.attachPageView(view);
    }
    return null;
  }

  /**
   * Attaches the overlay for one page view. Pages whose `pdfPage` is not there
   * yet are skipped: they report `pagerendered` a moment later.
   *
   * @param {object} pageView
   * @returns {Promise<void>|null}
   */
  attachPageView(pageView) {
    if (!this.enabled || this.destroyed || !this.documentId) return null;
    const pageNumber = Number(pageView?.id) || 0;
    if (!pageNumber) return null;
    if (!pageView?.pdfPage || !pageView?.div || !pageView?.viewport) return null;
    this.syncEditorContextRealm();
    if (this.editor?.active?.pageNumber === pageNumber && this.editor.active.pageView !== pageView) {
      this.editor.cancel("pageview-replaced");
    }
    let overlay = this.overlays.get(pageNumber);
    if (!overlay) {
      try {
        let created;
        created = new PageOverlay({
          pageView,
          innerWin: this.innerWin,
          // Scoped to this reader: two readers with the same printed fingerprint
          // must not read each other's cached regions.
          documentId: this.cacheKey(),
          // The raw key, for the canvas provenance stamp: the scoped key above is
          // the cache identity, this one says which document the paint read from.
          docId: this.documentId ?? null,
          regionCache: this.regionCache,
          persistentStore: this.persistentStore,
          resolveIdentity: this.persistentStore
            ? () => this.resolvePersistentIdentity(created?.docId ?? this.documentId)
            : null,
          resolveOPS: () => resolveOPS(this.innerWin, this.tag),
          tag: this.tag,
        });
        overlay = created;
      } catch (err) {
        warnOnce("overlay-ctor", err);
        return null;
      }
      this.overlays.set(pageNumber, overlay);
    } else if (overlay.pageView && overlay.pageView !== pageView) {
      // The viewer rebuilt the page view — a zoom, a toolbar toggle or a tab switch
      // all do it. The canvases of the old one went out of the document with it, so
      // the record is rebound to the live view and the paint remounts them.
      overlay.pageView = pageView;
      overlay.innerWin = this.innerWin;
      // The canvases are re-appended under whatever this session shows now, so the
      // record has to be re-stamped with it: a record that kept the previous
      // document's key keeps reading that document's cached regions, which is how the
      // other document's boxes come back on every repaint.
      this.restampOverlay(overlay);
    } else if (overlay.isMounted && !overlay.isMounted()) {
      // Same page view, canvases gone: the div they hung in left the DOM. Repaint
      // re-appends them, which is what makes the page visible again.
      overlay.innerWin = this.innerWin;
      this.restampOverlay(overlay);
    }
    const docKey = this.cacheKey();
    if (
      overlay.inFlightPaint &&
      overlay.inFlightPaint.pageView === pageView &&
      overlay.inFlightPaint.documentId === docKey &&
      (typeof overlay.isMounted !== "function" || overlay.isMounted()) &&
      (typeof overlay.geometryStale !== "function" || !overlay.geometryStale())
    ) {
      return overlay.inFlightPaint.promise;
    }
    if (typeof overlay.needsPaint === "function" && !overlay.needsPaint({ pageView, documentId: docKey })) {
      return null;
    }
    const job = this.track(overlay, this.paintOverlay(overlay));
    if (job) {
      const record = { promise: job, pageView, documentId: docKey };
      overlay.inFlightPaint = record;
      void job.finally(() => {
        if (overlay.inFlightPaint === record) overlay.inFlightPaint = null;
      });
    }
    return job;
  }

  /**
   * Detects and paints one overlay, re-checking ownership between the two
   * steps. Detection is async, so the feature may have been switched off, or
   * the page may have been re-attached with a different overlay, while it ran.
   * Painting into a dropped overlay would leave canvases mounted with the
   * feature off, covering regions with nothing in them.
   *
   * @param {PageOverlay} overlay
   * @returns {Promise<void>}
   */
  async paintOverlay(overlay) {
    if (!overlay || this.destroyed || !this.enabled) return;
    const detected = await overlay.detect();
    if (!detected) return;
    if (this.destroyed || !this.enabled || this.overlays.get(overlay.pageNumber) !== overlay) {
      // Stale job: drop whatever the overlay mounted instead of adding more.
      overlay.clear();
      return;
    }
    if (overlay.documentId !== this.cacheKey()) {
      // The regions were read — or cached — for the document the overlay was stamped
      // with, and the identity changed while detection was in flight. Painting them now
      // would mount the previous document's boxes on the new one, where they stay
      // because the next paint reads them back as this page's regions.
      overlay.clear();
      return;
    }
    await overlay.paintRegions(detected.regions);
  }

  /**
   * Paints every page that already has a rendered pdfPage, one page at a time
   * starting from the current page in view so visible figures never wait behind
   * offscreen pages or starve the UI thread.
   *
   * @returns {Promise<void>}
   */
  async repaintAttached() {
    if (!this.enabled || this.destroyed) return;
    if (!this.isForeground()) {
      this.workPausedInBackground = true;
      this.paintOnSelectPending = true;
      return;
    }
    this.workPausedInBackground = false;
    const epoch = ++this.paintEpoch;
    const pdfViewer = resolvePDFViewer(this.innerWin, this.tag);
    const remaining = listPageViews(pdfViewer).filter(
      (view) => view?.pdfPage && view?.div && view?.viewport,
    );
    while (remaining.length) {
      if (this.destroyed || !this.enabled || this.paintEpoch !== epoch) break;
      if (!this.isForeground()) {
        this.workPausedInBackground = true;
        this.paintOnSelectPending = true;
        break;
      }
      const cur = Number(pdfViewer?.currentPageNumber) || 1;
      let bestIndex = 0;
      let bestScore = null;
      for (let i = 0; i < remaining.length; i += 1) {
        const view = remaining[i];
        const pageNum = Number(view?.id) || 0;
        const dist = Math.abs(pageNum - cur);
        const dirPenalty = pageNum < cur ? 1 : 0;
        const renderedPenalty = view?.renderingState === 3 || Boolean(view?.canvas) ? 0 : 1;
        const score = [dist, dirPenalty, renderedPenalty, pageNum];
        if (
          bestScore === null ||
          score[0] < bestScore[0] ||
          (score[0] === bestScore[0] &&
            (score[1] < bestScore[1] ||
              (score[1] === bestScore[1] &&
                (score[2] < bestScore[2] || (score[2] === bestScore[2] && score[3] < bestScore[3])))))
        ) {
          bestScore = score;
          bestIndex = i;
        }
      }
      const [nextView] = remaining.splice(bestIndex, 1);
      const job = this.attachPageView(nextView);
      if (job) await job;
    }
  }

  /**
   * Repositions and re-renders the existing canvases after a zoom or rotation
   * change, using each page view's new viewport. Detection is not repeated.
   */
  onViewScaleChange() {
    if (!this.enabled || this.destroyed) return;
    if (!this.isForeground()) {
      this.workPausedInBackground = true;
      this.paintOnSelectPending = true;
      return;
    }
    // A zoom is a repaint, so it reads the cache like every other paint: the boxes
    // this method reuses were parsed for the document the overlay was stamped with,
    // and a wake that finds another document has to say so before they are re-used.
    // `wait` is the unproven-realm case: nothing is painted, and the settled check is
    // re-armed so the pass is tried again rather than lost — without it a realm that
    // stays unproven would leave the zoom with no repaint and no retry.
    const identity = this.ensureCurrentDocument("scale-change");
    if (identity === "wait") {
      this.scheduleSettledCheck();
      return;
    }
    if (identity !== "ok") return;
    const key = this.cacheKey();
    const epoch = ++this.paintEpoch;
    this.editor?.cancel("view-scale-change");
    const cur = Number(resolvePDFViewer(this.innerWin, this.tag)?.currentPageNumber) || 1;
    const ordered = [...this.overlays.values()]
      .filter((overlay) => overlay && !overlay.destroyed)
      .sort((a, b) => {
        const pa = Number(a.pageNumber) || 0;
        const pb = Number(b.pageNumber) || 0;
        const da = Math.abs(pa - cur);
        const db = Math.abs(pb - cur);
        if (da !== db) return da - db;
        return pa - pb;
      });
    const run = async () => {
      for (const overlay of ordered) {
        if (this.destroyed || !this.enabled || this.paintEpoch !== epoch) break;
        if (!this.isForeground()) {
          this.workPausedInBackground = true;
          this.paintOnSelectPending = true;
          break;
        }
        if (overlay.destroyed) continue;
        if (overlay.documentId !== key) {
          // The mounted boxes belong to another document: drop them and let the paint
          // below re-detect under this one, instead of re-positioning foreign boxes.
          this.restampOverlay(overlay);
        }
        // Keep the cached regions, but drop the "already painted" assumption for
        // pages that have not been rendered at the new scale yet.
        const boxes = overlay.regionBoxes.length ? overlay.regionBoxes : null;
        const job = boxes
          ? this.track(overlay, overlay.paintRegions(boxes))
          : this.track(overlay, this.paintOverlay(overlay));
        if (job) await job;
      }
    };
    void run();
  }

  /**
   * Keeps paint jobs reachable so teardown can cancel their render tasks.
   *
   * @param {PageOverlay} overlay
   * @param {Promise<void>|null} promise
   * @returns {Promise<void>|null}
   */
  track(overlay, promise) {
    if (!promise) return null;
    const job = promise
      .catch((err) => {
        warnOnce("page-paint", err);
        try {
          overlay?.clear?.();
        } catch (ignored) {
          // The page stays uncovered, which is the conservative outcome.
        }
      })
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
    return job;
  }

  /**
   * Turns the overlay on or off for this reader. The shared RegionCache keeps
   * its contents, so switching back is cheap.
   *
   * @param {boolean} next
   * @returns {boolean} The new state.
   */
  setEnabled(next) {
    const value = Boolean(next);
    this.enabled = value;
    if (this.destroyed) return value;
    if (!value) {
      this.editor?.cancel("disabled");
      this.editor?.clearNotice();
      this.detachAll();
    } else {
      // The toggle repaints every page, so it goes through the same entry as the
      // other wakes: a session that still holds the previous document's identity must
      // not read its regions back from the cache and mount them again. A `rekeyed`
      // wake already repainted, and a `wait` paints nothing on purpose.
      if (this.ensureCurrentDocument("enable") === "ok") {
        if (this.isForeground()) {
          void this.repaintAttached();
          // The paint above runs in the same tick as the toolbar state change, so
          // schedule the correction pass for after the viewer finishes relayouting.
          this.scheduleSettledCheck();
        } else {
          this.workPausedInBackground = true;
          this.paintOnSelectPending = true;
        }
      }
    }
    this.notify();
    return value;
  }

  /** @returns {boolean} The new enabled state. */
  toggle() {
    return this.setEnabled(!this.enabled);
  }

  /** Removes every canvas of this reader without clearing the RegionCache. */
  detachAll() {
    this.editor?.cancel("detach");
    this.editor?.clearNotice();
    for (const overlay of [...this.overlays.values()]) {
      try {
        overlay.clear();
      } catch (err) {
        warnOnce("detach-overlay", err);
      }
    }
    this.overlays.clear();
  }

  /**
   * Refreshes one page overlay after a manual override mutation or page-level
   * auto-cache invalidation, repainting if currently attached and enabled.
   *
   * @param {number} pageNumber
   * @param {{forceDetect?: boolean}} [options]
   */
  refreshPageOverlay(pageNumber, { forceDetect = false } = {}) {
    if (this.destroyed) return null;
    const pageNum = Number(pageNumber);
    if (!Number.isInteger(pageNum) || pageNum < 1) return null;
    if (forceDetect) {
      this.identityPromises.clear();
      const key = this.cacheKey();
      this.regionCache?.invalidateDocument?.(key);
    }
    const overlay = this.overlays.get(pageNum);
    overlay?.clear?.();
    if (!this.enabled) return null;
    if (!this.isForeground()) {
      this.workPausedInBackground = true;
      this.paintOnSelectPending = true;
      return null;
    }
    const job = this.attachPageNumber(pageNum);
    return job;
  }

  /**
   * Clears in-memory `RegionCache` entries and repaints active overlays after
   * document-wide auto-cache invalidation while keeping manual overrides intact.
   */
  refreshDocumentAfterAutoInvalidation() {
    if (this.destroyed) return;
    this.identityPromises.clear();
    this.regionCache?.invalidateDocument?.(this.cacheKey());
    this.detachAll();
    if (!this.enabled) return;
    if (!this.isForeground()) {
      this.workPausedInBackground = true;
      this.paintOnSelectPending = true;
      return;
    }
    void this.repaintAttached();
    this.scheduleSettledCheck();
  }

  /**
   * How many overlay canvases are mounted *in the live DOM*. A canvas the viewer
   * threw out with an old page div is not counted: counting it is what let a hidden
   * document's stale mount mask a missing repaint on the visible one.
   *
   * @returns {number} How many pages currently carry overlay canvases.
   */
  overlayCount() {
    let count = 0;
    for (const overlay of this.overlays.values()) {
      count += overlay.connectedCount ?? overlay.canvasCount;
    }
    return count;
  }

  /** Unsubscribes everything and removes every canvas this session made. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.editor?.destroy();
    } catch (err) {
      warnOnce("destroy-editor", err);
    }
    for (const overlay of [...this.overlays.values()]) {
      try {
        overlay.destroy();
      } catch (err) {
        warnOnce("destroy-overlay", err);
      }
    }
    this.overlays.clear();
    try {
      this.zoom?.destroy();
    } catch (err) {
      warnOnce("zoom-destroy", err);
    }
    this.zoom = null;
    if (this.documentCheckTimer !== null) {
      clearTimeout(this.documentCheckTimer);
      this.documentCheckTimer = null;
    }
    if (this.settledCheckTimer !== null) {
      clearTimeout(this.settledCheckTimer);
      this.settledCheckTimer = null;
    }
    for (const timer of this.timers) {
      try {
        clearTimeout(timer);
      } catch (ignored) {
        // Timer already gone.
      }
    }
    this.timers.clear();
    // A pending readiness wait must settle, otherwise start() keeps the session
    // pinned forever. Resolve, never reject: the caller already checks destroyed.
    for (const wake of [...this.readyWakes]) {
      try {
        wake();
      } catch (ignored) {
        // A resolver that was already called does not matter.
      }
    }
    this.readyWakes.clear();
    unsubscribe(this.eventBus, this.loadEventNames, this.onDocumentEvent, this.tag);
    unsubscribe(this.eventBus, this.renderEventNames, this.onPageRenderedEvent, this.tag);
    this.loadEventNames = [];
    this.renderEventNames = [];
    if (this.visHandler && this.visChangeTarget) {
      try {
        this.visChangeTarget.removeEventListener?.("visibilitychange", this.visHandler);
      } catch (ignored) {
        // The realm document is already gone.
      }
      this.visChangeTarget = null;
    }
    if (this.visHandler && this.outerVisTarget) {
      try {
        this.outerVisTarget.removeEventListener?.("visibilitychange", this.visHandler);
      } catch (ignored) {
        // The outer reader document is already gone.
      }
      this.outerVisTarget = null;
    }
    this.pending.clear();
    this.listeners.clear();
    this.identityPromises.clear();
    this.persistentStore = null;
    this.reader = null;
    this.regionCache = null;
  }
}
