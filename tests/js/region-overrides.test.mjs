import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DETECTOR_CACHE_REVISION,
  PERSISTENT_SCHEMA_VERSION,
  appendAddOverride,
  matchOverrideTarget,
  normalizeOverrideEntry,
  regionIdFor,
  removeOverride,
  resolveEffectiveRegions,
  serializeAutoRegions,
  upsertReplaceOverride,
  upsertSuppressOverride,
  validateBBox,
} from "../../src/core/region-overrides.js";

describe("region-overrides: validation and serialization", () => {
  it("exposes independent schema and detector cache revision numbers", () => {
    assert.equal(PERSISTENT_SCHEMA_VERSION, 1);
    assert.equal(DETECTOR_CACHE_REVISION, 1);
  });

  it("validates finite positive-area bounding boxes and rejects invalid inputs", () => {
    assert.deepEqual(validateBBox([10, 20, 110, 220]), [10, 20, 110, 220]);
    assert.deepEqual(validateBBox(new Float64Array([1.5, 2.5, 30.5, 40.5])), [1.5, 2.5, 30.5, 40.5]);
    assert.equal(validateBBox(null), null);
    assert.equal(validateBBox([10, 20, 30]), null);
    assert.equal(validateBBox([10, 20, 10, 40]), null, "zero-width box rejected");
    assert.equal(validateBBox([10, 20, 30, 20]), null, "zero-height box rejected");
    assert.equal(validateBBox([100, 20, 50, 80]), null, "inverted x bounds rejected");
    assert.equal(validateBBox([10, 100, 50, 20]), null, "inverted y bounds rejected");
    assert.equal(validateBBox([10, 20, Number.NaN, 80]), null, "NaN coordinate rejected");
    assert.equal(validateBBox([10, 20, Number.POSITIVE_INFINITY, 80]), null, "Infinity rejected");
  });

  it("serializes auto regions deterministically without array-index collision and without mutating input", () => {
    const raw = [
      { rect: [100, 460, 340, 620], captionNumber: "1", caption: "Figure 1: Overview", sourceKinds: ["image"], confidence: 0.92 },
      { rect: [100, 460, 340, 620], captionNumber: "1", sourceKinds: ["path"] },
      { rect: [10, 10, 10, 20], captionNumber: "9" },
    ];
    const snapshot = JSON.stringify(raw);
    const out = serializeAutoRegions(raw);
    assert.equal(JSON.stringify(raw), snapshot, "caller regions must stay unmutated");
    assert.equal(out.length, 2, "invalid bbox entry is filtered");
    assert.notEqual(out[0].id, out[1].id, "identical quantized boxes get disambiguated");
    assert.equal(out[0].captionNumber, "1");
    assert.deepEqual(out[0].sourceKinds, ["image"]);
  });

  it("validates normalized override entries and discards malformed records", () => {
    assert.equal(normalizeOverrideEntry(null), null);
    assert.equal(normalizeOverrideEntry({ op: "unknown", rect: [0, 0, 10, 10] }), null);
    assert.equal(normalizeOverrideEntry({ op: "add", rect: [10, 10, 10, 20] }), null);
    assert.equal(normalizeOverrideEntry({ op: "suppress" }), null);
    assert.equal(normalizeOverrideEntry({ op: "replace", targetRegionId: "r1", rect: [0, 0, 0, 10] }), null);

    const valid = normalizeOverrideEntry({
      id: "ovr-1",
      op: "replace",
      targetRegionId: "cap-1:10,20,100,200",
      targetCaptionNumber: 1,
      targetOriginalRect: [10, 20, 100, 200],
      rect: [12, 22, 108, 210],
    });
    assert.equal(valid?.op, "replace");
    assert.equal(valid?.targetCaptionNumber, "1");
    assert.deepEqual(valid?.rect, [12, 22, 108, 210]);
  });
});

describe("region-overrides: pure resolveEffectiveRegions (Test F)", () => {
  const autoFig1 = {
    rect: [80, 450, 300, 650],
    captionNumber: "1",
    caption: "Figure 1: Pipeline",
    sourceKinds: ["image"],
    kind: "image",
    confidence: 0.91,
  };
  const autoFig2 = {
    rect: [80, 150, 300, 350],
    captionNumber: "2",
    caption: "Figure 2: Results",
    sourceKinds: ["path"],
    kind: "path",
    confidence: 0.87,
  };
  const autoFig3 = {
    rect: [330, 450, 540, 650],
    captionNumber: "3",
    caption: "Figure 3: Ablation",
    sourceKinds: ["form"],
    kind: "form",
    confidence: 0.89,
  };

  it("suppresses a target region without mutating autoRegions or affecting siblings", () => {
    const auto = serializeAutoRegions([autoFig1, autoFig2]);
    const id1 = auto[0].id;
    const { ok, overrides } = upsertSuppressOverride([], id1, { autoRegions: auto });
    assert.equal(ok, true);

    const resolved = resolveEffectiveRegions(auto, overrides);
    assert.equal(auto.length, 2, "autoRegions array preserved untouched");
    assert.deepEqual(resolved.suppressedRegionIds, [id1]);
    assert.equal(resolved.regions.length, 1);
    assert.equal(resolved.regions[0].id, auto[1].id);
  });

  it("replaces a target region bounding box cleanly without duplicating the old box", () => {
    const auto = serializeAutoRegions([autoFig1, autoFig2]);
    const newRect = [70, 430, 315, 670];
    const { ok, overrides } = upsertReplaceOverride([], auto[0].id, newRect, { autoRegions: auto });
    assert.equal(ok, true);

    const resolved = resolveEffectiveRegions(auto, overrides);
    assert.deepEqual(auto[0].rect, [80, 450, 300, 650], "auto region stays unmutated");
    assert.equal(resolved.regions.length, 2, "replaced box must not duplicate original");
    assert.deepEqual(resolved.regions[0].rect, newRect);
    assert.equal(resolved.regions[0].origin, "manual-replace");
    assert.deepEqual(resolved.regions[1].rect, autoFig2.rect);
  });

  it("adds a manual region on an empty page and deduplicates if later auto detection catches the same area", () => {
    const manualRect = [90, 460, 290, 640];
    const { ok, overrides } = appendAddOverride([], manualRect, { captionNumber: "1" });
    assert.equal(ok, true);

    const onEmpty = resolveEffectiveRegions([], overrides);
    assert.equal(onEmpty.regions.length, 1);
    assert.deepEqual(onEmpty.regions[0].rect, manualRect);
    assert.equal(onEmpty.regions[0].origin, "manual-add");

    // Later detector upgrade discovers practically identical Figure 1 box.
    const laterAuto = serializeAutoRegions([{ rect: [88, 458, 292, 642], captionNumber: "1", sourceKinds: ["image"] }]);
    const afterDetect = resolveEffectiveRegions(laterAuto, overrides);
    assert.equal(afterDetect.regions.length, 1, "does not paint duplicate stacked box over matched auto detection");
    assert.equal(afterDetect.dedupedAddIds.length, 1);

    // Adjacent distinct manual box is still preserved.
    const add2 = appendAddOverride(overrides, [320, 460, 520, 640]);
    const both = resolveEffectiveRegions(laterAuto, add2.overrides);
    assert.equal(both.regions.length, 2);
  });

  it("applies composite overrides (suppress + replace + add + reset) cleanly on one page", () => {
    const auto = serializeAutoRegions([autoFig1, autoFig2, autoFig3]);
    let list = [];
    list = upsertSuppressOverride(list, auto[0].id, { autoRegions: auto }).overrides;
    list = upsertReplaceOverride(list, auto[1].id, [75, 140, 310, 365], { autoRegions: auto }).overrides;
    const added = appendAddOverride(list, [330, 150, 540, 350]);
    list = added.overrides;

    const merged = resolveEffectiveRegions(auto, list);
    assert.equal(merged.regions.length, 3, "suppressed Fig1 removed, Fig2 replaced, Fig3 kept, Fig4 added");
    assert.deepEqual(merged.suppressedRegionIds, [auto[0].id]);
    assert.deepEqual(merged.replacedRegionIds, [auto[1].id]);
    assert.equal(merged.addedOverrideIds.length, 1);

    // Resetting Fig1's suppress restores Fig1 without disturbing Fig2 replace or Fig4 add.
    const resetOne = removeOverride(list, auto[0].id, { autoRegions: auto });
    assert.equal(resetOne.removedCount, 1);
    const afterResetOne = resolveEffectiveRegions(auto, resetOne.overrides);
    assert.equal(afterResetOne.regions.length, 4);
    assert.deepEqual(afterResetOne.regions[0].rect, autoFig1.rect);

    // Resetting all overrides restores pure auto regions.
    const resetAll = removeOverride(resetOne.overrides, "*", { all: true });
    const pureAuto = resolveEffectiveRegions(auto, resetAll.overrides);
    assert.equal(pureAuto.regions.length, 3);
    assert.deepEqual(pureAuto.regions.map((r) => r.rect), auto.map((r) => r.rect));
  });

  it("matches by caption+geometry fallback on small detector shift, and leaves unmatched overrides unresolved instead of misapplying", () => {
    const original = serializeAutoRegions([autoFig1]);
    const { overrides } = upsertSuppressOverride([], original[0].id, { autoRegions: original });

    // Detector slightly expands bounds for Figure 1: ID changed, same captionNumber & strong overlap -> matches!
    const expandedFig1 = serializeAutoRegions([
      { ...autoFig1, rect: [75, 440, 310, 670] },
    ]);
    assert.equal(matchOverrideTarget(overrides[0], expandedFig1), 0);
    const matchedRes = resolveEffectiveRegions(expandedFig1, overrides);
    assert.equal(matchedRes.regions.length, 0);
    assert.equal(matchedRes.unresolvedOverrides.length, 0);

    // False positive Fig 1 disappeared; page now contains only unrelated Fig 2 elsewhere.
    const onlyFig2 = serializeAutoRegions([autoFig2]);
    assert.equal(matchOverrideTarget(overrides[0], onlyFig2), -1);
    const unresolvedRes = resolveEffectiveRegions(onlyFig2, overrides);
    assert.equal(unresolvedRes.regions.length, 1, "must NOT suppress unrelated Figure 2");
    assert.deepEqual(unresolvedRes.regions[0].rect, autoFig2.rect);
    assert.equal(unresolvedRes.unresolvedOverrides.length, 1, "unmatched override stays preserved as unresolved");
  });

  it("assigns deterministic ids independent of sibling count", () => {
    const single = regionIdFor(autoFig2, 0);
    const reordered = serializeAutoRegions([autoFig1, autoFig2, autoFig3]);
    assert.equal(reordered[1].id, single);
  });
});
