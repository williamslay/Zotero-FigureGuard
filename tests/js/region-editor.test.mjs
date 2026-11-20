import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { MEASURED_OP_CODES } from "../../src/core/index.js";
import {
  clientPointToViewportPoint,
  cssBoxFromViewportRect,
  toPdfPoint,
  toPdfRect,
  toViewportRect,
} from "../../src/core/viewport.js";
import { PAD_VIEWPORT, OVERLAY_CLASS, resetWarnOnce } from "../../src/zotero/overlay.js";
import {
  EDITOR_BACKDROP_CLASS,
  EDITOR_BOX_CLASS,
  EDITOR_CANCEL_CLASS,
  EDITOR_CONFIRM_CLASS,
  EDITOR_CONTROLS_CLASS,
  EDITOR_HANDLE_CLASS,
  EDITOR_LAYER_CLASS,
  EDITOR_NOTICE_CLASS,
  RegionEditorController,
  resizeCssBoxByCorner,
} from "../../src/zotero/region-editor.js";
import {
  CONTEXT_MENU_EVENT,
  TOOLBAR_EVENT,
  getEffectiveRegions,
  getSessions,
  setEnabled,
  shutdown,
  startup,
} from "../../src/zotero/main.js";

const tempDirs = [];
const savedGlobals = {
  Zotero: globalThis.Zotero,
  Zotero_Tabs: globalThis.Zotero_Tabs,
  IOUtils: globalThis.IOUtils,
  PathUtils: globalThis.PathUtils,
};

afterEach(async () => {
  try {
    shutdown();
  } catch {
    // Ignore already shut down state.
  }
  setEnabled(true);
  globalThis.Zotero = savedGlobals.Zotero;
  globalThis.Zotero_Tabs = savedGlobals.Zotero_Tabs;
  globalThis.IOUtils = savedGlobals.IOUtils;
  globalThis.PathUtils = savedGlobals.PathUtils;
  resetWarnOnce();
  while (tempDirs.length) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fg-editor-"));
  tempDirs.push(dir);
  return dir;
}

/** Node-backed Gecko IOUtils / PathUtils shim matching Zotero storage behavior. */
function installGeckoFsShim(dataDir, stats = {}) {
  const rec = Object.assign(stats, { writes: 0, failWritesWith: null });
  globalThis.PathUtils = {
    join: (...parts) => path.join(...parts),
  };
  globalThis.IOUtils = {
    async exists(targetPath) {
      try {
        await stat(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    async readUTF8(targetPath) {
      return readFile(targetPath, "utf8");
    },
    async makeDirectory(dirPath) {
      await mkdir(dirPath, { recursive: true });
    },
    async writeUTF8(targetPath, content, options = {}) {
      rec.writes += 1;
      if (rec.failWritesWith) {
        const err = rec.failWritesWith instanceof Error ? rec.failWritesWith : new Error(String(rec.failWritesWith));
        throw err;
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (options?.tmpPath) {
        await writeFile(options.tmpPath, content, "utf8");
        await rename(options.tmpPath, targetPath);
      } else {
        await writeFile(targetPath, content, "utf8");
      }
    },
    async move(fromPath, toPath) {
      await rename(fromPath, toPath);
    },
    async remove(targetPath) {
      await rm(targetPath, { recursive: true, force: true });
    },
  };
  return rec;
}

/**
 * Exact pdf.js-compatible PageViewport builder for all 4 rotation quadrants
 * and arbitrary CropBox `[bx0, by0, bx1, by1]` origins.
 */
function buildPdfViewport({ view = [0, 0, 612, 792], scale = 1, rotation = 0 } = {}) {
  const [vx0, vy0, vx1, vy1] = view;
  const pageW = vx1 - vx0;
  const pageH = vy1 - vy0;
  const rot = ((rotation % 360) + 360) % 360;

  let width;
  let height;
  let transform;
  if (rot === 0) {
    width = pageW * scale;
    height = pageH * scale;
    transform = [scale, 0, 0, -scale, -vx0 * scale, vy1 * scale];
  } else if (rot === 90) {
    width = pageH * scale;
    height = pageW * scale;
    transform = [0, scale, scale, 0, -vy0 * scale, -vx0 * scale];
  } else if (rot === 180) {
    width = pageW * scale;
    height = pageH * scale;
    transform = [-scale, 0, 0, scale, vx1 * scale, -vy0 * scale];
  } else if (rot === 270) {
    width = pageH * scale;
    height = pageW * scale;
    transform = [0, -scale, -scale, 0, vy1 * scale, vx1 * scale];
  } else {
    throw new Error(`Unsupported rotation ${rotation}`);
  }

  return {
    width,
    height,
    scale,
    rotation: rot,
    transform,
    convertToViewportPoint(x, y) {
      const [a, b, c, d, e, f] = transform;
      return [a * x + c * y + e, b * x + d * y + f];
    },
    convertToPdfPoint(vx, vy) {
      const [a, b, c, d, e, f] = transform;
      const det = a * d - b * c;
      const tx = vx - e;
      const ty = vy - f;
      return [(d * tx - c * ty) / det, (-b * tx + a * ty) / det];
    },
  };
}

/** Interactive DOM mock supporting bubbling, querySelector, pointer capture, and listener audits. */
function makeViewerDom({ lang = "zh-CN" } = {}) {
  const listenersByNode = new Set();
  const capturedPointers = new Map();

  const makeEl = (tag, doc) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      textContent: "",
      disabled: false,
      style: {},
      dataset: {},
      attributes: new Map(),
      children: [],
      parentNode: null,
      ownerDocument: doc,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      scrollLeft: 0,
      scrollTop: 0,
      listeners: new Map(),
      get classList() {
        const split = () => new Set(String(el.className || "").split(/\s+/).filter(Boolean));
        return {
          add(...names) {
            const s = split();
            for (const n of names) if (n) s.add(String(n));
            el.className = [...s].join(" ");
          },
          remove(...names) {
            const s = split();
            for (const n of names) s.delete(String(n));
            el.className = [...s].join(" ");
          },
          contains(name) {
            return split().has(String(name));
          },
        };
      },
      setAttribute(name, val) {
        this.attributes.set(name, String(val));
      },
      getAttribute(name) {
        return this.attributes.get(name) ?? null;
      },
      get isConnected() {
        let cur = this;
        while (cur) {
          if (cur === doc || cur === doc.documentElement || cur === doc.head || cur === doc.body) return true;
          cur = cur.parentNode;
        }
        return false;
      },
      appendChild(child) {
        if (child.parentNode && typeof child.parentNode.removeChild === "function") {
          child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        if (child.parentNode === this) child.parentNode = null;
        return child;
      },
      remove() {
        this.parentNode?.removeChild(this);
      },
      contains(target) {
        for (let cur = target; cur; cur = cur.parentNode) {
          if (cur === this) return true;
        }
        return false;
      },
      closest(selector) {
        const wantedClass = selector.startsWith(".") ? selector.slice(1) : null;
        for (let cur = this; cur; cur = cur.parentNode) {
          if (wantedClass && String(cur.className).split(/\s+/).includes(wantedClass)) return cur;
        }
        return null;
      },
      querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
          for (const child of node.children ?? []) {
            if (selector.startsWith(".") && String(child.className).split(/\s+/).includes(selector.slice(1))) {
              out.push(child);
            } else if (String(child.tagName).toLowerCase() === selector.toLowerCase()) {
              out.push(child);
            }
            walk(child);
          }
        };
        walk(this);
        return out;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      getBoundingClientRect() {
        const { left, top, width, height } = this.rect;
        return { left, top, width, height, right: left + width, bottom: top + height };
      },
      getContext() {
        return {
          setTransform() {},
          clearRect() {},
          fillRect() {},
          drawImage() {},
          save() {},
          restore() {},
        };
      },
      setPointerCapture(id) {
        capturedPointers.set(id, this);
      },
      releasePointerCapture(id) {
        if (capturedPointers.get(id) === this) capturedPointers.delete(id);
      },
      addEventListener(type, handler, capture = false) {
        const cap = capture === true || Boolean(capture?.capture);
        const list = this.listeners.get(type) ?? [];
        list.push({ handler, capture: cap });
        this.listeners.set(type, list);
        listenersByNode.add(this);
      },
      removeEventListener(type, handler, capture = false) {
        const cap = capture === true || Boolean(capture?.capture);
        const list = this.listeners.get(type) ?? [];
        const idx = list.findIndex((entry) => entry.handler === handler && entry.capture === cap);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatchEvent(event) {
        const evt = {
          ...event,
          target: this,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {
            this.propagationStopped = true;
          },
        };
        const pathNodes = [];
        for (let cur = this; cur; cur = cur.parentNode) pathNodes.push(cur);
        // Capture phase (root -> target)
        for (let i = pathNodes.length - 1; i >= 0; i -= 1) {
          if (evt.propagationStopped) break;
          const node = pathNodes[i];
          const entries = [...(node.listeners.get(evt.type) ?? [])].filter((e) => e.capture);
          for (const entry of entries) {
            evt.currentTarget = node;
            entry.handler(evt);
          }
        }
        // Bubble phase (target -> root)
        for (let i = 0; i < pathNodes.length; i += 1) {
          if (evt.propagationStopped) break;
          const node = pathNodes[i];
          const entries = [...(node.listeners.get(evt.type) ?? [])].filter((e) => !e.capture);
          for (const entry of entries) {
            evt.currentTarget = node;
            entry.handler(evt);
          }
        }
        return !evt.defaultPrevented;
      },
    };
    return el;
  };

  const doc = makeEl("#document", null);
  doc.ownerDocument = doc;
  doc.readyState = "complete";
  doc.documentElement = makeEl("html", doc);
  doc.documentElement.lang = lang;
  doc.documentElement.parentNode = doc;
  doc.head = makeEl("head", doc);
  doc.head.parentNode = doc.documentElement;
  doc.body = makeEl("body", doc);
  doc.body.parentNode = doc.documentElement;
  doc.documentElement.children.push(doc.head, doc.body);
  doc.children.push(doc.documentElement);
  doc.createElement = (tag) => makeEl(tag, doc);
  doc.getElementById = (id) => {
    const stack = [...doc.children];
    while (stack.length) {
      const node = stack.shift();
      if (node.id === id) return node;
      if (node.children?.length) stack.push(...node.children);
    }
    return null;
  };
  doc.totalListenerCount = () => {
    let total = 0;
    for (const node of listenersByNode) {
      for (const list of node.listeners.values()) total += list.length;
    }
    return total;
  };
  doc.docEditorListenerCount = () => {
    let total = 0;
    for (const type of ["pointermove", "pointerup", "pointercancel", "keydown"]) {
      total += (doc.listeners.get(type) ?? []).length;
    }
    return total;
  };
  doc.activePointerCaptures = () => capturedPointers.size;

  const win = {
    document: doc,
    devicePixelRatio: 1,
    Object,
    addEventListener(type, handler, cap) {
      doc.addEventListener(type, handler, cap);
    },
    removeEventListener(type, handler, cap) {
      doc.removeEventListener(type, handler, cap);
    },
  };
  doc.defaultView = win;
  return { doc, win };
}

/** Creates an operator list yielding one image figure rect (or empty when regions = []). */
function buildAutoDetectOps(figRect = [80, 460, 300, 640], captionText = "Figure 1: Pipeline") {
  // Image XObject CTM in PDF units: [w, 0, 0, h, x0, y0]
  const w = figRect[2] - figRect[0];
  const h = figRect[3] - figRect[1];
  const x0 = figRect[0];
  const y0 = figRect[1];
  const fnArray = [
    MEASURED_OP_CODES.save,
    MEASURED_OP_CODES.transform,
    MEASURED_OP_CODES.paintImageXObject,
    MEASURED_OP_CODES.restore,
  ];
  const argsArray = [
    [],
    [w, 0, 0, h, x0, y0],
    ["img0", 200, 150],
    [],
  ];
  const capY = y0 - 20;
  const textItems = [
    {
      str: captionText,
      transform: [10, 0, 0, 10, x0, capY],
      width: 140,
      height: 10,
      fontName: "g_d0_f1",
    },
  ];
  return { fnArray, argsArray, textItems };
}

function makeFakeReaderHarness({
  dataDir,
  itemID = 42,
  tabID = "tab-42",
  fingerprint = "fp-editor-42",
  scale = 1.5,
  rotation = 0,
  dpr = 2,
  lang = "zh-CN",
  pageOffset = { left: 40, top: 80 },
  pages = [{ id: 1, figRect: [80, 460, 300, 640], caption: "Figure 1: Pipeline" }],
}) {
  const { doc, win } = makeViewerDom({ lang });
  win.devicePixelRatio = dpr;

  const counters = { getOperatorList: 0, getTextContent: 0, renderCalls: 0 };
  const pageViews = pages.map((spec, idx) => {
    const viewBounds = spec.view ?? [0, 0, 612, 792];
    const viewport = buildPdfViewport({ view: viewBounds, scale, rotation });
    const div = doc.createElement("div");
    div.className = "page";
    div.rect = {
      left: pageOffset.left,
      top: pageOffset.top + idx * (viewport.height + 24),
      width: viewport.width,
      height: viewport.height,
    };
    doc.body.appendChild(div);

    const opsPayload = spec.figRect ? buildAutoDetectOps(spec.figRect, spec.caption) : { fnArray: [], argsArray: [], textItems: [] };
    const pdfPage = {
      pageNumber: spec.id,
      view: viewBounds,
      getViewport({ scale: reqScale = scale, rotation: reqRot = rotation } = {}) {
        return buildPdfViewport({ view: viewBounds, scale: reqScale, rotation: reqRot });
      },
      async getOperatorList() {
        counters.getOperatorList += 1;
        return { fnArray: opsPayload.fnArray, argsArray: opsPayload.argsArray };
      },
      async getTextContent() {
        counters.getTextContent += 1;
        return { items: opsPayload.textItems };
      },
      render() {
        counters.renderCalls += 1;
        return { promise: Promise.resolve(), cancel() {} };
      },
    };
    return {
      id: spec.id,
      div,
      pdfPage,
      viewport,
      renderingState: 3,
    };
  });

  const busListeners = new Map();
  const eventBus = {
    on(name, fn) {
      const set = busListeners.get(name) ?? new Set();
      set.add(fn);
      busListeners.set(name, set);
    },
    off(name, fn) {
      busListeners.get(name)?.delete(fn);
    },
    emit(name, payload) {
      for (const fn of [...(busListeners.get(name) ?? [])]) fn(payload);
    },
  };

  const pdfDocument = {
    numPages: pageViews.length,
    fingerprints: [fingerprint],
  };

  const pdfViewer = {
    _pages: pageViews,
    pdfDocument,
    currentPageNumber: pageViews[0]?.id ?? 1,
    currentScale: scale,
    _setViewport({ scale: nextScale = scale, rotation: nextRot = rotation } = {}) {
      for (let i = 0; i < pageViews.length; i += 1) {
        const pv = pageViews[i];
        const vp = buildPdfViewport({ view: pv.pdfPage.view, scale: nextScale, rotation: nextRot });
        pv.viewport = vp;
        pv.div.rect = {
          left: pageOffset.left,
          top: pageOffset.top + i * (vp.height + 24),
          width: vp.width,
          height: vp.height,
        };
      }
      pdfViewer.currentScale = nextScale;
    },
  };

  win.PDFViewerApplication = {
    pdfViewer,
    pdfDocument,
    eventBus,
  };

  const iframeEl = {
    rect: { left: 10, top: 20, width: 1200, height: 900 },
    getBoundingClientRect() {
      return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height };
    },
  };

  const reader = {
    itemID,
    tabID,
    _iframeWindow: { document: doc },
    _internalReader: {
      _primaryView: {
        _iframe: iframeEl,
        _iframeWindow: win,
      },
    },
  };

  const toolbarDoc = makeViewerDom({ lang }).doc;
  const toolbarContainer = toolbarDoc.createElement("div");
  toolbarDoc.body.appendChild(toolbarContainer);

  return {
    dataDir,
    reader,
    iframeEl,
    doc,
    win,
    toolbarDoc,
    toolbarContainer,
    pageViews,
    pdfViewer,
    eventBus,
    counters,
    renderToolbar(zoteroHandlers) {
      const handler = zoteroHandlers.get(TOOLBAR_EVENT);
      handler?.({
        reader,
        doc: toolbarDoc,
        append(node) {
          toolbarContainer.appendChild(node);
        },
      });
    },
    openContextMenuAtClient(zoteroHandlers, clientX, clientY, { pageView = pageViews[0], includeDomEvent = true, passParamsXY = true } = {}) {
      if (includeDomEvent) {
        pageView.div.dispatchEvent({ type: "contextmenu", clientX, clientY });
      }
      const appended = [];
      const handler = zoteroHandlers.get(CONTEXT_MENU_EVENT);
      const ir = iframeEl.getBoundingClientRect();
      handler?.({
        reader,
        doc: toolbarDoc,
        params: passParamsXY ? { x: ir.left + clientX, y: ir.top + clientY } : {},
        append(...items) {
          appended.push(...items);
        },
      });
      return appended;
    },
  };
}

function installMultiReaderZotero({ dataDir, readersByTab, locale = "zh-CN", activeTabID = null } = {}) {
  const registered = new Map();
  let currentActive = activeTabID ?? Object.keys(readersByTab)[0] ?? null;
  globalThis.Zotero_Tabs = {
    get selectedID() {
      return currentActive;
    },
  };
  globalThis.Zotero = {
    locale,
    DataDirectory: { dir: dataDir },
    debug() {},
    getMainWindow() {
      return { Zotero_Tabs: globalThis.Zotero_Tabs };
    },
    getMainWindows() {
      return [];
    },
    Reader: {
      registerEventListener(type, handler) {
        registered.set(type, handler);
      },
      unregisterEventListener(type, handler) {
        if (registered.get(type) === handler) registered.delete(type);
      },
      getByTabID(tabId) {
        return readersByTab[tabId] ?? null;
      },
      getActive() {
        return readersByTab[currentActive] ?? null;
      },
    },
    Notifier: {
      registerObserver() {
        return "notif-1";
      },
      unregisterObserver() {},
    },
  };
  return {
    registered,
    setActiveTab(tabId) {
      currentActive = tabId;
    },
  };
}

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("viewport: reverse pointer -> viewport -> PDF coordinates", () => {
  it("round-trips rects accurately across zoom scales, CropBox offsets, and all 4 rotations without DPR leakage", () => {
    const samplePdfRect = [84.25, 420.5, 310.75, 650.125];
    const bounds = [40, 50, 620, 810];

    for (const scale of [0.75, 1, 1.5, 2.5]) {
      for (const rotation of [0, 90, 180, 270]) {
        const viewport = buildPdfViewport({ view: bounds, scale, rotation });
        const vpRect = toViewportRect(samplePdfRect, viewport);
        const cssBox = cssBoxFromViewportRect(vpRect, viewport);
        assert.ok(cssBox && cssBox.width > 0 && cssBox.height > 0);

        const roundTripped = toPdfRect([cssBox.left, cssBox.top, cssBox.right, cssBox.bottom], viewport, bounds);
        assert.ok(roundTripped, `round-trip failed for scale=${scale}, rot=${rotation}`);
        for (let i = 0; i < 4; i += 1) {
          assert.ok(
            Math.abs(roundTripped[i] - samplePdfRect[i]) < 1e-3,
            `coord ${i} drift at scale=${scale}, rot=${rotation}: ${roundTripped[i]} vs ${samplePdfRect[i]}`,
          );
        }

        // Matrix inversion fallback matches convertToPdfPoint identically.
        const matrixOnly = { width: viewport.width, height: viewport.height, transform: viewport.transform };
        assert.deepEqual(
          toPdfPoint([vpRect[0], vpRect[1]], viewport),
          toPdfPoint([vpRect[0], vpRect[1]], matrixOnly),
        );
      }
    }
  });

  it("maps client pointer coordinates accounting for page offsets, scroll, CSS scale, and zero DPR distortion", () => {
    const viewport = buildPdfViewport({ view: [0, 0, 600, 800], scale: 1.5, rotation: 0 });
    const pageRect = { left: 120, top: 60, width: 900, height: 1200 };
    const pt = clientPointToViewportPoint({
      clientX: 270,
      clientY: 360,
      pageRect,
      scrollLeft: 15,
      scrollTop: 40,
      viewport,
    });
    assert.deepEqual(pt, [165, 340]);

    // When CSS element size differs from viewport size, clientPoint scales cleanly without DPR.
    const scaledPageRect = { left: 0, top: 0, width: 450, height: 600 };
    assert.deepEqual(
      clientPointToViewportPoint({ clientX: 225, clientY: 300, pageRect: scaledPageRect, viewport }),
      [450, 600],
    );
  });
});

describe("region-editor: 4-corner drag math", () => {
  it("anchors the opposite corner strictly and clamps within page bounds + minimum size for all 4 corners", () => {
    const initialBox = { left: 100, top: 120, right: 300, bottom: 280 };

    const nw = resizeCssBoxByCorner({ initialBox, corner: "nw", deltaX: -25, deltaY: -30, viewportWidth: 600, viewportHeight: 800 });
    assert.deepEqual(nw, { left: 75, top: 90, right: 300, bottom: 280, width: 225, height: 190 });

    const ne = resizeCssBoxByCorner({ initialBox, corner: "ne", deltaX: 50, deltaY: -20, viewportWidth: 600, viewportHeight: 800 });
    assert.deepEqual(ne, { left: 100, top: 100, right: 350, bottom: 280, width: 250, height: 180 });

    const sw = resizeCssBoxByCorner({ initialBox, corner: "sw", deltaX: -40, deltaY: 45, viewportWidth: 600, viewportHeight: 800 });
    assert.deepEqual(sw, { left: 60, top: 120, right: 300, bottom: 325, width: 240, height: 205 });

    const se = resizeCssBoxByCorner({ initialBox, corner: "se", deltaX: 500, deltaY: 900, viewportWidth: 600, viewportHeight: 800 });
    assert.deepEqual(se, { left: 100, top: 120, right: 600, bottom: 800, width: 500, height: 680 });

    // Pulling nw past se cannot invert rectangle or violate minSize.
    const clamped = resizeCssBoxByCorner({ initialBox, corner: "nw", deltaX: 999, deltaY: 999, viewportWidth: 600, viewportHeight: 800, minSize: 8 });
    assert.equal(clamped.right, 300);
    assert.equal(clamped.bottom, 280);
    assert.equal(clamped.left, 292);
    assert.equal(clamped.top, 272);
  });
});

describe("region-editor: Zotero context menu, interactive editing, persistence & lifecycle", () => {
  it("registers and unregisters createViewContextMenu cleanly, serves localized actions without replacing Zotero menus", async () => {
    const dataDir = await makeTempDir();
    installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({ dataDir, dpr: 2, scale: 1.5, lang: "zh-CN" });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
      locale: "zh-CN",
    });

    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    assert.equal(typeof registered.get(TOOLBAR_EVENT), "function");
    assert.equal(typeof registered.get(CONTEXT_MENU_EVENT), "function");

    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    // Right-click inside auto figure [80, 460, 300, 640] (converted to screen client coords).
    const vpRect = toViewportRect([80, 460, 300, 640], harness.pageViews[0].viewport);
    const pr = harness.pageViews[0].div.getBoundingClientRect();
    const insideX = pr.left + (vpRect[0] + vpRect[2]) / 2;
    const insideY = pr.top + (vpRect[1] + vpRect[3]) / 2;

    const autoItems = harness.openContextMenuAtClient(registered, insideX, insideY);
    assert.deepEqual(
      autoItems.map((i) => i.label),
      ["调整原色范围…", "取消此图原色保护", "手动添加原色区域…"],
      "auto region without override must NOT show Reset to Automatic Region",
    );

    // Overlay canvas stays pointer-events: none so native selection/annotations remain clickable.
    const canvases = harness.pageViews[0].div.querySelectorAll(`.${OVERLAY_CLASS}`);
    assert.equal(canvases.length, 1);
    assert.equal(canvases[0].style.pointerEvents, "none");

    // Empty page area shows Add Original Color Region only.
    const emptyItems = harness.openContextMenuAtClient(registered, pr.left + 10, pr.top + 10);
    assert.deepEqual(emptyItems.map((i) => i.label), ["手动添加原色区域…"]);

    // Params.{x, y} fallback works even if passive contextmenu listener did not fire beforehand.
    const fallbackItems = harness.openContextMenuAtClient(registered, insideX, insideY, {
      includeDomEvent: false,
      passParamsXY: true,
    });
    assert.deepEqual(fallbackItems.map((i) => i.label), ["调整原色范围…", "取消此图原色保护", "手动添加原色区域…"]);

    // Outside any page bounds appends zero items.
    const outsideItems = harness.openContextMenuAtClient(registered, 2, 2);
    assert.equal(outsideItems.length, 0);

    // Shutdown cleanly unregisters both events.
    await shutdown();
    assert.equal(registered.has(TOOLBAR_EVENT), false);
    assert.equal(registered.has(CONTEXT_MENU_EVENT), false);
  });

  it("supports English localization and disables context actions when Original color mode is off", async () => {
    const dataDir = await makeTempDir();
    installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({ dataDir, lang: "en-US", scale: 1 });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
      locale: "en-US",
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    const vpRect = toViewportRect([80, 460, 300, 640], harness.pageViews[0].viewport);
    const pr = harness.pageViews[0].div.getBoundingClientRect();
    const itemsEn = harness.openContextMenuAtClient(
      registered,
      pr.left + (vpRect[0] + vpRect[2]) / 2,
      pr.top + (vpRect[1] + vpRect[3]) / 2,
    );
    assert.deepEqual(
      itemsEn.map((i) => i.label),
      ["Adjust Original Color Region…", "Remove Original Color Protection", "Add Original Color Region…"],
    );

    setEnabled(false);
    const disabledItems = harness.openContextMenuAtClient(
      registered,
      pr.left + (vpRect[0] + vpRect[2]) / 2,
      pr.top + (vpRect[1] + vpRect[3]) / 2,
    );
    assert.equal(disabledItems.length, 0);
  });

  it("completes 4-corner adjust without detection/render/DPR/PAD drift during drag, persists across restart, and supports repeated adjustment without duplicates", async () => {
    const dataDir = await makeTempDir();
    const ioStats = installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({
      dataDir,
      dpr: 2.5,
      scale: 1.5,
      rotation: 90,
      pageOffset: { left: 30, top: 50 },
    });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
    });

    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    assert.equal(harness.counters.getOperatorList, 1, "initial cold page detection runs once");
    assert.equal(harness.counters.renderCalls, 1, "initial render runs once");
    const writesAfterInit = ioStats.writes;

    const pv = harness.pageViews[0];
    const pr = pv.div.getBoundingClientRect();
    const initVp = toViewportRect([80, 460, 300, 640], pv.viewport);
    const centerClientX = pr.left + (initVp[0] + initVp[2]) / 2;
    const centerClientY = pr.top + (initVp[1] + initVp[3]) / 2;

    const items = harness.openContextMenuAtClient(registered, centerClientX, centerClientY);
    items[0].onCommand();
    assert.equal(session.editor.hasActiveEditor(), true);

    // Editor box sits at exact viewport coordinates with ZERO PAD_VIEWPORT or DPR scaling!
    const boxEl = pv.div.querySelector(`.${EDITOR_BOX_CLASS}`);
    assert.ok(boxEl);
    assert.equal(Number.parseFloat(boxEl.style.left), initVp[0]);
    assert.equal(Number.parseFloat(boxEl.style.top), initVp[1]);
    assert.equal(Number.parseFloat(boxEl.style.width), initVp[2] - initVp[0]);
    assert.equal(Number.parseFloat(boxEl.style.height), initVp[3] - initVp[1]);
    assert.ok(PAD_VIEWPORT > 0, "sanity check overlay padViewport exists separately");

    // Drag southeast handle by (+30, +45) CSS px.
    const seHandle = pv.div.querySelectorAll(`.${EDITOR_HANDLE_CLASS}`).find((h) => h.getAttribute("data-corner") === "se");
    assert.ok(seHandle);
    const handleStartX = pr.left + initVp[2];
    const handleStartY = pr.top + initVp[3];
    seHandle.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 11, clientX: handleStartX, clientY: handleStartY });
    harness.doc.dispatchEvent({ type: "pointermove", pointerId: 11, clientX: handleStartX + 30, clientY: handleStartY + 45 });
    harness.doc.dispatchEvent({ type: "pointerup", pointerId: 11, clientX: handleStartX + 30, clientY: handleStartY + 45 });

    // During drag: CSS updated, NO detection, NO pdf render, NO disk write yet!
    assert.equal(Number.parseFloat(boxEl.style.width), initVp[2] - initVp[0] + 30);
    assert.equal(Number.parseFloat(boxEl.style.height), initVp[3] - initVp[1] + 45);
    assert.equal(harness.counters.getOperatorList, 1, "no detection during drag");
    assert.equal(harness.counters.renderCalls, 1, "no render during drag");
    assert.equal(ioStats.writes, writesAfterInit, "no JSON write until Confirm");
    assert.equal(harness.doc.activePointerCaptures(), 0, "pointer capture released on pointerup");

    // Confirm commits rotated + DPR-free PDF user-space bbox!
    const expectedPdf = toPdfRect([initVp[0], initVp[1], initVp[2] + 30, initVp[3] + 45], pv.viewport, pv.pdfPage.view);
    const confirmBtn = pv.div.querySelector(`.${EDITOR_CONFIRM_CLASS}`);
    confirmBtn.dispatchEvent({ type: "click" });
    await flushMicrotasks();

    assert.equal(session.editor.hasActiveEditor(), false);
    assert.equal(pv.div.querySelector(`.${EDITOR_LAYER_CLASS}`), null, "editor DOM removed cleanly");
    assert.equal(harness.counters.getOperatorList, 1, "confirm MUST NOT re-run figure detection");
    assert.equal(harness.counters.renderCalls, 2, "overlay re-painted immediately on confirm");
    assert.equal(ioStats.writes, writesAfterInit + 1);

    // Effective regions updated cleanly, and right-clicking again shows Reset AND adjusts in-place!
    const eff1 = await getEffectiveRegions(session, 1);
    assert.equal(eff1.regions.length, 1);
    assert.deepEqual(eff1.regions[0].rect, expectedPdf);
    assert.equal(eff1.regions[0].origin, "manual-replace");

    const updatedVp = toViewportRect(expectedPdf, pv.viewport);
    const items2 = harness.openContextMenuAtClient(
      registered,
      pr.left + (updatedVp[0] + updatedVp[2]) / 2,
      pr.top + (updatedVp[1] + updatedVp[3]) / 2,
    );
    assert.deepEqual(
      items2.map((i) => i.label),
      ["调整原色范围…", "取消此图原色保护", "恢复自动识别范围", "手动添加原色区域…"],
    );

    // Adjust a second time cleanly WITHOUT dragging handles -> confirm exact same box -> zero PAD/DPR drift, zero duplicates!
    items2[0].onCommand();
    pv.div.querySelector(`.${EDITOR_CONFIRM_CLASS}`).dispatchEvent({ type: "click" });
    await flushMicrotasks();
    const eff2 = await getEffectiveRegions(session, 1);
    assert.equal(eff2.regions.length, 1, "no duplicate regions created on repeated adjust");
    assert.equal(eff2.overrides.length, 1, "only one replace override persisted");
    for (let i = 0; i < 4; i += 1) {
      assert.ok(Math.abs(eff2.regions[0].rect[i] - expectedPdf[i]) < 1e-3, "repeated edit introduces zero drift");
    }

    // Restart simulation: shut down completely and open fresh session reading persisted JSON.
    await shutdown();
    const harnessRestart = makeFakeReaderHarness({ dataDir, dpr: 1, scale: 1.2, rotation: 90 });
    const restartZotero = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harnessRestart.reader.tabID]: harnessRestart.reader },
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harnessRestart.renderToolbar(restartZotero.registered);
    const [restartedSession] = getSessions();
    await restartedSession.start();
    await flushMicrotasks();

    assert.equal(harnessRestart.counters.getOperatorList, 0, "restart reads cached auto+override without re-detecting");
    const afterRestart = await getEffectiveRegions(restartedSession, 1);
    assert.equal(afterRestart.regions.length, 1);
    for (let i = 0; i < 4; i += 1) {
      assert.ok(Math.abs(afterRestart.regions[0].rect[i] - expectedPdf[i]) < 1e-3);
    }
  });

  it("completes manual add on an empty page, re-edits, removes without bogus suppress, and recovers suppressed auto figures", async () => {
    const dataDir = await makeTempDir();
    installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({
      dataDir,
      pages: [
        { id: 1, figRect: null }, // Empty auto-detection page
        { id: 2, figRect: [90, 400, 310, 620], caption: "Figure 2: Ablation" },
      ],
    });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    const opsBefore = harness.counters.getOperatorList;
    const pv1 = harness.pageViews[0];
    const pr1 = pv1.div.getBoundingClientRect();

    // Right-click empty page 1 -> Add Original Color Region...
    const emptyItems = harness.openContextMenuAtClient(registered, pr1.left + 60, pr1.top + 60, { pageView: pv1 });
    assert.deepEqual(emptyItems.map((i) => i.label), ["手动添加原色区域…"]);
    emptyItems[0].onCommand();

    // Draw initial rectangle [100, 120] -> [340, 300] via pointer events on backdrop.
    const backdrop = pv1.div.querySelector(`.${EDITOR_BACKDROP_CLASS}`);
    assert.ok(backdrop);
    backdrop.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 5, clientX: pr1.left + 100, clientY: pr1.top + 120 });
    harness.doc.dispatchEvent({ type: "pointermove", pointerId: 5, clientX: pr1.left + 340, clientY: pr1.top + 300 });
    harness.doc.dispatchEvent({ type: "pointerup", pointerId: 5, clientX: pr1.left + 340, clientY: pr1.top + 300 });

    // Transitions into 4-corner handles; tweak nw corner by (-20, -10) then Confirm!
    assert.equal(pv1.div.querySelector(`.${EDITOR_BACKDROP_CLASS}`), null);
    const nw = pv1.div.querySelectorAll(`.${EDITOR_HANDLE_CLASS}`).find((h) => h.getAttribute("data-corner") === "nw");
    nw.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 6, clientX: pr1.left + 100, clientY: pr1.top + 120 });
    harness.doc.dispatchEvent({ type: "pointermove", pointerId: 6, clientX: pr1.left + 80, clientY: pr1.top + 110 });
    harness.doc.dispatchEvent({ type: "pointerup", pointerId: 6, clientX: pr1.left + 80, clientY: pr1.top + 110 });

    pv1.div.querySelector(`.${EDITOR_CONFIRM_CLASS}`).dispatchEvent({ type: "click" });
    await flushMicrotasks();

    assert.equal(harness.counters.getOperatorList, opsBefore, "manual add never triggers figure detection");
    assert.equal(pv1.div.querySelectorAll(`.${OVERLAY_CLASS}`).length, 1, "manual region painted immediately on empty page");

    // Re-adjust manual addition in-place, then remove it -> removes manual-add directly without leaving suppress record!
    const effAdd = await getEffectiveRegions(session, 1);
    assert.equal(effAdd.regions.length, 1);
    assert.equal(effAdd.regions[0].origin, "manual-add");
    const addVp = toViewportRect(effAdd.regions[0].rect, pv1.viewport);
    const addCenterX = pr1.left + (addVp[0] + addVp[2]) / 2;
    const addCenterY = pr1.top + (addVp[1] + addVp[3]) / 2;

    const addMenu = harness.openContextMenuAtClient(registered, addCenterX, addCenterY, { pageView: pv1 });
    assert.deepEqual(addMenu.map((i) => i.label), [
      "调整原色范围…",
      "取消此图原色保护",
      "恢复自动识别范围",
      "手动添加原色区域…",
    ]);
    // Remove manual-add
    addMenu[1].onCommand();
    await flushMicrotasks();
    const afterRemoveAdd = await getEffectiveRegions(session, 1);
    assert.equal(afterRemoveAdd.regions.length, 0);
    assert.equal(afterRemoveAdd.overrides.length, 0, "removing manual-add leaves zero bogus suppress records");

    // Page 2: suppress auto figure -> right-click inside saved original BBox -> Reset restores protection!
    const pv2 = harness.pageViews[1];
    const pr2 = pv2.div.getBoundingClientRect();
    const p2Vp = toViewportRect([90, 400, 310, 620], pv2.viewport);
    const p2CenterX = pr2.left + (p2Vp[0] + p2Vp[2]) / 2;
    const p2CenterY = pr2.top + (p2Vp[1] + p2Vp[3]) / 2;

    const p2Menu1 = harness.openContextMenuAtClient(registered, p2CenterX, p2CenterY, { pageView: pv2 });
    p2Menu1[1].onCommand(); // Remove Original Color Protection
    await flushMicrotasks();

    const p2Suppressed = await getEffectiveRegions(session, 2);
    assert.equal(p2Suppressed.regions.length, 0);
    assert.equal(p2Suppressed.overrides[0]?.op, "suppress");
    assert.equal(pv2.div.querySelectorAll(`.${OVERLAY_CLASS}`).length, 0, "suppressed canvas removed");

    // Right-click inside original suppressed region offers Reset to Automatic Region!
    const p2RecoverMenu = harness.openContextMenuAtClient(registered, p2CenterX, p2CenterY, { pageView: pv2 });
    assert.deepEqual(p2RecoverMenu.map((i) => i.label), ["恢复自动识别范围", "手动添加原色区域…"]);
    p2RecoverMenu[0].onCommand();
    await flushMicrotasks();

    const p2Restored = await getEffectiveRegions(session, 2);
    assert.equal(p2Restored.regions.length, 1);
    assert.equal(p2Restored.overrides.length, 0);
    assert.equal(pv2.div.querySelectorAll(`.${OVERLAY_CLASS}`).length, 1, "restored canvas painted immediately");
    assert.equal(harness.counters.getOperatorList, opsBefore, "remove and reset never re-run detection");
  });

  it("shows explicit failure notice when persistence returns persisted=false instead of claiming permanent save", async () => {
    const dataDir = await makeTempDir();
    const ioStats = installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({ dataDir, scale: 1 });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    const pv = harness.pageViews[0];
    const pr = pv.div.getBoundingClientRect();
    const vp = toViewportRect([80, 460, 300, 640], pv.viewport);

    const items = harness.openContextMenuAtClient(registered, pr.left + (vp[0] + vp[2]) / 2, pr.top + (vp[1] + vp[3]) / 2);
    items[0].onCommand();

    // Inject disk write failure right before Confirm.
    ioStats.failWritesWith = new Error("EACCES: read-only directory");
    pv.div.querySelector(`.${EDITOR_CONFIRM_CLASS}`).dispatchEvent({ type: "click" });
    await flushMicrotasks();

    const notice = pv.div.querySelector(`.${EDITOR_NOTICE_CLASS}`);
    assert.ok(notice, "must render explicit failure notice when persisted=false");
    assert.match(notice.textContent, /保存失败|仅本次会话/);
  });

  it("safely cancels active uncommitted editor on Cancel, Esc, second editor, zoom/scale change, disable, tab switch, and close with zero leaks or JSON writes", async () => {
    const dataDir = await makeTempDir();
    const ioStats = installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({ dataDir, scale: 1 });
    const { registered, setActiveTab } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    const pv = harness.pageViews[0];
    const pr = pv.div.getBoundingClientRect();
    const baselineListeners = harness.doc.docEditorListenerCount();
    const baselineWrites = ioStats.writes;

    const verifyCleanExit = () => {
      assert.equal(session.editor.hasActiveEditor(), false);
      assert.equal(pv.div.querySelector(`.${EDITOR_LAYER_CLASS}`), null, "zero leftover editor layers");
      assert.equal(harness.doc.docEditorListenerCount(), baselineListeners, "zero leaked document listeners");
      assert.equal(harness.doc.activePointerCaptures(), 0, "zero dangling pointer captures");
      assert.equal(ioStats.writes, baselineWrites, "uncommitted edit never writes JSON");
    };

    // 1. Cancel button after dragging a handle
    session.startAdjustRegion({ pageNumber: 1, pageView: pv, region: { rect: [80, 460, 300, 640] } });
    const se = pv.div.querySelectorAll(`.${EDITOR_HANDLE_CLASS}`).find((h) => h.getAttribute("data-corner") === "se");
    se.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 1, clientX: pr.left + 300, clientY: pr.top + 332 });
    harness.doc.dispatchEvent({ type: "pointermove", pointerId: 1, clientX: pr.left + 350, clientY: pr.top + 380 });
    pv.div.querySelector(`.${EDITOR_CANCEL_CLASS}`).dispatchEvent({ type: "click" });
    verifyCleanExit();

    // 2. Escape key while actively capturing pointer!
    session.startAdjustRegion({ pageNumber: 1, pageView: pv, region: { rect: [80, 460, 300, 640] } });
    const nw = pv.div.querySelectorAll(`.${EDITOR_HANDLE_CLASS}`).find((h) => h.getAttribute("data-corner") === "nw");
    nw.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 2, clientX: pr.left + 80, clientY: pr.top + 152 });
    harness.doc.dispatchEvent({ type: "keydown", key: "Escape" });
    verifyCleanExit();

    // 3. Single active editor invariant: starting a second edit tears down the first cleanly.
    session.startAdjustRegion({ pageNumber: 1, pageView: pv, region: { rect: [80, 460, 300, 640] } });
    session.startAddRegion({ pageNumber: 1, pageView: pv });
    assert.equal(pv.div.querySelectorAll(`.${EDITOR_LAYER_CLASS}`).length, 1);

    // 4. Zoom / viewport scale change cancels cleanly.
    harness.pdfViewer._setViewport({ scale: 2, rotation: 0 });
    session.onViewScaleChange();
    verifyCleanExit();

    // 5. Tab background pause cancels cleanly.
    session.startAddRegion({ pageNumber: 1, pageView: pv });
    setActiveTab("other-tab");
    session.pauseBackgroundWork();
    verifyCleanExit();
    setActiveTab(harness.reader.tabID);

    // 6. Disabling Original color cancels cleanly.
    session.startAddRegion({ pageNumber: 1, pageView: pv });
    setEnabled(false);
    verifyCleanExit();
    setEnabled(true);
    await flushMicrotasks();

    // 7. Closing / destroying reader cancels active editor cleanly and detaches context listener too.
    session.startAddRegion({ pageNumber: 1, pageView: pv });
    session.destroy();
    verifyCleanExit();
    assert.equal(harness.doc.totalListenerCount(), 0, "all session/editor listeners unbound after destroy");
  });

  it("isolates hit testing, context menus, and editors cleanly across concurrent reader tabs", async () => {
    const dataDir = await makeTempDir();
    installGeckoFsShim(dataDir);
    const tabA = makeFakeReaderHarness({
      dataDir,
      itemID: 101,
      tabID: "tab-a",
      fingerprint: "fp-tab-a",
      scale: 1,
      pages: [{ id: 1, figRect: [50, 450, 260, 650] }],
    });
    const tabB = makeFakeReaderHarness({
      dataDir,
      itemID: 202,
      tabID: "tab-b",
      fingerprint: "fp-tab-b",
      scale: 1,
      pages: [{ id: 1, figRect: [300, 100, 520, 320] }],
    });
    const { registered, setActiveTab } = installMultiReaderZotero({
      dataDir,
      readersByTab: { "tab-a": tabA.reader, "tab-b": tabB.reader },
      activeTabID: "tab-a",
    });

    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    tabA.renderToolbar(registered);
    tabB.renderToolbar(registered);
    const sessionsList = getSessions();
    assert.equal(sessionsList.length, 2);
    await sessionsList[0].start();
    await sessionsList[1].start();
    setActiveTab("tab-b");
    await sessionsList[1].repaintAttached();
    await flushMicrotasks();

    // Back to tab A -> context menu hits Tab A figure only, NOT Tab B's figure coords!
    setActiveTab("tab-a");
    sessionsList[0].onTabActivate();
    await flushMicrotasks();

    const pvA = tabA.pageViews[0];
    const prA = pvA.div.getBoundingClientRect();
    const vpBInA = toViewportRect([300, 100, 520, 320], pvA.viewport);
    const missInA = tabA.openContextMenuAtClient(
      registered,
      prA.left + (vpBInA[0] + vpBInA[2]) / 2,
      prA.top + (vpBInA[1] + vpBInA[3]) / 2,
    );
    assert.deepEqual(missInA.map((i) => i.label), ["手动添加原色区域…"], "Tab B figure must not hit inside Tab A");

    const vpA = toViewportRect([50, 450, 260, 650], pvA.viewport);
    const hitInA = tabA.openContextMenuAtClient(
      registered,
      prA.left + (vpA[0] + vpA[2]) / 2,
      prA.top + (vpA[1] + vpA[3]) / 2,
    );
    hitInA[0].onCommand();
    assert.equal(sessionsList[0].editor.hasActiveEditor(), true);
    assert.equal(sessionsList[1].editor.hasActiveEditor(), false, "Tab B editor remains inactive");

    // Switching to Tab B and pausing Tab A cancels Tab A's active editor cleanly while Tab B remains unaffected.
    sessionsList[0].pauseBackgroundWork();
    setActiveTab("tab-b");
    sessionsList[1].onTabActivate();
    assert.equal(sessionsList[0].editor.hasActiveEditor(), false);

    // Tab B context menu hits Tab B figure cleanly.
    const pvB = tabB.pageViews[0];
    const prB = pvB.div.getBoundingClientRect();
    const vpB = toViewportRect([300, 100, 520, 320], pvB.viewport);
    const hitInB = tabB.openContextMenuAtClient(
      registered,
      prB.left + (vpB[0] + vpB[2]) / 2,
      prB.top + (vpB[1] + vpB[3]) / 2,
    );
    assert.deepEqual(hitInB.map((i) => i.label), ["调整原色范围…", "取消此图原色保护", "手动添加原色区域…"]);
  });

  it("ignores tiny accidental click in add-draw mode and resolves overlapping manual vs auto regions accurately under scroll", async () => {
    const dataDir = await makeTempDir();
    installGeckoFsShim(dataDir);
    const harness = makeFakeReaderHarness({
      dataDir,
      scale: 1,
      pages: [{ id: 1, figRect: [50, 400, 400, 700] }],
    });
    const { registered } = installMultiReaderZotero({
      dataDir,
      readersByTab: { [harness.reader.tabID]: harness.reader },
    });
    startup({ id: "figure-guard@zotero.org", version: "0.7.5" });
    await flushMicrotasks();
    harness.renderToolbar(registered);
    const [session] = getSessions();
    await session.start();
    await flushMicrotasks();

    const pv = harness.pageViews[0];
    pv.div.scrollLeft = 20;
    pv.div.scrollTop = 30;
    const pr = pv.div.getBoundingClientRect();

    // Start manual add and perform tiny 1x1 click -> remains in draw stage without committing/crashing.
    session.startAddRegion({ pageNumber: 1, pageView: pv });
    const backdrop = pv.div.querySelector(`.${EDITOR_BACKDROP_CLASS}`);
    assert.ok(backdrop);
    backdrop.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 1, clientX: pr.left + 120, clientY: pr.top + 120 });
    harness.doc.dispatchEvent({ type: "pointerup", pointerId: 1, clientX: pr.left + 121, clientY: pr.top + 121 });
    assert.ok(pv.div.querySelector(`.${EDITOR_BACKDROP_CLASS}`), "tiny click keeps draw backdrop active");

    // Drag a smaller manual box strictly inside auto figure [50, 400, 400, 700] (viewport top [92..392]).
    backdrop.dispatchEvent({ type: "pointerdown", button: 0, pointerId: 2, clientX: pr.left + 140, clientY: pr.top + 180 });
    harness.doc.dispatchEvent({ type: "pointermove", pointerId: 2, clientX: pr.left + 240, clientY: pr.top + 280 });
    harness.doc.dispatchEvent({ type: "pointerup", pointerId: 2, clientX: pr.left + 240, clientY: pr.top + 280 });
    pv.div.querySelector(`.${EDITOR_CONFIRM_CLASS}`).dispatchEvent({ type: "click" });
    await flushMicrotasks();

    // Verify both effective regions exist; clicking inside overlap prioritizes manual-add (shows Reset!),
    // while clicking outside manual-add inside auto selects auto (NO Reset!).
    const eff = await getEffectiveRegions(session, 1);
    assert.equal(eff.regions.length, 2);
    const manRegion = eff.regions.find((r) => r.origin === "manual-add");
    const manVp = toViewportRect(manRegion.rect, pv.viewport);
    const insideManualClientX = pr.left - pv.div.scrollLeft + (manVp[0] + manVp[2]) / 2;
    const insideManualClientY = pr.top - pv.div.scrollTop + (manVp[1] + manVp[3]) / 2;
    const manualHitMenu = harness.openContextMenuAtClient(registered, insideManualClientX, insideManualClientY);
    assert.deepEqual(manualHitMenu.map((i) => i.label), [
      "调整原色范围…",
      "取消此图原色保护",
      "恢复自动识别范围",
      "手动添加原色区域…",
    ]);

    const autoVp = toViewportRect([50, 400, 400, 700], pv.viewport);
    const onlyAutoClientX = pr.left - pv.div.scrollLeft + autoVp[0] + 10;
    const onlyAutoClientY = pr.top - pv.div.scrollTop + autoVp[1] + 10;
    const autoHitMenu = harness.openContextMenuAtClient(registered, onlyAutoClientX, onlyAutoClientY);
    assert.deepEqual(autoHitMenu.map((i) => i.label), [
      "调整原色范围…",
      "取消此图原色保护",
      "手动添加原色区域…",
    ]);
  });
});
