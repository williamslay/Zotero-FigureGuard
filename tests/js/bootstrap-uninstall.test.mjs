import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { PersistentFigureStore } from "../../src/zotero/persistent-figure-store.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fg-boot-"));
  tempDirs.push(dir);
  return dir;
}

async function existsOnDisk(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the real `bootstrap.js` inside an isolated `node:vm` context mirroring
 * Zotero 10.0.8's plugin sandbox (`Zotero`, `IOUtils`, `PathUtils`, `Services`,
 * `REASONS`, and `content/index.js` scriptloader).
 */
async function createBootstrapHarness({
  dataDir,
  removeOverride = null,
  initialStore = null,
  withAddonManager = false,
} = {}) {
  const bootstrapSource = await readFile(path.join(repoRoot, "bootstrap.js"), "utf8");
  const warnings = [];
  const shutdownCalls = [];
  const zoteroShutdownListeners = [];
  const io = {
    exists: existsOnDisk,
    readUTF8: (p) => readFile(p, "utf8"),
    makeDirectory: (d) => mkdir(d, { recursive: true }),
    async writeUTF8(targetPath, content, options = {}) {
      if (options?.tmpPath) {
        await writeFile(options.tmpPath, content, "utf8");
        const { rename } = await import("node:fs/promises");
        await rename(options.tmpPath, targetPath);
      } else {
        await writeFile(targetPath, content, "utf8");
      }
      return content.length;
    },
    async remove(targetPath, options = {}) {
      if (typeof removeOverride === "function") return removeOverride(targetPath, options);
      await rm(targetPath, { recursive: Boolean(options?.recursive), force: Boolean(options?.ignoreAbsent) });
    },
  };

  let activeStore = initialStore;
  const fakePlugin = {
    startup() {
      if (!activeStore) activeStore = new PersistentFigureStore({ dataDir, io: { ...io, joinPath: path.join, writeUTF8Atomic: io.writeUTF8 } });
    },
    shutdown(opts = {}) {
      shutdownCalls.push(opts);
      return activeStore?.close?.({ abortQueuedWrites: false });
    },
  };

  const addonState = { id: "figure-guard@zotero.org", pendingOperations: 0 };
  const addonListeners = new Set();
  const addonManager = withAddonManager
    ? {
        PENDING_UNINSTALL: 4,
        async getAddonByID(id) {
          return id === addonState.id ? addonState : null;
        },
        addAddonListener(listener) {
          addonListeners.add(listener);
        },
        removeAddonListener(listener) {
          addonListeners.delete(listener);
        },
        emit(event, target = addonState) {
          for (const listener of [...addonListeners]) {
            listener?.[event]?.(target);
          }
        },
      }
    : null;

  const context = vm.createContext({
    APP_STARTUP: 1,
    APP_SHUTDOWN: 2,
    ADDON_ENABLE: 3,
    ADDON_DISABLE: 4,
    ADDON_INSTALL: 5,
    ADDON_UNINSTALL: 6,
    ADDON_UPGRADE: 7,
    ADDON_DOWNGRADE: 8,
    Zotero: {
      DataDirectory: { dir: dataDir },
      debug() {},
      getMainWindow() {
        return null;
      },
      addShutdownListener(fn) {
        zoteroShutdownListeners.push(fn);
      },
    },
    PathUtils: {
      join: (...parts) => path.join(...parts),
    },
    IOUtils: io,
    ...(addonManager
      ? {
          ChromeUtils: {
            importESModule(spec) {
              if (spec === "resource://gre/modules/AddonManager.sys.mjs") {
                return { AddonManager: addonManager };
              }
              return null;
            },
          },
        }
      : {}),
    Services: {
      scriptloader: {
        loadSubScript() {
          context.FigureGuard = fakePlugin;
        },
      },
      wm: null,
    },
    console: {
      warn(...args) {
        warnings.push(args.map(String).join(" "));
      },
    },
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  });
  context.globalThis = context;
  vm.runInContext(bootstrapSource, context, { filename: "bootstrap.js" });

  return {
    context,
    warnings,
    shutdownCalls,
    addonState,
    addonListeners,
    addonManager,
    runZoteroShutdown: async () => {
      await Promise.all(zoteroShutdownListeners.map((fn) => fn()));
    },
    getStore: () => activeStore,
    setStore: (s) => {
      activeStore = s;
    },
  };
}

describe("bootstrap uninstall & Zotero lifecycle persistence cleanup (simulated Zotero lifecycle)", () => {
  it("preserves persistent data across Zotero shutdown (2), disable (4), upgrade (7), and downgrade (8)", async () => {
    const dataDir = await makeTempDir();
    const fgDir = path.join(dataDir, "figureguard");
    const cacheFile = path.join(fgDir, "cache", "item-101.json");
    const unrelatedFile = path.join(dataDir, "zotero.sqlite");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, '{"schemaVersion":1,"manualOverrides":{"pages":{"1":[]}}}', "utf8");
    await writeFile(unrelatedFile, "unrelated-zotero-db", "utf8");

    const { context } = await createBootstrapHarness({ dataDir });
    const data = { id: "figure-guard@zotero.org", version: "0.7.5", rootURI: "resource://fg/" };

    for (const reason of [2, 4, 7, 8]) {
      context.startup(data, 1);
      await context.shutdown(data, reason);
      await context.uninstall(data, reason);
      assert.equal(await existsOnDisk(cacheFile), true, `cache file must survive lifecycle reason=${reason}`);
      assert.equal(await existsOnDisk(unrelatedFile), true, "unrelated Zotero data untouched");
    }
  });

  it("removes only <DataDirectory>/figureguard on genuine uninstall (6) and prevents late async writes from recreating it", async () => {
    const dataDir = await makeTempDir();
    const unrelatedFile = path.join(dataDir, "storage", "important.pdf");
    await mkdir(path.dirname(unrelatedFile), { recursive: true });
    await writeFile(unrelatedFile, "keep-me", "utf8");

    let notifyWriteStarted;
    const writeStarted = new Promise((resolve) => {
      notifyWriteStarted = resolve;
    });
    let releaseInFlightWrite;
    const writeGate = new Promise((resolve) => {
      releaseInFlightWrite = resolve;
    });
    let writeCount = 0;

    const slowIo = {
      joinPath: path.join,
      isAvailable: () => true,
      exists: existsOnDisk,
      readUTF8: (p) => readFile(p, "utf8"),
      makeDirectory: (d) => mkdir(d, { recursive: true }),
      async writeUTF8Atomic(targetPath, content) {
        writeCount += 1;
        notifyWriteStarted();
        await writeGate;
        await writeFile(targetPath, content, "utf8");
      },
      move: async () => {},
    };
    const store = new PersistentFigureStore({ dataDir, io: slowIo });
    const { context } = await createBootstrapHarness({ dataDir, initialStore: store });
    const data = { id: "figure-guard@zotero.org", version: "0.7.5", rootURI: "resource://fg/" };
    context.startup(data, 1);

    const identity = { attachmentItemID: 901, fingerprint: "fp-uninstall-race" };
    // Start an in-flight write AND queue a second write before uninstall initiation.
    const firstWrite = store.addRegion(identity, 1, [10, 10, 100, 100]);
    await writeStarted;
    const queuedWrite = store.savePageAutoCache(identity, 2, [
      { rect: [20, 20, 120, 120], sourceKinds: ["image"] },
    ]);

    // Zotero runs shutdown(6) then uninstall(6).
    const shutdownPromise = context.shutdown(data, 6);
    const uninstallPromise = context.uninstall(data, 6);

    // Any new write requested after uninstall initiation must be refused immediately.
    const postCloseWrite = await store.addRegion(identity, 3, [30, 30, 130, 130]);
    assert.equal(postCloseWrite.persisted, false);
    assert.equal(postCloseWrite.reason, "store-closed");

    releaseInFlightWrite();
    await Promise.allSettled([firstWrite, queuedWrite, shutdownPromise]);
    await uninstallPromise;

    assert.equal(writeCount, 2, "in-flight and already-queued writes finish draining cleanly before directory removal");
    assert.equal(await existsOnDisk(path.join(dataDir, "figureguard")), false, "figureguard dir deleted cleanly");
    assert.equal(await existsOnDisk(unrelatedFile), true, "unrelated Zotero storage untouched");

    // Verify settling extra microtasks never recreates figureguard/.
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(await existsOnDisk(path.join(dataDir, "figureguard")), false, "no late async write recreates folder");
  });

  it("defers deletion during pending Undo window and preserves data on onOperationCancelled, deleting only when confirmed", async () => {
    const dataDir = await makeTempDir();
    const fgDir = path.join(dataDir, "figureguard");
    const cacheFile = path.join(fgDir, "cache", "item-202.json");
    const unrelatedFile = path.join(dataDir, "storage", "paper.pdf");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await mkdir(path.dirname(unrelatedFile), { recursive: true });
    const seedContent = '{"schemaVersion":1,"manualOverrides":{"pages":{"1":[{"id":"ovr-1","op":"add","rect":[1,2,30,40]}]}}}';
    await writeFile(cacheFile, seedContent, "utf8");
    await writeFile(unrelatedFile, "pdf-bytes", "utf8");

    const h = await createBootstrapHarness({ dataDir, withAddonManager: true });
    const data = { id: "figure-guard@zotero.org", version: "0.7.5", rootURI: "resource://fg/" };
    h.context.startup(data, 1);

    // 1. User clicks Remove -> Zotero marks PENDING_UNINSTALL and invokes shutdown(6) + uninstall(6) in onUninstalling.
    h.addonState.pendingOperations = h.addonManager.PENDING_UNINSTALL;
    await h.context.shutdown(data, 6);
    await h.context.uninstall(data, 6);
    assert.equal(await existsOnDisk(cacheFile), true, "data MUST remain untouched while Undo option is open");
    assert.equal(h.addonListeners.size, 1);

    // 2. User clicks Undo -> AddonManager emits onOperationCancelled, then Zotero calls install(5) + startup(5).
    h.addonState.pendingOperations = 0;
    h.addonManager.emit("onOperationCancelled", h.addonState);
    h.context.install(data, 5);
    h.context.startup(data, 5);
    assert.equal(h.addonListeners.size, 0, "watcher disarmed cleanly on Undo");
    assert.equal(await readFile(cacheFile, "utf8"), seedContent, "manual overrides survive Undo intact");

    // Subsequent Zotero shutdown does NOT remove the preserved data after Undo.
    await h.context.shutdown(data, 2);
    await h.runZoteroShutdown();
    assert.equal(await readFile(cacheFile, "utf8"), seedContent, "data still preserved on exit after Undo");

    // 3. User clicks Remove a second time AND closes Add-ons tab -> onUninstalled commits cleanup.
    h.context.startup(data, 1);
    h.addonState.pendingOperations = h.addonManager.PENDING_UNINSTALL;
    await h.context.shutdown(data, 6);
    await h.context.uninstall(data, 6);
    assert.equal(await existsOnDisk(cacheFile), true, "still kept until onUninstalled fires");

    h.addonState.pendingOperations = 0;
    h.addonManager.emit("onUninstalled", h.addonState);
    await h.runZoteroShutdown();
    assert.equal(h.addonListeners.size, 0, "listener removed after onUninstalled");
    assert.equal(await existsOnDisk(fgDir), false, "figureguard dir deleted after uninstall is confirmed");
    assert.equal(await existsOnDisk(unrelatedFile), true, "unrelated user files preserved");
  });

  it("cleans up pending uninstall cleanly if Zotero quits without clicking Undo", async () => {
    const dataDir = await makeTempDir();
    const fgDir = path.join(dataDir, "figureguard");
    const cacheFile = path.join(fgDir, "cache", "item-303.json");
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, '{"schemaVersion":1}', "utf8");

    const h = await createBootstrapHarness({ dataDir, withAddonManager: true });
    const data = { id: "figure-guard@zotero.org", version: "0.7.5", rootURI: "resource://fg/" };
    h.context.startup(data, 1);

    h.addonState.pendingOperations = h.addonManager.PENDING_UNINSTALL;
    await h.context.shutdown(data, 6);
    await h.context.uninstall(data, 6);
    assert.equal(await existsOnDisk(cacheFile), true, "deferred while pending");

    // User quits Zotero directly with pending uninstall still active (never clicked Undo).
    await h.runZoteroShutdown();
    assert.equal(h.addonListeners.size, 0);
    assert.equal(await existsOnDisk(fgDir), false, "figureguard dir cleaned before Zotero exits with pending uninstall");
  });

  it("cleans up persistent data when uninstalled while already disabled and handles missing dir or IO errors safely", async () => {
    const dataDir = await makeTempDir();
    const fgDir = path.join(dataDir, "figureguard");
    const staleFile = path.join(fgDir, "cache", "item-55.json");
    await mkdir(path.dirname(staleFile), { recursive: true });
    await writeFile(staleFile, '{"schemaVersion":1}', "utf8");

    // Disabled addon: startup() never called, uninstall(6) invoked directly.
    const h1 = await createBootstrapHarness({ dataDir });
    const data = { id: "figure-guard@zotero.org", version: "0.7.5", rootURI: "resource://fg/" };
    await h1.context.uninstall(data, 6);
    assert.equal(await existsOnDisk(fgDir), false, "disabled uninstall removes orphaned figureguard data");

    // Second uninstall when directory already absent must succeed silently.
    await h1.context.uninstall(data, 6);
    assert.equal(h1.warnings.length, 0);

    // Removal failure must log warning and never throw out of uninstall().
    const hErr = await createBootstrapHarness({
      dataDir,
      removeOverride: async () => {
        throw new Error("EACCES: locked file");
      },
    });
    await assert.doesNotReject(() => hErr.context.uninstall(data, 6));
    assert.equal(hErr.warnings.some((w) => w.includes("uninstall-cleanup")), true);
  });
});
