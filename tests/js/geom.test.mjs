import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDENTITY,
  coverageOf,
  expandRect,
  intersectRects,
  iou,
  multiplyMatrices,
  normalizeRect,
  rectArea,
  rectFromMatrix,
  toMatrix,
  toRect,
} from "../../src/core/geom.js";

describe("geom: matrices", () => {
  it("composes in PDF order (outer * inner)", () => {
    const translate = [1, 0, 0, 1, 54, 617.946];
    const scale = [1.00053, 0, 0, 1.00053, 0, 0];
    assert.deepEqual(multiplyMatrices(translate, scale), [
      1.00053, 0, 0, 1.00053, 54, 617.946,
    ]);
    assert.deepEqual(multiplyMatrices(IDENTITY, translate), translate);
  });

  it("coerces typed arrays and rejects malformed input", () => {
    assert.deepEqual(toMatrix(new Float32Array([1, 0, 0, 1, 3, 4])), [1, 0, 0, 1, 3, 4]);
    assert.equal(toMatrix([1, 0, 0]), null);
    assert.equal(toMatrix([1, 0, 0, 1, NaN, 0]), null);
    assert.equal(toMatrix(null), null);
    assert.equal(toRect([1, 2, 3]), null);
    assert.deepEqual(toRect(new Uint8Array([1, 2, 3, 4])), [1, 2, 3, 4]);
  });
});

describe("geom: rects", () => {
  it("bounds an axis-aligned rect exactly", () => {
    const m = [1.00053, 0, 0, 1.00053, 54, 617.946];
    const rect = rectFromMatrix(m, [0, 0, 240, 102]);
    assert.ok(Math.abs(rect[0] - 54) < 1e-9);
    assert.ok(Math.abs(rect[1] - 617.946) < 1e-9);
    assert.ok(Math.abs(rect[2] - 294.1272) < 1e-3);
    assert.ok(Math.abs(rect[3] - 720.0001) < 1e-3);
  });

  it("bounds a rotated rect by its four corners", () => {
    // 90 degrees counter-clockwise: a 100x40 box becomes 40x100.
    const rect = rectFromMatrix([0, 1, -1, 0, 0, 0], [10, 20, 110, 60]);
    assert.deepEqual(normalizeRect(rect), [-60, 10, -20, 110]);
    assert.equal(rectArea(rect), 100 * 40);
  });

  it("normalises inverted rects", () => {
    assert.deepEqual(normalizeRect([10, 20, 3, 5]), [3, 5, 10, 20]);
  });

  it("intersects, expands and unions", () => {
    assert.deepEqual(intersectRects([0, 0, 10, 10], [5, 5, 20, 20]), [5, 5, 10, 10]);
    assert.equal(intersectRects([0, 0, 5, 5], [5, 5, 10, 10]), null);
    assert.deepEqual(expandRect([10, 10, 20, 20], 2), [8, 8, 22, 22]);
    assert.deepEqual(expandRect([10, 10, 20, 20], 2, 5), [8, 5, 22, 25]);
  });

  it("meets IoU and containment", () => {
    const a = [0, 0, 10, 10];
    assert.equal(iou(a, a), 1);
    assert.equal(iou(a, [20, 20, 30, 30]), 0);
    assert.equal(iou(a, [0, 0, 5, 10]), 0.5);
    assert.equal(coverageOf([2, 2, 4, 4], a), 1);
    assert.equal(coverageOf(a, [2, 2, 4, 4]), 0.04);
  });
});
