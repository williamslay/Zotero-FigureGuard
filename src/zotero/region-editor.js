/**
 * Interactive manual figure region editor (adjust corners, draw new region,
 * capture right-click page coordinates, and surface persistence failures).
 *
 * Keeps drag interaction purely in viewport CSS geometry without running
 * figure detection, PDF re-rendering, or disk writes until user confirmation.
 */

import { clientPointToViewportPoint, cssBoxFromViewportRect, toPdfRect, toViewportRect } from "../core/viewport.js";

/** Style element id injected once per viewer document. */
export const EDITOR_STYLE_ID = "fg-editor-styles";
export const EDITOR_LAYER_CLASS = "fg-editor-layer";
export const EDITOR_BACKDROP_CLASS = "fg-editor-backdrop";
export const EDITOR_BOX_CLASS = "fg-editor-box";
export const EDITOR_HANDLE_CLASS = "fg-editor-handle";
export const EDITOR_CONTROLS_CLASS = "fg-editor-controls";
export const EDITOR_CONFIRM_CLASS = "fg-editor-confirm";
export const EDITOR_CANCEL_CLASS = "fg-editor-cancel";
export const EDITOR_NOTICE_CLASS = "fg-editor-notice";

/** Minimum CSS box dimension during interactive creation or corner dragging. */
export const MIN_EDITOR_BOX_CSS = 4;

const NOTICE_TIMEOUT_MS = 5000;
const CONTEXT_EVENT_MAX_AGE_MS = 2000;
const CORNERS = ["nw", "ne", "sw", "se"];

const EDITOR_CSS = `
.${EDITOR_LAYER_CLASS} {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  pointer-events: none;
  user-select: none;
  -moz-user-select: none;
}
.${EDITOR_BACKDROP_CLASS} {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
  background: rgba(1, 121, 242, 0.04);
}
.${EDITOR_BOX_CLASS} {
  position: absolute;
  box-sizing: border-box;
  border: 2px solid #2b8ef5;
  background: rgba(43, 142, 245, 0.14);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  pointer-events: none;
}
.${EDITOR_HANDLE_CLASS} {
  position: absolute;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  margin-top: -5px;
  box-sizing: border-box;
  border-radius: 2px;
  background: #ffffff;
  border: 2px solid #0157ad;
  pointer-events: auto;
  touch-action: none;
}
.${EDITOR_HANDLE_CLASS}[data-corner="nw"] { left: 0; top: 0; cursor: nwse-resize; }
.${EDITOR_HANDLE_CLASS}[data-corner="ne"] { left: 100%; top: 0; cursor: nesw-resize; }
.${EDITOR_HANDLE_CLASS}[data-corner="sw"] { left: 0; top: 100%; cursor: nesw-resize; }
.${EDITOR_HANDLE_CLASS}[data-corner="se"] { left: 100%; top: 100%; cursor: nwse-resize; }
.${EDITOR_CONTROLS_CLASS} {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  background: rgba(24, 26, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.16);
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
  font-family: sans-serif;
  font-size: 12px;
  color: #f4f6f8;
  white-space: nowrap;
}
.${EDITOR_CONTROLS_CLASS} button {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  padding: 2px 9px;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}
.${EDITOR_CONFIRM_CLASS} {
  background: #0179f2;
  color: #ffffff;
  border-color: #0157ad;
}
.${EDITOR_CONFIRM_CLASS}:hover {
  background: #2b8ef5;
}
.${EDITOR_CANCEL_CLASS} {
  background: rgba(255, 255, 255, 0.12);
  color: #f4f6f8;
}
.${EDITOR_CANCEL_CLASS}:hover {
  background: rgba(255, 255, 255, 0.22);
}
.${EDITOR_NOTICE_CLASS} {
  position: absolute;
  left: 12px;
  top: 12px;
  z-index: 21;
  max-width: calc(100% - 24px);
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(153, 27, 27, 0.94);
  border: 1px solid rgba(254, 202, 202, 0.5);
  color: #ffffff;
  font-family: sans-serif;
  font-size: 12px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
`;

/**
 * Resolves localized strings for FigureGuard context-menu items and the manual
 * region editor UI.
 *
 * @param {boolean} isZh
 * @returns {object}
 */
export function resolveEditorStrings(isZh) {
  if (isZh) {
    return {
      menuAdjust: "调整原色范围…",
      menuRemove: "取消此图原色保护",
      menuReset: "恢复自动识别范围",
      menuAdd: "手动添加原色区域…",
      confirm: "确认",
      cancel: "取消",
      drawHint: "在页面拖拽框选原色区域",
      adjustHint: "拖动四角调整范围",
      persistFailed: "保存失败：无法写入持久化缓存（仅本次会话生效）",
      commitFailed: "应用原色区域修改失败",
    };
  }
  return {
    menuAdjust: "Adjust Original Color Region…",
    menuRemove: "Remove Original Color Protection",
    menuReset: "Reset to Automatic Region",
    menuAdd: "Add Original Color Region…",
    confirm: "Confirm",
    cancel: "Cancel",
    drawHint: "Drag on page to select original color region",
    adjustHint: "Drag corners to adjust region",
    persistFailed: "Save failed: could not write to disk cache (session-only)",
    commitFailed: "Failed to apply original color change",
  };
}

function clampValue(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure 4-corner drag math in viewport CSS coordinates. Keeps the corner
 * opposite `corner` anchored while clamping the dragged corner within page
 * bounds `[0, viewportWidth] x [0, viewportHeight]` and maintaining `minSize`.
 *
 * @param {object} input
 * @param {{left: number, top: number, right: number, bottom: number}} input.initialBox
 * @param {"nw"|"ne"|"sw"|"se"} input.corner
 * @param {number} [input.deltaX]
 * @param {number} [input.deltaY]
 * @param {number|null} [input.viewportWidth]
 * @param {number|null} [input.viewportHeight]
 * @param {number} [input.minSize]
 * @returns {{left: number, top: number, right: number, bottom: number, width: number, height: number}}
 */
export function resizeCssBoxByCorner({
  initialBox,
  corner,
  deltaX = 0,
  deltaY = 0,
  viewportWidth = null,
  viewportHeight = null,
  minSize = MIN_EDITOR_BOX_CSS,
}) {
  const maxW = Number.isFinite(Number(viewportWidth)) && Number(viewportWidth) > 0
    ? Number(viewportWidth)
    : Number.POSITIVE_INFINITY;
  const maxH = Number.isFinite(Number(viewportHeight)) && Number(viewportHeight) > 0
    ? Number(viewportHeight)
    : Number.POSITIVE_INFINITY;
  const dx = Number.isFinite(Number(deltaX)) ? Number(deltaX) : 0;
  const dy = Number.isFinite(Number(deltaY)) ? Number(deltaY) : 0;

  let left = clampValue(Number(initialBox?.left ?? 0), 0, maxW);
  let top = clampValue(Number(initialBox?.top ?? 0), 0, maxH);
  let right = clampValue(Number(initialBox?.right ?? 0), 0, maxW);
  let bottom = clampValue(Number(initialBox?.bottom ?? 0), 0, maxH);
  if (right < left) [left, right] = [right, left];
  if (bottom < top) [top, bottom] = [bottom, top];

  const baseMin = Math.max(1, Number.isFinite(Number(minSize)) ? Number(minSize) : MIN_EDITOR_BOX_CSS);
  const effMinX = Number.isFinite(maxW) ? Math.min(baseMin, maxW) : baseMin;
  const effMinY = Number.isFinite(maxH) ? Math.min(baseMin, maxH) : baseMin;

  switch (corner) {
    case "nw":
      left = clampValue(left + dx, 0, Math.max(0, right - effMinX));
      top = clampValue(top + dy, 0, Math.max(0, bottom - effMinY));
      break;
    case "ne":
      right = clampValue(right + dx, Math.min(maxW, left + effMinX), maxW);
      top = clampValue(top + dy, 0, Math.max(0, bottom - effMinY));
      break;
    case "sw":
      left = clampValue(left + dx, 0, Math.max(0, right - effMinX));
      bottom = clampValue(bottom + dy, Math.min(maxH, top + effMinY), maxH);
      break;
    case "se":
      right = clampValue(right + dx, Math.min(maxW, left + effMinX), maxW);
      bottom = clampValue(bottom + dy, Math.min(maxH, top + effMinY), maxH);
      break;
    default:
      break;
  }

  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * Computes `[left, top]` CSS coordinates for the floating Confirm/Cancel bar
 * near an active box without leaving page bounds.
 */
export function computeControlsPosition(box, viewport) {
  const maxW = Number.isFinite(Number(viewport?.width)) && Number(viewport.width) > 0
    ? Number(viewport.width)
    : 800;
  const maxH = Number.isFinite(Number(viewport?.height)) && Number(viewport.height) > 0
    ? Number(viewport.height)
    : 800;
  const approxW = 140;
  const approxH = 34;
  const left = clampValue(box.left, 4, Math.max(4, maxW - approxW - 4));
  const preferBelow = box.bottom + 8;
  const top = preferBelow + approxH <= maxH - 4
    ? preferBelow
    : box.top - approxH - 8 >= 4
      ? box.top - approxH - 8
      : clampValue(box.top + 8, 4, Math.max(4, maxH - approxH - 4));
  return { left, top };
}

function ensureEditorStyles(doc) {
  if (!doc || typeof doc.createElement !== "function") return;
  try {
    const existing = typeof doc.getElementById === "function" ? doc.getElementById(EDITOR_STYLE_ID) : null;
    if (existing) {
      existing.textContent = EDITOR_CSS;
      return;
    }
    const head = doc.head ?? doc.querySelector?.("head") ?? doc.documentElement;
    if (!head || typeof head.appendChild !== "function") return;
    const style = doc.createElement("style");
    style.id = EDITOR_STYLE_ID;
    style.textContent = EDITOR_CSS;
    head.appendChild(style);
  } catch {
    // Inline fallback styles on elements keep editor usable if head is absent.
  }
}

function readPageBounds(pageView) {
  try {
    const view = pageView?.pdfPage?.view;
    if (view && typeof view.length === "number" && view.length >= 4) {
      return [Number(view[0]), Number(view[1]), Number(view[2]), Number(view[3])];
    }
  } catch {
    // Missing or unreadable pdfPage.view falls back to unclamped PDF coordinates.
  }
  return null;
}

function clientToViewport(event, pageView, viewport) {
  const div = pageView?.div;
  if (!div || typeof div.getBoundingClientRect !== "function") return null;
  const pageRect = div.getBoundingClientRect();
  return clientPointToViewportPoint({
    clientX: event?.clientX,
    clientY: event?.clientY,
    pageRect,
    scrollLeft: Number(div.scrollLeft) || 0,
    scrollTop: Number(div.scrollTop) || 0,
    viewport,
  });
}

function safeSetPointerCapture(el, pointerId) {
  if (pointerId === undefined || pointerId === null) return false;
  try {
    if (typeof el?.setPointerCapture === "function") {
      el.setPointerCapture(pointerId);
      return true;
    }
  } catch {
    // Ignore unsupported synthetic pointer ids.
  }
  return false;
}

function safeReleasePointerCapture(el, pointerId) {
  if (pointerId === undefined || pointerId === null) return;
  try {
    if (typeof el?.releasePointerCapture === "function") {
      el.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore if already released.
  }
}

/**
 * Manages interactive editing (single active box per ReaderSession) and passive
 * right-click coordinate capture for Zotero's viewer iframe document.
 */
export class RegionEditorController {
  /**
   * @param {object} [options]
   * @param {((doc?: object|null) => boolean)} [options.isChinese]
   * @param {((payload: object) => Promise<object>|object)|null} [options.onCommit]
   * @param {((state: {active: boolean, mode: string|null, pageNumber: number|null, reason: string}) => void)|null} [options.onStateChange]
   */
  constructor({ isChinese = null, onCommit = null, onStateChange = null } = {}) {
    this.isChinese = typeof isChinese === "function" ? isChinese : () => false;
    this.onCommit = typeof onCommit === "function" ? onCommit : null;
    this.onStateChange = typeof onStateChange === "function" ? onStateChange : null;
    this.destroyed = false;
    this.tokenCounter = 0;
    this.active = null;
    this.contextListener = null;
    this.lastContextEvent = null;
    this.activeNotice = null;
  }

  getStrings(doc = null) {
    let isZh = false;
    try {
      isZh = Boolean(this.isChinese(doc));
    } catch {
      isZh = false;
    }
    return resolveEditorStrings(isZh);
  }

  /**
   * Attaches a passive capture-phase `contextmenu` listener to record pointer
   * coordinates without altering Zotero's native right-click handling.
   *
   * @param {object|null} doc Viewer document (`innerWin.document`).
   */
  attachContextListener(doc) {
    if (this.destroyed) return;
    if (!doc || typeof doc.addEventListener !== "function") {
      this.detachContextListener();
      return;
    }
    if (this.contextListener?.doc === doc) return;
    this.detachContextListener();

    const handler = (event) => {
      try {
        const cx = Number(event?.clientX);
        const cy = Number(event?.clientY);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        this.lastContextEvent = {
          clientX: cx,
          clientY: cy,
          target: event?.target ?? null,
          timestamp: Date.now(),
        };
      } catch {
        // Never interfere with native context menu opening.
      }
    };
    try {
      doc.addEventListener("contextmenu", handler, true);
      this.contextListener = { doc, handler };
    } catch {
      this.contextListener = null;
    }
  }

  detachContextListener() {
    const bound = this.contextListener;
    this.contextListener = null;
    this.lastContextEvent = null;
    if (!bound?.doc || !bound.handler) return;
    try {
      bound.doc.removeEventListener?.("contextmenu", bound.handler, true);
    } catch {
      // Document may already be torn down.
    }
  }

  /**
   * Consumes the most recent viewer `contextmenu` pointer snapshot if still fresh.
   */
  consumeContextEvent(now = Date.now(), maxAgeMs = CONTEXT_EVENT_MAX_AGE_MS) {
    const snap = this.lastContextEvent;
    this.lastContextEvent = null;
    if (!snap) return null;
    if (now - snap.timestamp > maxAgeMs) return null;
    return snap;
  }

  hasActiveEditor() {
    return Boolean(this.active);
  }

  clearNotice() {
    const current = this.activeNotice;
    this.activeNotice = null;
    if (!current) return;
    if (current.timer != null) {
      try {
        clearTimeout(current.timer);
      } catch {
        // Ignore stale timer id.
      }
    }
    try {
      current.el?.parentNode?.removeChild(current.el);
    } catch {
      // Ignore already detached node.
    }
  }

  showNotice(text, pageView = null) {
    this.clearNotice();
    const container = pageView?.div;
    const doc = container?.ownerDocument ?? null;
    if (!container || !doc || typeof doc.createElement !== "function") return null;
    ensureEditorStyles(doc);
    const el = doc.createElement("div");
    el.className = EDITOR_NOTICE_CLASS;
    el.textContent = String(text ?? "");
    el.style.position = "absolute";
    el.style.left = "12px";
    el.style.top = "12px";
    el.style.zIndex = "21";
    el.style.pointerEvents = "none";
    container.appendChild(el);
    const timer = setTimeout(() => {
      if (this.activeNotice?.el === el) this.clearNotice();
    }, NOTICE_TIMEOUT_MS);
    this.activeNotice = { el, timer };
    return el;
  }

  /**
   * Enters Adjust mode for an existing region on `pageView`.
   * Cancels any prior uncommitted edit first so only one editor stays active.
   */
  startAdjust({ pageView, pageNumber, region }) {
    if (this.destroyed) return false;
    this.cancel("replaced");
    this.clearNotice();

    const doc = pageView?.div?.ownerDocument ?? null;
    const viewport = pageView?.viewport ?? null;
    const rect = region?.rect;
    if (!doc || !pageView?.div || !viewport || !rect) return false;

    let vpRect;
    try {
      vpRect = toViewportRect(rect, viewport);
    } catch {
      return false;
    }
    const initialBox = cssBoxFromViewportRect(vpRect, viewport);
    if (!initialBox || initialBox.width <= 0 || initialBox.height <= 0) return false;

    const state = this.createActiveState({
      mode: "adjust",
      stage: "adjusting",
      pageNumber: Number(pageNumber) || Number(pageView?.id) || 0,
      pageView,
      doc,
      viewport,
      region,
      box: initialBox,
    });
    if (!state) return false;
    this.mountAdjustUI(state);
    this.emitState("start-adjust");
    return true;
  }

  /**
   * Enters Manual Add mode on `pageView`: awaits an initial pointer drag to draw
   * the bounding rectangle, then shows 4 corner handles + Confirm/Cancel.
   */
  startAdd({ pageView, pageNumber }) {
    if (this.destroyed) return false;
    this.cancel("replaced");
    this.clearNotice();

    const doc = pageView?.div?.ownerDocument ?? null;
    const viewport = pageView?.viewport ?? null;
    if (!doc || !pageView?.div || !viewport) return false;

    const state = this.createActiveState({
      mode: "add",
      stage: "drawing",
      pageNumber: Number(pageNumber) || Number(pageView?.id) || 0,
      pageView,
      doc,
      viewport,
      region: null,
      box: null,
    });
    if (!state) return false;
    this.mountAddDrawUI(state);
    this.emitState("start-add");
    return true;
  }

  createActiveState({ mode, stage, pageNumber, pageView, doc, viewport, region, box }) {
    if (!pageNumber || !doc || typeof doc.createElement !== "function") return null;
    ensureEditorStyles(doc);

    const layerEl = doc.createElement("div");
    layerEl.className = EDITOR_LAYER_CLASS;
    layerEl.style.position = "absolute";
    layerEl.style.left = "0";
    layerEl.style.top = "0";
    layerEl.style.right = "0";
    layerEl.style.bottom = "0";
    layerEl.style.zIndex = "20";
    layerEl.style.pointerEvents = "none";

    const strings = this.getStrings(doc);
    this.tokenCounter += 1;
    const state = {
      token: this.tokenCounter,
      mode,
      stage,
      pageNumber,
      pageView,
      doc,
      viewport,
      pageBounds: readPageBounds(pageView),
      region,
      box,
      strings,
      layerEl,
      backdropEl: null,
      boxEl: null,
      controlsEl: null,
      confirmBtn: null,
      cancelBtn: null,
      handles: [],
      cleanupFns: [],
      pointerState: null,
      committing: false,
    };

    const onKeyDown = (event) => {
      if (event?.key === "Escape") {
        try {
          event.preventDefault?.();
          event.stopPropagation?.();
        } catch {
          // Best-effort key interception.
        }
        this.cancel("escape");
      }
    };
    this.listen(state, doc, "keydown", onKeyDown, true);

    pageView.div.appendChild(layerEl);
    this.active = state;
    return state;
  }

  listen(state, target, type, fn, capture = false) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, fn, capture);
    state.cleanupFns.push(() => {
      try {
        target.removeEventListener?.(type, fn, capture);
      } catch {
        // Ignore detached target.
      }
    });
  }

  mountAddDrawUI(state) {
    const { doc, layerEl, viewport, strings } = state;
    const backdropEl = doc.createElement("div");
    backdropEl.className = EDITOR_BACKDROP_CLASS;
    backdropEl.style.position = "absolute";
    backdropEl.style.left = "0";
    backdropEl.style.top = "0";
    backdropEl.style.right = "0";
    backdropEl.style.bottom = "0";
    backdropEl.style.pointerEvents = "auto";
    backdropEl.style.cursor = "crosshair";
    layerEl.appendChild(backdropEl);
    state.backdropEl = backdropEl;

    const controlsEl = doc.createElement("div");
    controlsEl.className = EDITOR_CONTROLS_CLASS;
    controlsEl.style.position = "absolute";
    controlsEl.style.left = "12px";
    controlsEl.style.top = "12px";
    controlsEl.style.pointerEvents = "auto";

    const hintEl = doc.createElement("span");
    hintEl.textContent = strings.drawHint;
    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = EDITOR_CANCEL_CLASS;
    cancelBtn.textContent = strings.cancel;
    controlsEl.appendChild(hintEl);
    controlsEl.appendChild(cancelBtn);
    layerEl.appendChild(controlsEl);
    state.controlsEl = controlsEl;
    state.cancelBtn = cancelBtn;

    this.listen(state, cancelBtn, "pointerdown", (event) => {
      event?.stopPropagation?.();
    });
    this.listen(state, cancelBtn, "click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      this.cancel("button");
    });

    const onDown = (event) => {
      if (this.active !== state || state.stage !== "drawing") return;
      if (event?.button !== undefined && event.button !== 0) return;
      const pt = clientToViewport(event, state.pageView, viewport);
      if (!pt) return;
      event?.preventDefault?.();
      event?.stopPropagation?.();

      const maxW = Number(viewport.width) || pt[0];
      const maxH = Number(viewport.height) || pt[1];
      const startX = clampValue(pt[0], 0, maxW);
      const startY = clampValue(pt[1], 0, maxH);
      const captureEl = safeSetPointerCapture(backdropEl, event?.pointerId) ? backdropEl : null;

      state.pointerState = {
        kind: "draw",
        pointerId: event?.pointerId ?? null,
        captureEl,
        startX,
        startY,
      };
      state.box = { left: startX, top: startY, right: startX, bottom: startY, width: 0, height: 0 };
      this.ensureBoxElement(state);
      this.syncBoxStyles(state);
    };

    const onMove = (event) => {
      const pState = state.pointerState;
      if (this.active !== state || !pState || pState.kind !== "draw") return;
      if (pState.pointerId != null && event?.pointerId != null && event.pointerId !== pState.pointerId) return;
      const pt = clientToViewport(event, state.pageView, viewport);
      if (!pt) return;
      const box = cssBoxFromViewportRect([pState.startX, pState.startY, pt[0], pt[1]], viewport);
      if (!box) return;
      state.box = box;
      this.syncBoxStyles(state);
    };

    const onEnd = (event, cancelled = false) => {
      const pState = state.pointerState;
      if (this.active !== state || !pState || pState.kind !== "draw") return;
      if (pState.pointerId != null && event?.pointerId != null && event.pointerId !== pState.pointerId) return;
      if (pState.captureEl) safeReleasePointerCapture(pState.captureEl, pState.pointerId);
      state.pointerState = null;

      if (cancelled) {
        this.removePreviewBox(state);
        return;
      }

      const pt = clientToViewport(event, state.pageView, viewport);
      const box = pt
        ? cssBoxFromViewportRect([pState.startX, pState.startY, pt[0], pt[1]], viewport)
        : state.box;

      if (!box || box.width < MIN_EDITOR_BOX_CSS || box.height < MIN_EDITOR_BOX_CSS) {
        this.removePreviewBox(state);
        return;
      }

      state.box = box;
      state.stage = "adjusting";
      try {
        backdropEl.parentNode?.removeChild(backdropEl);
      } catch {
        // Ignore already removed backdrop.
      }
      state.backdropEl = null;
      try {
        controlsEl.parentNode?.removeChild(controlsEl);
      } catch {
        // Ignore already removed draw controls.
      }
      state.controlsEl = null;
      this.mountAdjustUI(state);
      this.emitState("add-drawn");
    };

    this.listen(state, backdropEl, "pointerdown", onDown);
    this.listen(state, backdropEl, "pointermove", onMove);
    this.listen(state, doc, "pointermove", onMove);
    this.listen(state, backdropEl, "pointerup", (e) => onEnd(e, false));
    this.listen(state, doc, "pointerup", (e) => onEnd(e, false));
    this.listen(state, backdropEl, "pointercancel", (e) => onEnd(e, true));
    this.listen(state, doc, "pointercancel", (e) => onEnd(e, true));
  }

  removePreviewBox(state) {
    state.box = null;
    if (state.boxEl) {
      try {
        state.boxEl.parentNode?.removeChild(state.boxEl);
      } catch {
        // Ignore detached preview.
      }
      state.boxEl = null;
    }
  }

  ensureBoxElement(state) {
    if (state.boxEl) return state.boxEl;
    const boxEl = state.doc.createElement("div");
    boxEl.className = EDITOR_BOX_CLASS;
    boxEl.style.position = "absolute";
    boxEl.style.boxSizing = "border-box";
    boxEl.style.pointerEvents = "none";
    state.layerEl.appendChild(boxEl);
    state.boxEl = boxEl;
    return boxEl;
  }

  syncBoxStyles(state) {
    const { boxEl, box, controlsEl, viewport } = state;
    if (!boxEl || !box) return;
    boxEl.style.left = `${box.left}px`;
    boxEl.style.top = `${box.top}px`;
    boxEl.style.width = `${box.width}px`;
    boxEl.style.height = `${box.height}px`;
    if (controlsEl) {
      const pos = computeControlsPosition(box, viewport);
      controlsEl.style.left = `${pos.left}px`;
      controlsEl.style.top = `${pos.top}px`;
    }
  }

  mountAdjustUI(state) {
    const { doc, layerEl, strings, viewport } = state;
    const boxEl = this.ensureBoxElement(state);

    for (const corner of CORNERS) {
      const handle = doc.createElement("div");
      handle.className = EDITOR_HANDLE_CLASS;
      handle.setAttribute?.("data-corner", corner);
      if (handle.dataset) handle.dataset.corner = corner;
      handle.style.position = "absolute";
      handle.style.width = "10px";
      handle.style.height = "10px";
      handle.style.pointerEvents = "auto";
      boxEl.appendChild(handle);
      state.handles.push(handle);

      const onHandleDown = (event) => {
        if (this.active !== state || state.committing || state.stage !== "adjusting") return;
        if (event?.button !== undefined && event.button !== 0) return;
        const pt = clientToViewport(event, state.pageView, viewport);
        if (!pt || !state.box) return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const captureEl = safeSetPointerCapture(handle, event?.pointerId) ? handle : null;
        state.pointerState = {
          kind: "corner",
          corner,
          pointerId: event?.pointerId ?? null,
          captureEl,
          startPoint: pt,
          initialBox: { ...state.box },
        };
      };
      this.listen(state, handle, "pointerdown", onHandleDown);
    }

    const onMove = (event) => {
      const pState = state.pointerState;
      if (this.active !== state || !pState || pState.kind !== "corner" || state.committing) return;
      if (pState.pointerId != null && event?.pointerId != null && event.pointerId !== pState.pointerId) return;
      const pt = clientToViewport(event, state.pageView, viewport);
      if (!pt) return;
      state.box = resizeCssBoxByCorner({
        initialBox: pState.initialBox,
        corner: pState.corner,
        deltaX: pt[0] - pState.startPoint[0],
        deltaY: pt[1] - pState.startPoint[1],
        viewportWidth: viewport?.width,
        viewportHeight: viewport?.height,
        minSize: MIN_EDITOR_BOX_CSS,
      });
      this.syncBoxStyles(state);
    };

    const onEnd = (event) => {
      const pState = state.pointerState;
      if (this.active !== state || !pState || pState.kind !== "corner") return;
      if (pState.pointerId != null && event?.pointerId != null && event.pointerId !== pState.pointerId) return;
      if (pState.captureEl) safeReleasePointerCapture(pState.captureEl, pState.pointerId);
      state.pointerState = null;
    };

    this.listen(state, doc, "pointermove", onMove);
    this.listen(state, doc, "pointerup", onEnd);
    this.listen(state, doc, "pointercancel", onEnd);
    for (const handle of state.handles) {
      this.listen(state, handle, "pointermove", onMove);
      this.listen(state, handle, "pointerup", onEnd);
      this.listen(state, handle, "pointercancel", onEnd);
    }

    const controlsEl = doc.createElement("div");
    controlsEl.className = EDITOR_CONTROLS_CLASS;
    controlsEl.style.position = "absolute";
    controlsEl.style.pointerEvents = "auto";

    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = EDITOR_CONFIRM_CLASS;
    confirmBtn.textContent = strings.confirm;

    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = EDITOR_CANCEL_CLASS;
    cancelBtn.textContent = strings.cancel;

    controlsEl.appendChild(confirmBtn);
    controlsEl.appendChild(cancelBtn);
    layerEl.appendChild(controlsEl);
    state.controlsEl = controlsEl;
    state.confirmBtn = confirmBtn;
    state.cancelBtn = cancelBtn;

    this.listen(state, confirmBtn, "pointerdown", (event) => {
      event?.stopPropagation?.();
    });
    this.listen(state, cancelBtn, "pointerdown", (event) => {
      event?.stopPropagation?.();
    });
    this.listen(state, confirmBtn, "click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      void this.confirm();
    });
    this.listen(state, cancelBtn, "click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      this.cancel("button");
    });

    this.syncBoxStyles(state);
  }

  /**
   * Commits the active adjusted/drawn rectangle to PDF user space via `onCommit`.
   * Leaves detection untouched and shows an explicit notice if persistence fails.
   */
  async confirm() {
    const state = this.active;
    if (!state || state.committing || state.stage !== "adjusting" || !state.box) {
      return { ok: false, persisted: false, reason: "no-active-box" };
    }

    const pdfRect = toPdfRect(
      [state.box.left, state.box.top, state.box.right, state.box.bottom],
      state.viewport,
      state.pageBounds,
    );
    if (!pdfRect) {
      this.cancel("invalid-box");
      return { ok: false, persisted: false, reason: "invalid-box" };
    }

    state.committing = true;
    if (state.confirmBtn) state.confirmBtn.disabled = true;
    const token = state.token;
    const targetPageView = state.pageView;
    const strings = state.strings;

    let result = { ok: true, persisted: true };
    try {
      if (this.onCommit) {
        result = (await this.onCommit({
          mode: state.mode,
          pageNumber: state.pageNumber,
          region: state.region,
          pdfRect,
        })) ?? { ok: false, persisted: false, reason: "empty-result" };
      }
    } catch (err) {
      result = { ok: false, persisted: false, reason: "commit-threw", error: err?.message ?? String(err) };
    }

    if (this.destroyed || this.active?.token !== token) {
      return { ok: Boolean(result?.ok), persisted: result?.persisted !== false, pdfRect, result };
    }

    this.teardownActive();
    this.emitState("confirm");

    if (!result?.ok) {
      this.showNotice(strings.commitFailed, targetPageView);
    } else if (result.persisted === false) {
      this.showNotice(strings.persistFailed, targetPageView);
    }

    return { ok: Boolean(result?.ok), persisted: result?.persisted !== false, pdfRect, result };
  }

  teardownActive() {
    const state = this.active;
    this.active = null;
    if (!state) return false;
    if (state.pointerState?.captureEl) {
      safeReleasePointerCapture(state.pointerState.captureEl, state.pointerState.pointerId);
    }
    state.pointerState = null;
    for (const cleanup of state.cleanupFns) cleanup();
    state.cleanupFns = [];
    try {
      state.layerEl?.parentNode?.removeChild(state.layerEl);
    } catch {
      // Ignore already detached layer.
    }
    return true;
  }

  /**
   * Cancels any uncommitted active edit, restoring the document untouched.
   *
   * @param {string} [reason]
   * @returns {boolean} True when an active editor was torn down.
   */
  cancel(reason = "cancel") {
    const hadActive = this.teardownActive();
    if (hadActive) this.emitState(reason);
    return hadActive;
  }

  emitState(reason) {
    if (!this.onStateChange) return;
    try {
      this.onStateChange({
        active: Boolean(this.active),
        mode: this.active?.mode ?? null,
        pageNumber: this.active?.pageNumber ?? null,
        reason,
      });
    } catch {
      // Diagnostic listener errors must not break editing.
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancel("destroy");
    this.clearNotice();
    this.detachContextListener();
  }
}
