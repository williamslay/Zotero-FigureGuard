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
 * mounts — its name, its aria-pressed state wiring — the activation delegated to
 * every object a press can flow through (window, toolbar document, node), which
 * survives the React tree replacing the node we appended, the release and the click as
 * further real activation paths for the press that reaches us with no pointerdown at
 * all, the repair that puts a toggle back after the toolbar cleared it out, and the
 * packaged icon asset the manifest still ships for the add-on manager.
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

/**
 * The temporary counter line of a rendered toggle: the text of the `fg-count` span
 * inside the chip, or the native `title` in a realm that cannot attach children.
 *
 * @param {object} button
 * @returns {string}
 */
function counterText(button) {
  const span = (button?.children ?? []).find((child) => child?.className === "fg-count");
  return String(span?.textContent ?? button?.title ?? "");
}

/**
 * The counter pattern, without the leading name. `m` counts the mouse clicks this
 * button acted on because neither a pointerdown nor a release of the same press had
 * acted first, and `k` counts the releases that carried a press the pointerdown never
 * reported, so the accepted-event invariant is `p + c + m + k === t`. The tail carries
 * the last pointerdown sighting: `@x,y`, the target description `x=`, and the rounded
 * top-left of our own box `LT=`.
 */
const COUNTERS =
  /^p(\d+) t(\d+) c(\d+) m(\d+) k(\d+) D(\d+) W(\d+) B(\d+) M(\d+) I(\d+) U(\d+) a([01]) (\d+)x(\d+) @(-?\d+|-),(-?\d+|-) x=(\S+) LT=(-?\d+|\?)x(-?\d+|\?)$/;

/**
 * Reads the counters out of one read-out line, in the order the chip prints them:
 * `p t c m k D W B M I U a w h`, then the last-press tail as strings.
 *
 * @param {string} text One read-out line.
 * @returns {string[]} The captured fields, counters first.
 */
function fieldsOf(text) {
  const parts = text.match(COUNTERS);
  assert.ok(parts, `the read-out carries every counter: ${text}`);
  return parts.slice(1);
}

/**
 * The event types the toggle binds on every object it can hear a press through, in
 * the order it binds them: the press, its release, the release the chrome re-dispatches
 * across the iframe boundary, the click the browser synthesises, and the hover that
 * late-binds the reader's inner document.
 */
const BINDINGS = ["pointerdown", "pointerup", "mouseup", "click", "pointerover"];

installFakeZotero();

describe("toolbar toggle: the text button it builds", () => {
  it("mounts a plain text button named by its label, with only the counter line inside", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const { button } = render();

    assert.ok(button, "the toolbar render still produced a button");
    assert.equal(button.textContent, BUTTON_LABEL, "the button is its label: 原色, no icon");
    assert.equal(
      button.children.length,
      1,
      "the only child is the temporary counter span: no img and no label element",
    );
    assert.equal(button.children[0].className, "fg-count", "the counter line carries its own class");
    assert.ok(!button.title, "no native title: a tooltip window must not eat the press");
    assert.equal(
      button.attributes.get("aria-label"),
      BUTTON_TITLE,
      "the long name survives as the accessible name",
    );
    assert.match(
      counterText(button),
      /^p0 t0 c0 m0 k0 D0 W0 B0 M0 I0 U0 a1 0x0 @-,- x=\? LT=0x0$/,
      "the read-out starts every temporary counter at zero, has seen no pointerdown yet, and reports the node the toolbar has just attached",
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
      "and so is the click path, on the same set of objects",
    );
    assert.deepEqual(
      [bound(ctx.doc, "mouseup"), bound(ctx.doc.defaultView, "mouseup"), bound(ctx.button, "mouseup")],
      [1, 1, 1],
      "and so is the release path that sits between them, on the same set of objects",
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

  it("keeps the temporary counters in the chip, not in a native tooltip", () => {
    const parts = counterText(ctx.button).match(COUNTERS);
    assert.ok(parts, `the chip still carries the diagnostic counters: ${counterText(ctx.button)}`);
    const [presses, toggles, clicks, mouseClicks, releases, docs] = parts.slice(1).map(Number);
    assert.ok(docs > presses, "the misses above raised the document count without raising the accepted one");
    assert.ok(presses > 0 && clicks > 0, "and the accepted counts moved as well");
    assert.equal(presses + clicks + mouseClicks + releases, toggles, "every accepted event is exactly one toggle call");
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
          { type: "mouseup", capture: true },
          { type: "click", capture: true },
          { type: "pointerover", capture: true },
        ],
        "detach unbinds all five listeners from that target, and only the capture-phase bindings match",
      );
      for (const type of BINDINGS) {
        assert.deepEqual(target.listeners.get(type), [], `nothing of the old button is left bound to ${target.tagName}`);
      }
    }
    for (const type of BINDINGS) {
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

    for (const type of BINDINGS) {
      assert.equal(doc.listeners.get(type).length, 1, `three renders, still one ${type} handler on the document`);
      assert.equal(doc.defaultView.listeners.get(type).length, 1, `and one on its window`);
    }
    assert.equal(doc.unbound.length, 10, "each replaced button unbound its own five, nothing else");
    assert.equal(doc.defaultView.unbound.length, 10, "the same for the window it bound");
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
  /** Reads the temporary counters back out of the chip's own read-out. */
  const counts = () => fieldsOf(counterText(ctx.button)).map(Number);
  /** The three objects the toggle binds: document, its window, the node. */
  const targets = () => [ctx.doc, ctx.doc.defaultView, ctx.button];
  const mounted = () =>
    targets().flatMap((node) =>
      BINDINGS.map((type) => ({
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
      new Array(15).fill(1),
      "five listeners on each of the three objects, all capture phase",
    );

    // One event object, delivered the way capture does it: outermost first.
    fireAll(ctx, "pointerdown", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });

    assert.equal(pressed(), "false", "the press toggled");
    const [P, T, C, MC, , D, W, B, M] = counts();
    assert.equal(P, 1, "one accepted press, not three");
    assert.equal(T, 1, "exactly one session.toggle call for three sightings");
    assert.deepEqual([D, W, B], [1, 1, 1], "and each of the three objects says it saw the press");
    assert.equal(M, 0, "this fixture has no main-window document, so the M target is not bound");
    assert.deepEqual([C, MC], [0, 0], "a pointer press never counts as a keyboard or a mouse click");
  });

  it("counts a keyboard click once across the same three targets", () => {
    mount();
    const event = { button: 0, detail: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button };
    fireAll(ctx, "click", event);

    assert.equal(pressed(), "false", "the keyboard click toggled");
    const [P, T, C, MC, , D] = counts();
    assert.equal(C, 1, "one accepted click for three sightings of it");
    assert.equal(T, 1, "and one toggle call");
    assert.deepEqual([P, MC, D], [0, 0, 0], "a keyboard click is not a pointer press and not a mouse click");
  });

  it("raises U without toggling when only the pointerup arrives", () => {
    mount();
    // The Windows activation press: the pointerdown never reached anything this
    // button bound, but its release did.
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });

    assert.equal(pressed(), "true", "a lone pointerup must not toggle the session");
    const [P, T, , , K, , , B, , , U] = counts();
    assert.equal(U, 1, "the release counted once, though three objects saw it");
    assert.deepEqual([P, T, B], [0, 0, 0], "and it moved no press counter at all");
    assert.equal(K, 0, "the counting release is not the activation release: k stays put");
  });

  it("reports the connected state and the rounded box in the chip", () => {
    mount(60.4, 24.6);
    // Any event repaints the read-out, so the state is read after one.
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(counts()[11], 1, "our node is in the toolbar, so a is 1");
    assert.equal(counts()[12], 60, "the reported width is the rounded rect width");
    assert.equal(counts()[13], 25, "and the reported height is the rounded rect height");

    ctx.container.removeChild(ctx.button);
    fireAll(ctx, "pointerup", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(counts()[11], 0, "the read-out says so as soon as the node is out of the document");
    assert.equal(pressed(), "true", "and reading the read-out never toggled anything");
  });

  it("unbinds every target it bound when the button is detached", () => {
    shutdown();
    installFakeZotero();
    startup({ id: "toggle-test", version: "0.5.0" });
    const reader = fakeReader("multi-detach");
    ctx = render({ reader });
    const first = ctx;
    const listSizes = () =>
      targets().flatMap((node) => BINDINGS.map((type) => (node.listeners.get(type) ?? []).length));
    assert.deepEqual(listSizes(), new Array(15).fill(1), "fifteen capture bindings on the three objects of this realm");

    // The next render hands us a fresh toolbar realm, so nothing of the old one
    // should still carry a listener of ours.
    const second = render({ reader });

    assert.deepEqual(listSizes(), new Array(15).fill(0), "detach emptied the document, its window and the old node");
    assert.deepEqual(
      targets().map((node) => node.unbound.length),
      [5, 5, 5],
      "and unbound exactly the five it held on each object",
    );
    assert.equal(first.button.parentNode, null, "the old node is out of its toolbar");

    ctx = second;
    assert.deepEqual(listSizes(), new Array(15).fill(1), "the new button bound its own fifteen, on the new realm");
  });
});

describe("toolbar toggle: the pointerdown, mouseup, click activation ladder", () => {
  /** One reader's toolbar realm, rebuilt per case, with the box of its toggle. */
  let ctx = null;
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  const pressed = () => ctx.button.attributes.get("aria-pressed");
  /** The read-out counters, in the order the chip prints them. */
  const counts = () => fieldsOf(counterText(ctx.button)).map(Number);
  /** The accepted-event counters: `p` the press, `k` the release, `m`/`c` the click. */
  const accepted = () => {
    const [P, T, C, MC, K] = counts();
    return { P, T, C, MC, K };
  };

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
    // The single-click symptom itself: on the real machine a click arrives with no
    // pointerdown on any object this button bound, so click has to be an
    // activation path of its own.
    mount();
    fireAll(ctx, "click", inBox(1));

    assert.equal(pressed(), "false", "the click-only press toggled the session");
    const [P, T, C, MC, , D, W, B] = counts();
    assert.equal(MC, 1, "one accepted mouse click, for three sightings of one event object");
    assert.equal(T, 1, "and exactly one session.toggle call for it");
    assert.deepEqual([P, C], [0, 0], "no pointer press and no keyboard click were involved");
    assert.deepEqual([D, W, B], [0, 0, 0], "and no pointerdown was sighted on any target");
    assert.equal(P + C + MC, T, "the p + c + m + k === t invariant holds on the click-only path");
  });

  it("toggles once on a lone release with no pointerdown before it", () => {
    // The rung between the two: Zotero's chrome layer re-dispatches the release
    // across the iframe boundary, so a press whose pointerdown went nowhere can
    // still be carried by its mouseup.
    mount();
    fireAll(ctx, "mouseup", inBox());

    assert.equal(pressed(), "false", "the release-only press toggled the session");
    const { P, T, C, MC, K } = accepted();
    assert.equal(K, 1, "one accepted release, for three sightings of one event object");
    assert.equal(T, 1, "and exactly one session.toggle call for it");
    assert.deepEqual([P, C, MC], [0, 0, 0], "and neither the press nor either click rung acted");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds on the release-only path");
  });

  it("toggles once for a full press: pointerdown, then the click it produces", () => {
    mount();
    fireAll(ctx, "pointerdown", inBox());
    fireAll(ctx, "click", inBox(1));

    assert.equal(pressed(), "false", "the press acted, once");
    const { P, T, C, MC, K } = accepted();
    assert.deepEqual([P, C, MC, K, T], [1, 0, 0, 0, 1], "pointerdown acted and the closing click stood down");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds on the pointer path");
  });

  it("lets the release stand down when the pointerdown of the same press acted", () => {
    mount();
    fireAll(ctx, "pointerdown", inBox());
    fireAll(ctx, "pointerup", inBox());
    fireAll(ctx, "mouseup", inBox());
    fireAll(ctx, "click", inBox(1));

    assert.equal(pressed(), "false", "the press acted, once");
    const { P, T, C, MC, K } = accepted();
    assert.deepEqual([P, C, MC, K, T], [1, 0, 0, 0, 1], "neither the release nor the click added a toggle");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds across the whole ladder");
  });

  it("acts on the release and then stands the click of that same press down", () => {
    // The order the report shows: no pointerdown, but the release and the click
    // both arrive. The release carries the activation and the click has to notice.
    mount();
    fireAll(ctx, "mouseup", inBox());
    fireAll(ctx, "click", inBox(1));

    assert.equal(pressed(), "false", "one press, one toggle");
    const { P, T, C, MC, K } = accepted();
    assert.deepEqual([P, C, MC, K, T], [0, 0, 0, 1, 1], "the release acted and the click that closed it stood down");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds on the release-then-click path");
  });

  it("toggles twice for a double click, one action per press", () => {
    mount();
    // The event order a real double click produces, on all three targets.
    fireAll(ctx, "pointerdown", inBox());
    fireAll(ctx, "pointerup", inBox());
    fireAll(ctx, "mouseup", inBox());
    fireAll(ctx, "click", inBox(1));
    fireAll(ctx, "pointerdown", inBox());
    fireAll(ctx, "pointerup", inBox());
    fireAll(ctx, "mouseup", inBox());
    fireAll(ctx, "click", inBox(2));

    const { P, T, C, MC, K } = accepted();
    const [, , , , , , , , , , U] = counts();
    assert.deepEqual([P, C, MC, K, T], [2, 0, 0, 0, 2], "two presses acted, and neither release nor click added one");
    assert.equal(U, 2, "both counting releases recorded, without acting");
    assert.equal(pressed(), "true", "two toggles from the enabled start land back on enabled");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds across a double click");
  });

  it("ignores a lone mouse click outside the box", () => {
    mount();
    fireAll(ctx, "click", outside(1));

    assert.equal(pressed(), "true", "a click beside the toggle changes nothing");
    const [, T, C, MC] = counts();
    assert.deepEqual([T, C, MC], [0, 0, 0], "a click the hit test refused is not counted as accepted either");
  });

  it("ignores a lone release outside the box, and a release of another key", () => {
    mount();
    fireAll(ctx, "mouseup", outside());
    fireAll(ctx, "mouseup", { ...inBox(), button: 2 });

    assert.equal(pressed(), "true", "neither the release beside the toggle nor the right release toggled");
    const { T, C, MC, K } = accepted();
    assert.deepEqual([T, C, MC, K], [0, 0, 0, 0], "and a release of a non-primary key is not an activation");
  });

  it("keeps a keyboard click on c, never on m", () => {
    mount();
    fireAll(ctx, "click", inBox(0));

    assert.equal(pressed(), "false", "the keyboard activation still works");
    const [, T, C, MC] = counts();
    assert.deepEqual([C, MC, T], [1, 0, 1], "detail 0 is accepted as a keyboard click, not a mouse click");
  });

  it("keeps a keyboard click alive after a release left the flag raised", () => {
    // No pointer event ever precedes a key, so a flag an earlier mouse action left
    // raised must neither stop a keyboard click nor survive it.
    mount();
    fireAll(ctx, "mouseup", inBox()); // acts, and raises the flag
    fireAll(ctx, "click", inBox(0)); // a keyboard click with the flag set

    assert.equal(pressed(), "true", "a release and a keyboard click are two toggles");
    const { P, T, C, MC, K } = accepted();
    assert.deepEqual([P, C, MC, K, T], [0, 1, 0, 1, 2], "the keyboard click acted through the flag, under c");
    fireAll(ctx, "click", inBox(1)); // the mouse path again, with the key having cleared the flag
    assert.deepEqual([accepted().MC, accepted().T], [1, 3], "and the flag did not survive the key");
  });

  it("accepts every path in a row and still counts one toggle per accepted event", () => {
    mount();
    fireAll(ctx, "click", inBox(1)); // no pointerdown before it: the mouse-click path
    fireAll(ctx, "pointerdown", inBox()); // the pointer path
    fireAll(ctx, "click", inBox(1)); // the click that closes it, suppressed
    fireAll(ctx, "click", inBox(0)); // the keyboard path
    fireAll(ctx, "mouseup", inBox()); // the release path
    fireAll(ctx, "click", inBox(1)); // the click that closes it, suppressed
    fireAll(ctx, "click", inBox(1)); // another click-only press, after the suppressed one

    const { P, T, C, MC, K } = accepted();
    assert.deepEqual([P, C, MC, K], [1, 1, 2, 1], "one accepted event per path, plus one repeat of the click-only path");
    assert.equal(T, 5, "one toggle per accepted event, and none for either suppressed click");
    assert.equal(pressed(), "false", "five toggles from the enabled start land on off");
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds across all four paths");
  });
});

describe("toolbar toggle: the main-window and inner-document targets", () => {
  /** One render, plus the main-window document the fake Zotero reports. */
  let ctx = null;
  const BOX = { left: 100, top: 20, width: 60, height: 24 };
  const pressed = () => ctx.button.attributes.get("aria-pressed");
  /** The read-out fields as strings: counters, box, then the last-press tail. */
  const fields = () => fieldsOf(counterText(ctx.button));

  /** Fresh plugin whose main window owns a document distinct from the toolbar's. */
  const mount = (options = {}) => {
    shutdown();
    const mainDoc = fakeDoc();
    installFakeZotero({ mainWindow: { document: mainDoc } });
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render(options);
    ctx.mainDoc = mainDoc;
    place(ctx.button, BOX.left, BOX.top, BOX.width, BOX.height);
  };

  it("toggles once for a press inside the box that only the main-window document sees", () => {
    mount();
    const bound = (node, type) => (node.listeners.get(type) ?? []).filter((entry) => entry.capture).length;
    assert.equal(bound(ctx.mainDoc, "pointerdown"), 1, "the main-window document carries its own capture binding");

    fire(ctx.mainDoc, "pointerdown", {
      button: 0,
      clientX: BOX.left + 5,
      clientY: BOX.top + 5,
      target: ctx.button,
    });

    assert.equal(pressed(), "false", "the press reached the session through the main-window document");
    const [P, T, C, MC, K, D, W, B, M] = fields().map(Number);
    assert.deepEqual(
      [P, T, C, MC, K, D, W, B, M],
      [1, 1, 0, 0, 0, 0, 0, 0, 1],
      "one accepted press, one toggle, and M says the main window saw it",
    );
    assert.equal(P + C + MC + K, T, "the p + c + m + k === t invariant holds across the new target");
  });

  it("toggles once on a lone click that only the main-window document sees", () => {
    mount();
    fire(ctx.mainDoc, "click", {
      button: 0,
      detail: 1,
      clientX: BOX.left + 5,
      clientY: BOX.top + 5,
      target: ctx.button,
    });

    assert.equal(pressed(), "false", "a click with no pointerdown activates through the main-window document");
    const [P, T, C, MC, , , , , M] = fields().map(Number);
    assert.deepEqual([P, C, MC, T], [0, 0, 1, 1], "the click is accepted once, under m, with one toggle");
    assert.equal(M, 0, "and M stayed at zero: the M letter counts pointerdowns, which this click had none of");
  });

  it("toggles once on a lone release that only the main-window document sees", () => {
    mount();
    fire(ctx.mainDoc, "mouseup", {
      button: 0,
      clientX: BOX.left + 5,
      clientY: BOX.top + 5,
      target: ctx.button,
    });

    assert.equal(pressed(), "false", "a release with no pointerdown activates through the main-window document");
    const [P, T, C, MC, K, , , , M] = fields().map(Number);
    assert.deepEqual([P, C, MC, K, T], [0, 0, 0, 1, 1], "the release is accepted once, under k, with one toggle");
    assert.equal(M, 0, "and M stayed at zero: the M letter counts pointerdowns, not releases");
  });

  it("counts a main-window press outside the box without toggling, and records it", () => {
    mount();
    const outside = ctx.mainDoc.createElement("div");
    outside.id = "tb";
    outside.className = "btn";
    fire(ctx.mainDoc, "pointerdown", {
      button: 0,
      clientX: BOX.left - 30,
      clientY: BOX.top + 101,
      target: outside,
    });
    console.log(`sample read-out: ${counterText(ctx.button)}`);

    assert.equal(pressed(), "true", "a press outside our box reaches no session");
    const [P, T, , , , D, , , M, , , , , , atX, atY, xDesc] = fields();
    assert.equal(T, "0", "the miss toggled nothing");
    assert.deepEqual([P, D].map(Number), [0, 0], "and it was accepted nowhere");
    assert.equal(M, "1", "but the main-window document still counted the sighting");
    assert.equal(atX, String(BOX.left - 30), "the @ field carries the rejected press's x, though the hit test refused it");
    assert.equal(atY, String(BOX.top + 101), "and its y");
    assert.equal(xDesc, "div#tb.btn", "x= names the tag as the realm reports it, the id and the first class");
    assert.ok(xDesc.length <= 24, "the description stays inside its 24-character budget");
  });

  it("binds the main-window document once when it is the toolbar document", () => {
    shutdown();
    const doc = fakeDoc();
    installFakeZotero({ mainWindow: { document: doc } });
    startup({ id: "toggle-test", version: "0.5.0" });
    ctx = render({ doc });
    place(ctx.button, BOX.left, BOX.top, BOX.width, BOX.height);

    for (const type of BINDINGS) {
      assert.equal((doc.listeners.get(type) ?? []).length, 1, `the shared object keeps the single ${type} binding it got as the toolbar document`);
    }
    fire(doc, "pointerdown", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(pressed(), "false", "the press acts once through the shared document");
    const [P, T, , , , D, , M] = fields().map(Number);
    assert.deepEqual([P, T, D, M], [1, 1, 1, 0], "the sighting counts under the first role, and M never moves");
  });

  it("late-binds the inner document on hover and unbinds every target on detach", () => {
    mount({ reader: fakeReader("realm-detach") });
    const innerWin = { document: fakeDoc() };
    const session = getSessions()[getSessions().length - 1];
    session.innerWin = innerWin;

    // The inner document was null at render time, so the first hover binds it,
    // and a press that only it sees reaches the session through the I letter.
    fire(ctx.doc, "pointerover", { button: 0 });
    const innerBound = (node, type) => (node.listeners.get(type) ?? []).filter((entry) => entry.capture).length;
    assert.equal(innerBound(innerWin.document, "pointerdown"), 1, "the hover bound the press path to the reader's inner document");
    fire(innerWin.document, "pointerdown", { button: 0, clientX: BOX.left + 5, clientY: BOX.top + 5, target: ctx.button });
    assert.equal(pressed(), "false", "the inner document is a live activation path");
    const [P, , , , , , , , , I] = fields().map(Number);
    assert.deepEqual([P, I], [1, 1], "the accepted press counts once, under I");

    // Shutdown detaches the button: every target this render bound, the two new
    // roles included, ends with nothing of ours left on it.
    shutdown();
    for (const node of [ctx.doc, ctx.doc.defaultView, ctx.button, ctx.mainDoc, innerWin.document]) {
      for (const type of BINDINGS) {
        assert.deepEqual(node.listeners.get(type) ?? [], [], `no ${type} handler is left on ${node.tagName}`);
      }
      assert.deepEqual(
        node.unbound,
        [
          { type: "pointerdown", capture: true },
          { type: "pointerup", capture: true },
          { type: "mouseup", capture: true },
          { type: "click", capture: true },
          { type: "pointerover", capture: true },
        ],
        `detach unbound exactly the five it held on ${node.tagName}, and only the capture bindings match`,
      );
    }
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
