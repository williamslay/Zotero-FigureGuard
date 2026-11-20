/*
 * Legacy bootstrapped-extension entry point for Zotero 7 through 10.
 *
 * Zotero loads this file with loadSubScriptWithOptions into its own sandbox
 * (see Zotero's xpcom/plugins.js), so the file must stay a plain script: no
 * import or export statement, no module wrapper. The exported surface is just
 * four plain global functions: startup(), shutdown(), install(), uninstall().
 *
 * At startup the bundled module (built by esbuild as an IIFE with the global
 * name FigureGuard) is loaded into this same sandbox global, and its
 * startup() is called. Nothing in here may throw: an exception escaping the
 * bootstrap takes the reader window with it, so every Zotero or Services
 * access is guarded and reported instead of propagated.
 */

var FigureColorBootstrap = {
  id: "figure-guard@zotero.org",
  rootURI: "",
  started: false,
  pendingShutdown: null,
  pendingUninstallWatcher: null,
  shutdownHookRegistered: false,
  activeCleanup: null,
};

/**
 * Reports a bootstrap problem without ever throwing.
 *
 * @param {string} site Short label for the failing site.
 * @param {*} err Error or null.
 */
function figureColorWarn(site, err) {
  try {
    console.warn("[figure-color]", site, err);
    return;
  } catch (consoleUnavailable) {
    // Fall through to Zotero's own logger.
  }
  try {
    if (typeof Zotero !== "undefined" && Zotero && typeof Zotero.debug === "function") {
      Zotero.debug("[figure-color] " + site + ": " + (err && err.message ? err.message : err));
    }
  } catch (ignored) {
    // Logging must never break the reader.
  }
}

/**
 * Resolves Services.jsm, tolerating the sandbox and future Firefox changes.
 *
 * @returns {object|null}
 */
function figureColorServices() {
  try {
    if (typeof Services !== "undefined" && Services && Services.scriptloader) return Services;
  } catch (err) {
    figureColorWarn("services-global", err);
  }
  try {
    var imported = ChromeUtils.import("resource://gre/modules/Services.jsm");
    if (imported && imported.Services) return imported.Services;
  } catch (err) {
    figureColorWarn("services-import", err);
  }
  return null;
}

/**
 * The bundled plugin object, once the content script has run.
 *
 * @returns {object|null}
 */
function figureColorPlugin() {
  try {
    if (globalThis.FigureGuard) return globalThis.FigureGuard;
  } catch (err) {
    figureColorWarn("plugin-global", err);
  }
  try {
    if (typeof FigureGuard !== "undefined") return FigureGuard;
  } catch (ignored) {
    // The bundle is not in scope yet.
  }
  return null;
}

/**
 * Publishes the plugin object onto the main browser window.
 *
 * Zotero loads bootstrap.js into its own sandbox (xpcom/plugins.js), so the
 * bundle's global lives in that sandbox, not on the window. The Run JavaScript
 * window evaluates code with win.eval against the main window, which cannot see
 * sandbox globals; the window is the only shared rendezvous point. Best effort:
 * a missing window only means the handle is not introspectable from Run JS.
 *
 * @param {object} plugin The bundle's exported object.
 */
function figureColorPublish(plugin) {
  try {
    var services = figureColorServices();
    if (!services || !services.wm) return;
    var win = null;
    try {
      if (typeof Zotero !== "undefined" && Zotero && typeof Zotero.getMainWindow === "function") {
        win = Zotero.getMainWindow();
      }
    } catch (ignored) {
      win = null;
    }
    if (!win) win = services.wm.getMostRecentWindow("navigator:browser");
    if (win) win.FigureGuard = plugin;
  } catch (err) {
    figureColorWarn("publish", err);
  }
}

/**
 * Called by Zotero after the extension is started.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 */
function startup(data, reason) {
  try {
    figureColorDisarmPendingUninstall();
    data = data || {};
    var rootURI = data.rootURI || FigureColorBootstrap.rootURI || "";
    if (data.id) FigureColorBootstrap.id = data.id;
    FigureColorBootstrap.rootURI = rootURI;
    if (!rootURI) {
      figureColorWarn("startup: no rootURI", null);
      return;
    }

    var services = figureColorServices();
    if (!services || !services.scriptloader || typeof services.scriptloader.loadSubScript !== "function") {
      figureColorWarn("startup: no scriptloader", null);
      return;
    }

    // One argument means "load into the caller's scope", which is this sandbox
    // global: that is where the bundle publishes FigureGuard.
    services.scriptloader.loadSubScript(rootURI + "content/index.js");

    var plugin = figureColorPlugin();
    if (!plugin || typeof plugin.startup !== "function") {
      figureColorWarn("startup: content/index.js did not define FigureGuard.startup", null);
      return;
    }
    // The sandbox is not visible to Run JavaScript: publish the handle on the
    // window that exists now; startup() below republishes after Zotero is ready.
    figureColorPublish(plugin);

    plugin.startup({
      id: data.id || FigureColorBootstrap.id,
      version: data.version,
      rootURI,
      reason,
    });
    FigureColorBootstrap.started = true;
  } catch (err) {
    figureColorWarn("startup", err);
  }
}

/**
 * Resolves the Zotero/Gecko `ADDON_UNINSTALL` reason constant (`6`).
 *
 * @returns {number}
 */
function figureColorUninstallReason() {
  try {
    if (typeof ADDON_UNINSTALL === "number") return ADDON_UNINSTALL;
  } catch (ignored) {}
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.ADDON_UNINSTALL === "number") {
      return globalThis.ADDON_UNINSTALL;
    }
  } catch (ignored) {}
  return 6;
}

/**
 * Resolves Gecko's `AddonManager` (`sys.mjs` on Zotero 7.0.24+/10, `.jsm` fallback
 * on older Zotero 7) to distinguish pending-undoable uninstall from final removal.
 *
 * @returns {object|null}
 */
function figureColorAddonManager() {
  try {
    if (typeof AddonManager !== "undefined" && AddonManager) return AddonManager;
  } catch (ignored) {}
  try {
    if (typeof globalThis !== "undefined" && globalThis.AddonManager) return globalThis.AddonManager;
  } catch (ignored) {}
  try {
    if (typeof ChromeUtils !== "undefined" && ChromeUtils) {
      if (typeof ChromeUtils.importESModule === "function") {
        try {
          var mod = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
          if (mod && mod.AddonManager) return mod.AddonManager;
        } catch (ignored) {}
      }
      if (typeof ChromeUtils.import === "function") {
        try {
          var legacy = ChromeUtils.import("resource://gre/modules/AddonManager.jsm");
          if (legacy && legacy.AddonManager) return legacy.AddonManager;
        } catch (ignored) {}
      }
    }
  } catch (ignored) {}
  return null;
}

function figureColorDisarmPendingUninstall() {
  var watcher = FigureColorBootstrap.pendingUninstallWatcher;
  if (!watcher) return;
  FigureColorBootstrap.pendingUninstallWatcher = null;
  watcher.disarmed = true;
  try {
    if (watcher.addonManager && typeof watcher.addonManager.removeAddonListener === "function") {
      watcher.addonManager.removeAddonListener(watcher.listener);
    }
  } catch (err) {
    figureColorWarn("uninstall-remove-listener", err);
  }
}

/**
 * Deletes only FigureGuard's own storage folder (`<Zotero Data Directory>/figureguard`)
 * on genuine uninstall. Never touches Zotero's other folders or attachments.
 *
 * @returns {Promise<boolean>}
 */
async function figureColorRemovePersistentData() {
  try {
    var zotero = typeof Zotero !== "undefined" ? Zotero : (typeof globalThis !== "undefined" ? globalThis.Zotero : null);
    var pathUtils = typeof PathUtils !== "undefined" ? PathUtils : (typeof globalThis !== "undefined" ? globalThis.PathUtils : null);
    var ioUtils = typeof IOUtils !== "undefined" ? IOUtils : (typeof globalThis !== "undefined" ? globalThis.IOUtils : null);
    var rawDir = zotero && zotero.DataDirectory && zotero.DataDirectory.dir;
    if (typeof rawDir !== "string" || !rawDir.trim()) return false;
    if (!pathUtils || typeof pathUtils.join !== "function") return false;
    if (!ioUtils || typeof ioUtils.remove !== "function") return false;

    var baseDir = rawDir.trim();
    var targetDir = pathUtils.join(baseDir, "figureguard");
    if (!targetDir || targetDir === baseDir) return false;

    await ioUtils.remove(targetDir, { recursive: true, ignoreAbsent: true });
    return true;
  } catch (err) {
    figureColorWarn("uninstall-cleanup", err);
    return false;
  }
}

function figureColorRunFinalCleanup() {
  if (FigureColorBootstrap.activeCleanup) return FigureColorBootstrap.activeCleanup;
  var task = (async function () {
    try {
      var pending = FigureColorBootstrap.pendingShutdown;
      FigureColorBootstrap.pendingShutdown = null;
      if (pending && typeof pending.then === "function") {
        await pending;
      }
      var plugin = figureColorPlugin();
      if (FigureColorBootstrap.started && plugin && typeof plugin.shutdown === "function") {
        var extraPending = plugin.shutdown({ reason: figureColorUninstallReason(), uninstalling: true });
        FigureColorBootstrap.started = false;
        if (extraPending && typeof extraPending.then === "function") {
          await extraPending;
        }
      }
      await figureColorRemovePersistentData();
    } catch (err) {
      figureColorWarn("uninstall-cleanup", err);
    } finally {
      if (FigureColorBootstrap.activeCleanup === task) {
        FigureColorBootstrap.activeCleanup = null;
      }
    }
  })();
  FigureColorBootstrap.activeCleanup = task;
  return task;
}

/**
 * Called by Zotero before the extension is shut down.
 * Drains in-flight persistence writes safely before unload.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 * @returns {Promise<void>|undefined}
 */
function shutdown(data, reason) {
  var isUninstall = reason === figureColorUninstallReason();
  var pending = null;
  try {
    var plugin = figureColorPlugin();
    if (plugin && typeof plugin.shutdown === "function") {
      pending = plugin.shutdown({ reason: reason, uninstalling: isUninstall });
    }
  } catch (err) {
    figureColorWarn("shutdown", err);
  }
  FigureColorBootstrap.started = false;
  if (pending && typeof pending.then === "function") {
    FigureColorBootstrap.pendingShutdown = pending;
    return pending;
  }
  FigureColorBootstrap.pendingShutdown = null;
  return undefined;
}

/**
 * Called on install. Also disarms any prior pending-uninstall watcher if Undo
 * restored the add-on.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 */
function install(data, reason) {
  figureColorDisarmPendingUninstall();
}

/**
 * Called on uninstall/upgrade/downgrade.
 *
 * Only cleans up `<Zotero Data Directory>/figureguard` when
 * `reason === ADDON_UNINSTALL` (6), preserving user data across Zotero exit,
 * disable, upgrade (7), and downgrade (8).
 *
 * Because Zotero 10.0.8 (`xpcom/plugins.js:921-957`) invokes `uninstall()` at
 * `onUninstalling` while the Add-ons Manager may still show an "Undo" option
 * (`PENDING_UNINSTALL`), when `AddonManager` reports `PENDING_UNINSTALL` we
 * defer deletion until `onUninstalled` commits (or Zotero exits without
 * `onOperationCancelled`), keeping user data untouched if the user clicks Undo.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 * @returns {Promise<void>}
 */
async function uninstall(data, reason) {
  if (reason !== figureColorUninstallReason()) return;
  var addonId = (data && data.id) || FigureColorBootstrap.id;
  try {
    var addonManager = figureColorAddonManager();
    var addon = null;
    if (addonManager && typeof addonManager.getAddonByID === "function") {
      try {
        addon = await addonManager.getAddonByID(addonId);
      } catch (err) {
        figureColorWarn("uninstall-addon-lookup", err);
      }
    }

    var pendingMask =
      addonManager && typeof addonManager.PENDING_UNINSTALL === "number"
        ? addonManager.PENDING_UNINSTALL
        : 4;
    var isPendingUndoable = Boolean(
      addonManager &&
        typeof addonManager.addAddonListener === "function" &&
        addon &&
        (addon.pendingOperations & pendingMask) !== 0
    );

    if (!isPendingUndoable) {
      figureColorDisarmPendingUninstall();
      await figureColorRunFinalCleanup();
      return;
    }

    figureColorDisarmPendingUninstall();
    var watcher = {
      disarmed: false,
      addonManager: addonManager,
      listener: null,
    };
    watcher.listener = {
      onOperationCancelled: function (target) {
        if (watcher.disarmed || !target || target.id !== addonId) return;
        figureColorDisarmPendingUninstall();
      },
      onUninstalled: function (target) {
        if (watcher.disarmed || !target || target.id !== addonId) return;
        figureColorDisarmPendingUninstall();
        figureColorRunFinalCleanup();
      },
    };
    FigureColorBootstrap.pendingUninstallWatcher = watcher;
    addonManager.addAddonListener(watcher.listener);

    var zotero = typeof Zotero !== "undefined" ? Zotero : (typeof globalThis !== "undefined" ? globalThis.Zotero : null);
    if (zotero && typeof zotero.addShutdownListener === "function" && !FigureColorBootstrap.shutdownHookRegistered) {
      FigureColorBootstrap.shutdownHookRegistered = true;
      zotero.addShutdownListener(async function () {
        if (FigureColorBootstrap.activeCleanup) {
          await FigureColorBootstrap.activeCleanup;
          return;
        }
        var liveWatcher = FigureColorBootstrap.pendingUninstallWatcher;
        if (!liveWatcher || liveWatcher.disarmed) return;
        figureColorDisarmPendingUninstall();
        try {
          var liveAddon =
            typeof addonManager.getAddonByID === "function"
              ? await addonManager.getAddonByID(addonId)
              : null;
          if (!liveAddon || (liveAddon.pendingOperations & pendingMask) !== 0) {
            await figureColorRunFinalCleanup();
          }
        } catch (err) {
          figureColorWarn("uninstall-shutdown-check", err);
        }
      });
    }
  } catch (err) {
    figureColorWarn("uninstall-cleanup", err);
  }
}
