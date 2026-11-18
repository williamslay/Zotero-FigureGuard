/**
 * XObject placement extraction from a PDF.js operator list.
 *
 * The PDF.js operator list keeps the page's own graphics-state operators
 * (`save` / `restore` / `transform`), so the CTM in effect at a `Do` operator
 * can be rebuilt by walking the list. `paintFormXObjectBegin` additionally
 * carries the Form XObject's own `/Matrix` and `/BBox`, which gives the placed
 * region without any external PDF parser.
 *
 * Verified behaviour (see reports/A0_RESEARCH.md) on pdf.js 4.10.38 and 6.5.438:
 * nested Form content is expanded inline, so begin/end pairs nest, and pdf.js
 * does not inject a leading page transform of its own.
 *
 * Vector art (no XObject at all) is recovered from `constructPath`: pdf.js hands
 * over the bounding box of the path in the current user space, together with the
 * operator that consumes it. Only paths that are actually painted become
 * placements; a path kept for clipping (`endPath`) contributes nothing.
 *
 * Recorded geometry is clipped: a conforming renderer cuts a Form XObject's
 * content at the form's own `/BBox`, so a clip stack runs alongside the CTM
 * walk and every placement is clamped to the active clip before recording.
 */

import {
  IDENTITY,
  intersectRects,
  multiplyMatrices,
  rectFromMatrix,
  toMatrix,
  toRect,
  normalizeRect,
} from "./geom.js";

/**
 * Operators that consume a constructed path by painting it. A path followed by
 * any other operator (typically `endPath`, i.e. a clipping path) is not art.
 */
export const PATH_PAINT_OP_NAMES = Object.freeze([
  "stroke",
  "closeStroke",
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
]);

/**
 * Resolve the operator codes this module needs from a runtime `OPS` object.
 * Codes differ between pdf.js versions, names do not.
 *
 * @param {Record<string, number>} OPS pdf.js `OPS` export.
 * @returns {Record<string, number[]>} op name -> list of numeric codes.
 */
export function resolveOperatorCodes(OPS) {
  const exact = [
    "save",
    "restore",
    "transform",
    "clip",
    "eoClip",
    "shadingFill",
    "paintImageXObject",
    "paintImageXObjectRepeat",
    "paintJpegXObject",
    "paintInlineImageXObject",
    "paintInlineImageXObjectGroup",
    "paintImageMaskXObject",
    "paintImageMaskXObjectGroup",
    "paintSolidColorImageMask",
    "paintFormXObjectBegin",
    "paintFormXObjectEnd",
    "constructPath",
    "rawFillPath",
    ...PATH_PAINT_OP_NAMES,
  ];
  const codes = {};
  for (const name of exact) {
    if (typeof OPS?.[name] === "number") codes[name] = [OPS[name]];
  }
  // pdf.js has used several image paint variants over time
  // (paintImageXObject, paintImageXObjectRepeat, paintImageXObjectExt, ...).
  codes.paintImageXObject = codes.paintImageXObject ?? [];
  for (const [key, value] of Object.entries(OPS ?? {})) {
    if (
      typeof value === "number" &&
      /^paint(Image|Jpeg)XObject/.test(key) &&
      !key.endsWith("Repeat") &&
      !key.includes("Mask") &&
      !codes.paintImageXObject.includes(value)
    ) {
      codes.paintImageXObject.push(value);
    }
  }
  return codes;
}

/** Accept both the `ops` / `args` and `fnArray` / `argsArray` spellings. */
export function operatorListArrays(operatorList) {
  if (!operatorList) return { ops: [], args: [] };
  return {
    ops: operatorList.ops ?? operatorList.fnArray ?? [],
    args: operatorList.args ?? operatorList.argsArray ?? [],
  };
}

/**
 * Walk one page operator list and return every XObject placement in user space.
 *
 * Placements are clamped to the clip implied by the enclosing Form XObjects'
 * `/BBox` rects (see the `clip` declaration inside); content a conforming
 * renderer would clip away never reaches the detector.
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.ops Operator codes.
 * @param {ArrayLike<unknown>} [input.args] Operator arguments.
 * @param {Record<string, number[]>} input.codes Result of `resolveOperatorCodes`.
 * @returns {{placements: Array<object>, skipped: Array<object>, diagnostics: object}}
 */
export function collectPlacements({ ops, args = [], codes }) {
  const codeIndex = new Map();
  for (const [name, list] of Object.entries(codes ?? {})) {
    for (const code of list ?? []) {
      if (!codeIndex.has(code)) codeIndex.set(code, name);
    }
  }

  const placements = [];
  const skipped = [];
  const stack = [];
  const paintCodes = new Set();
  for (const name of PATH_PAINT_OP_NAMES) {
    for (const code of codes?.[name] ?? []) paintCodes.add(code);
  }
  let ctm = IDENTITY;
  let formDepth = 0;
  // Active clip in page/user space (the same space as the recorded rects), or
  // null meaning "no clip known". A conforming renderer clips a form's content
  // to the form's /BBox: on the Flash fixture page 8 the Figure 6 form places
  // 16 legend bars at local x0 = -68, outside its own /BBox, and MuPDF renders
  // no ink left of x = 58.9; recording their unclipped bounds dragged the
  // region's left edge to 14.32, ~44 pt of dead white space. `null` must stay
  // distinct from [0, 0, 0, 0]: `intersectRects` answers "no overlap" for a
  // zero-area rect, which is "clips everything", not "no clip". `/Group`
  // (OPS.beginGroup) clipping is deliberately out of scope here: it measured
  // neutral on both fixtures and would need a new operator-code mapping.
  let formClip = null;
  let pathClip = null;
  let pendingClip = false;
  let restoreCount = 0;
  let pathCount = 0;
  let clippedCount = 0;

  const activeClip = () =>
    formClip && pathClip
      ? intersectRects(formClip, pathClip) ?? formClip
      : formClip ?? pathClip;

  const push = (placement) => placements.push(placement);
  const pushUnitImage = (matrix, opIndex) => {
    const rect = rectFromMatrix(matrix, [0, 0, 1, 1]);
    if (!isUsableRect(rect)) {
      skipped.push({ kind: "image", opIndex, reason: "degenerate-rect" });
      return;
    }
    const clipped = clipRect(rect, activeClip());
    if (!clipped) {
      clippedCount += 1;
      skipped.push({ kind: "image", opIndex, reason: "outside-clip" });
      return;
    }
    if (!sameRect(clipped, rect)) clippedCount += 1;
    push({
      kind: "image",
      rect: clipped,
      localBox: [0, 0, 1, 1],
      matrix: IDENTITY,
      ctm: matrix,
      depth: formDepth,
      opIndex,
    });
  };

  for (let i = 0; i < ops.length; i++) {
    const name = codeIndex.get(ops[i]);
    if (!name) continue;
    const opArgs = args[i];

    switch (name) {
      case "save":
        stack.push({ ctm, formDepth, formClip, pathClip, pendingClip });
        break;

      case "restore": {
        const state = stack.pop();
        if (state) {
          ctm = state.ctm;
          formDepth = state.formDepth;
          formClip = state.formClip;
          pathClip = state.pathClip;
          pendingClip = state.pendingClip;
        }
        restoreCount += 1;
        break;
      }

      case "transform": {
        const matrix = toMatrix(opArgs);
        if (matrix) ctm = multiplyMatrices(ctm, matrix);
        break;
      }

      case "clip":
      case "eoClip":
        pendingClip = true;
        break;

      case "paintImageXObject":
      case "paintJpegXObject":
      case "paintInlineImageXObject":
      case "paintImageMaskXObject":
      case "paintSolidColorImageMask": {
        // Image and image-mask operators paint the unit square [0,0,1,1] under CTM.
        pushUnitImage(ctm, i);
        break;
      }

      case "paintInlineImageXObjectGroup": {
        const map = Array.isArray(opArgs?.[1]) ? opArgs[1] : [];
        for (const entry of map) {
          const entryMatrix = toMatrix(entry?.transform);
          pushUnitImage(entryMatrix ? multiplyMatrices(ctm, entryMatrix) : ctm, i);
        }
        break;
      }

      case "paintImageMaskXObjectGroup": {
        const images = Array.isArray(opArgs?.[0]) ? opArgs[0] : [];
        for (const entry of images) {
          const entryMatrix = toMatrix(entry?.transform);
          pushUnitImage(entryMatrix ? multiplyMatrices(ctm, entryMatrix) : ctm, i);
        }
        break;
      }

      case "shadingFill": {
        // `sh` fills the active clipping path; ignore unclipped full-page fills.
        const currentClip = activeClip();
        if (currentClip && isUsableRect(currentClip)) {
          pathCount += 1;
          push({
            kind: "path",
            rect: [...currentClip],
            localBox: null,
            matrix: IDENTITY,
            ctm,
            depth: formDepth,
            opIndex: i,
          });
        }
        break;
      }

      case "paintImageXObjectRepeat": {
        // Repeated image tiling: without the full tile box the safe answer is
        // to ignore it rather than guess a region.
        skipped.push({ kind: "image", opIndex: i, reason: "image-repeat-ignored" });
        break;
      }

      case "constructPath":
      case "rawFillPath": {
        // pdf.js records `constructPath(mode, points, minMax)`; `minMax` is the
        // path bounds in the user space of the CTM in effect here. `rawFillPath`
        // is always a fill, so its bounds sit one argument earlier.
        const wasClip = pendingClip;
        pendingClip = false;
        const mode = name === "constructPath" ? opArgs?.[0] : null;
        const bounds = toBounds(name === "constructPath" ? opArgs?.[2] : opArgs?.[1]);
        const isPainted = name !== "constructPath" || paintCodes.has(mode);

        if (wasClip && bounds) {
          const clipCandidate = rectFromMatrix(ctm, bounds);
          if (isUsableRect(clipCandidate)) {
            pathClip = pathClip ? intersectRects(pathClip, clipCandidate) ?? clipCandidate : clipCandidate;
          }
        }
        if (!isPainted) {
          skipped.push({ kind: "path", opIndex: i, reason: "path-not-painted" });
          break;
        }
        if (!bounds) {
          skipped.push({ kind: "path", opIndex: i, reason: "path-no-bounds" });
          break;
        }
        // Pure 1D horizontal/vertical lines (`dx === 0 || dy === 0`) are dropped as
        // degenerate-rect: real vector figures contain 2D primitives, whereas
        // 1D lines are overwhelmingly table rules and page dividers.
        const rect = rectFromMatrix(ctm, bounds);
        if (!isUsableRect(rect)) {
          skipped.push({ kind: "path", opIndex: i, reason: "degenerate-rect" });
          break;
        }
        // Apply Form /BBox clip and active path clip, keeping the pre-path-clip
        // extent when clipped solely by a `W` clip so off-page path filters still
        // see degenerate external extents.
        const formClamped = clipRect(rect, formClip);
        if (!formClamped) {
          clippedCount += 1;
          skipped.push({ kind: "path", opIndex: i, reason: "outside-clip" });
          break;
        }
        const clipped = clipRect(formClamped, pathClip);
        if (!clipped) {
          clippedCount += 1;
          skipped.push({ kind: "path", opIndex: i, reason: "outside-clip" });
          break;
        }
        if (!sameRect(clipped, rect)) clippedCount += 1;
        pathCount += 1;
        push({
          kind: "path",
          rect: clipped,
          rawRect: !sameRect(clipped, formClamped) ? formClamped : null,
          localBox: null,
          matrix: IDENTITY,
          ctm,
          depth: formDepth,
          opIndex: i,
        });
        break;
      }

      case "paintFormXObjectBegin": {
        const formMatrix = toMatrix(opArgs?.[0]) ?? IDENTITY;
        const localBox = toRect(opArgs?.[1]);
        // The clip to restore at this form's end, captured before any branch
        // below reassigns `formClip` / `pathClip`.
        const entryFormClip = formClip;
        const entryPathClip = pathClip;
        if (!localBox || localBox[2] <= localBox[0] || localBox[3] <= localBox[1]) {
          // No /BBox means no clip, exactly as in pdf.js: the active clip is
          // inherited unchanged for everything inside. Load-bearing on the
          // PipeBWrite fixture page 7, where three forms without a /BBox hold
          // 51 of the paths that draw Figure 5; an empty clip inherited here
          // instead would drop all of them (213 placements -> 162) and erase
          // the figure.
          skipped.push({ kind: "form", opIndex: i, reason: "missing-or-empty-bbox" });
        } else {
          const rect = rectFromMatrix(multiplyMatrices(ctm, formMatrix), localBox);
          if (!isUsableRect(rect)) {
            skipped.push({ kind: "form", opIndex: i, reason: "degenerate-rect" });
          } else {
            const clipped = clipRect(rect, activeClip());
            if (!clipped) {
              // Fully outside the parent clip: the form paints nothing. Its
              // children keep the form's own box as clip, so nested evidence
              // is still bounded, just no longer by the grandparent too.
              clippedCount += 1;
              skipped.push({ kind: "form", opIndex: i, reason: "outside-clip" });
              formClip = rect;
            } else {
              if (!sameRect(clipped, rect)) clippedCount += 1;
              push({
                kind: "form",
                rect: clipped,
                localBox,
                matrix: formMatrix,
                ctm,
                depth: formDepth,
                opIndex: i,
              });
              formClip = clipped;
            }
          }
        }
        formDepth += 1;
        // pdf.js applies the form /Matrix to the graphics state for the duration
        // of the form, so path coordinates inside it must see it too.
        stack.push({
          ctm,
          formDepth: formDepth - 1,
          form: true,
          formClip: entryFormClip,
          pathClip: entryPathClip,
          pendingClip,
        });
        pendingClip = false;
        ctm = multiplyMatrices(ctm, formMatrix);
        break;
      }

      case "paintFormXObjectEnd": {
        // Unwind to this form's entry: an unbalanced save inside the form must
        // not leak the form transform or its clip into the enclosing content.
        let state = null;
        let guard = stack.length;
        while (guard-- > 0) {
          state = stack.pop();
          if (state?.form) break;
          state = null;
        }
        if (state) {
          ctm = state.ctm;
          formDepth = state.formDepth;
          formClip = state.formClip;
          pathClip = state.pathClip;
          pendingClip = Boolean(state.pendingClip);
        } else {
          formDepth = Math.max(0, formDepth - 1);
          pendingClip = false;
        }
        break;
      }

      default:
        break;
    }
  }

  return {
    placements,
    skipped,
    diagnostics: {
      operatorCount: ops.length,
      unclosedSave: stack.length,
      restoreCount,
      formDepthAtEnd: formDepth,
      pathBoxCount: pathCount,
      // How much evidence the /BBox clip trimmed: every placement the clip
      // removed entirely or shrunk counts once, so a survey can tell a tight
      // border from a lucky one.
      clippedCount,
    },
  };
}

function isUsableRect(rect) {
  const r = normalizeRect(rect);
  return r.every(Number.isFinite) && r[2] - r[0] > 0 && r[3] - r[1] > 0;
}

/**
 * Clip one candidate rect against the active clip. A null clip means "no clip
 * known" and skips the test: pdf.js applies no clip when a form has no /BBox.
 * Returns the clamped rect, or null when the rect lies fully outside the clip
 * (`intersectRects` answers null for "no overlap"; invalid input cannot occur
 * because both sides went through `toRect`/`rectFromMatrix`).
 */
function clipRect(rect, clip) {
  return clip ? intersectRects(rect, clip) : rect;
}

/** Exact coordinate equality, used to tell "clamped" from "unchanged". */
function sameRect(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * pdf.js keeps path bounds in a `Float32Array`, the operator-list arguments in
 * plain arrays. Anything that is not exactly four finite numbers is not bounds.
 */
function toBounds(value) {
  if (!value) return null;
  const raw = Array.isArray(value) || ArrayBuffer.isView(value) ? value : null;
  if (!raw || raw.length !== 4) return null;
  const out = [
    Number(raw[0]),
    Number(raw[1]),
    Number(raw[2]),
    Number(raw[3]),
  ];
  return out.every(Number.isFinite) ? out : null;
}
