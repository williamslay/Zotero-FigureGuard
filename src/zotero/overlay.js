/**
 * DOM overlay layer. No Zotero API is used here: everything comes from the
 * pdf.js viewer realm (pageView, canvas, document) and the framework-free core.
 *
 * For one pdf.js page view this module
 *   - runs detection once per (document, page) through the shared RegionCache,
 *   - turns every accepted region into a CSS box plus a raster buffer through
 *     core/viewport.js overlayGeometry(),
 *   - paints that box with core/render.js renderRegion(), which renders the
 *     page into its own canvas with a translate transform.
 *
 * Original colours: the render context gets `skipBlender = true` before
 * PDFPageProxy.render() runs. Zotero's forked pdf.js recolours the canvas in a
 * post-render "blender" step unless the flag is set; plain pdf.js ignores the
 * unknown property, so it is harmless on Zotero 7.
 *
 * Since v0.1.15 the render call itself normally runs inside the viewer realm
 * (realm-render.js), because iterating a sandbox-side parameter array there is
 * refused; `paintPath` records which of the two routes a pass took.
 */

import { detectPageRegions } from "../core/index.js";
import { resolveEffectiveRegions, serializeAutoRegions } from "../core/region-overrides.js";
import { overlayGeometry } from "../core/viewport.js";
import { renderRegion } from "../core/render.js";
import { ensureRenderHelper, renderRegionViaHelper } from "./realm-render.js";
import { localPDFPage, localViewport } from "./xray.js";

/** Extra padding around a region, in CSS pixels. */
export const PAD_VIEWPORT = 1.6;

/** Simple stacking: above the page canvas (1), below the text layer (2) work. */
export const OVERLAY_Z_INDEX = 3;

/** Class name used to recognise our own canvases, for cleanup and debugging. */
export const OVERLAY_CLASS = "fg-overlay";

/** Marks the canvas of a page whose raster could not be painted. */
export const ERROR_CLASS = "fg-error";

const warnedSites = new Set();
/** Ring of recent warnings, readable from Run JavaScript. */
const warnLog = [];

/**
 * A copy of the recent warnings, oldest first.
 *
 * @returns {string[]}
 */
export function getWarnLog() {
  return warnLog.slice();
}

/**
 * The first stack frame of an error, formatted for the ring buffer.
 *
 * Gecko frames read `name@file:line:column` and V8 frames read `at name
 * (file:line:column)`; the leading `name: message` line is skipped so the entry
 * still names the throw site instead of repeating the message.
 *
 * @param {*} err The caught error.
 * @returns {string} ` @ <frame>`, or an empty string when no frame is usable.
 */
function firstStackFrame(err) {
  try {
    const stack = typeof err?.stack === "string" ? err.stack : "";
    if (!stack) return "";
    const lines = stack.split("\n");
    for (const line of lines) {
      const frame = line.trim();
      if (!frame) continue;
      const looksLikeFrame = frame.includes("@") || frame.startsWith("at ");
      if (!looksLikeFrame) continue;
      return ` @ ${frame.replace(/^at\s+/, "")}`;
    }
    return "";
  } catch (ignored) {
    // A broken stack must not break logging.
    return "";
  }
}

/**
 * Logs once per site so a broken reader cannot flood the console.
 *
 * @param {string} site Stable site label.
 * @param {*} err The caught error.
 * @param {*} [detail] Extra context, appended when it is not a string.
 * @returns {boolean} True when this call produced the log.
 */
export function warnOnce(site, err, detail) {
  const key = typeof detail === "string" ? `${site}:${detail}` : site;
  if (warnedSites.has(key)) return false;
  warnedSites.add(key);
  warnLog.push(`${key}: ${err?.message ?? err}${firstStackFrame(err)}`);
  if (warnLog.length > 30) warnLog.shift();
  try {
    console.warn("[figure-color]", err);
  } catch (ignored) {
    // A missing console must not break PDF viewing.
  }
  // The bootstrap sandbox may not expose a usable console at all, so mirror
  // into Zotero's own logger: visible under 帮助 → 调试日志 → 查看输出日志.
  try {
    if (typeof Zotero !== "undefined" && Zotero?.debug) {
      Zotero.debug("[figure-color] " + key + ": " + (err?.message ?? err));
    }
  } catch (ignored) {
    // Logging must never break the reader.
  }
  return true;
}

/** Clears the once-per-site log memory. Used by tests and full teardown. */
export function resetWarnOnce() {
  warnedSites.clear();
  warnLog.length = 0;
}

const documentIds = new WeakMap();
let documentIdCounter = 0;

/**
 * A stable id for one loaded pdf.js document, used as the RegionCache key.
 *
 * The pdf.js fingerprint and loading-task doc id are preferred; when neither is
 * reachable the pdfDocument object itself becomes the identity.
 *
 * @param {object|null} pdfDocument A pdf.js `PDFDocumentProxy`.
 * @returns {string|null}
 */
export function resolveDocumentId(pdfDocument) {
  if (!pdfDocument) return null;
  try {
    const printed =
      pdfDocument.fingerprints?.[0] ?? pdfDocument.loadingTask?.docId ?? pdfDocument._pdfDocument?.docId;
    if (typeof printed === "string" && printed) return `fcp:${printed}`;
  } catch (err) {
    warnOnce("document-id", err);
  }
  let id = documentIds.get(pdfDocument);
  if (!id) {
    documentIdCounter += 1;
    id = `fcp:doc-${documentIdCounter}`;
    try {
      documentIds.set(pdfDocument, id);
    } catch (err) {
      warnOnce("document-id-weakmap", err);
    }
  }
  return id;
}

/** Matches the ids `resolveDocumentId()` mints from the WeakMap fallback. */
const PROVISIONAL_DOCUMENT_ID = /^fcp:doc-\d+$/;

/**
 * True when a document key came from the WeakMap fallback rather than from a
 * printed pdf.js identity (fingerprint or loading-task doc id).
 *
 * Such a key is provisional: when Xrays hide both printed fields the fallback
 * re-mints a fresh `fcp:doc-N` for every read that hands back a new wrapper
 * object, so the string says nothing about which document is loaded. The session
 * uses this to tell a real document swap from the key churning underneath it.
 *
 * @param {string|null|undefined} documentId Key produced by `resolveDocumentId()`.
 * @returns {boolean}
 */
export function isProvisionalDocumentId(documentId) {
  return typeof documentId === "string" && PROVISIONAL_DOCUMENT_ID.test(documentId);
}

/**
 * Whether an overlay canvas is part of the live document tree.
 *
 * The viewer replaces `pageView.div` on a relayout, a toolbar toggle and a tab
 * switch, and the overlay canvas mounted inside the old div leaves the document
 * with it: the record still lists the canvas, so `canvasCount` reports the page as
 * painted while the visible page shows nothing. A canvas stand-in without
 * `isConnected` counts as connected, because a harness that does not model the DOM
 * tree must not look detached.
 *
 * @param {object|null} canvas Overlay canvas this plugin created.
 * @param {object|null} host The page view's own div, the mount target.
 * @returns {boolean}
 */
export function canvasConnected(canvas, host) {
  if (typeof canvas?.isConnected === "boolean") return canvas.isConnected;
  if (typeof host?.isConnected === "boolean") return host.isConnected;
  return true;
}

/** Counter behind `realmStamp()`: one number per window that asked for an id. */
let realmCounter = 0;

/**
 * The stamp identifying one viewer realm, minted once per window.
 *
 * At startup the bridge hands a reader the *other* reader's `PDFViewerApplication`
 * while its own realm is still unresolvable, so the session latches a realm it
 * does not own and a document id that belongs to the other tab. A printed realm
 * fingerprint says which file both windows show, not which window is which, and
 * `Components.utils.unwrap(window)` can answer with a wrapper whose identity the
 * sandbox cannot compare. This stamp is stamped onto the window object the first
 * time a canvas or a probe asks for it, so the same window keeps the same id for
 * the whole run and two realms can be told apart in `probeAll` and on the canvas
 * itself.
 *
 * @param {object|null} win A viewer realm window.
 * @returns {string|null} The realm id, or null when the window cannot be stamped.
 */
export function realmStamp(win) {
  if (!win || (typeof win !== "object" && typeof win !== "function")) return null;
  try {
    const existing = win.__fcpRealm;
    if (typeof existing === "string" && existing) return existing;
    realmCounter += 1;
    const stamp = `r${realmCounter}`;
    win.__fcpRealm = stamp;
    return stamp;
  } catch (err) {
    warnOnce("realm-stamp", err);
    return null;
  }
}

/**
 * The realm a page view belongs to: its own document's window when the DOM tree
 * says so, the overlay's latched realm otherwise.
 *
 * The DOM answer outranks the latched one, because the latched realm is the value
 * the whole bug is about: a session can hold the other reader's window while its
 * page views belong to this one.
 *
 * @param {object|null} pageView A pdf.js page view.
 * @param {object|null} fallback The session's inner window.
 * @returns {object|null}
 */
function canvasRealmWin(pageView, fallback) {
  try {
    const view = pageView?.div?.ownerDocument?.defaultView ?? null;
    if (view) return view;
  } catch (ignored) {
    // An unreadable owner document falls back to the latched realm.
  }
  return fallback ?? null;
}

/**
 * Writes the realm and document provenance onto one overlay canvas.
 *
 * A displaced canvas is only explainable afterwards if it carries the two ids it
 * was painted for: which realm handed it out and which document's regions it
 * shows. The realm stamp is rewritten when it differs, so a canvas rebound to
 * another realm tells where it paints now; a stale realm stamp on a canvas that
 * still shows the old document is exactly the cross-tab displacement symptom,
 * and keeping it would hide which pass went wrong. The document id stays
 * written once: it names the document the regions were parsed from, and the
 * rebind that changes it drops the canvas anyway. A canvas stand-in with no
 * `dataset` (a test harness) is skipped instead of throwing.
 *
 * @param {object|null} canvas An overlay canvas.
 * @param {string|null} realmId From `realmStamp()`.
 * @param {string|null} docId The session's raw document key, not the scoped cache key.
 */
function stampCanvas(canvas, realmId, docId) {
  try {
    const dataset = canvas?.dataset;
    if (!dataset) return;
    if (realmId && dataset.fcpRealm !== realmId) dataset.fcpRealm = realmId;
    if (docId && !dataset.fcpDoc) dataset.fcpDoc = String(docId);
  } catch (ignored) {
    // A read-only dataset must not fail the paint.
  }
}

/**
 * A viewport field as a finite number, or null when it is missing or not one.
 *
 * The value crosses the reader realm, so even the `Number()` conversion can
 * throw on a hostile wrapper; a throw is the same "unreadable" as NaN here.
 *
 * @param {*} value Raw viewport field value.
 * @returns {number|null}
 */
function finiteOrNull(value) {
  try {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (ignored) {
    // Unreadable across the realm: null, same as a non-finite value.
    return null;
  }
}

/**
 * Viewport difference below which a change is sub-pixel rounding rather than
 * an actual move, in viewport units.
 */
const GEOMETRY_TOLERANCE = 0.01;

/**
 * True when a viewport field painted into the canvases differs from the page's
 * current one.
 *
 * Two finite numbers differ only past `GEOMETRY_TOLERANCE`; one finite side
 * against one unreadable side counts as a move, because the paint cannot have
 * used geometry the page no longer reports. Two unreadable sides are equal:
 * nothing new was learned.
 *
 * @param {number|null} painted The value `lastPaintGeometry` recorded.
 * @param {number|null} current The value the page view reports now.
 * @returns {boolean}
 */
function viewportFieldMoved(painted, current) {
  if (painted === null && current === null) return false;
  if (painted === null || current === null) return true;
  return Math.abs(painted - current) > GEOMETRY_TOLERANCE;
}

function deviceScaleOf(innerWin) {
  try {
    const scale = innerWin?.devicePixelRatio;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  } catch (err) {
    warnOnce("device-pixel-ratio", err);
    return 1;
  }
}

/**
 * Builds the factory for objects handed to pdf.js.
 *
 * pdf.js destructures its render parameters inside the reader realm, and a
 * sandbox plain object can arrive there with its own properties unreadable
 * (`can't access property "canvas", canvasContext is undefined`), so the
 * parameter objects are minted with the realm's own `Object`. The property
 * writes then happen sandbox-side onto a realm-native object, the direction
 * the wrapper is known to carry.
 *
 * @param {object} innerWin The pdf.js viewer realm.
 * @returns {() => object}
 */
function realmParamsFactory(innerWin) {
  try {
    if (typeof innerWin?.Object === "function") return () => new innerWin.Object();
  } catch (err) {
    warnOnce("realm-object", err);
  }
  return () => ({});
}

/**
 * Keeps the canvas list of one page in sync with the region list: canvases are
 * reused, added or removed so a zoom burst does not thrash the DOM.
 */
function syncCanvases(canvases, count, innerDoc, provenance = null) {
  while (canvases.length > count) {
    const canvas = canvases.pop();
    try {
      canvas.parentNode?.removeChild(canvas);
    } catch (err) {
      warnOnce("remove-canvas", err);
    }
  }
  while (canvases.length < count) {
    const canvas = innerDoc.createElement("canvas");
    canvas.className = OVERLAY_CLASS;
    // Positioned from the geometry below; never takes part in hit testing, so
    // text selection and annotation tools keep working on top of the overlay.
    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = String(OVERLAY_Z_INDEX);
    // Provenance at creation: the canvas has no parent node yet, so the ids come
    // from the pass that asked for it — the realm whose document handed out the
    // canvas, and the document whose regions it will paint.
    if (provenance) stampCanvas(canvas, provenance.realmId, provenance.docId);
    canvases.push(canvas);
  }
  return canvases;
}

/**
 * Compresses the detector's `sourceKinds` into one probe label: "path" when
 * vector art contributed, "xobject" for image/form placements, "struct" for
 * tagged structure. A region built from both carries both, e.g. "xobject+path",
 * so a probe answer says which evidence painted the box.
 *
 * @param {string[]|string|null|undefined} sourceKinds
 * @returns {string|null} Null when nothing is known about the region.
 */
export function regionKindLabel(sourceKinds) {
  const kinds = Array.isArray(sourceKinds) ? sourceKinds : sourceKinds ? [sourceKinds] : [];
  if (!kinds.length) return null;
  const parts = [];
  if (kinds.includes("path")) parts.push("path");
  if (kinds.some((kind) => kind === "image" || kind === "form" || kind === "multi")) {
    parts.push("xobject");
  }
  if (kinds.includes("struct")) parts.push("struct");
  if (kinds.includes("manual")) parts.push("manual");
  return parts.length ? parts.join("+") : "unknown";
}

/**
 * One overlay group for one pdf.js page view.
 */
export class PageOverlay {
  /**
   * @param {object} input
   * @param {object} input.pageView A pdf.js page view with `.div` and `.viewport`.
   * @param {object} input.innerWin The pdf.js viewer realm (for createElement).
   * @param {string} input.documentId RegionCache document key.
   * @param {object} input.regionCache Shared `RegionCache` from core/cache.js.
   * @param {() => object|undefined} [input.resolveOPS] Returns the realm's `OPS`
   *   table, or undefined so the core falls back to MEASURED_OP_CODES.
   * @param {string} [input.tag] Reader label used for the one-time warnings.
   * @param {string|null} [input.docId] The session's raw document key, stamped onto
   *   every canvas this overlay creates. `documentId` above is the scoped cache key
   *   (`item:N|fcp:...`), which says nothing about the printed document identity a
   *   probe has to compare against the live document.
   * @param {number} [input.padViewport]
   * @param {object|null} [input.persistentStore] Optional per-attachment persistent store.
   * @param {(() => Promise<object|null>|object|null)|null} [input.resolveIdentity]
   */
  constructor({
    pageView,
    innerWin,
    documentId,
    regionCache,
    resolveOPS,
    tag = "",
    padViewport = PAD_VIEWPORT,
    docId = null,
    persistentStore = null,
    resolveIdentity = null,
  }) {
    this.pageView = pageView;
    this.innerWin = innerWin;
    this.documentId = documentId;
    /** @type {string|null} Raw document key for the canvas provenance stamp. */
    this.docId = docId ?? null;
    this.regionCache = regionCache;
    this.persistentStore = persistentStore ?? null;
    this.resolveIdentity = typeof resolveIdentity === "function" ? resolveIdentity : null;
    this.resolveOPS = typeof resolveOPS === "function" ? resolveOPS : () => undefined;
    this.tag = tag;
    this.padViewport = padViewport;
    /** Mints the render-parameter objects pdf.js will read (realm-native). */
    this.paramsFactory = realmParamsFactory(innerWin);
    /** @type {number} 1-based page number, from the pdf.js page view. */
    this.pageNumber = Number(pageView?.id) || 0;
    /** @type {HTMLCanvasElement[]} */
    this.canvases = [];
    /** @type {Array<Array<number>|null>} Region each canvas paints, for repositioning. */
    this.regionBoxes = [];
    /**
     * @type {Array<string|null>} What each canvas's region was detected from:
     *   "path" for vector art, "xobject" for image/form placements, "struct" for
     *   tagged structure. Null before detection and for regions that came in as
     *   bare rectangles.
     */
    this.regionKinds = [];
    /** @type {Array<{cancel: () => void}>} Live pdf.js render tasks. */
    this.tasks = [];
    /** @type {object|null} Diagnostics of the last detection for this page. */
    this.diagnostics = null;
    /**
     * @type {string|null} Short description of the last failed step for this
     *   page ("geometry: ..." or "render: ..."), so a plain white canvas can be
     *   told apart from a canvas whose pdf.js render task rejected.
     */
    this.lastPaintError = null;
    /**
     * @type {boolean} True when the last paint pass found its canvases outside the
     *   live document tree — the host div was replaced or the whole page view was
     *   thrown out. Pixels were written to a canvas nobody can see.
     */
    this.mountDetached = false;
    /**
     * @type {"helper"|"legacy"|null} Which render call painted the last pass:
     *   `helper` when the pdf.js viewer realm ran it (v0.1.15, the structural fix
     *   for `Permission denied to access property Symbol.iterator`), `legacy`
     *   when the realm helper was refused and `core/render.js` did the work.
     *   Null before the first pass.
     */
    this.paintPath = null;
    /**
     * @type {{viewportWidth: number|null, viewportHeight: number|null,
     *   viewportScale: number|null, viewportRotation: number|null,
     *   deviceScale: number, at: number}|null}
     * The viewport the last paint pass actually used. `geometryStale()` uses it
     * to tell whether the page geometry moved underneath the mounted canvases
     * after that pass, and `probeAll` compares these paint-time numbers with
     * the probe-time viewport to confirm or kill that diagnosis on the machine.
     * Null before the first paint.
     */
    this.lastPaintGeometry = null;
    /** @type {boolean} True once regions were detected and painted. */
    this.painted = false;
    /** @type {boolean} True when a render pass was cancelled mid-flight and needs resuming. */
    this.paintIncomplete = false;
    /** @type {Promise<*>|null} In-flight detect() promise, so concurrent callers share one parse. */
    this.detectPromise = null;
    /** @type {string|null} Document cache key the in-flight detectPromise belongs to. */
    this.detectDocumentId = null;
    /** @type {{promise: Promise<void>, pageView: object, documentId: string}|null} Active paint job for dedup. */
    this.inFlightPaint = null;
    /**
     * @type {number} Bumped on every cancel(), so a rejected render task can
     * tell whether its own paint pass is still the current one.
     */
    this.generation = 0;
    this.destroyed = false;
  }

  /** @returns {number} How many overlay canvases are mounted. */
  get canvasCount() {
    return this.canvases.length;
  }

  /**
   * How many mounted canvases are still in the live document tree. The session
   * counts these, because a canvas the viewer threw out with an old `pageView.div`
   * is painted but invisible.
   *
   * @returns {number}
   */
  get connectedCount() {
    let count = 0;
    for (const canvas of this.canvases) {
      if (canvasConnected(canvas, this.pageView?.div)) count += 1;
    }
    return count;
  }

  /**
   * Whether this overlay's canvases are still mounted in the live DOM, so a paint
   * into them would actually be visible.
   *
   * @returns {boolean}
   */
  isMounted() {
    if (this.canvases.length === 0) return true;
    return this.connectedCount === this.canvases.length;
  }

  /**
   * Detects (once per document and page) then paints every accepted region.
   *
   * @returns {Promise<{regions: Array<object>, diagnostics: object|null}|null>}
   *   Null when the page cannot be painted yet.
   */
  async paint() {
    const detected = await this.detect();
    if (!detected || this.destroyed) return null;
    await this.paintRegions(detected.regions);
    return detected;
  }

  /**
   * True when this overlay still needs detection or painting for `pageView` and
   * `documentId` (not yet painted, cancelled mid-pass, detached, moved, or errored).
   *
   * @param {{pageView: object, documentId: string}} expected
   * @returns {boolean}
   */
  needsPaint({ pageView, documentId }) {
    if (this.destroyed) return false;
    if (!this.painted || this.paintIncomplete || this.lastPaintError) return true;
    if (this.pageView !== pageView || this.documentId !== documentId) return true;
    if (typeof this.isMounted === "function" && !this.isMounted()) return true;
    if (typeof this.geometryStale === "function" && this.geometryStale()) return true;
    return false;
  }

  /**
   * Runs detection, reusing the shared per-page cache result and deduplicating
   * concurrent in-flight detections for the same document key.
   *
   * @returns {Promise<{regions: Array<object>, diagnostics: object|null}|null>}
   */
  async detect() {
    const pdfPage = this.pageView?.pdfPage;
    if (!pdfPage) return null;
    if (!this.painted) {
      const cached = this.regionCache.get(this.documentId, this.pageNumber);
      if (cached && !this.persistentStore) {
        this.regionBoxes = cached.regions.map((region) => region.rect);
        this.regionKinds = cached.regions.map((region) => regionKindLabel(region.sourceKinds));
        this.diagnostics = cached.diagnostics ?? null;
        this.painted = true;
      } else {
        const docKey = this.documentId;
        if (this.detectPromise && this.detectDocumentId === docKey) {
          return this.detectPromise;
        }
        const applyDetected = (regions, diagnostics) => {
          this.regionBoxes = regions.map((region) => region.rect);
          this.regionKinds = regions.map((region) => regionKindLabel(region.sourceKinds));
          this.diagnostics = diagnostics ?? null;
          this.painted = true;
          return { regions: this.regionBoxes, regionKinds: this.regionKinds, diagnostics: this.diagnostics };
        };
        const run = (async () => {
          const identity = this.resolveIdentity ? await this.resolveIdentity() : null;
          if (this.destroyed || this.documentId !== docKey) return null;

          const memCached = this.regionCache.get(docKey, this.pageNumber);
          if (memCached) {
            if (!identity || !this.persistentStore) {
              return applyDetected(memCached.regions, memCached.diagnostics);
            }
            const versions = this.persistentStore.getVersionsSync(identity);
            const autoEpochMatches =
              memCached.autoEpoch == null || versions == null || memCached.autoEpoch === versions.autoEpoch;
            if (autoEpochMatches && memCached.autoRegions === undefined) {
              return applyDetected(memCached.regions, memCached.diagnostics);
            }
            if (
              autoEpochMatches &&
              memCached.autoRegions !== undefined &&
              versions &&
              memCached.overrideVersion === versions.overrideVersion
            ) {
              return applyDetected(memCached.regions, memCached.diagnostics);
            }
            if (autoEpochMatches && memCached.autoRegions !== undefined) {
              const diskCheck = await this.persistentStore.getPageAutoCache(identity, this.pageNumber);
              if (this.destroyed || this.documentId !== docKey) return null;
              if (memCached.autoEpoch == null || diskCheck.autoEpoch === memCached.autoEpoch) {
                const resolved = resolveEffectiveRegions(memCached.autoRegions, diskCheck.overrides);
                this.regionCache.set(docKey, this.pageNumber, {
                  regions: resolved.regions,
                  autoRegions: memCached.autoRegions,
                  diagnostics: memCached.diagnostics ?? null,
                  overrideVersion: diskCheck.overrideVersion,
                  autoEpoch: diskCheck.autoEpoch,
                });
                return applyDetected(resolved.regions, memCached.diagnostics);
              }
            }
          }

          const token = this.regionCache.begin(docKey, this.pageNumber);
          if (identity && this.persistentStore) {
            const disk = await this.persistentStore.getPageAutoCache(identity, this.pageNumber);
            if (this.destroyed || !this.regionCache.isCurrent(token) || this.documentId !== docKey) return null;
            if (disk?.hit) {
              const autoRegions = disk.regions;
              const resolved = resolveEffectiveRegions(autoRegions, disk.overrides);
              const diagnostics = {
                cacheSource: "persistent",
                detectorRevision: disk.detectorRevision,
                autoRegionCount: autoRegions.length,
                effectiveRegionCount: resolved.regions.length,
                unresolvedOverrides: resolved.unresolvedOverrides.length,
              };
              this.regionCache.set(docKey, this.pageNumber, {
                regions: resolved.regions,
                autoRegions,
                diagnostics,
                overrideVersion: disk.overrideVersion,
                autoEpoch: disk.autoEpoch,
              });
              return applyDetected(resolved.regions, diagnostics);
            }
          }

          const autoEpochBefore =
            identity && this.persistentStore ? this.persistentStore.getAutoEpoch(identity) : null;
          const result = await detectPageRegions({
            // Detection reads the page data out of the reader realm, so it gets a
            // local copy: TypedArray element access through an Xray wrapper throws.
            pdfPage: localPDFPage(pdfPage),
            // undefined keeps the core on its validated MEASURED_OP_CODES table.
            OPS: this.resolveOPS() ?? undefined,
          });
          if (this.destroyed || !this.regionCache.isCurrent(token) || this.documentId !== docKey) return null;

          const rawRegions = result?.regions ?? [];
          const autoRegions = serializeAutoRegions(rawRegions);
          let effectiveRegions = this.persistentStore ? autoRegions : rawRegions;
          let overrideVersion = 0;
          let autoEpoch = autoEpochBefore ?? 0;

          if (identity && this.persistentStore) {
            const saved = await this.persistentStore.savePageAutoCache(
              identity,
              this.pageNumber,
              autoRegions,
              { expectedAutoEpoch: autoEpochBefore },
            );
            if (this.destroyed || !this.regionCache.isCurrent(token) || this.documentId !== docKey) return null;
            if (saved?.reason === "stale-auto-epoch") return null;
            const resolved = resolveEffectiveRegions(autoRegions, saved?.overrides ?? []);
            effectiveRegions = resolved.regions;
            overrideVersion = saved?.overrideVersion ?? overrideVersion;
            autoEpoch = saved?.autoEpoch ?? autoEpoch;
          }

          const diagnostics = result?.diagnostics ?? null;
          this.regionCache.set(docKey, this.pageNumber, {
            regions: effectiveRegions,
            ...(this.persistentStore ? { autoRegions, overrideVersion, autoEpoch } : {}),
            diagnostics,
          });
          return applyDetected(effectiveRegions, diagnostics);
        })();
        this.detectPromise = run;
        this.detectDocumentId = docKey;
        try {
          return await run;
        } finally {
          if (this.detectPromise === run) {
            this.detectPromise = null;
            this.detectDocumentId = null;
          }
        }
      }
    }
    return { regions: this.regionBoxes, regionKinds: this.regionKinds, diagnostics: this.diagnostics };
  }

  /**
   * Positions and re-renders the canvases for the given user-space regions,
   * using the page view's current viewport. Safe to call again after a zoom or
   * rotation change.
   *
   * @param {Array<number[]|{rect: number[]}>} regions
   * @returns {Promise<void>}
   */
  async paintRegions(regions) {
    if (this.destroyed) return;
    const pageView = this.pageView;
    const pdfPage = pageView?.pdfPage;
    // Copied out of the reader realm: `convertToViewportPoint` results and the
    // `transform` fallback are indexed here, and a TypedArray over Xrays throws.
    const viewport = localViewport(pageView?.viewport);
    const innerDoc = this.innerWin?.document;
    if (!pdfPage || !viewport || !innerDoc) return;

    const list = Array.isArray(regions) ? regions : [];
    const deviceScale = deviceScaleOf(this.innerWin);
    // The viewport this pass actually paints against, taken from the same read
    // the geometry below uses. `geometryStale()` later compares it with the
    // page view's viewport: when the viewer relayouts or re-zooms after this
    // pass, the mounted canvases keep the paint-time box and the whole page
    // overlay shifts together until something re-paints.
    this.lastPaintGeometry = {
      viewportWidth: finiteOrNull(viewport.width),
      viewportHeight: finiteOrNull(viewport.height),
      viewportScale: finiteOrNull(viewport.scale),
      viewportRotation: finiteOrNull(viewport.rotation),
      deviceScale,
      at: Date.now(),
    };
    this.lastPaintError = null;
    this.paintIncomplete = false;
    this.cancel();
    // Taken after cancel(), so it identifies this pass: any later cancel()
    // changes it and marks this pass as superseded.
    const generation = this.generation;
    // The two ids every canvas this pass touches carries: which realm handed the
    // canvases out, and which document's regions they paint. The realm is taken
    // from the page view's own window when the DOM tree reports one, so a session
    // latched onto the other reader's realm still stamps the canvas with the
    // realm that actually owns the page.
    const provenance = { realmId: realmStamp(canvasRealmWin(pageView, this.innerWin)), docId: this.docId };
    syncCanvases(this.canvases, list.length, innerDoc, provenance);
    const hostPositioned = this.ensureHostPositioning();
    // Set again below when a region canvas refused to go back into the live DOM.
    this.mountDetached = false;

    this.regionBoxes = list.map((region) => (Array.isArray(region) ? region : region?.rect) ?? null);
    const freshKinds = list.map((region) => regionKindLabel(region?.sourceKinds));
    this.regionKinds = freshKinds.some((kind) => kind !== null)
      ? freshKinds
      : Array.from({ length: list.length }, (_, index) => this.regionKinds[index] ?? null);
    // Resolved once per pass, cached per realm window afterwards. Null here means
    // the realm refused the helper (no `eval`, a Content-Security-Policy, or an
    // Xray that hides the expando), so the regions go the legacy route below.
    const helper = ensureRenderHelper(this.innerWin, this.tag);
    const rotation = viewport.rotation ?? 0;
    // Counts the regions of this pass whose canvas is not in the live DOM.
    let mountDetached = false;
    const pushTask = (task) => this.tasks.push({ task, cancel: () => this.cancelTask(task) });
    for (let index = 0; index < list.length; index += 1) {
      const canvas = this.canvases[index];
      const region = this.regionBoxes[index];
      if (!canvas || !region) continue;
      stampCanvas(canvas, provenance.realmId, provenance.docId);
      if (!canvasConnected(canvas, pageView.div)) {
        // Either the canvas was never appended or the viewer replaced the page div
        // underneath this overlay; in both cases the visible page has no canvas.
        try {
          pageView.div?.appendChild(canvas);
        } catch (err) {
          warnOnce("mount-canvas", err);
          continue;
        }
        if (!canvasConnected(canvas, pageView.div)) mountDetached = true;
      }
      let geometry;
      try {
        geometry = overlayGeometry({ region, viewport, padViewport: this.padViewport, deviceScale });
      } catch (err) {
        warnOnce("overlay-geometry", err);
        this.lastPaintError = `geometry: ${err?.message ?? String(err)}`;
        canvas.classList.add(ERROR_CLASS);
        continue;
      }
      canvas.style.left = `${geometry.left}px`;
      canvas.style.top = `${geometry.top}px`;
      canvas.style.width = `${geometry.width}px`;
      canvas.style.height = `${geometry.height}px`;
      canvas.classList.remove(ERROR_CLASS);
      try {
        canvas.style.visibility = "visible";
      } catch (ignored) {
        // Ignore a read-only style; the canvas keeps whatever it had.
      }

      // One region at a time, awaited: pdf.js takes a single render task per
      // page, so kicking off the next region before this task settles used to
      // trip the v0.1.9 "Rendering cancelled" trap.
      try {
        if (helper) {
          // Every value the render call touches is realm-native: the viewport,
          // the canvas context, the transform array and the parameter object are
          // built inside the viewer realm, so pdf.js never iterates a sandbox
          // array across the Xray boundary.
          this.paintPath = "helper";
          await renderRegionViaHelper(helper, {
            pdfPage,
            canvas,
            geometry,
            rotation,
            background: "#ffffff",
            onTask: pushTask,
          });
        } else {
          const context = canvas.getContext("2d");
          if (!context) continue;
          // Set before render() runs, so Zotero's recolour blender skips this
          // canvas. Only this path can write it: on the helper path the context
          // is created inside the realm, which sets the flag itself.
          try {
            context.skipBlender = true;
          } catch (ignored) {
            // Ignore read-only contexts; the raster is still painted.
          }
    this.paintPath = "legacy";
          await renderRegion({
            pdfPage,
            canvas,
            region,
            viewport,
            deviceScale,
            padViewport: this.padViewport,
            background: "#ffffff",
            paramsFactory: this.paramsFactory,
            onTask: pushTask,
          });
        }
      } catch (err) {
        // A cancelled or failed region must not break the rest of the page.
        warnOnce("render-region", err);
        // A pass that was cancelled, or a canvas the new pass dropped, must
        // not be stamped: that canvas is gone or belongs to another paint.
        // The reason is only recorded for the current pass, so a cancellation
        // from a zoom burst cannot overwrite the next paint's clean state.
        if (this.destroyed || generation !== this.generation) break;
        this.lastPaintError = `render: ${err?.message ?? String(err)}`;
        if (!this.canvases.includes(canvas)) continue;
        canvas.classList.add(ERROR_CLASS);
        // A canvas that never got a raster is a plain white block over the
        // figure, so hide it and let the reader's own (tinted) page show.
        try {
          canvas.style.visibility = "hidden";
        } catch (ignored) {
          // Ignore a read-only style; the class above still marks the canvas.
        }
      }
      // A cancel() from a zoom burst means the next paint owns the canvases.
      if (this.generation !== generation) break;
    }
    if (this.destroyed || this.generation !== generation) {
      this.paintIncomplete = true;
      return;
    }
    // Reported once the pass is over, for both render routes: pixels written into a
    // canvas that is not in the live DOM are invisible, which is what the real
    // machine showed for the document whose tab was switched to.
    this.mountDetached = mountDetached || !hostPositioned;
    if (this.mountDetached && !this.lastPaintError) {
      // A repaint of the same regions cannot heal this: the canvas has to be back in
      // the live DOM before pixels mean anything.
      this.lastPaintError = "mount: host detached";
    }
  }

  /**
   * True when the page view's viewport differs from the one the last paint
   * pass used, i.e. the page geometry moved underneath the mounted canvases.
   *
   * Why this exists: on the real machine the overlays align on first open but
   * sit displaced after the toolbar toggle goes off then on, with identical
   * cached regions. A paint that ran against a viewport the page no longer has
   * leaves every canvas of the page displaced by the same proportion, and
   * nothing else re-paints until the next zoom. This lets the session spot that
   * state once the viewer has settled.
   *
   * Every read crosses the reader realm, so a throw answers false: a probe
   * that cannot read must not trigger a repaint.
   *
   * @returns {boolean}
   */
  geometryStale() {
    if (this.destroyed) return false;
    const painted = this.lastPaintGeometry;
    if (!painted) return false;
    try {
      const raw = this.pageView?.viewport;
      if (!raw) return false;
      const viewport = localViewport(raw);
      if (!viewport) return false;
      if (viewportFieldMoved(painted.viewportWidth, finiteOrNull(viewport.width))) return true;
      if (viewportFieldMoved(painted.viewportHeight, finiteOrNull(viewport.height))) return true;
      if (viewportFieldMoved(painted.viewportScale, finiteOrNull(viewport.scale))) return true;
      if (viewportFieldMoved(painted.viewportRotation, finiteOrNull(viewport.rotation))) return true;
      return false;
    } catch (err) {
      warnOnce("geometry-stale", err, this.tag || undefined);
      return false;
    }
  }

  /**
   * Makes the host element a positioning context, because the overlay canvases
   * are absolutely positioned inside `pageView.div`. Reports whether that host is
   * still in the live document: a detached div accepts writes without showing them,
   * and `offsetParent` stays null — the shape the real machine shows for the
   * document whose tab is in the background.
   *
   * @returns {boolean} False when the host is out of the DOM or refused the write.
   */
  ensureHostPositioning() {
    const div = this.pageView?.div;
    if (!div?.style) return false;
    try {
      if (!div.style.position) div.style.position = "relative";
    } catch (err) {
      warnOnce("host-positioning", err);
      return false;
    }
    return div.isConnected !== false;
  }

  cancelTask(task) {
    try {
      task?.cancel?.();
    } catch (ignored) {
      // A task that is already finished has nothing to cancel.
    }
  }

  /** Cancels in-flight pdf.js render tasks. */
  cancel() {
    this.generation += 1;
    this.inFlightPaint = null;
    const tasks = this.tasks;
    this.tasks = [];
    for (const entry of tasks) {
      try {
        entry.cancel?.();
      } catch (ignored) {
        // Ignore, the raster is replaced anyway.
      }
    }
  }

  /** Removes every canvas of this page. Detection results stay cached. */
  clear() {
    this.cancel();
    while (this.canvases.length) {
      const canvas = this.canvases.pop();
      try {
        canvas.parentNode?.removeChild(canvas);
      } catch (err) {
        warnOnce("clear-canvas", err);
      }
    }
    this.regionBoxes = [];
    this.regionKinds = [];
    // Detection results live in the shared RegionCache, so dropping the local
    // copy means the next paint() has to run detection again. Keeping painted
    // true here would let a later paint() paint an empty region list forever.
    this.painted = false;
    this.paintIncomplete = false;
    this.detectPromise = null;
    this.detectDocumentId = null;
    this.inFlightPaint = null;
  }

  /** Drops all references so the page view can be released. */
  destroy() {
    this.clear();
    this.painted = false;
    this.destroyed = true;
    this.pageView = null;
    this.innerWin = null;
    this.regionCache = null;
    this.persistentStore = null;
    this.resolveIdentity = null;
  }
}
