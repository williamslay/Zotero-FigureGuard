import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  BUTTON_LABEL,
  BUTTON_TITLE,
  getSessions,
  shutdown,
  startup,
} from "../../src/zotero/main.js";

/**
 * The toolbar toggle is a plain text button labelled 原色: the add-on icon
 * belongs to the plug-in list (the manifest `icons` entries), not to the
 * reader toolbar. These tests pin the text button the renderToolbar handler
 * mounts — its name, its aria-pressed state wiring — and the packaged icon
 * asset the manifest still ships for the add-on manager.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The packaged location the manifest maps for the plug-in-list icon. */
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
 * A toolbar realm stand-in. Elements record their listeners so tests can fire
 * events and check what detach removed. `withAppendChild: false` is the
 * degraded shape the existing harness stubs have: elements are creatable but
 * nothing can be attached, and the text button must keep working there.
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
      listeners: new Map(),
      parentNode: null,
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      addEventListener(type, handler) {
        const list = node.listeners.get(type) ?? [];
        list.push(handler);
        node.listeners.set(type, list);
      },
      removeEventListener(type, handler) {
        const list = node.listeners.get(type) ?? [];
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      },
    };
    if (withAppendChild) {
      node.appendChild = (child) => {
        child.parentNode = node;
        node.children.push(child);
        return child;
      };
      node.removeChild = (child) => {
        const at = node.children.indexOf(child);
        if (at >= 0) node.children.splice(at, 1);
        child.parentNode = null;
        return child;
      };
    }
    return node;
  };
  return {
    head: element("head"),
    documentElement: element("html"),
    createElement: (tag) => element(tag),
    getElementById: () => null,
  };
}

/** Fires every handler a fake element registered for `type`. */
function fire(node, type, event = {}) {
  for (const handler of [...(node.listeners.get(type) ?? [])]) handler(event);
}

/**
 * Runs the registered renderToolbar handler over one fake toolbar render.
 * Pass the same `reader` twice to re-render one reader's toolbar; pass the
 * same `container` to re-render into the same toolbar bar.
 *
 * @param {{withAppendChild?: boolean, reader?: object, container?: object}} [options]
 * @returns {{button: object|null, container: object}}
 */
function render(options = {}) {
  const doc = fakeDoc(options);
  const container = options.container ?? doc.createElement("div");
  let appended = null;
  const event = {
    reader: options.reader ?? fakeReader(`toggle-${++render.count}`),
    doc,
    append(button) {
      if (typeof container.appendChild === "function") container.appendChild(button);
      appended = button;
    },
  };
  handlers.get("renderToolbar")(event);
  return { button: appended, container };
}
render.count = 0;

/** A reader stand-in: enough for a session object to exist and stay unstarted. */
function fakeReader(tag) {
  return { _iframe: null, tabID: tag, getIFrame: () => null };
}

installFakeZotero();

describe("toolbar toggle: the text button it builds", () => {
  it("mounts a plain text button named by its label, with no child elements", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const { button } = render();

    assert.ok(button, "the toolbar render still produced a button");
    assert.equal(button.textContent, BUTTON_LABEL, "the button is its label: 原色, no icon");
    assert.equal(button.children.length, 0, "no img and no label span are built any more");
    assert.equal(button.title, BUTTON_TITLE, "the tooltip is unchanged");
    assert.equal(button.type, "button", "a plain button, never a form submit");
    assert.equal(button.className, "fg-toggle", "the class name keeps the fg- prefix");
    assert.equal(button.style.pointerEvents, "auto", "the toggle stays clickable over the React toolbar");
  });

  it("drives aria-pressed from the session state", () => {
    const { button } = render();
    const session = getSessions()[getSessions().length - 1];
    assert.equal(button.attributes.get("aria-pressed"), "true", "the plugin starts enabled");
    session.toggle();
    assert.equal(button.attributes.get("aria-pressed"), "false", "a toggle turns the chip off");
    session.toggle();
    assert.equal(button.attributes.get("aria-pressed"), "true", "and back on");
  });

  it("keeps its text name in a realm that cannot attach children", () => {
    const { button } = render({ withAppendChild: false });
    assert.equal(button.textContent, BUTTON_LABEL, "the name never depended on appendChild");
    assert.equal(button.attributes.get("aria-pressed"), "true", "the state attribute still applies");
  });
});

describe("toolbar toggle: activation without the double-click race", () => {
  /** One reader and toolbar shared by the activation cases. */
  let ctx = null;
  const pressed = () => ctx.button.attributes.get("aria-pressed");

  it("a primary press toggles immediately and consumes the click that follows", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render();
    assert.equal(pressed(), "true", "the plugin starts enabled");

    let prevented = false;
    fire(ctx.button, "pointerdown", { button: 0, preventDefault: () => { prevented = true; } });
    assert.equal(pressed(), "false", "pointerdown toggles on the press itself");
    assert.ok(!prevented, "pointerdown must not preventDefault: focus stays with the browser");

    fire(ctx.button, "click", { detail: 1 });
    assert.equal(pressed(), "false", "the mouse click after the press is ignored, not a second toggle");
  });

  it("ignores non-primary presses and counts each double click as two toggles, not four", () => {
    fire(ctx.button, "pointerdown", { button: 2 });
    assert.equal(pressed(), "false", "a right press does nothing");
    fire(ctx.button, "pointerdown", { button: 1 });
    assert.equal(pressed(), "false", "a middle press does nothing either");

    fire(ctx.button, "pointerdown", { button: 0 });
    fire(ctx.button, "click", { detail: 2 });
    assert.equal(pressed(), "true", "the second press of a double click toggles once; its click is ignored");
  });

  it("activates from the keyboard, where click is the only event", () => {
    fire(ctx.button, "click", { detail: 0 });
    assert.equal(pressed(), "false", "a keyboard click carries detail 0 and toggles through click");
  });

  it("re-rendering detaches the old button: both listeners gone, node out of the toolbar", () => {
    const reader = fakeReader("re-render");
    const first = render({ reader });
    const second = render({ reader, container: first.container });

    assert.deepEqual(first.button.listeners.get("click"), [], "the stale click handler is unbound");
    assert.deepEqual(first.button.listeners.get("pointerdown"), [], "and so is the stale pointerdown handler");
    assert.equal(first.button.parentNode, null, "the old node is taken out of the toolbar, not left stacked");
    assert.deepEqual(first.container.children, [second.button], "the toolbar holds exactly the new button");
    assert.notEqual(first.button, second.button, "the render really replaced the node");

    fire(first.button, "pointerdown", { button: 0 });
    fire(first.button, "click", { detail: 0 });
    assert.equal(second.button.attributes.get("aria-pressed"), "true", "firing the stale node changes nothing");
  });
});

describe("toolbar toggle: the stylesheet behind the states", () => {
  const source = readFileSync(path.join(repoRoot, "src", "zotero", "main.js"), "utf8");
  const css = source.slice(source.indexOf("const TOGGLE_CSS"), source.indexOf("`;", source.indexOf("const TOGGLE_CSS")));

  it("marks the on state with the chip fill, border and shadow only", () => {
    assert.match(css, /\[aria-pressed="true"\] \{[^}]*background-color: #0179f2/, "the on chip keeps the accent fill");
    assert.match(css, /\[aria-pressed="true"\] \{[^}]*border-color: #0157ad/, "and the accent border");
    assert.match(css, /\[aria-pressed="true"\] \{[^}]*box-shadow: 0 1px 3px/, "and the shadow");
  });

  it("leaves the label without any underline and the icon styles gone", () => {
    assert.ok(!css.includes("text-decoration"), "the real-machine verdict: no underline on 原色");
    assert.ok(!css.includes("fg-toggle-icon"), "the toolbar icon class is no longer styled");
  });
});

describe("plug-in list icon: the packaged asset behind it", () => {
  it("ships the icon at the path the manifest declares", () => {
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
