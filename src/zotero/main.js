/**
 * Zotero integration entry point, bundled by esbuild as an IIFE published to
 * the sandbox global `FigureGuard`.
 *
 * Responsibilities:
 *   - register the single plugin-visible reader event ("renderToolbar"), which
 *     is where the toolbar toggle is mounted,
 *   - keep one ReaderSession per open reader,
 *   - own the shared RegionCache, so detection results survive toggling,
 *   - tear everything down on shutdown.
 *
 * Every Zotero access goes through a guard: an unexpected throw must never
 * break PDF viewing, it is logged once per site and the reader keeps working.
 */

import { CORE_VERSION, RegionCache } from "../core/index.js";
import { resetWarnOnce, warnOnce, getWarnLog, resolveDocumentId, realmStamp } from "./overlay.js";
import { probeOverlay } from "./paint-probe.js";
import {
  ReaderSession,
  chainProbe,
  resolvePDFViewer,
  unwrapViewerApplication,
  realmBelongsToReader,
  RECOVERY_INTERVAL_MS,
  RECOVERY_MAX_MS,
} from "./reader-session.js";

/** Extension id; must match manifest.json. */
export const PLUGIN_ID = "figure-guard@zotero.org";

/** The only Zotero reader event this plugin listens to. */
export const TOOLBAR_EVENT = "renderToolbar";

/** Firefox topics used to notice reader windows appearing or closing. */
export const WINDOW_TOPICS = ["domwindowopened", "domwindowclosed"];

/** Most reader sessions one `probeAll` report carries, so the JSON stays small. */
export const MAX_PROBE_SESSIONS = 8;

/** Longest `location.href` one `probeAll` entry carries, in characters. */
export const REALM_HREF_MAX = 120;

/** Button text and tooltip per UI locale: Chinese uses 原色, others use Original. */
export const BUTTON_TEXT_ZH = Object.freeze({
  label: "原色",
  title: "图表原色显示",
});
export const BUTTON_TEXT_EN = Object.freeze({
  label: "Original",
  title: "Show figures in original color",
});
export const BUTTON_LABEL = BUTTON_TEXT_ZH.label;
export const BUTTON_TITLE = BUTTON_TEXT_ZH.title;

/**
 * Returns true when a BCP 47 / POSIX locale tag denotes Chinese (`zh` or `zh-*`).
 *
 * @param {string|null|undefined} locale
 * @returns {boolean}
 */
export function isChineseLocale(locale) {
  if (typeof locale !== "string") return false;
  const normalized = locale.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "zh" || normalized.startsWith("zh-");
}

/**
 * Detects Zotero's active UI locale string, or null when unavailable.
 * Zotero and Gecko locale services take precedence over reader document
 * attributes so the toolbar label follows Zotero's UI language setting.
 *
 * @param {object|null} [doc]
 * @returns {string|null}
 */
export function resolveZoteroLocale(doc = null) {
  const read = (fn) => {
    try {
      const value = fn();
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  };
  return (
    read(() => globalThis.Zotero?.locale) ??
    read(() => globalThis.Services?.locale?.appLocaleAsBCP47) ??
    read(() => globalThis.Services?.locale?.appLocalesAsBCP47?.[0]) ??
    read(() => globalThis.Services?.locale?.requestedLocales?.[0]) ??
    read(() => globalThis.Zotero?.Prefs?.get?.("intl.locale.requested", true)) ??
    read(() => doc?.documentElement?.lang) ??
    read(() => doc?.documentElement?.getAttribute?.("lang")) ??
    read(() => doc?.defaultView?.navigator?.language) ??
    read(() => globalThis.navigator?.language) ??
    null
  );
}

/**
 * Resolves the toolbar toggle text and tooltip for the given locale or doc.
 * Chinese locales use "原色"; all other or unknown locales use "Original".
 *
 * @param {string|object|null} [localeOrDoc]
 * @returns {{label: string, title: string}}
 */
export function resolveButtonStrings(localeOrDoc = null) {
  const locale = typeof localeOrDoc === "string" ? localeOrDoc : resolveZoteroLocale(localeOrDoc);
  return isChineseLocale(locale) ? BUTTON_TEXT_ZH : BUTTON_TEXT_EN;
}

/** Class and style-node id for the toolbar toggle's injected stylesheet. */
const TOGGLE_CLASS = "fg-toggle";
const TOGGLE_STYLE_ID = "fg-toggle-style";

/**
 * Stylesheet for the toolbar toggle, injected once per toolbar document. The
 * on/off look keys off [aria-pressed], so the existing aria-pressed update is
 * all the state wiring the button needs. Colours are theme-neutral: translucent
 * greys read on both light and dark toolbars, and the on state is a solid
 * accent chip that stands out against either.
 */
const TOGGLE_CSS = `
.${TOGGLE_CLASS} {
  appearance: none;
  -moz-appearance: none;
  -moz-window-dragging: no-drag;
  display: inline-flex;
  align-items: center;
  margin-inline: 2px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  font: inherit;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  color: rgba(128, 128, 128, 0.85);
  background-color: rgba(128, 128, 128, 0.12);
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease,
    box-shadow 120ms ease;
}
.${TOGGLE_CLASS}:hover {
  background-color: rgba(128, 128, 128, 0.28);
}
.${TOGGLE_CLASS}:focus-visible {
  outline: 2px solid rgba(1, 121, 242, 0.9);
  outline-offset: 1px;
}
/*
 * The on state is the solid accent chip: grey text on a translucent grey wash
 * versus white on a filled blue chip reads clearly on light and dark toolbars
 * alike, with no decoration on the label itself.
 */
.${TOGGLE_CLASS}[aria-pressed="true"] {
  color: #ffffff;
  background-color: #0179f2;
  border-color: #0157ad;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.${TOGGLE_CLASS}[aria-pressed="true"]:hover {
  color: #ffffff;
  background-color: #2b8ef5;
}
.${TOGGLE_CLASS}[aria-pressed="true"]:active {
  background-color: #0166cc;
}
`;

// Module state lives in the bundle scope: one cache, one session per reader.
/** @type {RegionCache|null} */
let regionCache = null;
/** @type {Map<object, {session: ReaderSession, startPromise: Promise<any>|null, closeWatch: object|null}>} */
const sessions = new Map();
/** @type {Map<ReaderSession, {button: object, session: ReaderSession, doc: object, onPointerDown: (event: object) => void, onMouseUp: (event: object) => void, onClick: (event: object) => void, off: () => void, toolbarDoc: object|null, append: ((node: object) => void)|null, parent: object|null}>} The toolbar button currently mounted per session, with its delegated activation listeners on the toolbar document. */
const buttonLinks = new Map();
/** @type {Array<object|null>} Registered window observers. */
const observers = [];
/** @type {string[]} Registered Zotero.Reader event types. */
let registeredEventTypes = [];
/** Handle of the Zotero `tab` notifier, which is not a window observer. */
let zoteroNotifierId = null;
let started = false;
/**
 * The version the bootstrap reported at startup — the installed add-on version from
 * `manifest.json`. Empty until a startup supplied one, so `probeAll()` falls back to
 * the core version in a Run-JavaScript harness that calls `startup()` bare.
 * @type {string}
 */
let addonVersion = "";

/**
 * The `Zotero` global, if this realm has one.
 *
 * @returns {object|null}
 */
function getZotero() {
  try {
    if (globalThis.Zotero) return globalThis.Zotero;
  } catch (err) {
    warnOnce("zotero-global", err);
  }
  try {
    if (typeof Zotero !== "undefined") return Zotero;
  } catch (ignored) {
    // No Zotero in scope.
  }
  return null;
}

/**
 * Resolves an observer service. Zotero 7 and later expose `Services.observers`,
 * Firefox-style access is `Services.obs`; both are tried. Which one exists in a
 * given build is unverified, so the failure mode is "no window pruning".
 *
 * @returns {{svc: object, mode: "observers"|"obs"}|null}
 */
function observerService() {
  try {
    const services = globalThis.Services;
    if (services?.observers && typeof services.observers.addObserver === "function") {
      return { svc: services.observers, mode: "observers" };
    }
    if (services?.obs && typeof services.obs.addObserver === "function") {
      return { svc: services.obs, mode: "obs" };
    }
  } catch (err) {
    warnOnce("observer-service", err);
  }
  return null;
}

/**
 * Adds a topic observer without throwing.
 *
 * Both service shapes found in Zotero and Firefox builds implement
 * nsIObserverService, so the observer is an object with an `observe` method and
 * the argument order is always (observer, topic, data).
 *
 * @param {string} topic
 * @param {(subject: any, topic: string) => void} handler
 * @returns {object|null} Handle passed back to removeObserver().
 */
function addWindowObserver(topic, handler) {
  const found = observerService();
  if (!found) {
    warnOnce("observer-add", new Error("No observer service for window topics"), topic);
    return null;
  }
  // The service keeps a weak reference, so the handle below holds this object
  // for as long as the registration is live.
  const observer = {
    observe(subject, observedTopic, data) {
      handler(subject, observedTopic ?? topic, data);
    },
  };
  try {
    found.svc.addObserver(observer, topic, null);
    return { svc: found.svc, topic, observer };
  } catch (err) {
    warnOnce("observer-add", err, topic);
    return null;
  }
}

/**
 * Removes a window observer handle, mirroring the registration arguments.
 *
 * @param {object|null} handle
 */
function removeWindowObserver(handle) {
  if (!handle?.observer) return;
  try {
    handle.svc.removeObserver(handle.observer, handle.topic, null);
  } catch (err) {
    warnOnce("observer-remove", err, handle.topic);
  }
}

/** Shared window-topic handler. */
function onWindowEvent(subject, topic) {
  try {
    if (topic === "domwindowclosed") pruneSessions();
    else syncOpenReaders();
  } catch (err) {
    warnOnce("window-event", err, String(topic));
  }
}

/**
 * A short label for warnings, without touching any unverified Zotero field.
 *
 * @param {object} reader
 * @returns {string}
 */
function tagFor(reader) {
  try {
    return `item:${reader?.itemID ?? "?"}`;
  } catch (ignored) {
    return "reader";
  }
}

/**
 * Hit test for the delegated toolbar listeners: whether the press coordinates
 * fall inside `node`'s box. A rect of zero width or height never hits, because
 * every reader tab in the window owns a `.fg-toggle` and the toggles of the
 * hidden tabs report a zero-size rect.
 *
 * @param {object} node The element to test the press against.
 * @param {object} event The pointer or click event, for its client coordinates.
 * @returns {boolean} Whether the press landed inside a real, visible box.
 */
function pressInsideBox(node, event) {
  if (!node || !event) return false;
  const rect = node?.getBoundingClientRect?.();
  if (!rect) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

/**
 * Removes the session's current button from the toolbar: all delegated
 * activation listeners are unbound from the toolbar document, the node is taken
 * out of its parent, and the state listener is dropped, so repeated toolbar
 * renders do not pile up detached buttons and listeners.
 *
 * @param {ReaderSession} session
 * @returns {boolean} Whether a button was detached.
 */
function detachButton(session) {
  const link = buttonLinks.get(session);
  if (!link) return false;
  buttonLinks.delete(session);
  for (const [type, handler] of [
    ["pointerdown", link.onPointerDown],
    ["mouseup", link.onMouseUp],
    ["click", link.onClick],
  ]) {
    if (!handler) continue;
    try {
      link.doc?.removeEventListener?.(type, handler, true);
    } catch (ignored) {
      // The toolbar document is already gone; the next render binds its own set.
    }
  }
  try {
    const parent = link.button.parentNode;
    if (parent?.removeChild) parent.removeChild(link.button);
  } catch (ignored) {
    // Already unmounted, or the realm hides the parent; the next render appends
    // its own button either way.
  }
  try {
    link.off();
  } catch (ignored) {
    // Listener set already cleared.
  }
  return true;
}

/**
 * Puts a toggle back in the toolbar after the toolbar threw it away. The
 * real-machine symptom is a switch that still works — the delegated activation
 * listeners sit on the document, so a press aimed at the right place reaches the
 * session — while the node itself is gone and no further `renderToolbar` comes to
 * re-append it, which is why neither a tab switch nor a restart brought it back.
 *
 * A link is remounted only when its own node is out of the document and the
 * toolbar document holds no `.fg-toggle` at all, so a repair can never produce a
 * second switch. The node's recorded parent is used while that parent is still in
 * the document, because it restores the exact slot the toolbar had; a parent the
 * toolbar replaced falls back to the render's own `append` callback, which can
 * throw outside the render it came from. A link whose repair fails is logged and
 * left as it is: one hostile or half-built realm must not stop the other tabs.
 *
 * @returns {number} How many toggles this pass put back.
 */
/**
 * Mounts the toolbar toggle directly into an already-open reader's toolbar when
 * the add-on is installed or updated after `renderToolbar` has already fired.
 * Because `zotero/reader`'s toolbar `useEffect` only fires `renderToolbar` once
 * per opened document, `syncOpenReaders` and `maintainButtons` use this fallback
 * so live tabs get the switch immediately alongside their restored colors.
 *
 * @param {object} reader
 * @param {ReaderSession} session
 * @returns {boolean} Whether a button was mounted.
 */
function ensureButtonForOpenReader(reader, session) {
  if (!reader || !session || session.destroyed) return false;
  const existingLink = buttonLinks.get(session);
  if (existingLink?.button?.isConnected) return false;
  const doc = reader?._iframeWindow?.document ?? null;
  if (!doc?.createElement || typeof doc.querySelector !== "function") return false;
  const existingToggles = Array.from(doc.querySelectorAll?.(`.${TOGGLE_CLASS}`) ?? []);
  const liveOwned = new Set(Array.from(buttonLinks.values(), (l) => l.button));
  if (existingToggles.some((el) => liveOwned.has(el))) return false;
  const container =
    doc.querySelector(".toolbar .custom-sections") ??
    doc.querySelector(".custom-sections") ??
    doc.querySelector(".toolbar .end") ??
    doc.querySelector(".toolbar");
  if (!container?.appendChild) return false;
  for (const stale of existingToggles) {
    try {
      stale?.parentNode?.removeChild?.(stale);
    } catch (ignored) {}
  }
  const button = createButton(doc, session);
  container.appendChild(button);
  const link = buttonLinks.get(session);
  if (link) {
    link.toolbarDoc = doc;
    link.parent = button.parentNode ?? container;
  }
  return true;
}

export function maintainButtons() {
  let remounted = 0;
  for (const link of Array.from(buttonLinks.values())) {
    try {
      const node = link?.button;
      if (!node || node.isConnected !== false) continue;
      // Another of our switches is still on screen in this document: this session's
      // box belongs to a hidden reader tab, and appending would double the toolbar.
      if ((link.toolbarDoc?.querySelectorAll?.(`.${TOGGLE_CLASS}`)?.length ?? 0) > 0) continue;
      if (typeof link.parent?.appendChild === "function" && link.parent.isConnected) {
        link.parent.appendChild(node);
      } else if (typeof link.append === "function") {
        link.append(node);
      } else {
        warnOnce("button-reattach", new Error("toggle has neither a live parent nor an append callback"));
        continue;
      }
      remounted += 1;
    } catch (err) {
      warnOnce("button-reattach", err);
    }
  }
  for (const [reader, entry] of Array.from(sessions.entries())) {
    try {
      const session = entry?.session;
      if (!session || session.destroyed) continue;
      if (buttonLinks.has(session)) continue;
      if (ensureButtonForOpenReader(reader, session)) remounted += 1;
    } catch (err) {
      warnOnce("button-open-mount", err);
    }
  }
  return remounted;
}

/**
 * Injects TOGGLE_CSS into a toolbar document once. The style text is a plain
 * string, so creating the node in the reader realm carries no cross-realm risk.
 *
 * @param {object} doc The document of the toolbar realm.
 */
function ensureToggleStyles(doc) {
  try {
    const existing = typeof doc.getElementById === "function" ? doc.getElementById(TOGGLE_STYLE_ID) : null;
    if (existing) {
      existing.textContent = TOGGLE_CSS;
      return;
    }
    const head = doc.head ?? doc.querySelector?.("head") ?? doc.documentElement;
    if (!head) return;
    const style = doc.createElement("style");
    style.id = TOGGLE_STYLE_ID;
    style.textContent = TOGGLE_CSS;
    head.appendChild(style);
  } catch (ignored) {
    // Without the stylesheet the button still works, it just looks plain.
  }
}

/**
 * Creates the toolbar toggle for one reader and wires it to the session. Any
 * button from an earlier toolbar render of the same reader is detached first.
 *
 * The button is a plain text control: the short label names it, in the toolbar
 * and for assistive technology alike. The add-on icon belongs to the plug-in
 * list (the manifest `icons` entries), not to this button.
 *
 * @param {object} doc The document of the toolbar realm.
 * @param {ReaderSession} session
 * @returns {object} The button element.
 */
function createButton(doc, session) {
  detachButton(session);
  ensureToggleStyles(doc);
  const button = doc.createElement("button");
  const { label, title } = resolveButtonStrings(doc);
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.type = "button";
  button.className = TOGGLE_CLASS;
  // The Zotero toolbar is a React tree: pointer events are enabled locally so
  // the toggle stays clickable even when an overlay covers the toolbar area.
  button.style.pointerEvents = "auto";
  // Zotero's DIV.toolbar carries -moz-window-dragging: drag; without no-drag on
  // the chip, Windows treats a single press as a titlebar drag and drops the
  // DOM pointer/mouse events before they ever reach the button.
  try {
    button.style?.setProperty?.("-moz-window-dragging", "no-drag");
  } catch (ignored) {
    // TOGGLE_CSS also sets -moz-window-dragging: no-drag.
  }

  const applyState = () => {
    try {
      // The stylesheet maps [aria-pressed] onto the on/off look, so this
      // attribute is the only restyling the button needs.
      button.setAttribute("aria-pressed", String(Boolean(session.enabled)));
    } catch (ignored) {
      // A button that cannot restyle itself is still functional.
    }
  };
  // Activation is delegated to the toolbar document in the capture phase,
  // because the Zotero toolbar is a React tree: a press that first focuses the
  // window can re-render the toolbar and replace the node we appended, and then
  // the event is delivered to nodes we never hold. Each listener hit-tests the
  // press against the node we hold and, while our own node is out of the
  // document, against a re-rendered stand-in carrying our class, so one press
  // reaches the session however the toolbar rebuilt itself underneath it.
  //
  // Activation is a three-rung ladder — pointerdown, then mouseup, then click —
  // and one press sequence moves the session exactly once. Pointer presses act on
  // pointerdown, immediately and with no preventDefault, so the browser keeps its
  // normal focus behaviour. Mouseup and click carry cross-iframe releases
  // re-dispatched by Zotero's chrome layer, native button clicks, and keyboard
  // activation (detail === 0).
  //
  // The shared pressActivated flag keeps the rungs from stacking. Every primary
  // pointerdown clears it so a new sequence starts unfired. Acting on a
  // pointerdown or a mouseup raises it; a mouseup outside the toggle clears it so
  // dragging out cannot strand the next click; a click that finds it raised only
  // closes the sequence and lowers it again. A keyboard click ignores the flag.
  let pressActivated = false;

  /**
   * Both accepted shapes of a press on this toggle: the node we appended, or a
   * stand-in the toolbar re-rendered after throwing our node away. The stand-in
   * counts only while our own node is out of the document: every reader tab in
   * the window owns a `.fg-toggle` and shares this document, so a still-attached
   * node of ours means a press on a class-carrying box belongs to that other
   * tab's toggle, not to this session.
   *
   * @param {object} event
   * @returns {boolean}
   */
  const hitToggle = (event) => {
    if (pressInsideBox(button, event)) return true;
    if (button.isConnected) {
      return event?.target === button || Boolean(button.contains?.(event?.target));
    }
    const standIn = event?.target?.closest?.(`.${TOGGLE_CLASS}`) ?? null;
    if (!standIn || standIn === button) return false;
    return pressInsideBox(standIn, event);
  };

  const onPointerDown = (event) => {
    try {
      if (event?.button !== 0) return;
      pressActivated = false;
      if (!hitToggle(event)) return;
      pressActivated = true;
      session.toggle();
    } catch (err) {
      warnOnce("button-press", err);
    }
  };
  const onMouseUp = (event) => {
    try {
      if (event?.button !== 0) return;
      if (!hitToggle(event)) {
        pressActivated = false;
        return;
      }
      if (pressActivated) return;
      pressActivated = true;
      session.toggle();
    } catch (err) {
      warnOnce("button-release", err);
    }
  };
  const onClick = (event) => {
    try {
      if (!hitToggle(event)) return;
      const keyboard = event?.detail === 0;
      if (!keyboard && pressActivated) {
        pressActivated = false;
        return;
      }
      pressActivated = false;
      session.toggle();
    } catch (err) {
      warnOnce("button-click", err);
    }
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  doc.addEventListener("click", onClick, true);
  const off = session.addListener(applyState);
  applyState();
  buttonLinks.set(session, {
    button,
    session,
    doc,
    onPointerDown,
    onMouseUp,
    onClick,
    off,
    // Filled in by the render that appends this node, once the append returned:
    // the document this toolbar belongs to, the append callback it offered, and
    // the parent the node ended up under. They are what maintainButtons() needs to
    // put the switch back after the toolbar's own re-render clears it out.
    toolbarDoc: doc ?? null,
    append: null,
    parent: null,
  });
  return button;
}

/**
 * Returns the session of a reader, creating and starting it on first use.
 *
 * @param {object} reader
 * @returns {ReaderSession|null}
 */
function ensureSession(reader) {
  if (!reader || !regionCache) return null;
  const existing = sessions.get(reader);
  if (existing) return existing.session;
  let session;
  try {
    session = new ReaderSession({ reader, regionCache, tag: tagFor(reader), enabled });
  } catch (err) {
    warnOnce("session-ctor", err);
    return null;
  }
  const entry = { session, startPromise: null, closeWatch: null };
  sessions.set(reader, entry);
  session.addListener(() => {
    lastDiagnostics = collectDiagnostics();
  });
  watchReaderClose(reader, session, entry);
  // Starting waits for the pdf.js document, so it must not block the toolbar
  // handler, which has to append the button synchronously.
  entry.startPromise = session.start().catch((err) => {
    warnOnce("session-start", err);
  });
  return session;
}

/**
 * Watches the reader's outer iframe for teardown. `unload` is a DOM event; the
 * Zotero-level `zotero-reader-state` name is unverified and purely additive.
 *
 * @param {object} reader
 * @param {ReaderSession} session
 * @param {object} entry
 */
function watchReaderClose(reader, session, entry) {
  const win = (() => {
    try {
      return reader?._iframeWindow ?? null;
    } catch (err) {
      warnOnce("reader-window", err);
      return null;
    }
  })();
  if (!win?.addEventListener) return;
  const handler = () => {
    if (readerAlive(reader)) return;
    closeSession(session);
  };
  try {
    win.addEventListener("unload", handler, { once: true });
  } catch (err) {
    warnOnce("watch-unload", err);
  }
  try {
    win.addEventListener("zotero-reader-state", handler);
  } catch (err) {
    warnOnce("watch-reader-state", err);
  }
  entry.closeWatch = { win, handler };
}

/**
 * Whether a reader still has a live document in its outer iframe.
 *
 * @param {object} reader
 * @returns {boolean}
 */
function readerAlive(reader) {
  try {
    const win = reader?._iframeWindow;
    if (!win) return false;
    const doc = win.document;
    if (!doc) return false;
    return doc.readyState !== "unloaded";
  } catch (err) {
    warnOnce("reader-alive", err);
    return false;
  }
}

/**
 * Destroys one session and detaches its toolbar buttons.
 *
 * @param {ReaderSession} session
 */
function closeSession(session) {
  if (session.destroyed) return;
  detachButton(session);
  for (const [reader, entry] of [...sessions]) {
    if (entry.session === session) {
      if (entry.closeWatch) {
        // Both listeners of watchReaderClose have to go, otherwise the handler
        // keeps this session and its reader alive until the window unloads.
        for (const type of ["unload", "zotero-reader-state"]) {
          try {
            entry.closeWatch.win.removeEventListener(type, entry.closeWatch.handler);
          } catch (ignored) {
            // Window already torn down.
          }
        }
      }
      sessions.delete(reader);
    }
  }
  try {
    session.destroy();
  } catch (err) {
    warnOnce("session-destroy", err);
  }
  lastDiagnostics = collectDiagnostics();
}

/** Drops sessions whose reader window is gone. */
function pruneSessions() {
  for (const [reader, entry] of [...sessions]) {
    if (entry.session.destroyed || !readerAlive(reader)) {
      if (!entry.session.destroyed) closeSession(entry.session);
      else sessions.delete(reader);
    }
  }
}

/**
 * Creates sessions for readers that were already open when the extension was
 * started. `Zotero.Reader._readers` is an internal list (unverified), so the
 * whole pass is best effort; the toolbar button still appears on the next
 * toolbar render.
 */
function syncOpenReaders() {
  const zotero = getZotero();
  try {
    const windows = typeof zotero?.getMainWindows === "function" ? zotero.getMainWindows() ?? [] : [];
    for (const win of windows) {
      const readerAPI = win?.Zotero?.Reader ?? zotero?.Reader ?? null;
      const records = Array.isArray(readerAPI?._readers) ? readerAPI._readers : [];
      for (const record of records) {
        let reader = null;
        try {
          reader =
            typeof readerAPI?.getByTabID === "function"
              ? readerAPI.getByTabID(record?.tabID) ?? record?.reader ?? null
              : record?.reader ?? null;
        } catch (err) {
          warnOnce("get-by-tab-id", err);
        }
        if (reader) {
          const session = ensureSession(reader);
          if (session) {
            try {
              ensureButtonForOpenReader(reader, session);
            } catch (err) {
              warnOnce("sync-open-reader-button", err);
            }
          }
        }
      }
    }
  } catch (err) {
    warnOnce("sync-open-readers", err);
  }
}

/**
 * The `renderToolbar` handler: creates the session and appends the toggle. The
 * `append()` call has to happen synchronously inside the handler.
 *
 * @param {{type: string, reader: object, doc: object, params: object, append: (node: object) => void}} event
 */
function onRenderToolbar(event) {
  try {
    const reader = event?.reader;
    if (!reader) return;
    const session = ensureSession(reader);
    if (!session || typeof event.append !== "function") return;
    // A reader panel that was thrown away while its tab stayed hidden comes back
    // with a freshly rendered toolbar, so this render is the deterministic moment
    // the session learns the realm it paints has been replaced. A ready, idle
    // session re-validates here: it re-resolves the realm, adopts the new window,
    // rebinds its events and repaints; an unchanged realm repaints nothing. A
    // session that is still booting is left to the recovery loop, which owns it.
    if (session.ready && !session.destroyed && !session.pending?.size) {
      try {
        if (session.isForeground?.() && (session.workPausedInBackground || session.paintOnSelectPending)) {
          session.onTabActivate?.();
        } else {
          session.ensureCurrentDocument("toolbar-render");
        }
      } catch (err) {
        warnOnce("toolbar-render-wake", err);
      }
    }
    const doc = event?.doc ?? null;
    if (!doc?.createElement) return;
    const button = createButton(doc, session);
    event.append(button);
    // The append returned, so this is the moment the link can record how the node
    // was mounted: the toolbar document it lives in, the callback that mounted it
    // and the parent it ended up under. The callback is kept bound to the event it
    // arrived on, because the render is long gone by the time a repair calls it.
    const link = buttonLinks.get(session);
    if (link) {
      link.toolbarDoc = doc;
      link.append = typeof event.append === "function" ? event.append.bind(event) : null;
      link.parent = button.parentNode ?? null;
    }
  } catch (err) {
    warnOnce("render-toolbar", err);
  }
}

/**
 * Summarises the last detection results, for debugging in Stage B.
 *
 * @returns {object|null}
 */
function collectDiagnostics() {
  if (!sessions.size) return null;
  let pages = 0;
  let canvases = 0;
  let detail = null;
  const documents = new Set();
  for (const entry of sessions.values()) {
    const session = entry.session;
    if (session.destroyed) continue;
    if (session.documentId) documents.add(session.documentId);
    for (const overlay of session.overlays.values()) {
      if (!overlay.painted) continue;
      pages += 1;
      canvases += overlay.canvasCount;
      detail = overlay.diagnostics ?? detail;
    }
  }
  return {
    // Same rule as `probeAll()`: the installed add-on version when the bootstrap
    // supplied one, so no probe reports a build number that contradicts another.
    version: addonVersion || CORE_VERSION,
    enabled,
    readers: sessions.size,
    documents: documents.size,
    pages,
    canvases,
    core: detail,
  };
}

/**
 * Source of the realm-bridge resolver, evaluated in the main window realm.
 *
 * Kept as one string so a test can run it against a stand-in window: `win.eval`
 * is the point of the bridge, the function has to be created in that realm for
 * its property reads to see the reader objects without Xrays.
 *
 * The list of open readers comes from `Zotero.Reader.getOpenReaders()` where that
 * exists. It does not exist in every build (measured on the user's Zotero:
 * "getOpenReaders is not a function"), so `_readers` is normalised instead: a
 * keyed object, a Map or an Array, depending on the build. Where it does exist,
 * Zotero 7 hands back a generator, which has no `length` and would make the index
 * loop below run zero times, so both sources go through `Array.from` - that turns
 * an array, a generator or any other iterable into the list the loop wants. A
 * `getOpenReaders()` that exists but throws falls through to `_readers` as well,
 * the way `openReaderRecords()` does, instead of losing the whole lookup.
 *
 * `c === r` compares the reader handed in from the bootstrap sandbox with the one
 * this realm holds. Over a realm boundary that identity test can never be true,
 * which is why a list that carries exactly one reader with an iframe window is
 * returned instead. Before that guess, and because a shallow `tabID` read usually
 * survives the boundary, a record whose `tabID` equals the one on the argument is
 * taken: with two readers open, one of them already mounted, the guess would
 * otherwise hand back the frame of the wrong reader.
 *
 * @param {object} r A reader instance, or the realm window whose application
 *   object is wanted (the `bridge` route of `unwrapViewerApplication` passes that).
 * @param {boolean} [wantApp] When true, return the reader realm's
 *   `PDFViewerApplication` instead of its window. The property read then happens in
 *   this realm, where the plain read is proven to work, which is what makes the
 *   value usable in the sandbox: an application object is a plain object, so it
 *   arrives as a plain cross-compartment wrapper and its own properties stay
 *   readable.
 */
export const VIEWER_BRIDGE_SRC =
  "window.FigureColorResolveViewer = function (r, wantApp) {" +
  "var appOf = function (w) { if (!w) return null; try { return w.PDFViewerApplication || null; } catch (e) { return null; } };" +
  "try {" +
  "var R = window.Zotero && window.Zotero.Reader;" +
  "if (!R) return null;" +
  "var L = null;" +
  "if (typeof R.getOpenReaders === 'function') { try { L = Array.from(R.getOpenReaders()); } catch (e1) { L = null; } }" +
  "if (!L) { var m = R._readers || {};" +
  " L = (typeof m.values === 'function' && m.length === undefined) ? Array.from(m.values()) : Object.values(m); }" +
  "var rt = null; try { rt = r && r.tabID; } catch (e2) { rt = null; }" +
  "var tabIdForReader = function (rec, cand) {" +
  " var V = window.Zotero && window.Zotero.Viewer;" +
  " var ids = [null, null];" +
  " try { if (V && typeof V.getTabID === 'function') { ids[0] = V.getTabID(rec); ids[1] = V.getTabID(cand); } } catch (e3) {}" +
  " if (!ids[0] && rec && rec.tabID !== undefined) ids[0] = rec.tabID;" +
  " if (!ids[1] && cand && cand.tabID !== undefined) ids[1] = cand.tabID;" +
  " return ids;" +
  "};" +
  "var only = null; var onlyCount = 0; var tab = null; var tabHit = false;" +
  "for (var i = 0; i < L.length; i++) {" +
  "var rec = L[i];" +
  "var c = (rec && rec.tabID !== undefined && typeof R.getByTabID === 'function')" +
  " ? (R.getByTabID(rec.tabID) || rec) : rec;" +
  "var f = c && c._internalReader && c._internalReader._primaryView" +
  " ? c._internalReader._primaryView._iframeWindow : null;" +
  "if (c === r || f === r) return wantApp ? appOf(f) : (f || null);" +
  "var tids = tabIdForReader(rec, c);" +
  "if (!tabHit && rt !== undefined && rt !== null && (tids[0] === rt || tids[1] === rt)) { tab = f; tabHit = true; }" +
  "if (f) { only = f; onlyCount++; }" +
  "}" +
  "if (tabHit) return wantApp ? appOf(tab) : (tab || null);" +
  "if (L.length !== 1 || onlyCount !== 1) return null;" +
  "return wantApp ? appOf(only) : only;" +
  "} catch (err) { return null; }" +
  "};";

/**
 * Installs the realm-bridge resolver onto the main browser window. Reading the
 * reader's own underscore properties from the bootstrap sandbox timed out on
 * the real machine, so the lookup is evaluated in the main window realm, where
 * the same chain is proven to work. `win.eval` runs as code in that realm, so
 * a plain source string is enough; a missing window only means no bridge.
 *
 * @param {object|null} win The main browser window.
 */
function installViewerBridge(win) {
  if (!win || typeof win.eval !== "function") return;
  try {
    win.eval(VIEWER_BRIDGE_SRC);
  } catch (err) {
    warnOnce("bridge-install", err);
  }
}

/**
 * Wakes the reader sessions a Zotero `tab` notifier event is about.
 *
 * Zotero calls a notifier observer as `(event, type, ids, extra, id)`, so the
 * tab ids of a `select` arrive in `ids` — not in the second argument, which is the
 * event type. Reading the type as a tab id used to resolve `Reader.getByTabID` to
 * nothing on every switch, and the wake-all fallback below then hid the mistake:
 * the selected reader got woken, the hidden one did not, because the selected one
 * also gets its own `renderToolbar`.
 *
 * Every id in `ids` is resolved, not just the first: while the app is starting up
 * Zotero's Notifier queues the events it fires and hands observers one merged
 * notification carrying several tab ids, so a read of `ids[0]` woke one of the
 * tabs the user had switched through and left the rest of them — the tab actually
 * on screen — asleep, with nothing left to wake it once the boot storm was over.
 *
 * Both `select` and `load` are wakes. `load:tab` is the deterministic one for a
 * tab whose content finished loading during that storm, and a wake is an
 * idempotent re-validation and repaint, so reacting to it costs nothing.
 *
 * The coalesced startup batch wakes all named tabs, but only the one on screen
 * repaints. The on-screen reader is resolved once per notification through
 * `Zotero.Reader.getActive()` (Zotero 7+); every other named session wakes with
 * `paint: false`, which re-validates its document identity cheaply and defers
 * painting — a hidden tab's detection and canvas work during the boot storm was
 * measurably stalling Zotero. The deferred session relies on its own future
 * select wake, or a toolbar render, to paint. When `getActive()` resolves to
 * nothing (absent, or it throws), every named session gets the full paint wake,
 * exactly the behavior before the gate.
 *
 * @param {string} event Notifier event, e.g. "select" or "load".
 * @param {Array<*>|undefined|null} [ids] Tab ids the event carries.
 * @param {object} [extra] Notifier's extra data, may carry `id`.
 * @returns {void}
 */
/**
 * Tally of notifier-driven wakes, exposed for `probeAll()`: `count` is how many
 * tab notifications reached `wakeTabSessions`, `nullTarget` how many of them could
 * not resolve a reader for any of the tab ids they carried — the wake-all fallback
 * path. Both are per notification, not per tab id, so a coalesced startup batch
 * still reads as one wake pass. A growing `nullTarget` means the notifier payload
 * shape differs from the documented `(event, type, ids, extra)` on this machine,
 * and every switch wakes every session instead of the selected one.
 * @type {{ count: number, nullTarget: number }}
 */
export const wakeStats = { count: 0, nullTarget: 0 };

export function wakeTabSessions(event, ids, extra) {
  if (event !== "select" && event !== "load") return;
  // A tab switch is the moment the switch gets put back after the toolbar cleared
  // it out: the switch is what the user is looking at, and its own render is not
  // coming until the panel is rebuilt.
  try {
    maintainButtons();
  } catch (err) {
    warnOnce("button-maintain", err);
  }
  const zotero = getZotero();
  const rawIds = Array.isArray(ids) ? ids : ids === undefined || ids === null ? [] : [ids];
  const tabIds = rawIds.filter((id) => id !== undefined && id !== null);
  if (!tabIds.length && extra?.id !== undefined && extra?.id !== null) tabIds.push(extra.id);
  /** @type {Set<object>} The readers the notification's tab ids resolved to. */
  const targets = new Set();
  for (const tabId of tabIds) {
    try {
      const target = zotero?.Reader?.getByTabID?.(tabId) ?? null;
      if (target) targets.add(target);
    } catch (ignored) {
      // A half-built or hostile Reader only means this one id cannot be placed.
    }
  }
  wakeStats.count += 1;
  if (!targets.size) wakeStats.nullTarget += 1;
  // The one reader on screen, resolved once per notification: it is the only tab
  // whose paint work is worth doing now. An unreadable answer is null, which leaves
  // every named session on the full paint wake.
  let activeReader = null;
  try {
    activeReader = zotero?.Reader?.getActive?.() ?? null;
  } catch (ignored) {
    // A Reader that cannot answer the Zotero 7+ getActive read is the null case.
  }
  if (!activeReader) {
    try {
      const mainWin = typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null;
      const activeTabId = mainWin?.Zotero_Tabs?.selectedID ?? globalThis.Zotero_Tabs?.selectedID ?? null;
      if (activeTabId !== null && activeTabId !== undefined) {
        activeReader = zotero?.Reader?.getByTabID?.(activeTabId) ?? null;
      }
    } catch (ignored) {
      // Tab service optional.
    }
  }
  const isActiveReader = (sessionReader) => {
    if (!activeReader) return true;
    if (sessionReader === activeReader) return true;
    try {
      if (
        activeReader.tabID !== undefined &&
        activeReader.tabID !== null &&
        sessionReader?.tabID !== undefined &&
        sessionReader?.tabID !== null
      ) {
        return activeReader.tabID === sessionReader.tabID;
      }
    } catch (ignored) {}
    return false;
  };
  for (const [, record] of sessions) {
    const session = record.session;
    if (!session || session.destroyed) continue;
    const isTarget = !targets.size || targets.has(record.reader) || targets.has(session.reader);
    const active = isActiveReader(session.reader);
    if (!isTarget) {
      // A tab we just switched away from is not in `targets` for the new select
      // event, yet it may still have queued pages running; pause it immediately.
      if (activeReader && !active) {
        try {
          session.pauseBackgroundWork?.();
        } catch (err) {
          warnOnce("tab-pause", err);
        }
      }
      continue;
    }
    try {
      // A named tab that is not the one on screen: re-validate its identity only,
      // the on-screen session's check paints the visible document.
      if (activeReader && !active) {
        session.onTabActivate?.({ paint: false });
      } else {
        session.onTabActivate?.();
      }
    } catch (err) {
      warnOnce("tab-activate", err);
    }
  }
}

/**
 * Subscribes to Zotero's own notifier so a tab switch reaches the reader that
 * stays hidden: only the selected reader gets `renderToolbar`, so the session
 * behind the other tab never learns to re-check its own mount.
 *
 * The contract is Zotero's own, read from its reader: the first argument is an
 * observer OBJECT carrying `notify(event, type, ids, extraData)` — Zotero's
 * dispatcher calls `ref.notify(...)`, so a bare callback throws a `TypeError`
 * there, the throw is swallowed by the notifier, and the subscription never
 * fires. The third argument is the observer's name and the return value is a
 * string hash, which `removeZoteroNotifier()` hands back to unregister.
 *
 * @param {object|null} zotero The Zotero root.
 * @returns {string|number|null} Notifier id, when one could be registered.
 */
export function addZoteroNotifier(zotero) {
  const api = zotero?.Notifier;
  if (!api || typeof api.registerObserver !== "function" || typeof api.unregisterObserver !== "function") return null;
  try {
    const ref = {
      notify: (event, type, ids, extra) => {
        void type;
        wakeTabSessions(event, ids, extra);
      },
    };
    const id = api.registerObserver(ref, ["tab"], "figure-color");
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch (err) {
    warnOnce("notifier-register", err);
    return null;
  }
}

/**
 * Unsubscribes the Zotero notifier. The id is whatever `registerObserver`
 * returned — a string hash on Zotero 10 — so only `null` means "nothing to do".
 */
function removeZoteroNotifier() {
  const api = getZotero()?.Notifier;
  if (zoteroNotifierId == null || !api || typeof api.unregisterObserver !== "function") {
    zoteroNotifierId = null;
    return;
  }
  try {
    api.unregisterObserver(zoteroNotifierId);
  } catch (err) {
    warnOnce("notifier-unregister", err);
  }
  zoteroNotifierId = null;
}

/**
 * Called from bootstrap.js after the bundle has been loaded.
 *
 * @param {{id?: string, version?: string, rootURI?: string, reason?: number}} [data]
 */
export function startup(data = {}) {
  try {
    if (started) return;
    started = true;
    // The installed add-on version, from the bootstrap's startup data. Recorded
    // before anything can bail out: `probeAll().version` is how a report proves which
    // build is installed, and that matters most on a start that went wrong.
    addonVersion = String(data?.version ?? "");
    regionCache = new RegionCache({ maxEntries: 256 });
    const zotero = getZotero();
    const readerAPI = zotero?.Reader ?? null;
    if (!readerAPI || typeof readerAPI.registerEventListener !== "function") {
      warnOnce("reader-api", new Error("Zotero.Reader.registerEventListener is unavailable"));
      return;
    }
    try {
      readerAPI.registerEventListener(TOOLBAR_EVENT, onRenderToolbar, data?.id || PLUGIN_ID);
      registeredEventTypes = [TOOLBAR_EVENT];
    } catch (err) {
      warnOnce("register-toolbar-event", err);
      return;
    }

    const win0 = (() => {
      try {
        return (typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null)
          ?? globalThis.Services?.wm?.getMostRecentWindow?.("navigator:browser")
          ?? null;
      } catch (ignored) {
        return null;
      }
    })();
    installViewerBridge(win0);

    // bootstrap.startup() can run before Zotero finished initialising.
    const ready = (() => {
      try {
        return zotero?.initializedPromise ?? zotero?.Startup?.initializedPromise ?? null;
      } catch (ignored) {
        return null;
      }
    })();
    const afterReady = () => {
      if (!started) return;
      // Republish for Run JavaScript: startup() may have run before any
      // browser window existed, and the bundle's own global is a sandbox.
      try {
        const wm = globalThis.Services?.wm;
        const win = (typeof zotero?.getMainWindow === "function" ? zotero.getMainWindow() : null)
          ?? wm?.getMostRecentWindow?.("navigator:browser")
          ?? null;
        if (win) win.FigureGuard = globalThis.FigureGuard ?? null;
        installViewerBridge(win);
      } catch (err) {
        warnOnce("publish-window", err);
      }
      for (const topic of WINDOW_TOPICS) observers.push(addWindowObserver(topic, onWindowEvent));
      zoteroNotifierId = addZoteroNotifier(zotero);
      syncOpenReaders();
      lastDiagnostics = collectDiagnostics();
    };
    if (ready && typeof ready.then === "function") ready.then(afterReady, (err) => {
      warnOnce("zotero-initialized", err);
      afterReady();
    });
    else afterReady();
  } catch (err) {
    warnOnce("startup", err);
  }
}

/**
 * Called from bootstrap.js on shutdown: unregisters everything and removes all
 * overlays.
 */
export function shutdown() {
  try {
    started = false;
    addonVersion = "";
    while (observers.length) removeWindowObserver(observers.pop());
    removeZoteroNotifier();

    const readerAPI = getZotero()?.Reader ?? null;
    for (const type of registeredEventTypes) {
      try {
        readerAPI?.unregisterEventListener?.(type, onRenderToolbar);
      } catch (err) {
        warnOnce("unregister-event", err, type);
      }
    }
    registeredEventTypes = [];

    for (const [, entry] of [...sessions]) {
      if (!entry.session.destroyed) closeSession(entry.session);
    }
    for (const reader of [...sessions.keys()]) sessions.delete(reader);
    buttonLinks.clear();

    regionCache = null;
    lastDiagnostics = null;
  } catch (err) {
    warnOnce("shutdown", err);
  }
}

/**
 * Sets the default state for new sessions and applies it to live readers.
 *
 * @param {boolean} next
 * @returns {boolean} The new value.
 */
export function setEnabled(next) {
  const value = Boolean(next);
  enabled = value;
  if (regionCache) {
    for (const entry of sessions.values()) {
      if (!entry.session.destroyed) entry.session.setEnabled(value);
    }
  }
  return enabled;
}

/** Drops the shared detection cache; the next paint re-runs detection. */
export function clearCache() {
  try {
    regionCache?.clear();
  } catch (err) {
    warnOnce("clear-cache", err);
  }
}

/** Clears the once-per-site warning memory, mainly for debugging. */
export function resetWarnings() {
  resetWarnOnce();
}

/** @returns {object|null} The shared RegionCache, or null after shutdown. */
export function getRegionCache() {
  return regionCache;
}

/** @returns {Array<object>} Live sessions, for debugging. */
export function getSessions() {
  return [...sessions.values()].map((entry) => entry.session);
}

/** @returns {string[]} Recent warnings that the sandbox console may have hidden. */
export function getLog() {
  return getWarnLog();
}

/**
 * Resolves the reader and session the diagnostics report on: the reader of the
 * selected tab when the tab service and the reader API expose one, otherwise
 * the first live session. Shared by `runProbe` and `probePaint`.
 *
 * @returns {{tabID: *, reader: object|null, session: ReaderSession|null}}
 */
function resolveProbeTarget() {
  const zotero = getZotero();
  let tabID = null;
  try {
    tabID = globalThis.Zotero_Tabs?.selectedID ?? null;
  } catch (ignored) {
    // Tab service optional.
  }
  let reader = null;
  try {
    reader = zotero?.Reader?.getByTabID?.(tabID) ?? null;
  } catch (err) {
    warnOnce("probe-reader", err);
  }
  if (!reader) {
    for (const entry of sessions.values()) {
      if (!entry.session.destroyed) {
        reader = entry.session.reader;
        break;
      }
    }
  }
  const entry = reader ? sessions.get(reader) : null;
  return { tabID, reader, session: entry?.session ?? null };
}

/**
 * Runs the inner-window probe from the plugin's own realm, so Run JavaScript
 * can see what the sandbox sees without opening the error console.
 *
 * @returns {object} Plain data: session state, per-route probe and log tail.
 */
export function runProbe() {
  const { tabID, reader, session } = resolveProbeTarget();
  return {
    at: new Date().toISOString(),
    tabID,
    reader: reader ? reader?.constructor?.name ?? "object" : null,
    session: session
      ? {
          ready: session.ready,
          attempts: session.attempts,
          innerWin: Boolean(session.innerWin),
          eventBus: Boolean(session.eventBus),
          docId: session.documentId ?? null,
          overlays: session.overlays.size,
          enabled: session.enabled,
        }
      : null,
    chain: reader ? chainProbe(reader) : null,
    timers: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
    log: getWarnLog(),
  };
}

/**
 * Picks the overlay a paint probe should read: the requested page when given
 * and finite, then the page currently in view, then the first attached
 * overlay. A requested page without an attached overlay falls through to the
 * fallbacks so the probe still reports something.
 *
 * @param {ReaderSession|null} session
 * @param {number|undefined} pageNumber Requested 1-based page number, optional.
 * @param {number|null} currentPage Page currently in view, or null.
 * @returns {object|null} The overlay to probe, or null when none is attached.
 */
function pickTargetOverlay(session, pageNumber, currentPage) {
  const overlays = session?.overlays;
  if (!overlays || typeof overlays.get !== "function" || typeof overlays.values !== "function") return null;
  const wanted = Number(pageNumber);
  if (Number.isFinite(wanted)) {
    const hit = overlays.get(wanted);
    if (hit) return hit;
  }
  if (currentPage !== null) {
    const hit = overlays.get(currentPage);
    if (hit) return hit;
  }
  const first = overlays.values().next();
  return first.done ? null : first.value ?? null;
}

/**
 * The label `probeAll` reports for one session: the warning tag when it exists,
 * otherwise a short slice of the document id, otherwise `reader`.
 *
 * @param {ReaderSession} session
 * @returns {string}
 */
function sessionKey(session) {
  try {
    if (session?.tag) return String(session.tag);
  } catch (ignored) {
    // Fall through to the document id.
  }
  try {
    const documentId = session?.documentId;
    if (documentId) return String(documentId).slice(0, 12);
  } catch (ignored) {
    // Fall through to the plain label.
  }
  return "reader";
}

/**
 * Self-introspection of the realm a session latched onto, as plain data: whether
 * that window really carries `PDFViewerApplication`, through which unwrap route,
 * how many iframes it holds and where it points. On the real machine a session
 * reported `innerWin: true` with no event bus, and the plain read said
 * `pva: "undefined"` while the realm was the viewer: which of the unwrap routes
 * resolves the application object is what separates a wrong realm from a realm
 * whose JS-defined properties are hidden from this sandbox.
 *
 * `route` is one of `direct`, `wrapped`, `cu-unwrap`, `bridge` or `null`. The last
 * one is ambiguous on its own: a sandbox without `Components` and a realm whose
 * unwrap returns nothing both end there, and neither throws, so `hasCuUnwrap` says
 * which of the two the sandbox has at all. It is a read of this realm's own global,
 * so it costs nothing and cannot throw.
 *
 * Every read crosses a realm and may throw, so whatever was collected before the
 * throw is kept and the message is reported instead.
 *
 * @param {object|null} innerWin
 * @param {string} [tag] Reader label used for one-time warnings.
 * @returns {{info: object|null, error: string|null}}
 */
function readRealm(innerWin, tag = "") {
  if (!innerWin) return { info: null, error: null };
  const info = {
    pva: null,
    route: null,
    wrappedPva: null,
    hasCuUnwrap: null,
    frames: null,
    href: null,
  };
  // The route first: `unwrapViewerApplication` swallows every cross-realm throw,
  // so a realm that refuses the plain read still gets its route reported.
  info.route = unwrapViewerApplication(innerWin, tag).route;
  try {
    info.hasCuUnwrap = typeof globalThis.Components?.utils?.unwrap;
    info.wrappedPva = typeof innerWin.wrappedJSObject?.PDFViewerApplication;
    info.pva = typeof innerWin.PDFViewerApplication;
    info.frames = innerWin.document?.querySelectorAll?.("iframe")?.length ?? null;
    const href = innerWin.location?.href;
    info.href = href === undefined || href === null ? null : String(href).slice(0, REALM_HREF_MAX);
  } catch (err) {
    return { info, error: err?.message ?? String(err) };
  }
  return { info, error: null };
}

/**
 * The per-session entry of `probeAll`: the state the plugin knows, plus the
 * realm self-report and the paint evidence of one overlay. `Zotero_Tabs.selectedID`
 * is not readable from the bootstrap sandbox, so a single-session report can land
 * on a background reader; this entry does not depend on tab resolution.
 *
 * Reported keys: `key`, `ready`, `attempts`, `settledRepaints`, `innerWin`, `realm` (`pva`/`route`/
 * `wrappedPva`/`hasCuUnwrap`/`frames`/`href`, plus `realmError` when a cross-realm
 * read threw), `eventBus`, `docId`, `overlays`, `enabled`, `currentPage` (plus
 * `currentPageError`), `cacheKey`, `realmId` (the same stamp the overlay canvases
 * carry in `fcpRealm`), `freshDocId`, `realmSwitches`, `realmProvenance`,
 * `realmOwned` (frame membership), `realmUnproven`, `documentIdAdopted`,
 * `lastValidation`, `docIdStale`, `lastStaleKey`, `staleKeyPresent`,
 * `scale` (`currentScale`/`currentScaleValue`/`defaultZoomValue`,
 * the zoom the viewer reports now, so a `target.lastPaintGeometry` vs
 * `target.liveViewport` mismatch can be read against the value a fit-width relayout
 * settled on), `target` (plus `targetError`), and last `button` — `mounted` whether
 * this session's toggle is in the document now, `hasParent`/`hasAppend` whether a
 * repair has a parent node or a render append callback to put it back with, plus
 * `buttonError`, and `null` when the session never rendered a toolbar.
 * `target` is `probeOverlay`'s evidence:
 * the viewport captured at the last paint (`lastPaintGeometry`), the viewport read
 * while probing (`liveViewport`), the host box and the resolved theme custom
 * properties (`hostBox`, `cssVars`), and, per canvas, its own `getBoundingClientRect`
 * result and `offsetParent` label. Each `target.regions` entry
 * carries `kind`: "path" for vector art, "xobject" for image/form placements,
 * "struct" for tagged structure, or a combination such as "xobject+path".
 *
 * @param {ReaderSession} session
 * @returns {object} Plain, JSON-able data.
 */
function describeSession(session) {
  const entry = {
    key: sessionKey(session),
    ready: Boolean(session.ready),
    attempts: Number(session.attempts) || 0,
    // How many pages the settled pass had to heal: a non-zero count, seen with
    // the offset disappearing on the real machine, says the paint raced the
    // viewer's relayout.
    settledRepaints: Number(session.settledRepaints) || 0,
    innerWin: Boolean(session.innerWin),
    realm: null,
    eventBus: Boolean(session.eventBus),
    docId: session.documentId ?? null,
    // The key the region cache actually uses, the realm identity, and what the
    // live document answers right now: two readers sharing one `docId`, or one
    // reader whose `freshDocId` differs from `docId`, is the multi-tab bug.
    cacheKey: session.cacheKey?.() ?? session.documentId ?? null,
    realmId: null,
    freshDocId: null,
    // How often this session had to change its mind about which pdf.js realm it
    // paints, and whether a provisional document key was replaced by a printed
    // one. A non-zero `realmSwitches` next to a `freshDocId` that still differs
    // from `docId` says the correction is not landing on this machine.
    realmSwitches: Number(session.realmSwitches) || 0,
    // Where the latched realm came from (`chain`/`src`/`scan`/`bridge`/
    // `bridge-guessed`/`none`) and whether the window is still listed by this
    // reader's own chain or iframe set — frame membership, not document ownership:
    // it says the realm belongs to this reader's frames, which does not by itself
    // prove that the document inside it is the one this reader shows. `bridge` with
    // `realmOwned: false` is the cross-reader guess, kept visible so the probe proves
    // the adoption gate is landing on the real machine.
    realmProvenance: String(session.realmProvenance ?? "none"),
    realmOwned: (() => {
      try {
        return realmBelongsToReader(session.innerWin ?? null, session.reader ?? null);
      } catch {
        return false;
      }
    })(),
    // Whether the realm is still only a guess, so the identity read from it proves
    // nothing and the wakes hold their paint: `true` with `docId` set is the state
    // where the plugin deliberately paints nothing rather than the wrong document.
    realmUnproven: (() => {
      try {
        return Boolean(session.realmUnproven?.());
      } catch {
        return true;
      }
    })(),
    documentIdAdopted: Boolean(session.documentIdAdopted),
    // What the last wake through `ensureCurrentDocument()` decided — `{trigger,
    // decision, after, at}` with `decision` in `ok`/`rekeyed`/`wait` and `after` the
    // identity the wake left behind — plus the scoped cache key the last re-key
    // released. Together they answer "did the wake see my document, and whose regions
    // did it drop" without a code change.
    lastValidation: session.lastValidation ?? null,
    // True when the session's own drift read reports another document right now, so
    // the next wake re-keys: a trusted realm, printed against printed. Provisional
    // re-mints and unproven realms read false, exactly as the gate does.
    docIdStale: (() => {
      try {
        return Boolean(session.docIdentityDrift?.());
      } catch {
        return false;
      }
    })(),
    lastStaleKey: session.lastStaleKey ?? null,
    // True when the key the last re-key released still holds cached regions, which
    // would mean the previous document's regions are still readable by some session.
    // `false` is the clean state the re-key is supposed to leave.
    staleKeyPresent: (() => {
      try {
        const stale = session.lastStaleKey ?? null;
        if (!stale) return false;
        return Boolean(session.regionCache?.hasDocument?.(stale));
      } catch {
        return false;
      }
    })(),
    overlays: session.overlays?.size ?? 0,
    enabled: Boolean(session.enabled),
    currentPage: null,
    target: null,
    mountDetached: null,
  };
  const realm = readRealm(session.innerWin, entry.key);
  entry.realm = realm.info;
  if (realm.error) entry.realmError = realm.error;
  // Identity of the realm this session actually paints, so two sessions can be
  // told apart even when the printed fingerprint says they are the same file.
  entry.realmId = null;
  try {
    // The same stamp the overlay canvases carry: a probe that finds two sessions
    // with one `realmId` is looking at one realm painted twice, and a canvas whose
    // `fcpRealm` differs from its session's `realmId` was mounted for another tab.
    const stamped = realmStamp(session.innerWin ?? null);
    if (stamped) entry.realmId = stamped;
  } catch (ignored) {
    entry.realmId = null;
  }
  if (!entry.realmId) {
    try {
      const raw = session.innerWin ?? null;
      const zid = raw?.wrappedJSObject ?? raw;
      const internal = typeof zid?.__ID__ === "number" ? zid.__ID__ : null;
      const href = typeof entry.realm?.href === "string" ? entry.realm.href : "";
      entry.realmId = internal !== null ? `iwin:${internal}`
        : href ? `href:${href}@${entry.realm?.route ?? "?"}` : null;
    } catch (ignored) {
      entry.realmId = null;
    }
  }
  try {
    entry.freshDocId = resolveDocumentId(session.currentPDFDocument?.() ?? null);
  } catch (err) {
    entry.freshDocIdError = err?.message ?? String(err);
  }
  try {
    const value = Number(resolvePDFViewer(session.innerWin, entry.key)?.currentPageNumber);
    if (Number.isFinite(value)) entry.currentPage = value;
  } catch (err) {
    entry.currentPageError = err?.message ?? String(err);
  }
  // The zoom state the viewer reports now, so a `target.lastPaintGeometry` vs
  // `target.liveViewport` mismatch can be read together with the zoom value a
  // fit-width relayout settled on. Reported even when unreadable, as nulls.
  entry.scale = { currentScale: null, currentScaleValue: null, defaultZoomValue: null };
  try {
    const viewer = resolvePDFViewer(session.innerWin, entry.key);
    const scale = Number(viewer?.currentScale);
    const scaleValue = viewer?.currentScaleValue;
    const defaultZoom = viewer?.defaultZoomValue;
    entry.scale.currentScale = Number.isFinite(scale) ? scale : null;
    entry.scale.currentScaleValue = typeof scaleValue === "string" && scaleValue ? scaleValue : null;
    entry.scale.defaultZoomValue = typeof defaultZoom === "string" && defaultZoom ? defaultZoom : null;
  } catch (err) {
    warnOnce("probe-scale", err);
  }
  try {
    const overlay = pickTargetOverlay(session, undefined, entry.currentPage);
    if (overlay) {
      entry.target = probeOverlay(overlay);
      // Unknown is not detached: a stand-in overlay that reports nothing keeps false.
      const mounted = typeof overlay.isMounted === "function" ? overlay.isMounted() : true;
      entry.mountDetached = !mounted;
    }
  } catch (err) {
    entry.targetError = err?.message ?? String(err);
  }
  // Whether this session's toggle is actually in the toolbar right now, plus what a
  // repair would have to work with: `hasParent` the recorded parent node, `hasAppend`
  // the render's own append callback. A mounted false with both false is a switch no
  // repair can bring back, which is the case `warnOnce("button-reattach")` reports.
  try {
    const link = buttonLinks.get(session);
    entry.button = link
      ? {
          mounted: Boolean(link.button?.isConnected),
          hasParent: Boolean(link.parent),
          hasAppend: typeof link.append === "function",
        }
      : null;
  } catch (err) {
    entry.buttonError = err?.message ?? String(err);
  }
  return entry;
}

/**
 * Reports every live reader session, for debugging: the answer cannot end up on
 * the wrong (unloaded, background) reader because tab resolution is skipped.
 *
 * @returns {{at: string, sessions: Array<object>, active: string|null, count: number, truncated?: boolean}}
 *   `at` is the report time, `sessions` the entries of at most
 *   `MAX_PROBE_SESSIONS` readers, `active` the key of the session the single
 *   `probePaint` lookup would have picked, and `count` the number of live
 *   sessions, which exceeds `sessions.length` when the list is capped.
 */
export function probeAll() {
  const entries = [];
  let count = 0;
  for (const record of sessions.values()) {
    const session = record.session;
    if (!session || session.destroyed) continue;
    count += 1;
    if (entries.length < MAX_PROBE_SESSIONS) entries.push(describeSession(session));
  }
  // Whether the readers in this report are provably different documents. False
  // means the printed fingerprints collide, which is what put one paper's
  // regions on another's page.
  const freshIds = entries.map((entry) => entry.freshDocId).filter((value) => value !== null && value !== undefined);
  const docIdentityDistinct = freshIds.length > 1 ? new Set(freshIds).size === freshIds.length : null;
  const active = resolveProbeTarget().session;
  const result = {
    at: new Date().toISOString(),
    // The installed add-on version the bootstrap reported, so a machine report proves
    // which build is loaded; the core build stays visible in `coreVersion` for the
    // harness cases that call `startup()` without version data.
    version: addonVersion || CORE_VERSION,
    coreVersion: CORE_VERSION,
    sessions: entries,
    active: active && !active.destroyed ? sessionKey(active) : null,
    count,
    docIdentityDistinct,
    wake: { count: wakeStats.count, nullTarget: wakeStats.nullTarget },
    log: getWarnLog(),
  };
  if (count > entries.length) result.truncated = true;
  return result;
}

/**
 * Probes the painted overlays of the live reader, for Run JavaScript. Reports
 * device scale, the pdf.js page canvas ink ratio and per-canvas pixel evidence
 * for one target overlay, so a white-block report can be split into "pdf.js
 * drew nothing", "content landed outside the canvas" or "the raster is here".
 *
 * @param {number} [pageNumber] 1-based page to probe; defaults to the page in
 *   view, then to the first attached overlay.
 * @param {object} [options] Passed to `probeOverlay`, e.g.
 *   `{ maxPaintReadbackPixels: 400000 }` to shrink the pixel readback further.
 * @returns {object} Plain, JSON-able data: session summary, current page, the
 *   `probeOverlay` result of the target and the warning log tail. `target.paintPath`
 *   says which render route painted it: "helper" (inside the viewer realm) or
 *   "legacy".
 */
export function probePaint(pageNumber, options = {}) {
  const { session } = resolveProbeTarget();
  let currentPage = null;
  try {
    const viewer = session ? resolvePDFViewer(session.innerWin, session.tag) : null;
    const value = Number(viewer?.currentPageNumber);
    if (Number.isFinite(value)) currentPage = value;
  } catch (err) {
    warnOnce("probe-current-page", err);
  }
  let target = null;
  try {
    const overlay = pickTargetOverlay(session, pageNumber, currentPage);
    if (overlay) target = probeOverlay(overlay, options);
  } catch (err) {
    warnOnce("probe-target", err);
  }
  return {
    at: new Date().toISOString(),
    ready: Boolean(session?.ready),
    innerWin: Boolean(session?.innerWin),
    overlays: session?.overlays?.size ?? 0,
    currentPage,
    target,
    log: getWarnLog(),
  };
}

/** Plugin version, taken from the core so it cannot drift. */
export const version = CORE_VERSION;

/** Diagnostics of the most recent detection run. */
export let lastDiagnostics = null;

/** Default enabled state for new reader sessions (auto mode). */
export let enabled = true;
