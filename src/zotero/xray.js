/**
 * Realm-safe copies of pdf.js values read out of the Zotero reader realm.
 *
 * The Zotero bootstrap sandbox reaches the reader's pdf.js objects through Xray
 * wrappers. Property access works, but element access on a TypedArray behind an
 * Xray wrapper throws: "Accessing TypedArray data over Xrays is slow, and
 * forbidden in order to encourage performant code." Plain Array element access
 * is allowed, so every numeric payload coming out of the reader is copied into
 * this realm before the detection core indexes into it.
 *
 * The core stays free of Xray handling. The render path keeps passing
 * reader-realm objects into pdf.js, which is always safe.
 */

import { operatorListArrays } from "../core/placements.js";
import { warnOnce } from "./overlay.js";

/**
 * `Components.utils.cloneInto` when this realm is a Gecko sandbox.
 *
 * @returns {((value: *, target: object) => *)|null}
 */
function cloneIntoFn() {
  try {
    const clone = globalThis.Components?.utils?.cloneInto;
    return typeof clone === "function" ? clone : null;
  } catch (err) {
    warnOnce("xray-clone-into", err);
    return null;
  }
}

/**
 * True when element-by-element copying makes sense for this value.
 *
 * Only `length` and the iterator are inspected, never an element, so an Xray
 * TypedArray does not throw here.
 *
 * @param {*} value Candidate array-like value.
 * @returns {boolean}
 */
function isArrayLike(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return true;
  try {
    if (typeof value.length === "number") return true;
    return typeof value[Symbol.iterator] === "function";
  } catch (err) {
    warnOnce("xray-array-like", err);
    return false;
  }
}

/**
 * Copies `length` and then every index. Last resort because it reads one
 * element at a time across the realm boundary.
 *
 * @param {ArrayLike<*>} value Array-like value.
 * @returns {Array<*>} A local plain Array of the raw elements.
 */
function indexLoop(value) {
  const length = Number(value.length) || 0;
  const out = [];
  for (let i = 0; i < length; i += 1) out.push(value[i]);
  return out;
}

/**
 * Copies an array-like value into this realm without reading an element before
 * the copy strategy itself has been tried.
 *
 * `cloneInto` is a C++ copy and the only strategy that also copies nested
 * TypedArrays, so it comes first for numeric payloads. `Array.from` and the
 * index loop are shallow, which is what a heterogeneous list wants.
 *
 * @param {*} value Array-like value, possibly an Xray wrapper.
 * @param {boolean} preferClone True for numeric payloads, false for lists of
 *   mixed values, where a deep copy would also duplicate image buffers.
 * @returns {Array<*>|null} A local plain Array, or null when nothing worked.
 */
function copyArrayLike(value, preferClone = true) {
  if (!isArrayLike(value)) return null;
  const cloneInto = cloneIntoFn();
  const clone = cloneInto ? () => cloneInto(value, {}) : null;
  const strategies = [];
  if (clone && preferClone) strategies.push(clone);
  strategies.push(() => Array.from(value));
  strategies.push(() => indexLoop(value));
  if (clone && !preferClone) strategies.push(clone);
  let lastError = null;
  for (const strategy of strategies) {
    try {
      const copy = strategy();
      if (Array.isArray(copy)) return copy;
      lastError = new TypeError("copyArrayLike: no Array produced");
    } catch (err) {
      lastError = err;
    }
  }
  warnOnce("xray-copy", lastError);
  return null;
}

/**
 * Local `number[]` for any array-like input: a plain Array, a TypedArray or an
 * Xray wrapper of either.
 *
 * @param {*} value Numeric array-like value.
 * @returns {number[]|null} A local plain Array of numbers, or null when the
 *   input is not array-like or every copy strategy threw.
 */
export function localNumbers(value) {
  const list = copyArrayLike(value, true);
  if (!list) return null;
  return list.map((entry) => Number(entry));
}

/**
 * Finite number for a scalar field read out of the reader realm.
 *
 * @param {*} value Raw property value.
 * @returns {number|undefined} The number, or undefined when it is missing or
 *   not finite, so the caller's defaults still apply.
 */
function scalar(value) {
  try {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  } catch (err) {
    warnOnce("xray-scalar", err);
    return undefined;
  }
}

/**
 * String for a text field read out of the reader realm.
 *
 * @param {*} value Raw property value.
 * @returns {string|undefined} The string, or undefined when it is not one.
 */
function asString(value) {
  try {
    return typeof value === "string" ? value : undefined;
  } catch (err) {
    warnOnce("xray-string", err);
    return undefined;
  }
}

/**
 * Local copy of a pdf.js `PageViewport`.
 *
 * Carries the scalar fields the core reads plus `convertToViewportPoint`, whose
 * result is copied because the reader returns it as a realm-local array.
 *
 * @param {object|null|undefined} viewport A pdf.js `PageViewport` (any version).
 * @returns {object|null} A plain local viewport descriptor, or null when the
 *   input is falsy.
 */
export function localViewport(viewport) {
  if (!viewport) return null;
  const raw = viewport;
  const local = {
    scale: scalar(raw.scale),
    width: scalar(raw.width),
    height: scalar(raw.height),
    rotation: scalar(raw.rotation),
    offsetX: scalar(raw.offsetX),
    offsetY: scalar(raw.offsetY),
    transform: localNumbers(raw.transform),
  };
  Object.defineProperty(local, "convertToViewportPoint", {
    enumerable: false,
    writable: false,
    value: (x, y) => {
      try {
        return localNumbers(raw.convertToViewportPoint(x, y)) ?? [Number.NaN, Number.NaN];
      } catch (err) {
        warnOnce("xray-viewport-point", err);
        return [Number.NaN, Number.NaN];
      }
    },
  });
  return local;
}

/**
 * True when every entry of a copied list is a value a numeric matrix may hold.
 *
 * @param {Array<*>} list Already local list of raw entries.
 * @returns {boolean}
 */
function isNumericList(list) {
  for (const entry of list) {
    const type = typeof entry;
    if (entry === null || entry === undefined) continue;
    if (type === "number" || type === "bigint") continue;
    return false;
  }
  return true;
}

/**
 * Copies one operator-argument entry into this realm.
 *
 * Matrices and bounding boxes become local number arrays. Non-numeric objects,
 * such as the image dictionaries pdf.js hands along, are passed through by
 * reference: the detector never indexes into them, so their pixel buffers are
 * not copied element by element.
 *
 * @param {*} value One entry of the operator-list argument array.
 * @param {number} depth Recursion depth, 0 for the entry itself.
 * @returns {*} A local value, or the original reference for plain objects.
 */
function localArgValue(value, depth) {
  if (!value || typeof value !== "object") return value;
  const list = copyArrayLike(value, depth === 0);
  if (!list) return value;
  if (list.length === 0 || isNumericList(list)) return list.map((entry) => Number(entry));
  if (depth === 0) return list.map((entry) => localArgValue(entry, depth + 1));
  return list;
}

/**
 * Copies a pdf.js operator list into the shape `operatorListArrays()` accepts.
 *
 * @param {object|null|undefined} operatorList A pdf.js operator list.
 * @returns {{ops: number[], args: Array<*>}} A local operator list.
 */
function localOperatorList(operatorList) {
  let source;
  try {
    source = operatorListArrays(operatorList);
  } catch (err) {
    warnOnce("xray-operator-list", err);
    return { ops: [], args: [] };
  }
  const ops = localNumbers(source.ops) ?? [];
  const args = copyArrayLike(source.args, false) ?? [];
  for (let i = 0; i < args.length; i += 1) args[i] = localArgValue(args[i], 0);
  return { ops, args };
}

/**
 * Copies the text items of a pdf.js text-content result.
 *
 * `styles` is an empty object: the core reads nothing from it, and its values
 * are reader-realm dictionaries.
 *
 * @param {object|null|undefined} textContent A pdf.js text-content result.
 * @returns {{items: Array<object>, styles: object}} A local text content.
 */
function localTextContent(textContent) {
  let items = [];
  try {
    items = copyArrayLike(textContent?.items, false) ?? [];
  } catch (err) {
    warnOnce("xray-text-items", err);
  }
  const out = [];
  for (const rawItem of items) {
    let item;
    try {
      item = {
        str: asString(rawItem?.str),
        width: scalar(rawItem?.width),
        height: scalar(rawItem?.height),
        fontName: asString(rawItem?.fontName),
        type: asString(rawItem?.type),
        transform: localNumbers(rawItem?.transform),
      };
    } catch (err) {
      warnOnce("xray-text-item", err);
      item = { str: undefined, width: undefined, height: undefined, fontName: undefined, type: undefined, transform: null };
    }
    out.push(item);
  }
  return { items: out, styles: {} };
}

/**
 * Local adapter for one pdf.js `PDFPageProxy`, for the detection path only.
 *
 * Exposes exactly what the core reads: `view`, `getViewport()`,
 * `getOperatorList()`, `getTextContent()` and `render()`. Every access is
 * guarded, so one odd field cannot throw out of the adapter.
 *
 * @param {object|null|undefined} pdfPage A pdf.js `PDFPageProxy`.
 * @returns {object|null} A plain local page, or null when the input is falsy.
 */
export function localPDFPage(pdfPage) {
  if (!pdfPage) return null;
  const raw = pdfPage;
  let view = null;
  try {
    view = localNumbers(raw.view);
  } catch (err) {
    warnOnce("xray-page-view", err);
  }
  return {
    view,
    getViewport(options) {
      try {
        return localViewport(raw.getViewport(options));
      } catch (err) {
        warnOnce("xray-page-getViewport", err);
        return null;
      }
    },
    async getOperatorList(...args) {
      try {
        return localOperatorList(await raw.getOperatorList(...args));
      } catch (err) {
        warnOnce("xray-page-getOperatorList", err);
        return { ops: [], args: [] };
      }
    },
    async getTextContent(...args) {
      try {
        return localTextContent(await raw.getTextContent(...args));
      } catch (err) {
        warnOnce("xray-page-getTextContent", err);
        return { items: [], styles: {} };
      }
    },
    render(options) {
      return raw.render(options);
    },
  };
}
