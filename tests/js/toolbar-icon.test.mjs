import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  BUTTON_LABEL,
  BUTTON_TITLE,
  shutdown,
  startup,
  toolbarIconUrl,
} from "../../src/zotero/main.js";

/**
 * The toolbar toggle draws the packaged add-on icon, and it can only do that
 * when the bootstrap handed `startup()` a root URI to resolve it against. These
 * tests pin the resolution, the plain-text degradation when there is no root or
 * no DOM to build the image in, and the fact that the manifest and the toolbar
 * point at the same packaged path.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The packaged location the manifest maps and the toolbar resolves. */
const ICON_ENTRY = "content/figureguard-icon.svg";

/** Handlers the fake `Zotero.Reader` recorded, keyed by event type. */
const handlers = new Map();

/** A `Zotero` global with just the reader event registration main.js uses. */
function installFakeZotero() {
  globalThis.Zotero = {
    debug() {},
    getMainWindow() {
      return null;
    },
    getMainWindows() {
      return [];
    },
    Reader: {
      registerEventListener(type, handler) {
        handlers.set(type, handler);
      },
      unregisterEventListener(type) {
        handlers.delete(type);
      },
      getByTabID() {
        return null;
      },
    },
  };
}

/**
 * A toolbar realm stand-in. `withAppendChild: false` is the degraded shape the
 * existing harness stubs have: elements are creatable but nothing can be
 * attached, so the button has to fall back to naming itself through text.
 *
 * @param {{withAppendChild?: boolean}} [options]
 */
function fakeDoc({ withAppendChild = true } = {}) {
  const element = (tag) => {
    const node = {
      tagName: tag,
      style: {},
      children: [],
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      addEventListener() {},
      removeEventListener() {},
    };
    if (withAppendChild) {
      node.appendChild = (child) => {
        node.children.push(child);
        return child;
      };
    }
    return node;
  };
  return {
    head: element("head"),
    documentElement: element("html"),
    getElementById: () => null,
    createElement: (tag) => element(tag),
  };
}

/** A reader stand-in: enough for a session object to exist and stay unstarted. */
function fakeReader() {
  return { _iframe: null, tabID: "icon-test", getIFrame: () => null };
}

installFakeZotero();

describe("toolbar icon: URL resolution", () => {
  it("is empty before a startup supplied an add-on root", () => {
    assert.equal(toolbarIconUrl(), "", "no root means no icon, so the button stays plain text");
  });

  it("resolves the packaged path against the installed add-on root", () => {
    startup({ id: "icon-test", version: "0.5.0", rootURI: "jar:file:///opt/zotero/figure-guard@zotero.org.xpi!/" });
    assert.equal(
      toolbarIconUrl(),
      `jar:file:///opt/zotero/figure-guard@zotero.org.xpi!/${ICON_ENTRY}`,
      "the icon resolves the same way the bootstrap loads content/index.js",
    );
  });

  it("adds the missing separator when the root has no trailing slash", () => {
    shutdown();
    startup({ id: "icon-test", rootURI: "jar:file:///opt/zotero/figure-guard@zotero.org.xpi!" });
    assert.equal(
      toolbarIconUrl(),
      `jar:file:///opt/zotero/figure-guard@zotero.org.xpi!/${ICON_ENTRY}`,
      "exactly one slash separates root and path",
    );
  });

  it("is empty again after shutdown, and for a startup that reported no root", () => {
    shutdown();
    assert.equal(toolbarIconUrl(), "", "a stale root must not outlive the add-on");
    startup({ id: "icon-test" });
    assert.equal(toolbarIconUrl(), "", "a root-less startup keeps the plain text button");
  });
});

describe("toolbar icon: the button it builds", () => {
  /** The last button the toolbar handler appended. */
  let last = null;

  /** Runs the registered renderToolbar handler over one fake toolbar render. */
  function render(options) {
    const doc = fakeDoc(options);
    const event = {
      reader: fakeReader(),
      doc,
      append(button) {
        last = button;
      },
    };
    handlers.get("renderToolbar")(event);
    return last;
  }

  it("mounts a decorative icon beside the label and keeps the button named", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "icon-test", rootURI: "chrome://figure-guard/content/" });
    const button = render();

    assert.ok(button, "the toolbar render still produced a button");
    assert.equal(button.attributes.get("aria-label"), BUTTON_LABEL, "the accessible name is the label");
    assert.equal(button.title, BUTTON_TITLE, "the tooltip is unchanged");

    const [icon, label] = button.children;
    assert.equal(icon.tagName, "img", "the icon is an image element");
    assert.equal(icon.src, `chrome://figure-guard/content/${ICON_ENTRY}`, "and it points at the packaged icon");
    assert.equal(icon.attributes.get("alt"), "", "the image is decorative");
    assert.equal(icon.attributes.get("aria-hidden"), "true", "and hidden from the accessibility tree");
    assert.equal(label.tagName, "span", "the label sits next to the icon");
    assert.equal(label.textContent, BUTTON_LABEL, "with the existing short label");
  });

  it("degrades to a plain text button in a realm that cannot attach children", () => {
    const button = render({ withAppendChild: false });
    assert.equal(button.children.length, 0, "nothing could be attached");
    assert.equal(button.textContent, BUTTON_LABEL, "so the button names itself through its own text");
    assert.equal(button.attributes.get("aria-label"), BUTTON_LABEL, "and keeps the accessible name");
  });

  it("keeps the label when the root is unknown, so no broken image appears", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "icon-test" });
    const button = render();
    assert.equal(button.children.length, 1, "only the label is built, there is no icon to point at");
    assert.equal(button.children[0].tagName, "span");
  });
});

describe("toolbar icon: the packaged asset behind it", () => {
  it("ships the icon at the path the toolbar resolves", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
    const sizes = Object.keys(manifest.icons ?? {});
    assert.ok(sizes.length > 0, "the manifest declares icons");
    for (const size of sizes) {
      assert.equal(manifest.icons[size], ICON_ENTRY, `the ${size}px entry is the packaged icon`);
    }
  });

  it("is a titled SVG that scales from its viewBox", () => {
    const svg = readFileSync(path.join(repoRoot, "assets", "figureguard-icon.svg"), "utf8");
    assert.match(svg, /^<svg\b[^>]*viewBox="/, "the asset is an SVG with a viewBox");
    assert.ok(
      svg.includes("<title") && svg.includes("Zotero Figure Guard"),
      "and it names the add-on for assistive technology",
    );
  });
});

after(() => {
  shutdown();
  delete globalThis.Zotero;
});
