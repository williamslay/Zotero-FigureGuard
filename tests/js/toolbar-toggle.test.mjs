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
 * mounts — its name, its aria-pressed state wiring — the activation delegated to
 * the toolbar document, which survives the React tree replacing the node we
 * appended, and the packaged icon asset the manifest still ships for the add-on
 * manager.
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
 * A toolbar realm stand-in. The document and every element record their
 * listeners together with the capture flag, and every `removeEventListener`
 * call, so tests can fire document-level events and pin exactly what detach
 * unbound. A fresh element is zero-size, like the toggle of a reader tab that
 * is not the visible one; `place` puts one on screen. `withAppendChild: false`
 * is the degraded shape the existing harness stubs have: elements are creatable
 * but nothing can be attached, and the text button must keep working there.
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
      /** Every `removeEventListener` call, so detach can be asserted exactly. */
      unbound: [],
      parentNode: null,
      /** Whether this node is still in the document, as the DOM reports it. */
      get isConnected() {
        return Boolean(node.parentNode);
      },
      /** The node's box on screen; a fresh node has never been laid out. */
      rect: { left: 0, top: 0, width: 0, height: 0 },
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      getBoundingClientRect() {
        const { left, top, width, height } = node.rect;
        return { left, top, width, height, right: left + width, bottom: top + height };
      },
      // Enough of `closest` for a single-class selector such as `.fg-toggle`.
      closest(selector) {
        for (let cur = node; cur; cur = cur.parentNode) {
          if (typeof cur.className === "string" && `.${cur.className}` === selector) return cur;
        }
        return null;
      },
      addEventListener(type, handler, options) {
        const list = node.listeners.get(type) ?? [];
        list.push({ handler, capture: options === true });
        node.listeners.set(type, list);
      },
      removeEventListener(type, handler, options) {
        const list = node.listeners.get(type) ?? [];
        const at = list.findIndex(
          (entry) => entry.handler === handler && entry.capture === (options === true),
        );
        if (at >= 0) list.splice(at, 1);
        node.unbound.push({ type, capture: options === true });
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

  // The document itself is a node, because that is where the toggle's
  // activation listeners are bound now.
  const doc = element("document");
  doc.head = element("head");
  doc.documentElement = element("html");
  doc.createElement = (tag) => element(tag);
  doc.getElementById = () => null;
  return doc;
}

/** Puts a fake node on screen, so a press can land inside it or outside it. */
function place(node, left, top, width = 60, height = 24) {
  node.rect = { left, top, width, height };
  return node;
}

/** Fires every handler a fake node registered for `type`, capture included. */
function fire(node, type, event = {}) {
  for (const entry of [...(node.listeners.get(type) ?? [])]) entry.handler(event);
}

/**
 * Runs the registered renderToolbar handler over one fake toolbar render.
 * Pass the same `reader` twice to re-render one reader's toolbar; pass the same
 * `container` to re-render into the same toolbar bar, or the same `doc` to
 * re-render into the same toolbar document.
 *
 * @param {{withAppendChild?: boolean, reader?: object, container?: object, doc?: object}} [options]
 * @returns {{button: object|null, container: object, doc: object}}
 */
function render(options = {}) {
  const doc = options.doc ?? fakeDoc(options);
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
  return { button: appended, container, doc };
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
    assert.match(
      button.title,
      /^图表原色显示 p0 c0 d0 t0$/,
      "the tooltip names the toggle and starts the temporary counters at zero",
    );
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

describe("toolbar toggle: activation delegated to the toolbar document", () => {
  /** One reader, toolbar bar and toolbar document shared by these cases. */
  let ctx = null;
  /** Our toggle's box on screen; every press below is written against it. */
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  const pressed = () => ctx.button.attributes.get("aria-pressed");
  /** One press at `x`, `y`, aimed at `target`, with `button` the pointer key. */
  const press = (x, y, target, button = 0) => ({ button, clientX: x, clientY: y, target });
  /** A re-rendered toolbar node that carries our class but is not our node. */
  const standIn = (left, width = BOX.width, height = BOX.height) => {
    const node = ctx.doc.createElement("button");
    node.className = "fg-toggle";
    place(node, left, BOX.top, width, height);
    return node;
  };

  it("toggles once on a press inside our button's box, from the document listener", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render();
    place(ctx.button, BOX.left, BOX.top, BOX.width, BOX.height);
    assert.equal(pressed(), "true", "the plugin starts enabled");

    const bindings = ctx.doc.listeners.get("pointerdown");
    assert.equal(bindings.length, 1, "the press handler is bound on the document, never on the node");
    assert.equal(bindings[0].capture, true, "in the capture phase, so a re-render cannot swallow the press");
    assert.equal(ctx.doc.listeners.get("click").length, 1, "the keyboard handler sits on the document too");

    let prevented = false;
    fire(ctx.doc, "pointerdown", {
      ...press(BOX.left + 5, BOX.top + 5, ctx.button),
      preventDefault: () => { prevented = true; },
    });
    assert.equal(pressed(), "false", "the press itself toggles, exactly once");
    assert.ok(!prevented, "the press must not preventDefault: focus stays with the browser");
  });

  it("ignores a press elsewhere in the toolbar document", () => {
    fire(ctx.doc, "pointerdown", press(BOX.left + BOX.width + 40, BOX.top + 5, ctx.container));
    assert.equal(pressed(), "false", "a press beside the toggle changes nothing");
  });

  it("toggles on a press over a re-rendered stand-in that carries the class", () => {
    // The case this delegation exists for: the toolbar threw our node away and
    // rendered its own node for the toggle in its place.
    ctx.container.removeChild(ctx.button);
    assert.equal(ctx.button.isConnected, false, "our node is out of the document");
    const node = standIn(400);
    fire(ctx.doc, "pointerdown", press(420, BOX.top + 5, node));
    assert.equal(pressed(), "true", "the toolbar's own node for our toggle is accepted");
  });

  it("ignores a press on the zero-size toggle of a hidden reader tab", () => {
    const hidden = standIn(500, 0, 0);
    fire(ctx.doc, "pointerdown", press(500, BOX.top, hidden));
    assert.equal(pressed(), "true", "a zero-area box belongs to a hidden tab, so it is not a hit");
  });

  it("ignores non-primary presses aimed at the box", () => {
    fire(ctx.doc, "pointerdown", press(BOX.left + 5, BOX.top + 5, ctx.button, 1));
    assert.equal(pressed(), "true", "a middle press does nothing");
    fire(ctx.doc, "pointerdown", press(BOX.left + 5, BOX.top + 5, ctx.button, 2));
    assert.equal(pressed(), "true", "a right press does nothing either");
  });

  it("does not double-toggle on the click a mouse press produces", () => {
    fire(ctx.doc, "pointerdown", press(BOX.left + 5, BOX.top + 5, ctx.button));
    assert.equal(pressed(), "false", "the press toggled");
    fire(ctx.doc, "click", { ...press(BOX.left + 5, BOX.top + 5, ctx.button), detail: 1 });
    assert.equal(pressed(), "false", "the mouse click after the press is ignored, not a second toggle");
    fire(ctx.doc, "click", { ...press(BOX.left + 5, BOX.top + 5, ctx.button), detail: 2 });
    assert.equal(pressed(), "false", "nor is the click of a double click");
  });

  it("activates from the keyboard, where click is the only event", () => {
    fire(ctx.doc, "click", { ...press(BOX.left + 5, BOX.top + 5, ctx.button), detail: 0 });
    assert.equal(pressed(), "true", "a keyboard click carries detail 0 and toggles through click");
    fire(ctx.doc, "click", { ...press(BOX.left + BOX.width + 40, BOX.top + 5, ctx.container), detail: 0 });
    assert.equal(pressed(), "true", "a keyboard click outside the box is ignored too");
  });

  it("keeps the temporary counters in the tooltip", () => {
    const seen = ctx.button.title.match(/^图表原色显示 p(\d+) c(\d+) d(\d+) t(\d+)$/);
    assert.ok(seen, `the tooltip still carries the diagnostic counters: ${ctx.button.title}`);
    const [presses, clicks, docs, toggles] = seen.slice(1).map(Number);
    assert.ok(docs > presses, "the misses above raised the document count without raising the accepted one");
    assert.ok(presses > 0 && clicks > 0, "and the accepted counts moved as well");
    assert.equal(presses + clicks, toggles, "every accepted event is exactly one toggle call");
  });
});

describe("toolbar toggle: re-rendering unwinds the delegated listeners", () => {
  it("detaches the old button: both document listeners gone, node out of the toolbar", () => {
    const reader = fakeReader("re-render");
    const first = render({ reader });
    const second = render({ reader, container: first.container });

    assert.deepEqual(
      first.doc.unbound,
      [
        { type: "pointerdown", capture: true },
        { type: "click", capture: true },
      ],
      "detach unbinds both document listeners, and only the capture-phase bindings match",
    );
    assert.deepEqual(first.doc.listeners.get("pointerdown"), [], "nothing is left bound to the old document");
    assert.deepEqual(first.doc.listeners.get("click"), [], "for the press handler and for the click handler");
    assert.equal(second.doc.listeners.get("pointerdown").length, 1, "the new document carries exactly the new pair");
    assert.equal(second.doc.listeners.get("click").length, 1, "one press handler and one click handler");
    assert.equal(first.button.parentNode, null, "the old node is taken out of the toolbar, not left stacked");
    assert.deepEqual(first.container.children, [second.button], "the toolbar holds exactly the new button");
    assert.notEqual(first.button, second.button, "the render really replaced the node");
  });

  it("leaves one listener pair per session however often one document re-rendered", () => {
    const reader = fakeReader("same-document");
    const doc = fakeDoc();
    render({ reader, doc });
    render({ reader, doc });
    render({ reader, doc });

    assert.equal(doc.listeners.get("pointerdown").length, 1, "three renders, still one press handler");
    assert.equal(doc.listeners.get("click").length, 1, "and one click handler");
    assert.equal(doc.unbound.length, 4, "each replaced button unbound its own pair, nothing else");
  });
});

describe("toolbar toggle: two reader tabs sharing one toolbar document", () => {
  it("toggles only the visible tab, because the hidden tab's toggle has no box", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const doc = fakeDoc();
    const visible = render({ reader: fakeReader("tab-visible"), doc });
    const background = render({ reader: fakeReader("tab-background"), doc });
    place(visible.button, 100, 20, 60, 24);
    place(background.button, 0, 0, 0, 0);

    assert.equal(doc.listeners.get("pointerdown").length, 2, "one press handler per session, on the shared document");
    assert.equal(visible.button.attributes.get("aria-pressed"), "true", "both tabs start enabled");
    assert.equal(background.button.attributes.get("aria-pressed"), "true", "including the one behind");

    fire(doc, "pointerdown", {
      button: 0,
      clientX: 120,
      clientY: 30,
      target: visible.button,
    });
    assert.equal(visible.button.attributes.get("aria-pressed"), "false", "the tab under the press toggled");
    assert.equal(
      background.button.attributes.get("aria-pressed"),
      "true",
      "the background tab kept its state: its own listener rejected the zero-area box",
    );
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

  it("keeps the press box still, since the press now repaints immediately", () => {
    assert.ok(!/\.fg-toggle:active\b/.test(css), "the bare :active rule is gone: its 1px shift moved the hit area between press and release");
    assert.ok(!css.includes("transform"), "no transform is left in the toggle stylesheet");
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
