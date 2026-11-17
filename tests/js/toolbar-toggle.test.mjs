import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
  BUTTON_LABEL,
  BUTTON_TITLE,
  getSessions,
  maintainButtons,
  probeAll,
  shutdown,
  startup,
} from "../../src/zotero/main.js";

/**
 * The toolbar toggle is a plain text button labelled 原色: the add-on icon
 * belongs to the plug-in list (the manifest `icons` entries), not to the
 * reader toolbar. These tests pin the text button the renderToolbar handler
 * mounts — its name, its aria-pressed state wiring — the capture-phase
 * activation delegated to the toolbar document (surviving React replacing the
 * node, cross-frame mouseup releases, and keyboard clicks), the repair that puts
 * a toggle back after the toolbar cleared it out, and the packaged icon asset.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The packaged location the manifest maps for the plug-in-list icon. */
const ICON_ENTRY = "content/figureguard-icon.svg";

/** Handlers the fake `Zotero.Reader` recorded, keyed by event type. */
const handlers = new Map();

/**
 * A `Zotero` global with just the reader event registration main.js uses.
 * `mainWindow` is the stand-in `getMainWindow()` hands back: a window with its
 * own document, which the toggle binds as the `M` target. Null keeps the old
 * shape where there is no main window to bind.
 *
 * @param {{mainWindow?: object|null}} [options]
 */
function installFakeZotero({ mainWindow = null } = {}) {
  globalThis.Zotero = {
    debug() {},
    getMainWindow() {
      return mainWindow;
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
  // A single-class selector is all `maintainButtons` asks the toolbar document for, so
  // the fake answers it by walking the tree the way a real document would.
  doc.querySelectorAll = (selector) => {
    const found = [];
    const walk = (node) => {
      for (const child of node.children ?? []) {
        if (typeof child.className === "string" && `.${child.className}` === selector) found.push(child);
        walk(child);
      }
    };
    walk(doc);
    return found;
  };
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

/**
 * The event types the toggle binds on the toolbar document in capture phase:
 * pointerdown for immediate press response, mouseup for cross-frame releases
 * re-dispatched by Zotero's chrome layer, and click for native button clicks and
 * keyboard activation (detail === 0).
 */
const BINDINGS = ["pointerdown", "mouseup", "click"];

installFakeZotero();

describe("toolbar toggle: the text button it builds", () => {
  it("mounts a plain text button named by its label, with no icon or diagnostic span", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const { button } = render();

    assert.ok(button, "the toolbar render still produced a button");
    assert.equal(button.textContent, BUTTON_LABEL, "the button is its label: 原色, no icon");
    assert.equal(button.children.length, 0, "a plain text button has no child elements");
    assert.equal(button.title, BUTTON_TITLE, "hovering shows the full tooltip name");
    assert.equal(
      button.attributes.get("aria-label"),
      BUTTON_TITLE,
      "the long name also survives as the accessible name",
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
      BINDINGS.map((type) => bound(ctx.doc, type)),
      [1, 1, 1],
      "pointerdown, mouseup and click are each bound once on the toolbar document in capture phase",
    );

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
    assert.equal(
      pressed(),
      "false",
      "the click that closes that press stands down: the pointerdown of the same press already acted",
    );
    fire(ctx.doc, "pointerdown", press(BOX.left + 5, BOX.top + 5, ctx.button));
    assert.equal(pressed(), "true", "the next press acts on its own, once");
    fire(ctx.doc, "click", { ...press(BOX.left + 5, BOX.top + 5, ctx.button), detail: 2 });
    assert.equal(pressed(), "true", "and so does the click of a double click stand down");
  });

  it("activates from the keyboard, where click is the only event", () => {
    fire(ctx.doc, "click", { ...press(BOX.left + 5, BOX.top + 5, ctx.button), detail: 0 });
    assert.equal(pressed(), "false", "a keyboard click carries detail 0 and toggles through click");
    fire(ctx.doc, "click", { ...press(BOX.left + BOX.width + 40, BOX.top + 5, ctx.container), detail: 0 });
    assert.equal(pressed(), "false", "a keyboard click outside the box is ignored too");
  });
});

describe("toolbar toggle: re-rendering unwinds the delegated listeners", () => {
  it("detaches the old button: every listener gone from the toolbar document, node out of the toolbar", () => {
    const reader = fakeReader("re-render");
    const first = render({ reader });
    const second = render({ reader, container: first.container });

    assert.deepEqual(
      first.doc.unbound,
      [
        { type: "pointerdown", capture: true },
        { type: "mouseup", capture: true },
        { type: "click", capture: true },
      ],
      "detach unbinds pointerdown, mouseup and click from the toolbar document in capture phase",
    );
    for (const type of BINDINGS) {
      assert.deepEqual(first.doc.listeners.get(type), [], `nothing of the old button is left bound on ${type}`);
      assert.equal(second.doc.listeners.get(type).length, 1, `the new document carries exactly one ${type} handler`);
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

    for (const type of BINDINGS) {
      assert.equal(doc.listeners.get(type).length, 1, `three renders, still one ${type} handler on the document`);
    }
    assert.equal(doc.unbound.length, 6, "each replaced button unbound its own three, nothing else");
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

describe("toolbar toggle: the pointerdown, mouseup, click activation ladder", () => {
  /** One reader's toolbar realm, rebuilt per case, with the box of its toggle. */
  let ctx = null;
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  const pressed = () => ctx.button.attributes.get("aria-pressed");

  /** Fresh plugin, fresh toolbar, one toggle laid out on screen. */
  const mount = () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render();
    place(ctx.button, BOX.left, BOX.top, BOX.width, BOX.height);
  };
  /** One event aimed at the middle of our box, with `detail` the click count. */
  const inBox = (detail = 0) => ({
    button: 0,
    detail,
    clientX: BOX.left + 5,
    clientY: BOX.top + 5,
    target: ctx.button,
  });
  /** The same shape beside the toggle, aimed at the toolbar bar. */
  const outside = (detail = 0) => ({
    button: 0,
    detail,
    clientX: BOX.left + BOX.width + 40,
    clientY: BOX.top + 5,
    target: ctx.container,
  });

  it("toggles once on a lone mouse click with no pointerdown before it", () => {
    mount();
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "the click-only press toggled the session");
  });

  it("toggles once on a lone release with no pointerdown before it", () => {
    mount();
    fire(ctx.doc, "mouseup", inBox());
    assert.equal(pressed(), "false", "the release-only press toggled the session");
  });

  it("toggles once for a full press: pointerdown, then the click it produces", () => {
    mount();
    fire(ctx.doc, "pointerdown", inBox());
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "pointerdown acted and the closing click stood down");
  });

  it("lets the release stand down when the pointerdown of the same press acted", () => {
    mount();
    fire(ctx.doc, "pointerdown", inBox());
    fire(ctx.doc, "mouseup", inBox());
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "neither the release nor the click added a toggle");
  });

  it("acts on the release and then stands the click of that same press down", () => {
    mount();
    fire(ctx.doc, "mouseup", inBox());
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "the release acted and the click that closed it stood down");
  });

  it("clears pressActivated when dragging out before release", () => {
    mount();
    fire(ctx.doc, "pointerdown", inBox());
    assert.equal(pressed(), "false", "the initial press toggled");
    fire(ctx.doc, "mouseup", outside());
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "true", "the next click is not swallowed by a stale flag");
  });

  it("toggles twice for a double click, one action per press", () => {
    mount();
    fire(ctx.doc, "pointerdown", inBox());
    fire(ctx.doc, "mouseup", inBox());
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "first click of double-click toggled once");
    fire(ctx.doc, "pointerdown", inBox());
    fire(ctx.doc, "mouseup", inBox());
    fire(ctx.doc, "click", inBox(2));
    assert.equal(pressed(), "true", "two presses land back on enabled");
  });

  it("ignores a lone mouse click outside the box", () => {
    mount();
    fire(ctx.doc, "click", outside(1));
    assert.equal(pressed(), "true", "a click beside the toggle changes nothing");
  });

  it("ignores a lone release outside the box, and a release of another key", () => {
    mount();
    fire(ctx.doc, "mouseup", outside());
    fire(ctx.doc, "mouseup", { ...inBox(), button: 2 });
    assert.equal(pressed(), "true", "neither the release beside the toggle nor the right release toggled");
  });

  it("activates from keyboard click even with zeroed client coordinates", () => {
    mount();
    fire(ctx.doc, "click", inBox(0));
    assert.equal(pressed(), "false", "keyboard activation works");
    fire(ctx.doc, "click", { button: 0, detail: 0, clientX: 0, clientY: 0, target: ctx.button });
    assert.equal(pressed(), "true", "zero-coordinate keyboard click targeting our connected button also toggles");
  });

  it("keeps a keyboard click alive after a release left the flag raised", () => {
    mount();
    fire(ctx.doc, "mouseup", inBox());
    fire(ctx.doc, "click", inBox(0));
    assert.equal(pressed(), "true", "a release and a keyboard click are two toggles");
    fire(ctx.doc, "click", inBox(1));
    assert.equal(pressed(), "false", "and the flag did not survive the key");
  });
});

describe("toolbar toggle: putting a lost toggle back", () => {
  /** One render, plus the toolbar bar it was mounted in. */
  let ctx = null;
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  /** The probe's view of this session's toggle: `{mounted, hasParent, hasAppend}`. */
  const buttonState = () => {
    const report = probeAll();
    assert.equal(report.sessions.length, 1, "this fixture has exactly one live session to probe");
    return report.sessions[0].button;
  };

  /** Fresh plugin, fresh toolbar, one toggle laid out on screen. */
  const mount = () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render();
    place(ctx.button, BOX.left, BOX.top, BOX.width, BOX.height);
  };
  /** The toolbar's own re-render: our node out of the bar, nothing re-appended. */
  const clearOut = () => {
    if (ctx.container.children.includes(ctx.button)) ctx.container.removeChild(ctx.button);
    assert.equal(ctx.button.isConnected, false, "the toolbar's re-render left our node out");
  };

  it("remounts a toggle the toolbar cleared out, into the bar it came from", () => {
    mount();
    ctx.doc.appendChild(ctx.container);
    clearOut();
    assert.equal(buttonState().mounted, false, "the probe says the switch is gone");

    assert.equal(maintainButtons(), 1, "one repair pass brings one toggle back");
    assert.equal(ctx.button.parentNode, ctx.container, "into the toolbar bar it was mounted in");
    assert.equal(ctx.button.isConnected, true, "so the node is on screen again");
    assert.equal(buttonState().mounted, true, "and the probe sees it mounted");
    assert.equal(maintainButtons(), 0, "a second pass finds nothing to do");
  });

  it("does not stack a second switch on a toolbar that still has one", () => {
    mount();
    ctx.doc.appendChild(ctx.container);
    assert.equal(maintainButtons(), 0, "a mounted toggle needs no repair");
    assert.deepEqual(ctx.container.children, [ctx.button], "and the bar still holds exactly one node");
  });

  it("leaves a hidden tab's toggle alone while another of ours is on screen", () => {
    mount();
    ctx.doc.appendChild(ctx.container);
    clearOut();
    // The toolbar rendered its own node for our toggle: appending ours would put
    // two switches in one bar.
    const other = ctx.doc.createElement("span");
    other.className = "fg-toggle";
    ctx.doc.appendChild(other);

    assert.equal(maintainButtons(), 0, "a document that already holds one of ours gets no second one");
    assert.equal(ctx.button.isConnected, false, "ours stays out, waiting for the toolbar's own render");
  });

  it("falls back to the render's append callback when the recorded parent is gone", () => {
    mount();
    // The bar itself was replaced, so the parent we recorded is no longer in the
    // document: only the render's own append callback can mount anything.
    clearOut();
    assert.equal(ctx.container.isConnected, false, "the recorded parent is out of the document too");
    assert.equal(buttonState().hasParent, true, "the repair still knows the parent it recorded");
    assert.equal(buttonState().hasAppend, true, "and the append callback the render offered");

    assert.equal(maintainButtons(), 1, "the fallback path mounts the toggle");
    assert.equal(ctx.button.isConnected, true, "through the append callback the render gave us");
    assert.equal(buttonState().mounted, true, "and the probe agrees");
  });

  it("reports the toggle state of the session the probe lists", () => {
    mount();
    assert.deepEqual(buttonState(), { mounted: true, hasParent: true, hasAppend: true }, "a fresh render is mounted");
    ctx.container.removeChild(ctx.button);
    assert.deepEqual(buttonState(), { mounted: false, hasParent: true, hasAppend: true }, "after the bar drops it, not");
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

  it("leaves the label without any underline and the icon or counter styles gone", () => {
    assert.ok(!css.includes("text-decoration"), "the real-machine verdict: no underline on 原色");
    assert.ok(!css.includes("fg-toggle-icon"), "the toolbar icon class is no longer styled");
    assert.ok(!css.includes("COUNT_CLASS") && !css.includes("fg-count"), "temporary counter styles are removed");
  });

  it("keeps the press box still, since the press now repaints immediately", () => {
    assert.ok(!/\.fg-toggle:active\b/.test(css), "the bare :active rule is gone: its 1px shift moved the hit area between press and release");
    assert.ok(!css.includes("transform"), "no transform is left in the toggle stylesheet");
  });

  it("opts out of Zotero toolbar window dragging so single presses reach the button", () => {
    assert.match(css, /\.\$\{TOGGLE_CLASS\}\s*\{[^}]*-moz-window-dragging:\s*no-drag;/, "the toggle excludes itself from DIV.toolbar's drag region");
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
