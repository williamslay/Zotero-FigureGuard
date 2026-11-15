import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { collectPageEvidence } from "../../src/core/pdf-source.js";
import { localNumbers, localPDFPage, localViewport } from "../../src/zotero/xray.js";

const FORBIDDEN = "Accessing TypedArray data over Xrays is slow, and forbidden";

/**
 * Mimics an Xray-wrapped typed array the way the task describes it: copying the
 * whole list works, reading one element throws.
 */
function xrayArray(values) {
  const holder = {};
  Object.defineProperty(holder, "length", { value: values.length });
  Object.defineProperty(holder, Symbol.iterator, {
    value: function* iterate() {
      yield* values;
    },
  });
  values.forEach((value, index) => {
    Object.defineProperty(holder, index, {
      enumerable: true,
      get() {
        throw new Error(FORBIDDEN);
      },
    });
  });
  return holder;
}

/**
 * Mimics the throw seen on the real machine: the bulk element access pdf.js
 * style copying uses (`Array.from`, spread) is forbidden, single element reads
 * still work.
 */
function strictArray(values) {
  const holder = { length: values.length };
  values.forEach((value, index) => {
    holder[index] = value;
  });
  Object.defineProperty(holder, Symbol.iterator, {
    value() {
      throw new Error(FORBIDDEN);
    },
  });
  return holder;
}

describe("xray: localNumbers", () => {
  it("copies a plain array into a new local array of numbers", () => {
    const source = [1, 2, 3, 4, 5, 6];
    const copy = localNumbers(source);
    assert.notEqual(copy, source);
    assert.ok(Array.isArray(copy));
    assert.ok(copy instanceof Object);
    assert.deepEqual(copy, source);
  });

  it("copies Float64Array and Uint8ClampedArray into plain arrays", () => {
    for (const typed of [
      new Float64Array([1, 0, 0, 1, 0, 0]),
      new Uint8ClampedArray([10, 20, 30]),
    ]) {
      const copy = localNumbers(typed);
      assert.ok(Array.isArray(copy), "plain local Array, not a typed array");
      assert.ok(copy instanceof Object);
      assert.deepEqual(copy, Array.from(typed));
    }
  });

  it("returns null for missing and non array-like input", () => {
    for (const value of [null, undefined, 0, 1, "abc", {}, { a: 1 }, true]) {
      assert.equal(localNumbers(value), null, `${String(value)} is not array-like`);
    }
  });

  it("copies an Xray-like array that throws on element access", () => {
    const copy = localNumbers(xrayArray([1, 0, 0, 1, 0, 0]));
    assert.ok(Array.isArray(copy));
    assert.deepEqual(copy, [1, 0, 0, 1, 0, 0]);
  });

  it("copies an array whose bulk element access throws", () => {
    const copy = localNumbers(strictArray([1, 0, 0, 1, 0, 0]));
    assert.ok(Array.isArray(copy));
    assert.deepEqual(copy, [1, 0, 0, 1, 0, 0]);
  });

  it("prefers Components.utils.cloneInto when the sandbox exposes it", () => {
    const calls = [];
    const previous = globalThis.Components;
    globalThis.Components = {
      utils: {
        cloneInto(value, target) {
          calls.push(value);
          assert.equal(target.constructor, Object);
          return Array.isArray(value) ? value.slice() : value;
        },
      },
    };
    try {
      assert.deepEqual(localNumbers(new Float64Array([2, 4, 6])), [2, 4, 6]);
      assert.equal(calls.length, 1, "cloneInto is the first strategy");
    } finally {
      if (previous === undefined) delete globalThis.Components;
      else globalThis.Components = previous;
    }
  });
});

describe("xray: localViewport", () => {
  function fakeViewport(scale = 2) {
    return {
      scale,
      width: 200,
      height: 100,
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      transform: new Float64Array([scale, 0, 0, scale, 0, 0]),
      convertToViewportPoint(x, y) {
        return new Float64Array([scale * x, scale * y]);
      },
    };
  }

  it("returns null for a missing viewport", () => {
    assert.equal(localViewport(null), null);
    assert.equal(localViewport(undefined), null);
  });

  it("copies scalar fields and a Float64Array transform into a plain object", () => {
    const local = localViewport(fakeViewport(2));
    assert.equal(Object.getPrototypeOf(local), Object.prototype);
    assert.equal(local.scale, 2);
    assert.equal(local.width, 200);
    assert.equal(local.height, 100);
    assert.equal(local.rotation, 0);
    assert.equal(local.offsetX, 0);
    assert.equal(local.offsetY, 0);
    assert.ok(Array.isArray(local.transform));
    assert.ok(local.transform instanceof Object);
    assert.equal(local.transform instanceof Float64Array, false);
    assert.deepEqual(local.transform, [2, 0, 0, 2, 0, 0]);
  });

  it("returns a local array from convertToViewportPoint", () => {
    const local = localViewport(fakeViewport(2));
    const point = local.convertToViewportPoint(10, 20);
    assert.ok(Array.isArray(point));
    assert.ok(point instanceof Object);
    assert.equal(point instanceof Float64Array, false);
    assert.deepEqual(point, [20, 40]);
  });

  it("feeds core viewport geometry unchanged", async () => {
    const { toViewportRect } = await import("../../src/core/viewport.js");
    assert.deepEqual(toViewportRect([0, 0, 10, 10], localViewport(fakeViewport(2))), [0, 0, 20, 20]);
  });
});

/**
 * A pdf.js page whose every numeric payload is a typed array, optionally wrapped
 * to behave like an Xray wrapper.
 */
function fakePage(wrap = (value) => value) {
  const matrix = () => wrap(new Float64Array([2, 0, 0, 2, 0, 0]));
  const image = { bitmap: { data: new Uint8ClampedArray(4) }, width: 2, height: 2 };
  const items = [
    {
      str: "Figure 1: A test figure",
      width: 120,
      height: 10,
      fontName: "g_d0_f1",
      transform: wrap(new Float64Array([10, 0, 0, 10, 40, 700])),
    },
    {
      type: "markedContent",
      width: 0,
      height: 0,
      transform: wrap(new Float64Array([1, 0, 0, 1, 0, 0])),
    },
  ];
  return {
    view: wrap(new Float64Array([0, 0, 612, 792])),
    getViewport({ scale = 1 } = {}) {
      return {
        scale,
        width: 612 * scale,
        height: 792 * scale,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: wrap(new Float64Array([scale, 0, 0, scale, 0, 0])),
        convertToViewportPoint(x, y) {
          return wrap(new Float64Array([scale * x, (792 - y) * scale]));
        },
      };
    },
    async getOperatorList() {
      return {
        fnArray: wrap(
          new Uint8Array([OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.restore]),
        ),
        argsArray: wrap([
          null,
          matrix(),
          wrap([matrix(), wrap(new Float64Array([0, 0, 100, 50]))]),
          image,
        ]),
      };
    },
    async getTextContent() {
      return { items: wrap(items), styles: {} };
    },
    render() {
      return { promise: Promise.resolve() };
    },
    imageDict: image,
  };
}

describe("xray: localPDFPage", () => {
  it("returns null for a missing page", () => {
    assert.equal(localPDFPage(null), null);
    assert.equal(localPDFPage(undefined), null);
  });

  it("localises view, viewport, operator list and text content", async () => {
    const local = localPDFPage(fakePage());
    assert.ok(Array.isArray(local.view));
    assert.deepEqual(local.view, [0, 0, 612, 792]);

    const viewport = local.getViewport({ scale: 1 });
    assert.ok(Array.isArray(viewport.transform));
    assert.deepEqual(viewport.transform, [1, 0, 0, 1, 0, 0]);
    assert.deepEqual(viewport.convertToViewportPoint(10, 10), [10, 782]);

    const { ops, args } = await local.getOperatorList();
    assert.ok(Array.isArray(ops));
    assert.equal(ops instanceof Uint8Array, false);
    assert.deepEqual(ops, [OPS.save, OPS.transform, OPS.paintFormXObjectBegin, OPS.restore]);
    assert.ok(Array.isArray(args));
    assert.equal(args[0], null);
    assert.deepEqual(args[1], [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(args[2], [[2, 0, 0, 2, 0, 0], [0, 0, 100, 50]]);

    const text = await local.getTextContent({ includeMarkedContent: false });
    assert.equal(text.items.length, 2);
    assert.equal(text.items[0].str, "Figure 1: A test figure");
    assert.equal(text.items[0].fontName, "g_d0_f1");
    assert.equal(text.items[0].height, 10);
    assert.equal(text.items[0].width, 120);
    assert.equal(text.items[0].type, undefined);
    assert.deepEqual(text.items[0].transform, [10, 0, 0, 10, 40, 700]);
    assert.equal(text.items[1].type, "markedContent");
    assert.deepEqual(Object.keys(text.items[0]).sort(), [
      "fontName",
      "height",
      "str",
      "transform",
      "type",
      "width",
    ]);
  });

  it("passes image dictionaries through by reference and render straight through", async () => {
    const page = fakePage();
    const local = localPDFPage(page);
    const { args } = await local.getOperatorList();
    assert.equal(typeof args[3], "object");
    assert.ok(!Array.isArray(args[3]), "image dict stays a reference, not copied element-wise");
    assert.equal(args[3], page.imageDict, "the image dict, payload buffer included, is passed through");
    assert.equal(typeof local.render, "function");
    const task = local.render({ viewport: {}, canvasContext: {} });
    assert.equal(typeof task.promise, "object");
  });

  it("stays defensive when one reader field throws", async () => {
    const local = localPDFPage({
      get view() {
        throw new Error(FORBIDDEN);
      },
      getViewport() {
        throw new Error(FORBIDDEN);
      },
      getOperatorList() {
        return Promise.reject(new Error(FORBIDDEN));
      },
      getTextContent() {
        return Promise.reject(new Error(FORBIDDEN));
      },
    });
    assert.equal(local.view, null);
    assert.equal(local.getViewport({ scale: 1 }), null);
    assert.deepEqual(await local.getOperatorList(), { ops: [], args: [] });
    assert.deepEqual(await local.getTextContent({}), { items: [], styles: {} });
  });
});

describe("xray: collectPageEvidence through the adapter", () => {
  for (const [label, wrap] of [
    ["typed arrays", (value) => value],
    ["Xray-like arrays that forbid element access", xrayArray],
    ["Xray-like arrays that forbid bulk copying", strictArray],
  ]) {
    it(`reads a page whose payloads are ${label}`, async () => {
      const evidence = await collectPageEvidence({ pdfPage: localPDFPage(fakePage(wrap)), OPS });
      assert.deepEqual(evidence.pageRect, [0, 0, 612, 792]);
      assert.ok(Array.isArray(evidence.placements));
      assert.equal(evidence.placements.length, 1);
      assert.deepEqual(evidence.placements[0].rect, [0, 0, 400, 200]);
      assert.equal(evidence.diagnostics.operatorCount, 4);
      assert.equal(evidence.diagnostics.textItemCount, 1);
      assert.equal(evidence.captions.length, 1);
      assert.equal(evidence.captions[0].number, "1");
      assert.ok(evidence.viewport);
      assert.ok(Array.isArray(evidence.viewport.transform));
    });
  }
});
