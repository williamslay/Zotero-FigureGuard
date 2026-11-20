import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DETECTOR_CACHE_REVISION,
  MEASURED_OP_CODES,
  PERSISTENT_SCHEMA_VERSION,
  RegionCache,
  scopedDocumentId,
} from "../../src/core/index.js";
import { PageOverlay, getWarnLog, resetWarnOnce } from "../../src/zotero/overlay.js";
import {
  PersistentFigureStore,
  documentMatches,
  normalizeAttachmentIdentity,
  resolveAttachmentIdentity,
} from "../../src/zotero/persistent-figure-store.js";
import { ReaderSession } from "../../src/zotero/reader-session.js";
import {
  addRegion,
  clearCache,
  getEffectiveRegions,
  getPersistentStore,
  getSessions,
  invalidateAutoCache,
  replaceRegion,
  resetOverride,
  shutdown,
  startup,
  suppressRegion,
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
    // Ignore shutdown errors on uninitialized runs.
  }
  globalThis.Zotero = savedGlobals.Zotero;
  globalThis.Zotero_Tabs = savedGlobals.Zotero_Tabs;
  globalThis.IOUtils = savedGlobals.IOUtils;
  globalThis.PathUtils = savedGlobals.PathUtils;
  resetWarnOnce();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fg-persist-"));
  tempDirs.push(dir);
  return dir;
}

/** Node-backed Gecko `IOUtils` + `PathUtils` adapter exercising real disk atomic IO. */
function installGeckoFsShim(dataDir, statsRecorder = null) {
  const rec = statsRecorder ?? { exists: 0, reads: 0, writes: 0, moves: 0, mkdirs: 0, failWritesWith: null };
  globalThis.PathUtils = {
    join: (...parts) => path.join(...parts),
  };
  globalThis.IOUtils = {
    async exists(targetPath) {
      rec.exists += 1;
      try {
        await stat(targetPath);
        return true;
      } catch {
        return false;
      }
    },
    async readUTF8(targetPath) {
      rec.reads += 1;
      return readFile(targetPath, "utf8");
    },
    async makeDirectory(dirPath) {
      rec.mkdirs += 1;
      await mkdir(dirPath, { recursive: true });
    },
    async writeUTF8(targetPath, content, options = {}) {
      rec.writes += 1;
      if (rec.failWritesWith) {
        throw rec.failWritesWith;
      }
      if (options?.tmpPath) {
        await writeFile(options.tmpPath, content, "utf8");
        await rename(options.tmpPath, targetPath);
      } else {
        await writeFile(targetPath, content, "utf8");
      }
      return content.length;
    },
    async move(srcPath, destPath) {
      rec.moves += 1;
      await rename(srcPath, destPath);
    },
    async stat(targetPath) {
      const info = await stat(targetPath);
      return { size: info.size, lastModified: Math.round(info.mtimeMs) };
    },
  };
  return rec;
}

function fakeCanvasElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    style: {},
    width: 0,
    height: 0,
    dataset: {},
    parentNode: null,
    isConnected: false,
    className: "",
    type: "",
    textContent: "",
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.get(k) ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
    removeChild(child) {
      if (child) {
        child.parentNode = null;
        child.isConnected = false;
      }
    },
    getContext() {
      return { setTransform() {}, clearRect() {}, fillRect() {}, fillStyle: "" };
    },
  };
}

function makeFakePage({
  pageNumber = 1,
  withFigure = true,
  figureRect = [100, 460, 340, 620],
  captionText = "Figure 1: System overview showing cache pipeline.",
  onGetOperatorList = null,
} = {}) {
  const [x0, y0, x1, y1] = figureRect;
  const w = x1 - x0;
  const h = y1 - y0;
  const opCalls = { count: 0 };

  const div = {
    style: {},
    isConnected: true,
    children: [],
    appendChild(node) {
      node.parentNode = div;
      node.isConnected = true;
      div.children.push(node);
    },
    removeChild(node) {
      node.parentNode = null;
      node.isConnected = false;
      div.children = div.children.filter((c) => c !== node);
    },
  };

  const innerWin = {
    devicePixelRatio: 2,
    document: {
      head: { appendChild() {} },
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      createElement: () => fakeCanvasElement(),
    },
  };

  const pageView = {
    id: pageNumber,
    div,
    viewport: {
      scale: 1,
      width: 612,
      height: 792,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      transform: [1, 0, 0, -1, 0, 792],
      convertToViewportPoint: (x, y) => [x, 792 - y],
    },
    pdfPage: {
      view: [0, 0, 612, 792],
      getViewport: ({ scale = 1, rotation = 0 } = {}) => ({
        scale,
        rotation,
        width: 612 * scale,
        height: 792 * scale,
        transform: [scale, 0, 0, -scale, 0, 792 * scale],
        convertToViewportPoint: (x, y) => [x * scale, (792 - y) * scale],
      }),
      getOperatorList: async () => {
        opCalls.count += 1;
        if (typeof onGetOperatorList === "function") await onGetOperatorList();
        if (!withFigure) return { fnArray: [], argsArray: [] };
        return {
          fnArray: [
            MEASURED_OP_CODES.save,
            MEASURED_OP_CODES.transform,
            MEASURED_OP_CODES.paintImageXObject,
            MEASURED_OP_CODES.restore,
          ],
          argsArray: [[], [w, 0, 0, h, x0, y0], ["img0", w, h], []],
        };
      },
      getTextContent: async () => {
        if (!withFigure) {
          return {
            items: [
              {
                str: "Body paragraph discussing performance measurements without any caption.",
                transform: [10, 0, 0, 10, 80, 640],
                width: 420,
                height: 10,
              },
            ],
          };
        }
        return {
          items: [
            {
              str: captionText,
              transform: [9, 0, 0, 9, x0, y0 - 20],
              width: 220,
              height: 9,
            },
          ],
        };
      },
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
    },
  };

  return { pageView, innerWin, opCalls };
}

function makeFakeReaderEnv({ itemID = 101, fingerprint = "fp-alpha", pageSetup = {} } = {}) {
  const { pageView, innerWin, opCalls } = makeFakePage(pageSetup);
  const listeners = new Map();
  const eventBus = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn);
    },
  };
  const pdfDocument = {
    numPages: 10,
    fingerprints: [fingerprint],
  };
  const pdfViewer = {
    currentPageNumber: pageSetup.pageNumber ?? 1,
    pagesCount: 1,
    _pages: [pageView],
    getPageView(idx) {
      return idx === 0 ? pageView : null;
    },
  };
  innerWin.PDFViewerApplication = { eventBus, pdfViewer, pdfDocument };
  innerWin.PDFViewerApplicationOptions = {};
  const reader = {
    itemID,
    tabID: `tab-${itemID}`,
    _iframeWindow: null,
    _internalReader: { _primaryView: { _iframeWindow: innerWin } },
  };
  return { reader, innerWin, pageView, pdfDocument, pdfViewer, eventBus, opCalls };
}

describe("persistent-figure-store: identity & file matching", () => {
  it("requires valid attachmentItemID and non-provisional fingerprint", async () => {
    assert.equal(normalizeAttachmentIdentity(null), null);
    assert.equal(normalizeAttachmentIdentity({ fingerprint: "abc" }), null, "missing attachmentItemID rejected");
    assert.equal(normalizeAttachmentIdentity({ attachmentItemID: -1, fingerprint: "abc" }), null);
    assert.equal(normalizeAttachmentIdentity({ attachmentItemID: "../x", fingerprint: "abc" }), null);
    assert.equal(normalizeAttachmentIdentity({ attachmentItemID: 12, fingerprint: "fcp:doc-1" }), null, "provisional doc id rejected");
    assert.equal(normalizeAttachmentIdentity({ attachmentItemID: 12, fingerprint: "   " }), null);

    const id = normalizeAttachmentIdentity({
      attachmentItemID: 42,
      fingerprint: "fcp:deadbeef1234",
      fileSize: 1024,
      fileMtime: 1700000000000,
    });
    assert.deepEqual(id, {
      attachmentItemID: 42,
      storageKey: "42",
      fingerprint: "deadbeef1234",
      fileSize: 1024,
      fileMtime: 1700000000000,
    });

    const provisional = await resolveAttachmentIdentity({
      reader: { itemID: 99 },
      pdfDocument: {},
      docId: "fcp:doc-7",
      zotero: null,
    });
    assert.equal(provisional, null, "provisional document must not persist");
  });

  it("reads optional attachment size and mtime from Zotero item metadata without failing when unavailable", async () => {
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, "sample.pdf");
    await writeFile(pdfPath, "pdf-bytes-123456");
    installGeckoFsShim(dir);

    const zotero = {
      Items: {
        async getAsync(id) {
          return id === 55 ? { async getFilePathAsync() { return pdfPath; } } : null;
        },
      },
    };
    const resolved = await resolveAttachmentIdentity({
      reader: { itemID: 55 },
      pdfDocument: { fingerprints: ["fp-zot-55"] },
      zotero,
    });
    assert.equal(resolved.attachmentItemID, 55);
    assert.equal(resolved.fingerprint, "fp-zot-55");
    assert.equal(resolved.fileSize, 16);
    assert.equal(typeof resolved.fileMtime, "number");

    assert.equal(
      documentMatches(resolved, { ...resolved, fileSize: 999 }),
      false,
      "fileSize mismatch invalidates match",
    );
    assert.equal(
      documentMatches(resolved, { ...resolved, fileMtime: resolved.fileMtime + 5000 }),
      false,
      "fileMtime mismatch invalidates match",
    );
    assert.equal(
      documentMatches({ ...resolved, fileSize: null, fileMtime: null }, resolved),
      true,
      "unrecorded stat enriches safely when fingerprint matches",
    );
  });
});

describe("persistent-figure-store: Test A & B (cache hit + empty pages + zero re-scan)", () => {
  it("restores detected regions after restart without calling getOperatorList (Test A)", async () => {
    const dir = await makeTempDir();
    const fsStats = installGeckoFsShim(dir);
    const store1 = new PersistentFigureStore({ dataDir: dir });
    const identity = { attachmentItemID: 101, fingerprint: "fp-paper-a", fileSize: 5000, fileMtime: 100000 };

    const { pageView: pv1, innerWin: win1, opCalls: ops1 } = makeFakePage({ pageNumber: 5, withFigure: true });
    const overlay1 = new PageOverlay({
      pageView: pv1,
      innerWin: win1,
      documentId: scopedDocumentId("item:101", "fcp:fp-paper-a"),
      docId: "fcp:fp-paper-a",
      regionCache: new RegionCache(),
      persistentStore: store1,
      resolveIdentity: () => identity,
    });

    const first = await overlay1.paint();
    assert.equal(ops1.count, 1, "first open runs pdf.js extraction once");
    assert.equal(first.regions.length, 1, "detected real Figure 1 region");
    assert.equal(pv1.div.children.length, 1, "rendered original-color canvas");

    const diskPath = store1.getFilePath(101);
    const diskJson = JSON.parse(await readFile(diskPath, "utf8"));
    assert.equal(diskJson.schemaVersion, PERSISTENT_SCHEMA_VERSION);
    assert.equal(diskJson.autoCache.detectorRevision, DETECTOR_CACHE_REVISION);
    assert.equal(diskJson.autoCache.pages["5"].complete, true);
    assert.equal(diskJson.autoCache.pages["5"].regions.length, 1);

    // Restart simulation: brand new store instance, empty memory RegionCache.
    const writesAfterSession1 = fsStats.writes;
    const store2 = new PersistentFigureStore({ dataDir: dir });
    const { pageView: pv2, innerWin: win2, opCalls: ops2 } = makeFakePage({ pageNumber: 5, withFigure: true });
    const overlay2 = new PageOverlay({
      pageView: pv2,
      innerWin: win2,
      documentId: scopedDocumentId("item:101", "fcp:fp-paper-a"),
      docId: "fcp:fp-paper-a",
      regionCache: new RegionCache(),
      persistentStore: store2,
      resolveIdentity: () => identity,
    });

    const second = await overlay2.paint();
    assert.equal(ops2.count, 0, "restart hit must skip pdfPage.getOperatorList completely");
    assert.deepEqual(second.regions, first.regions);
    assert.equal(second.diagnostics.cacheSource, "persistent");
    assert.equal(pv2.div.children.length, 1, "overlay canvas still mounted on cache hit");
    assert.equal(fsStats.writes, writesAfterSession1, "clean reopen performs zero redundant writes");
  });

  it("caches empty pages as complete: true with regions: [] and skips re-scan on reopen (Test B)", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const store1 = new PersistentFigureStore({ dataDir: dir });
    const identity = { attachmentItemID: 102, fingerprint: "fp-empty-p2" };

    const { pageView: pv1, innerWin: win1, opCalls: ops1 } = makeFakePage({ pageNumber: 2, withFigure: false });
    const overlay1 = new PageOverlay({
      pageView: pv1,
      innerWin: win1,
      documentId: "item:102|fcp:fp-empty-p2",
      docId: "fcp:fp-empty-p2",
      regionCache: new RegionCache(),
      persistentStore: store1,
      resolveIdentity: () => identity,
    });

    const res1 = await overlay1.detect();
    assert.equal(ops1.count, 1);
    assert.deepEqual(res1.regions, []);

    const diskJson = JSON.parse(await readFile(store1.getFilePath(102), "utf8"));
    assert.deepEqual(diskJson.autoCache.pages["2"].complete, true);
    assert.deepEqual(diskJson.autoCache.pages["2"].regions, []);

    // Reopen with fresh store + add manual box onto cached empty page.
    const store2 = new PersistentFigureStore({ dataDir: dir });
    const { pageView: pv2, innerWin: win2, opCalls: ops2 } = makeFakePage({ pageNumber: 2, withFigure: false });
    const overlay2 = new PageOverlay({
      pageView: pv2,
      innerWin: win2,
      documentId: "item:102|fcp:fp-empty-p2",
      docId: "fcp:fp-empty-p2",
      regionCache: new RegionCache(),
      persistentStore: store2,
      resolveIdentity: () => identity,
    });

    const res2 = await overlay2.detect();
    assert.equal(ops2.count, 0, "empty page must not be re-scanned");
    assert.deepEqual(res2.regions, []);

    await store2.addRegion(identity, 2, [50, 100, 250, 300]);
    overlay2.clear();
    const res3 = await overlay2.detect();
    assert.equal(ops2.count, 0, "manual add still reuses empty autoCache without re-detecting");
    assert.deepEqual(res3.regions, [[50, 100, 250, 300]]);
  });
});

describe("persistent-figure-store: Test C & D (isolation & document replacement)", () => {
  it("isolates persistent caches and manual edits across distinct attachments sharing the same PDF fingerprint (Test C)", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const store = new PersistentFigureStore({ dataDir: dir });
    const idA = { attachmentItemID: 201, fingerprint: "fp-identical" };
    const idB = { attachmentItemID: 202, fingerprint: "fp-identical" };

    await store.savePageAutoCache(idA, 1, [{ rect: [10, 20, 110, 120], captionNumber: "1", sourceKinds: ["image"] }]);
    await store.savePageAutoCache(idB, 1, [{ rect: [10, 20, 110, 120], captionNumber: "1", sourceKinds: ["image"] }]);

    await store.addRegion(idA, 1, [300, 300, 500, 500]);
    await store.suppressRegion(idB, 1, { rect: [10, 20, 110, 120], captionNumber: "1" });

    const effA = await store.getEffectivePageRegions(idA, 1);
    const effB = await store.getEffectivePageRegions(idB, 1);
    assert.equal(effA.regions.length, 2, "attachment 201 shows auto + manual add");
    assert.equal(effB.regions.length, 0, "attachment 202 suppresses auto independently");
    assert.notEqual(store.getFilePath(201), store.getFilePath(202));

    // Provisional or missing attachmentItemID must never write a file.
    const cacheDirFilesBefore = await readdir(store.getCacheDir());
    const missingItemOverlay = new PageOverlay({
      ...makeFakePage({ pageNumber: 1 }),
      documentId: "fcp:doc-9",
      docId: "fcp:doc-9",
      regionCache: new RegionCache(),
      persistentStore: store,
      resolveIdentity: () => null,
    });
    const provisionalRes = await missingItemOverlay.detect();
    assert.equal(provisionalRes.regions.length, 1, "detection still works in memory");
    const cacheDirFilesAfter = await readdir(store.getCacheDir());
    assert.deepEqual(cacheDirFilesAfter, cacheDirFilesBefore, "provisional session must not create disk cache");
  });

  it("invalidates autoCache and archives manualOverrides without applying them when the PDF behind an attachment changes (Test D)", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);

    const oldId = { attachmentItemID: 301, fingerprint: "fp-old", fileSize: 1000, fileMtime: 100000 };
    const store1 = new PersistentFigureStore({ dataDir: dir });
    await store1.savePageAutoCache(oldId, 1, [
      { rect: [100, 460, 340, 620], captionNumber: "1", sourceKinds: ["image"] },
    ]);
    await store1.addRegion(oldId, 1, [50, 50, 150, 150], { captionNumber: "9" });

    // Scenario 1: fingerprint changes under same itemID.
    const store2 = new PersistentFigureStore({ dataDir: dir });
    const newFpId = { attachmentItemID: 301, fingerprint: "fp-new", fileSize: 1000, fileMtime: 100000 };
    let redetectCalls = 0;
    const afterFpSwap = await store2.getEffectivePageRegions(newFpId, 1, async () => {
      redetectCalls += 1;
      return [{ rect: [200, 300, 400, 500], captionNumber: "1", sourceKinds: ["path"] }];
    });
    assert.equal(redetectCalls, 1, "must re-detect when fingerprint changes");
    assert.equal(afterFpSwap.regions.length, 1, "old manual add must NOT apply to replaced document");
    assert.deepEqual(afterFpSwap.regions[0].rect, [200, 300, 400, 500]);

    const jsonAfterFpSwap = JSON.parse(await readFile(store2.getFilePath(301), "utf8"));
    assert.equal(jsonAfterFpSwap.document.fingerprint, "fp-new");
    assert.equal(Object.keys(jsonAfterFpSwap.manualOverrides.pages).length, 0);
    assert.equal(jsonAfterFpSwap.archivedOverrides.length, 1, "user's old overrides stay preserved in archive");
    assert.equal(jsonAfterFpSwap.archivedOverrides[0].document.fingerprint, "fp-old");
    assert.equal(jsonAfterFpSwap.archivedOverrides[0].pages["1"].length, 1);

    // Also tag another manual edit on fp-new, then change ONLY fileSize / fileMtime (same fingerprint).
    await store2.addRegion(newFpId, 1, [20, 20, 90, 90]);
    const modifiedStatId = { attachmentItemID: 301, fingerprint: "fp-new", fileSize: 2048, fileMtime: 200000 };
    const store3 = new PersistentFigureStore({ dataDir: dir });
    let statRedetects = 0;
    const afterStatSwap = await store3.getEffectivePageRegions(modifiedStatId, 1, async () => {
      statRedetects += 1;
      return [{ rect: [110, 210, 310, 410], captionNumber: "1", sourceKinds: ["image"] }];
    });
    assert.equal(statRedetects, 1, "same fingerprint with different size/mtime triggers re-detection");
    assert.equal(afterStatSwap.regions.length, 1);
    const jsonAfterStatSwap = JSON.parse(await readFile(store3.getFilePath(301), "utf8"));
    assert.equal(jsonAfterStatSwap.archivedOverrides.length, 2, "previous archives retained across replacements");
  });
});

describe("persistent-figure-store: Test E (detectorRevision & schemaVersion)", () => {
  it("re-runs detection when detectorRevision bumps while preserving and reapplying manualOverrides", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const identity = { attachmentItemID: 401, fingerprint: "fp-rev" };

    const oldStore = new PersistentFigureStore({ dataDir: dir, detectorRevision: 1 });
    await oldStore.savePageAutoCache(identity, 1, [
      { rect: [100, 460, 340, 620], captionNumber: "1", sourceKinds: ["image"] },
      { rect: [100, 120, 340, 280], captionNumber: "2", sourceKinds: ["image"] },
    ]);
    await oldStore.suppressRegion(identity, 1, { captionNumber: "2", rect: [100, 120, 340, 280] });
    await oldStore.addRegion(identity, 1, [360, 120, 560, 280]);

    // Simulated detector upgrade to revision 2.
    const newStore = new PersistentFigureStore({ dataDir: dir, detectorRevision: 2 });
    let detectRuns = 0;
    const upgraded = await newStore.getEffectivePageRegions(identity, 1, async () => {
      detectRuns += 1;
      return [
        // Fig 1 slightly shifted by improved detector; Fig 2 same area -> still suppressed!
        { rect: [95, 455, 345, 625], captionNumber: "1", sourceKinds: ["image"] },
        { rect: [98, 118, 342, 282], captionNumber: "2", sourceKinds: ["image"] },
      ];
    });
    assert.equal(detectRuns, 1, "detector revision bump triggers fresh detection");
    assert.equal(upgraded.regions.length, 2, "upgraded Fig 1 kept, Fig 2 still suppressed, manual Fig 3 kept");
    assert.deepEqual(upgraded.regions[0].rect, [95, 455, 345, 625]);
    assert.deepEqual(upgraded.regions[1].rect, [360, 120, 560, 280]);

    const diskJson = JSON.parse(await readFile(newStore.getFilePath(401), "utf8"));
    assert.equal(diskJson.autoCache.detectorRevision, 2);
    assert.equal(diskJson.manualOverrides.pages["1"].length, 2);
  });

  it("refuses to overwrite incompatible future schemaVersion while falling back cleanly in memory", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const identity = { attachmentItemID: 402, fingerprint: "fp-future" };

    const store = new PersistentFigureStore({ dataDir: dir });
    const filePath = store.getFilePath(402);
    await mkdir(path.dirname(filePath), { recursive: true });
    const futurePayload = JSON.stringify({
      schemaVersion: 999,
      futureMetadata: { preserveMe: true },
      document: { attachmentItemID: 402, fingerprint: "fp-future" },
      autoCache: { detectorRevision: 99, pages: { 1: { complete: true, regions: [] } } },
    });
    await writeFile(filePath, futurePayload, "utf8");

    let detectCount = 0;
    const res = await store.getEffectivePageRegions(identity, 1, async () => {
      detectCount += 1;
      return [{ rect: [50, 50, 200, 200], captionNumber: "1", sourceKinds: ["image"] }];
    });
    assert.equal(detectCount, 1, "falls back to detection cleanly");
    assert.equal(res.persisted, false);
    assert.equal(res.regions.length, 1);
    assert.equal(await readFile(filePath, "utf8"), futurePayload, "future-version disk file must never be clobbered");
    assert.equal(getWarnLog().some((msg) => msg.includes("persistent-schema-version")), true);
  });
});

describe("persistent-figure-store: Test G (concurrency, corruption & IO error resilience)", () => {
  it("deduplicates concurrent reads per attachment and serializes concurrent multi-page writes", async () => {
    const dir = await makeTempDir();
    const stats = installGeckoFsShim(dir);
    const identity = { attachmentItemID: 501, fingerprint: "fp-concurrent" };

    const seedStore = new PersistentFigureStore({ dataDir: dir });
    await seedStore.savePageAutoCache(identity, 1, [{ rect: [10, 10, 100, 100], sourceKinds: ["image"] }]);
    await seedStore.savePageAutoCache(identity, 2, [{ rect: [20, 20, 120, 120], sourceKinds: ["image"] }]);

    // Concurrent reads of pages 1 & 2 on a fresh store must read the JSON file only once.
    stats.reads = 0;
    const readStore = new PersistentFigureStore({ dataDir: dir });
    const [p1, p2, p3] = await Promise.all([
      readStore.getPageAutoCache(identity, 1),
      readStore.getPageAutoCache(identity, 2),
      readStore.getPageAutoCache(identity, 3),
    ]);
    assert.equal(stats.reads, 1, "shared in-flight load reads file once across concurrent pages");
    assert.equal(p1.hit, true);
    assert.equal(p2.hit, true);
    assert.equal(p3.hit, false);

    // Concurrent multi-page saves must serialize and preserve all 3 pages.
    await Promise.all([
      readStore.savePageAutoCache(identity, 4, [{ rect: [40, 40, 140, 140], sourceKinds: ["path"] }]),
      readStore.savePageAutoCache(identity, 5, [{ rect: [50, 50, 150, 150], sourceKinds: ["image"] }]),
      readStore.savePageAutoCache(identity, 6, []),
    ]);
    const finalJson = JSON.parse(await readFile(readStore.getFilePath(501), "utf8"));
    assert.deepEqual(Object.keys(finalJson.autoCache.pages).sort(), ["1", "2", "4", "5", "6"]);
  });

  it("preserves interleaved manual edit when slow auto-detection completes concurrently and drops stale pre-invalidation auto saves", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const identity = { attachmentItemID: 502, fingerprint: "fp-race" };
    const store = new PersistentFigureStore({ dataDir: dir });
    const page1 = makeFakePage({
      pageNumber: 1,
      withFigure: true,
    });
    let releaseOps;
    const opsGate = new Promise((resolve) => {
      releaseOps = resolve;
    });
    const origGetOps = page1.pageView.pdfPage.getOperatorList;
    page1.pageView.pdfPage.getOperatorList = async () => {
      await opsGate;
      return origGetOps();
    };

    const regionCache = new RegionCache();
    const overlay = new PageOverlay({
      pageView: page1.pageView,
      innerWin: page1.innerWin,
      documentId: "item:502|fcp:fp-race",
      docId: "fcp:fp-race",
      regionCache,
      persistentStore: store,
      resolveIdentity: () => identity,
    });

    const detectPromise = overlay.detect();
    // Concurrent manual edit on page 1 BEFORE detection finishes.
    await store.addRegion(identity, 1, [400, 500, 550, 650]);
    releaseOps();
    const detected = await detectPromise;
    assert.equal(detected.regions.length, 2, "late auto-save must merge with instead of clobbering concurrent manual edit");

    const diskAfterInterleave = JSON.parse(await readFile(store.getFilePath(502), "utf8"));
    assert.equal(diskAfterInterleave.manualOverrides.pages["1"].length, 1);
    assert.equal(diskAfterInterleave.autoCache.pages["1"].regions.length, 1);

    // Now test stale auto-detection aborted cleanly if invalidateAutoCache runs mid-flight.
    const page2 = makeFakePage({ pageNumber: 2, withFigure: true });
    let releaseP2;
    const p2Gate = new Promise((resolve) => {
      releaseP2 = resolve;
    });
    const origOps2 = page2.pageView.pdfPage.getOperatorList;
    page2.pageView.pdfPage.getOperatorList = async () => {
      await p2Gate;
      return origOps2();
    };
    const overlay2 = new PageOverlay({
      pageView: page2.pageView,
      innerWin: page2.innerWin,
      documentId: "item:502|fcp:fp-race",
      docId: "fcp:fp-race",
      regionCache,
      persistentStore: store,
      resolveIdentity: () => identity,
    });
    const p2Run = overlay2.detect();
    await store.invalidateAutoCache(identity);
    regionCache.invalidateDocument("item:502|fcp:fp-race");
    releaseP2();
    const staleResult = await p2Run;
    assert.equal(staleResult, null, "mid-flight detection invalidated before finish must be discarded");
    const diskAfterInvalid = JSON.parse(await readFile(store.getFilePath(502), "utf8"));
    assert.equal(diskAfterInvalid.autoCache.pages["2"], undefined, "stale detection must not write back invalidated autoCache");
    assert.equal(diskAfterInvalid.manualOverrides.pages["1"].length, 1, "manual override survives invalidateAutoCache");
  });

  it("drops in-flight persistent load/detection on reader close or document re-key without polluting the new document", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);
    const store = new PersistentFigureStore({ dataDir: dir });
    const regionCache = new RegionCache();

    // Case 1: ReaderSession re-keys mid-flight while PageOverlay.detect() is waiting on doc A.
    const env = makeFakeReaderEnv({ itemID: 504, fingerprint: "fp-doc-a", pageSetup: { pageNumber: 1, withFigure: true } });
    let releaseDocAOps;
    const docAGate = new Promise((resolve) => {
      releaseDocAOps = resolve;
    });
    let currentDoc = "A";
    const emptyBPage = makeFakePage({ pageNumber: 1, withFigure: false });
    const origGetOpsA = env.pageView.pdfPage.getOperatorList;
    const origTextA = env.pageView.pdfPage.getTextContent;
    env.pageView.pdfPage.getOperatorList = async () => {
      if (currentDoc === "A") {
        await docAGate;
        return origGetOpsA();
      }
      return emptyBPage.pageView.pdfPage.getOperatorList();
    };
    env.pageView.pdfPage.getTextContent = async () =>
      currentDoc === "A" ? origTextA() : emptyBPage.pageView.pdfPage.getTextContent();

    const session = new ReaderSession({
      reader: env.reader,
      regionCache,
      persistentStore: store,
      tag: "item:504",
    });
    session.applyDocumentId("fcp:fp-doc-a");
    session.innerWin = env.innerWin;
    const paintJob = session.attachPageNumber(1);
    const overlayA = session.overlays.get(1);
    const detectARun = overlayA.detectPromise;

    // Document swaps to empty doc B under the same session before doc A's async detection resolves.
    currentDoc = "B";
    env.pdfDocument.fingerprints = ["fp-doc-b"];
    session.commitRekey("fcp:fp-doc-b", "test-swap");
    releaseDocAOps();
    await Promise.allSettled([paintJob, detectARun, ...session.pending]);

    assert.deepEqual(
      regionCache.get("item:504|fcp:fp-doc-b", 1)?.regions ?? [],
      [],
      "doc A figure must never populate doc B memory cache",
    );
    const fileAExists = await store.io.exists(store.getFilePath(504));
    if (fileAExists) {
      const disk = JSON.parse(await readFile(store.getFilePath(504), "utf8"));
      assert.equal(disk.document.fingerprint, "fp-doc-b");
      assert.deepEqual(disk.autoCache.pages["1"]?.regions ?? [], [], "aborted doc A figure must not persist into disk cache after rekey");
    }
    session.destroy();

    // Case 2: Standalone overlay destroyed while persistent disk load is mid-flight -> returns null and leaves no canvas.
    let releaseDiskRead;
    const diskGate = new Promise((resolve) => {
      releaseDiskRead = resolve;
    });
    const slowStore = new PersistentFigureStore({
      dataDir: dir,
      io: {
        joinPath: globalThis.PathUtils.join,
        isAvailable: () => true,
        exists: globalThis.IOUtils.exists,
        readUTF8: async (p) => {
          await diskGate;
          return globalThis.IOUtils.readUTF8(p);
        },
        makeDirectory: globalThis.IOUtils.makeDirectory,
        writeUTF8Atomic: globalThis.IOUtils.writeUTF8,
      },
    });
    const pClosed = makeFakePage({ pageNumber: 1, withFigure: true });
    const overlayClosed = new PageOverlay({
      pageView: pClosed.pageView,
      innerWin: pClosed.innerWin,
      documentId: "item:505|fcp:fp-close",
      docId: "fcp:fp-close",
      regionCache,
      persistentStore: slowStore,
      resolveIdentity: () => ({ attachmentItemID: 505, fingerprint: "fp-close" }),
    });
    const closedDetect = overlayClosed.detect();
    overlayClosed.destroy();
    releaseDiskRead();
    assert.equal(await closedDetect, null, "destroyed overlay drops in-flight persistent detect safely");
  });

  it("quarantines corrupt JSON files and degrades safely on disk write failures without breaking reading", async () => {
    const dir = await makeTempDir();
    const stats = installGeckoFsShim(dir);
    const identity = { attachmentItemID: 503, fingerprint: "fp-corrupt" };

    const store = new PersistentFigureStore({ dataDir: dir });
    const filePath = store.getFilePath(503);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "{broken-json", "utf8");

    const { pageView, innerWin } = makeFakePage({ pageNumber: 1, withFigure: true });
    const overlay = new PageOverlay({
      pageView,
      innerWin,
      documentId: "item:503|fcp:fp-corrupt",
      docId: "fcp:fp-corrupt",
      regionCache: new RegionCache(),
      persistentStore: store,
      resolveIdentity: () => identity,
    });

    const recovered = await overlay.detect();
    assert.equal(recovered.regions.length, 1, "recovers cleanly from corrupt JSON via fallback detection");
    const dirEntries = await readdir(store.getCacheDir());
    assert.equal(dirEntries.some((name) => name.includes(".corrupt-")), true, "corrupt file backed up");
    const repairedText = await readFile(filePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(repairedText), "repaired cache written");

    // Simulate EACCES write failure.
    stats.failWritesWith = Object.assign(new Error("EACCES: read-only cache"), { code: "EACCES" });
    const failRes = await store.addRegion(identity, 1, [360, 120, 560, 280]);
    assert.equal(failRes.ok, true, "manual edit updates in-memory state gracefully");
    assert.equal(failRes.persisted, false);
    assert.match(failRes.error, /EACCES/);
    assert.equal(failRes.effective.regions.length, 2, "reading still receives effective manual addition in session");
  });
});

describe("persistent-figure-store: main.js integration & Test F/H (clearCache vs invalidateAutoCache, zoom, toggle)", () => {
  it("supports end-to-end cache-first detection, manual override APIs, clearCache vs invalidateAutoCache, zoom, and toggle", async () => {
    const dir = await makeTempDir();
    installGeckoFsShim(dir);

    let activeEnv = makeFakeReaderEnv({ itemID: 601, fingerprint: "fp-main-test" });
    const toolbarListeners = new Map();

    globalThis.Zotero = {
      DataDirectory: { dir },
      Reader: {
        registerEventListener(type, fn) {
          toolbarListeners.set(type, fn);
        },
        unregisterEventListener(type) {
          toolbarListeners.delete(type);
        },
        getByTabID() {
          return activeEnv.reader;
        },
      },
      Items: {
        async getAsync() {
          return null;
        },
      },
      debug() {},
    };
    globalThis.Zotero_Tabs = { selectedID: activeEnv.reader.tabID };

    startup({ id: "persist-test", version: "0.7.5" });
    const onRenderToolbar = toolbarListeners.get("renderToolbar");
    onRenderToolbar({ reader: activeEnv.reader, doc: activeEnv.innerWin.document, append() {} });

    const [session] = getSessions();
    assert.ok(session instanceof ReaderSession);
    session.applyDocumentId("fcp:fp-main-test");
    await session.attachPageNumber(1);
    assert.equal(activeEnv.opCalls.count, 1, "initial paint runs detection once");

    // Add + suppress + replace + reset via FigureGuard main exports.
    const added = await addRegion({ pageNumber: 1, rect: [360, 120, 540, 260] });
    assert.equal(added.ok, true);
    assert.equal(added.persisted, true);

    const effAfterAdd = await getEffectiveRegions(null, 1);
    assert.equal(effAfterAdd.regions.length, 2);

    const autoTargetId = effAfterAdd.autoRegions[0].id;
    const replaced = await replaceRegion(null, 1, autoTargetId, [80, 440, 360, 640]);
    assert.equal(replaced.ok, true);
    const effAfterReplace = await getEffectiveRegions(null, 1);
    assert.equal(effAfterReplace.regions.length, 2, "replace does not duplicate original region");
    assert.deepEqual(effAfterReplace.regions[0].rect, [80, 440, 360, 640]);

    // Invalid rect rejected cleanly without touching disk overrides.
    const invalidReplace = await replaceRegion(null, 1, autoTargetId, [100, 100, 50, 50]);
    assert.equal(invalidReplace.ok, false);

    // Zoom / scale change & toolbar toggle keep manual overrides intact without re-running getOperatorList.
    const opsBeforeUiEvents = activeEnv.opCalls.count;
    session.setEnabled(false);
    session.setEnabled(true);
    await new Promise((r) => setTimeout(r, 10));
    session.onViewScaleChange();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(activeEnv.opCalls.count, opsBeforeUiEvents, "toggle and zoom do not re-detect");
    assert.equal(session.overlays.get(1).regionBoxes.length, 2);

    // clearCache() drops ONLY memory RegionCache -> reopen hits persistent cache (0 new getOperatorList calls) and preserves overrides!
    clearCache();
    assert.equal(session.regionCache.size, 0);
    session.detachAll();
    await session.attachPageNumber(1);
    assert.equal(activeEnv.opCalls.count, opsBeforeUiEvents, "clearCache allows persistent cache hit without re-scan");
    assert.equal(session.overlays.get(1).regionBoxes.length, 2);

    // Full restart: shutdown() -> fresh startup() with same Zotero DataDirectory.
    shutdown();
    activeEnv = makeFakeReaderEnv({ itemID: 601, fingerprint: "fp-main-test" });
    globalThis.Zotero_Tabs.selectedID = activeEnv.reader.tabID;
    startup({ id: "persist-test", version: "0.7.5" });
    toolbarListeners.get("renderToolbar")({
      reader: activeEnv.reader,
      doc: activeEnv.innerWin.document,
      append() {},
    });
    const [restartedSession] = getSessions();
    restartedSession.applyDocumentId("fcp:fp-main-test");
    await restartedSession.attachPageNumber(1);
    assert.equal(activeEnv.opCalls.count, 0, "fresh session after restart loads persistent cache + manual overrides with 0 re-scans");
    assert.equal(restartedSession.overlays.get(1).regionBoxes.length, 2);

    // invalidateAutoCache() clears persistent autoCache (re-detects on next paint) while keeping manualOverrides intact!
    const invRes = await invalidateAutoCache();
    assert.equal(invRes.ok, true);
    assert.deepEqual(invRes.preservedOverridePages, ["1"]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(activeEnv.opCalls.count, 1, "invalidateAutoCache forces re-detection");
    assert.equal(
      restartedSession.overlays.get(1).regionBoxes.length,
      2,
      "manual replace + add survive invalidateAutoCache and re-apply onto new auto result",
    );

    // suppressRegion & resetOverride restore clean auto box.
    const suppressed = await suppressRegion(null, 1, autoTargetId);
    assert.equal(suppressed.ok, true);
    const effAfterSuppress = await getEffectiveRegions(null, 1);
    assert.equal(effAfterSuppress.regions.length, 1, "only manual add remains");

    const resetAll = await resetOverride(null, 1, "*", { all: true });
    assert.equal(resetAll.ok, true);
    const effAfterReset = await getEffectiveRegions(null, 1);
    assert.equal(effAfterReset.regions.length, 1);
    assert.equal(effAfterReset.regions[0].origin, "auto");
    assert.ok(getPersistentStore() instanceof PersistentFigureStore);
  });
});
