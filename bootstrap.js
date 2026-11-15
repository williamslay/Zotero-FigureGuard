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
 * Called by Zotero before the extension is shut down.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 */
function shutdown(data, reason) {
  try {
    var plugin = figureColorPlugin();
    if (plugin && typeof plugin.shutdown === "function") plugin.shutdown();
  } catch (err) {
    figureColorWarn("shutdown", err);
  }
  FigureColorBootstrap.started = false;
}

/**
 * Called on install. The content script is only loaded in startup(), so there
 * is nothing to register yet.
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 */
function install(data, reason) {
  // Intentionally empty: no chrome.manifest or preferences to write.
}

/**
 * Called on uninstall. Sessions are already gone with the shutdown().
 *
 * @param {{id?: string, version?: string, rootURI?: string}} data
 * @param {number} reason
 */
function uninstall(data, reason) {
  // Intentionally empty: the plugin stores no data.
}
