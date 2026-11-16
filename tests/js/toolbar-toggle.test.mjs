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
 * every object a press can flow through (window, toolbar document, node), which
 * survives the React tree replacing the node we appended, and the packaged icon
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
 * A toolbar realm stand-in. The window, the document and every element record
 * their listeners together with the capture flag, and every `removeEventListener`
 * call, so tests can fire one event at every object the toggle binds to and pin
 * exactly what detach unbound. A fresh element is zero-size, like the toggle of
 * a reader tab that is not the visible one; `place` puts one on screen.
 * `withAppendChild: false` is the degraded shape the existing harness stubs
 * have: elements are creatable but nothing can be attached, and the text button
 * must keep working there.
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
  // activation listeners are bound now, together with its window and the node.
  const doc = element("document");
  doc.defaultView = element("window");
  doc.head = element("head");
  doc.documentElement = element("html");
  doc.createElement = (tag) => {
    const node = element(tag);
    node.ownerDocument = doc;
    return node;
  };
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
 * Fires one event object the way capture propagation does: window, then
 * document, then the node. The same object reaches every binding the toggle
 * holds, which is exactly what its deduplication has to survive.
 *
 * @param {{doc: object, button: object}} target The render whose targets fire.
 * @param {string} type The event type.
 * @param {object} event One event object, shared by all three targets.
 */
function fireAll({ doc, button }, type, event) {
  fire(doc.defaultView, type, event);
  fire(doc, type, event);
  fire(button, type, event);
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
      /^图表原色显示 p0 t0 c0 D0 W0 O0 B0 U0 a1 0x0$/,
      "the tooltip names the toggle, starts every temporary counter at zero, and reports the node the toolbar has just attached",
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

    const bound = (node, type) => (node.listeners.get(type) ?? []).filter((entry) => entry.capture).length;
    assert.deepEqual(
      [bound(ctx.doc, "pointerdown"), bound(ctx.doc.defaultView, "pointerdown"), bound(ctx.button, "pointerdown")],
      [1, 1, 1],
      "the press path is bound once on the document, its window and the node, in the capture phase",
    );
    assert.deepEqual(
      [bound(ctx.doc, "click"), bound(ctx.doc.defaultView, "click"), bound(ctx.button, "click")],
      [1, 1, 1],
      "and so is the keyboard path, on the same set of objects",
    );
    assert.equal(ctx.button.ownerDocument, ctx.doc, "the node's own document is the toolbar document, so it is bound once");

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
    const parts = ctx.button.title.match(
      /^图表原色显示 p(\d+) t(\d+) c(\d+) D(\d+) W(\d+) O(\d+) B(\d+) U(\d+) a([01]) (\d+)x(\d+)$/,
    );
    assert.ok(parts, `the tooltip still carries the diagnostic counters: ${ctx.button.title}`);
    const [presses, toggles, clicks, docs] = parts.slice(1).map(Number);
    assert.ok(docs > presses, "the misses above raised the document count without raising the accepted one");
    assert.ok(presses > 0 && clicks > 0, "and the accepted counts moved as well");
    assert.equal(presses + clicks, toggles, "every accepted event is exactly one toggle call");
    assert.equal(ctx.doc.defaultView.listeners.get("pointerdown").length, 1, "every binding is still in place after all of that");
  });
});

describe("toolbar toggle: re-rendering unwinds the delegated listeners", () => {
  it("detaches the old button: every listener gone from every target, node out of the toolbar", () => {
    const reader = fakeReader("re-render");
    const first = render({ reader });
    const second = render({ reader, container: first.container });

    // The three objects this button held bindings on: the toolbar document, its
    // window and the node. The node's own document is the same object as the
    // toolbar document, so it contributes no fourth set.
    const targets = [first.doc, first.doc.defaultView, first.button];
    for (const target of targets) {
      assert.deepEqual(
        target.unbound,
        [
          { type: "pointerdown", capture: true },
          { type: "pointerup", capture: true },
          { type: "click", capture: true },
          { type: "pointerover", capture: true },
        ],
        "detach unbinds all four listeners from that target, and only the capture-phase bindings match",
      );
      for (const type of ["pointerdown", "pointerup", "click", "pointerover"]) {
        assert.deepEqual(target.listeners.get(type), [], `nothing of the old button is left bound to ${target.tagName}`);
      }
    }
    for (const type of ["pointerdown", "pointerup", "click", "pointerover"]) {
      assert.equal(second.doc.listeners.get(type).length, 1, `the new document carries exactly one ${type} handler`);
      assert.equal(second.doc.defaultView.listeners.get(type).length, 1, "on its window as well");
      assert.equal(second.button.listeners.get(type).length, 1, "and on the new node");
    }
    assert.equal(first.button.parentNode, null, "the old node is taken out of the toolbar, not left stacked");
    assert.deepEqual(first.container.children, [second.button], "the toolbar holds exactly the new button");
    assert.notEqual(first.button, second.button, "the render really replaced the node");
  });

  it("leaves one listener set per session however often one document re-rendered", () => {
    const reader = fakeReader("same-document");
    const doc = fakeDoc();
    render({ reader, doc });
    render({ reader, doc });
    render({ reader, doc });

    for (const type of ["pointerdown", "pointerup", "click", "pointerover"]) {
      assert.equal(doc.listeners.get(type).length, 1, `three renders, still one ${type} handler on the document`);
      assert.equal(doc.defaultView.listeners.get(type).length, 1, `and one on its window`);
    }
    assert.equal(doc.unbound.length, 8, "each replaced button unbound its own four, nothing else");
    assert.equal(doc.defaultView.unbound.length, 8, "the same for the window it bound");
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

describe("toolbar toggle: one press, every target, one action", () => {
  /** One reader's toolbar realm, rebuilt per case, with the box of its toggle. */
  let ctx = null;
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  const pressed = () => ctx.button.attributes.get("aria-pressed");
  /** Reads the temporary counters back out of the tooltip. */
  const counts = () => {
    const parts = ctx.button.title.match(
      /^图表原色显示 p(\d+) t(\d+) c(\d+) D(\d+) W(\d+) O(\d+) B(\d+) U(\d+) a([01]) (\d+)x(\d+)$/,
    );
    assert.ok(parts, `the tooltip carries every counter: ${ctx.button.title}`);
    return parts.slice(1).map(Number);
  };
  /** The three objects the toggle binds: document, its window, the node. */
  const targets = () => [ctx.doc, ctx.doc.defaultView, ctx.button];
  const mounted = () =>
    targets().flatMap((node) =>
      ["pointerdown", "pointerup", "click", "pointerover"].map((type) => ({
        what: `${node.tagName} ${type}`,
        n: (node.listeners.get(type) ?? []).filter((entry) => entry.capture).length,
      })),
    );

  /** Fresh plugin, fresh toolbar, one toggle laid out on screen. */
  const mount = (width = BOX.width, height = BOX.height) => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render();
    place(ctx.button, BOX.left, BOX.top, width, height);
  };

  it("toggles once for one press that window, document and node all report", () => {
    mount();
    assert.deepEqual(
      mounted().map((entry) => entry.n),
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      "four listeners on each of the three objects, all capture phase",
    );

    // One event object, delivered the way capture does it: outermost first.
    fireAll(ctx, "pointerdown", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });

    assert.equal(pressed(), "false", "the press toggled");
    const [P, T, C, D, W, O, B] = counts();
    assert.equal(P, 1, "one accepted press, not three");
    assert.equal(T, 1, "exactly one session.toggle call for three sightings");
    assert.deepEqual([D, W, B], [1, 1, 1], "and each of the three objects says it saw the press");
    assert.equal(O, 0, "the node's own document is the toolbar document, so it is not counted twice");
    assert.equal(C, 0, "a pointer press never counts as a keyboard click");
  });

  it("counts a keyboard click once across the same three targets", () => {
    mount();
    const event = { button: 0, detail: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button };
    fireAll(ctx, "click", event);

    assert.equal(pressed(), "false", "the keyboard click toggled");
    const [P, T, C, D] = counts();
    assert.equal(C, 1, "one accepted click for three sightings of it");
    assert.equal(T, 1, "and one toggle call");
    assert.deepEqual([P, D], [0, 0], "a keyboard click is not a pointer press");
  });

  it("raises U without toggling when only the pointerup arrives", () => {
    mount();
    // The Windows activation press: the pointerdown never reached anything this
    // button bound, but its release did.
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });

    assert.equal(pressed(), "true", "a lone pointerup must not toggle the session");
    const [P, T, , , , , B, U] = counts();
    assert.equal(U, 1, "the release counted once, though three objects saw it");
    assert.deepEqual([P, T, B], [0, 0, 0], "and it moved no press counter at all");
  });

  it("reports the connected state and the rounded box in the tooltip", () => {
    mount(60.4, 24.6);
    // Any event repaints the tooltip, so the state is read after one.
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(counts()[8], 1, "our node is in the toolbar, so a is 1");
    assert.equal(counts()[9], 60, "the reported width is the rounded rect width");
    assert.equal(counts()[10], 25, "and the reported height is the rounded rect height");

    ctx.container.removeChild(ctx.button);
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(counts()[8], 0, "the tooltip says so as soon as the node is out of the document");
    assert.equal(pressed(), "true", "and reading the tooltip never toggled anything");
  });

  it("unbinds every target it bound when the button is detached", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const reader = fakeReader("multi-detach");
    ctx = render({ reader });
    const first = ctx;
    const listSizes = () =>
      targets().flatMap((node) =>
        ["pointerdown", "pointerup", "click", "pointerover"].map((type) => (node.listeners.get(type) ?? []).length),
      );
    assert.deepEqual(listSizes(), new Array(12).fill(1), "twelve capture bindings on the three objects of this realm");

    // The next render hands us a fresh toolbar realm, so nothing of the old one
    // should still carry a listener of ours.
    const second = render({ reader });

    assert.deepEqual(listSizes(), new Array(12).fill(0), "detach emptied the document, its window and the old node");
    assert.deepEqual(
      targets().map((node) => node.unbound.length),
      [4, 4, 4],
      "and unbound exactly the four it held on each object",
    );
    assert.equal(first.button.parentNode, null, "the old node is out of its toolbar");

    ctx = second;
    assert.deepEqual(listSizes(), new Array(12).fill(1), "the new button bound its own twelve, on the new realm");
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
