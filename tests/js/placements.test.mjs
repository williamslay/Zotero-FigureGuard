import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  collectPlacements,
  operatorListArrays,
  resolveOperatorCodes,
} from "../../src/core/placements.js";

const codes = resolveOperatorCodes(OPS);

function collect(ops, args) {
  return collectPlacements({ ops, args, codes });
}

describe("placements: operator codes", () => {
  it("resolves every code it needs from the runtime OPS table", () => {
    for (const name of ["save", "restore", "transform", "paintFormXObjectBegin", "paintFormXObjectEnd"]) {
      assert.equal(typeof OPS[name], "number", `${name} exists in pdf.js OPS`);
      assert.deepEqual(codes[name], [OPS[name]]);
    }
  });

  it("collects image paint variants without the repeat tiling", () => {
    assert.ok(codes.paintImageXObject.includes(OPS.paintImageXObject));
    assert.ok(!codes.paintImageXObject.includes(OPS.paintImageXObjectRepeat));
  });

  it("reads both operator-list spellings", () => {
    assert.deepEqual(operatorListArrays({ ops: [1], args: [2] }), { ops: [1], args: [2] });
    assert.deepEqual(operatorListArrays({ fnArray: [1], argsArray: [2] }), { ops: [1], args: [2] });
  });
});

describe("placements: forms", () => {
  it("maps a Form XObject /BBox through CTM * /Matrix", () => {
    const { placements } = collect(
      [
        OPS.save,
        OPS.transform,
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.paint,
        OPS.restore,
        OPS.paintFormXObjectEnd,
      ],
      [
        null,
        [1.00053, 0, 0, 1.00053, 54, 617.946],
        [[1, 0, 0, 1, 0, 0], [0, 0, 240, 102]],
        [[], []],
        [],
        null,
        null,
      ],
    );
    assert.equal(placements.length, 1);
    const rect = placements[0].rect;
    assert.equal(placements[0].kind, "form");
    assert.ok(Math.abs(rect[0] - 54) < 1e-9);
    assert.ok(Math.abs(rect[2] - 294.1272) < 1e-3);
    assert.ok(Math.abs(rect[3] - 720.0001) < 1e-3);
  });

  it("applies the form's own /Matrix, including scale and offset", () => {
    const { placements } = collect(
      [OPS.transform, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd],
      [
        [1, 0, 0, 1, 317.88, 577.48],
        [[0.43729, 0, 0, 0.43729, 0, 0], [0, 0, 549.12, 325.92]],
        null,
      ],
    );
    const rect = placements[0].rect;
    assert.ok(Math.abs(rect[0] - 317.88) < 1e-9);
    assert.ok(Math.abs(rect[2] - 558.0047) < 1e-3);
    assert.ok(Math.abs(rect[3] - 720.0016) < 1e-3);
  });

  it("nests subforms and reports depth", () => {
    const { placements } = collect(
      [
        OPS.paintFormXObjectBegin,
        OPS.transform,
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.paintFormXObjectEnd,
      ],
      [
        [[1, 0, 0, 1, 0, 0], [0, 0, 200, 200]],
        [0.5, 0, 0, 0.5, 10, 10],
        [[1, 0, 0, 1, 0, 0], [0, 0, 100, 100]],
        null,
        null,
      ],
    );
    assert.equal(placements.length, 2);
    assert.deepEqual(placements.map((p) => p.depth), [0, 1]);
    // Inner box: 0.5 scale of [0,0,100,100] offset by (10,10) inside the outer.
    assert.deepEqual(placements[1].rect, [10, 10, 60, 60]);
  });

  it("restores the CTM after a save/restore pair", () => {
    const { placements } = collect(
      [
        OPS.save,
        OPS.transform,
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.restore,
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
      ],
      [
        null,
        [1, 0, 0, 1, 100, 100],
        [[1, 0, 0, 1, 0, 0], [0, 0, 50, 50]],
        null,
        null,
        [[1, 0, 0, 1, 0, 0], [0, 0, 50, 50]],
        null,
      ],
    );
    assert.deepEqual(placements.map((p) => p.rect), [
      [100, 100, 150, 150],
      [0, 0, 50, 50],
    ]);
  });

  it("skips forms without a usable /BBox", () => {
    const { placements, skipped } = collect(
      [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd],
      [[[1, 0, 0, 1, 0, 0], [0, 0, 0, 0]], null],
    );
    assert.equal(placements.length, 0);
    assert.equal(skipped[0].reason, "missing-or-empty-bbox");
  });

  it("keeps far off-canvas placements for the detector to judge", () => {
    const { placements } = collect(
      [OPS.transform, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd],
      [[1, 0, 0, 1, 90_000, 0], [[1, 0, 0, 1, 0, 0], [0, 0, 10, 10]], null],
    );
    assert.deepEqual(placements[0].rect, [90_000, 0, 90_010, 10]);
  });
});

describe("placements: images", () => {
  it("maps the unit square through the CTM", () => {
    const { placements } = collect(
      [OPS.transform, OPS.paintImageXObject],
      [[120, 0, 0, 80, 36, 400], ["img_p0_1", 120, 80]],
    );
    assert.equal(placements[0].kind, "image");
    assert.deepEqual(placements[0].rect, [36, 400, 156, 480]);
    assert.deepEqual(placements[0].localBox, [0, 0, 1, 1]);
  });

  it("records a degenerate image instead of guessing", () => {
    const { placements, skipped } = collect(
      [OPS.transform, OPS.paintImageXObject],
      [[1, 0, 0, 0, 36, 400], ["img", 120, 80]],
    );
    assert.equal(placements.length, 0);
    assert.equal(skipped[0].reason, "degenerate-rect");
  });

  it("ignores repeat tiling rather than inventing a tile box", () => {
    const { placements, skipped } = collect([OPS.paintImageXObjectRepeat], [[["img"], 10, 10, 2, 2]]);
    assert.equal(placements.length, 0);
    assert.equal(skipped[0].reason, "image-repeat-ignored");
  });
});

describe("placements: vector paths", () => {
  it("emits a path placement when a paint operator consumes the path", () => {
    const { placements } = collect(
      [OPS.transform, OPS.constructPath, OPS.fill],
      [
        [2, 0, 0, 2, 10, 20],
        [OPS.fill, new Float32Array([0, 0, 30, 40]), [0, 0, 30, 40]],
        [],
      ],
    );
    assert.equal(placements.length, 1);
    assert.equal(placements[0].kind, "path");
    assert.deepEqual(placements[0].rect, [10, 20, 70, 100]);
  });

  it("keeps a clipping path (endPath) out of the placements", () => {
    const { placements, skipped } = collect(
      [OPS.constructPath, OPS.endPath],
      [[OPS.endPath, new Float32Array([0, 0, 10, 10]), [0, 0, 10, 10]], null],
    );
    assert.equal(placements.length, 0);
    assert.equal(skipped.at(-1).reason, "path-not-painted");
  });

  it("reads Float32Array bounds", () => {
    const { placements } = collect(
      [OPS.constructPath, OPS.stroke],
      [[OPS.stroke, new Float32Array([5, 6, 15, 26]), new Float32Array([5, 6, 15, 26])], []],
    );
    assert.deepEqual(placements[0].rect, [5, 6, 15, 26]);
  });

  it("records a path without bounds as skipped", () => {
    const { placements, skipped } = collect([OPS.constructPath, OPS.fill], [[OPS.fill, new Float32Array([]), null], []]);
    assert.equal(placements.length, 0);
    assert.equal(skipped.at(-1).reason, "path-no-bounds");
  });

  it("treats rawFillPath as always painted", () => {
    const { placements } = collect([OPS.rawFillPath], [[OPS.fill, [50, 60, 150, 160]]]);
    assert.equal(placements.length, 1);
    assert.deepEqual(placements[0].rect, [50, 60, 150, 160]);
  });

  it("applies the enclosing form's /Matrix to inner paths", () => {
    const { placements } = collect(
      [
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.fill,
        OPS.paintFormXObjectEnd,
      ],
      [
        [[1, 0, 0, 1, 100, 100], [0, 0, 200, 200]],
        [OPS.fill, new Float32Array([0, 0, 10, 10]), [0, 0, 10, 10]],
        [],
        null,
      ],
    );
    const path = placements.find((p) => p.kind === "path");
    assert.deepEqual(path.rect, [100, 100, 110, 110]);
  });

  it("counts painted path boxes in the diagnostics", () => {
    const { diagnostics } = collect(
      [
        OPS.constructPath,
        OPS.fill,
        OPS.constructPath,
        OPS.endPath,
        OPS.constructPath,
        OPS.stroke,
      ],
      [
        [OPS.fill, new Float32Array([0, 0, 9, 9]), [0, 0, 9, 9]],
        [],
        [OPS.endPath, new Float32Array([0, 0, 9, 9]), [0, 0, 9, 9]],
        null,
        [OPS.stroke, new Float32Array([20, 20, 40, 40]), [20, 20, 40, 40]],
        [],
      ],
    );
    assert.equal(diagnostics.pathBoxCount, 2);
  });
});

describe("placements: form /BBox clipping", () => {
  it("skips a path painted outside its form's /BBox as outside-clip", () => {
    // A conforming renderer clips form content at the form's /BBox, so a path
    // entirely outside it paints nothing and must not become evidence: the
    // Flash fixture page 8 hides 16 legend bars at local x0 = -68 this way.
    const { placements, skipped } = collect(
      [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd],
      [
        [[1, 0, 0, 1, 100, 100], [0, 0, 200, 200]],
        [OPS.fill, new Float32Array([-80, 10, -60, 30]), [-80, 10, -60, 30]],
        [],
        null,
      ],
    );
    assert.deepEqual(placements.map((p) => p.kind), ["form"]);
    assert.equal(skipped.at(-1).reason, "outside-clip");
  });

  it("clamps a path that sticks out of the form's /BBox", () => {
    const { placements, diagnostics } = collect(
      [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd],
      [
        [[1, 0, 0, 1, 100, 100], [0, 0, 200, 200]],
        [OPS.fill, new Float32Array([-50, 20, 100, 60]), [-50, 20, 100, 60]],
        [],
        null,
      ],
    );
    const path = placements.find((p) => p.kind === "path");
    assert.deepEqual(path.rect, [100, 120, 200, 160]);
    assert.equal(diagnostics.clippedCount, 1);
  });

  it("composes nested form clips: a child form outside the grandparent /BBox", () => {
    const { placements } = collect(
      [
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.fill,
        OPS.paintFormXObjectEnd,
        OPS.paintFormXObjectEnd,
        OPS.constructPath,
        OPS.fill,
      ],
      [
        [[1, 0, 0, 1, 0, 0], [0, 0, 200, 200]],
        [[1, 0, 0, 1, 0, 0], [100, 100, 400, 400]],
        [OPS.fill, new Float32Array([150, 150, 500, 500]), [150, 150, 500, 500]],
        [],
        null,
        null,
        [OPS.fill, new Float32Array([300, 0, 500, 100]), [300, 0, 500, 100]],
        [],
      ],
    );
    // The child rect is clamped to the grandparent clip ...
    assert.deepEqual(placements.map((p) => p.rect), [
      [0, 0, 200, 200],
      [100, 100, 200, 200],
      [150, 150, 200, 200], // ... and the path inside it to the clamped child.
      [300, 0, 500, 100], // after both ends the clip is gone again, unchanged
    ]);
  });

  it("inherits the parent clip through a form without a /BBox", () => {
    // No /BBox means no clip (pdf.js applies none), never an empty one: the
    // PipeBWrite fixture page 7 draws Figure 5 through 51 paths living inside
    // three bbox-less forms, and an empty clip would drop every one of them.
    const { placements, skipped } = collect(
      [
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.fill,
        OPS.paintFormXObjectEnd,
        OPS.paintFormXObjectEnd,
      ],
      [
        [[1, 0, 0, 1, 0, 0], [0, 0, 200, 200]],
        [[1, 0, 0, 1, 0, 0], [0, 0, 0, 0]],
        [OPS.fill, new Float32Array([-100, 50, 100, 150]), [-100, 50, 100, 150]],
        [],
        null,
        null,
      ],
    );
    assert.equal(skipped[0].reason, "missing-or-empty-bbox");
    const path = placements.find((p) => p.kind === "path");
    assert.ok(path, "the path is neither dropped nor clipped to nothing");
    assert.deepEqual(path.rect, [0, 50, 100, 150]);
  });

  it("treats a /BBox of [0 0 0 0] as no clip, not as clip-to-nothing", () => {
    const { placements } = collect(
      [
        OPS.paintFormXObjectBegin,
        OPS.constructPath,
        OPS.fill,
        OPS.paintFormXObjectEnd,
      ],
      [
        [[1, 0, 0, 1, 0, 0], [0, 0, 0, 0]],
        [OPS.fill, new Float32Array([-500, -600, -400, -500]), [-500, -600, -400, -500]],
        [],
        null,
      ],
    );
    const path = placements.find((p) => p.kind === "path");
    assert.deepEqual(path.rect, [-500, -600, -400, -500]);
  });

  it("clips image placements to the enclosing form too", () => {
    // The Flash fixture page 1 paints a 930x616 sub-image whose top sticks
    // out of the containing form's /BBox; unclipped it pulled Figure 1's
    // region 13 pt above the rendered ink.
    const { placements, skipped, diagnostics } = collect(
      [OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd],
      [
        [[1, 0, 0, 1, 0, 0], [0, 0, 200, 200]],
        [300, 0, 0, 250, 0, 100],
        ["img", 930, 616],
        null,
      ],
    );
    assert.deepEqual(placements.map((p) => p.rect), [
      [0, 0, 200, 200],
      [0, 100, 200, 200],
    ]);
    assert.equal(skipped.length, 0);
    assert.equal(diagnostics.clippedCount, 1);
  });
});

describe("placements: diagnostics", () => {
  it("reports unbalanced save/restore", () => {
    const { diagnostics } = collect([OPS.save, OPS.save, OPS.restore], [null, null, null]);
    assert.equal(diagnostics.unclosedSave, 1);
    assert.equal(diagnostics.restoreCount, 1);
    assert.equal(diagnostics.operatorCount, 3);
  });

  it("restores the nesting depth recorded by save", () => {
    const { placements } = collect(
      [OPS.save, OPS.paintFormXObjectBegin, OPS.restore, OPS.paintFormXObjectBegin],
      [null, [[1, 0, 0, 1, 0, 0], [0, 0, 10, 10]], null, [[1, 0, 0, 1, 0, 0], [0, 0, 10, 10]]],
    );
    assert.deepEqual(placements.map((p) => p.depth), [0, 0]);
  });

  it("ignores unknown operator codes", () => {
    const { placements } = collect([OPS.setFillRGBColor, OPS.fill, OPS.endPath], [[0, 0, 0], [], null]);
    assert.equal(placements.length, 0);
  });
});

describe("placements: Zotero-aligned operator coverage", () => {
  it("preserves pure 1D strokes as 1 pt bands while dropping 0x0 moves as degenerate-rect", () => {
    const { placements, skipped } = collect(
      [OPS.constructPath, OPS.constructPath, OPS.constructPath, OPS.constructPath],
      [
        [OPS.stroke, null, [50, 100, 250, 100]],
        [OPS.stroke, null, [50, 100, 50, 220]],
        [OPS.stroke, null, [80, 80, 80, 80]],
        [OPS.stroke, null, [50, 100, 250, 101]],
      ],
    );
    assert.equal(placements.length, 3);
    assert.deepEqual(
      placements.map((p) => p.rect),
      [
        [50, 100, 250, 101],
        [50, 100, 51, 220],
        [50, 100, 250, 101],
      ],
    );
    assert.equal(skipped.filter((s) => s.reason === "degenerate-rect").length, 1);
  });

  it("extracts inline images, image masks, solid color masks, and clipped shading fills", () => {
    const { placements } = collect(
      [
        OPS.save,
        OPS.transform,
        OPS.paintInlineImageXObject,
        OPS.restore,
        OPS.save,
        OPS.transform,
        OPS.paintImageMaskXObject,
        OPS.restore,
        OPS.save,
        OPS.transform,
        OPS.paintSolidColorImageMask,
        OPS.restore,
        OPS.save,
        OPS.clip,
        OPS.constructPath,
        OPS.shadingFill,
        OPS.restore,
      ],
      [
        null,
        [100, 0, 0, 80, 50, 400],
        [{}],
        null,
        null,
        [60, 0, 0, 60, 200, 400],
        [{}],
        null,
        null,
        [40, 0, 0, 40, 300, 400],
        null,
        null,
        null,
        null,
        [OPS.endPath, null, [100, 100, 220, 220]],
        [0],
        null,
      ],
    );
    assert.deepEqual(
      placements.map((p) => [p.kind, p.rect]),
      [
        ["image", [50, 400, 150, 480]],
        ["image", [200, 400, 260, 460]],
        ["image", [300, 400, 340, 440]],
        ["path", [100, 100, 220, 220]],
      ],
    );
  });

  it("clips subsequent artwork to active W/W* clip paths while keeping pre-clip bounds", () => {
    const { placements } = collect(
      [
        OPS.save,
        OPS.eoClip,
        OPS.constructPath,
        OPS.save,
        OPS.transform,
        OPS.paintImageXObject,
        OPS.restore,
        OPS.constructPath,
        OPS.restore,
      ],
      [
        null,
        null,
        [OPS.endPath, null, [100, 100, 300, 300]],
        null,
        [400, 0, 0, 400, 0, 0],
        ["img"],
        null,
        [OPS.fill, null, [50, 120, 350, 250]],
        null,
      ],
    );
    assert.deepEqual(
      placements.map((p) => [p.kind, p.rect, p.rawRect ?? null]),
      [
        ["image", [100, 100, 300, 300], null],
        ["path", [100, 120, 300, 250], [50, 120, 350, 250]],
      ],
    );
  });
});
