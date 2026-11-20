import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DETECTOR_CACHE_REVISION,
  PERSISTENT_SCHEMA_VERSION,
  appendAddOverride,
  findSuppressedTargetAtPoint,
  hitTestRegions,
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

  it("prioritizes manual add region over overlapping automatic detection (Manual > Automatic)", () => {
    const manualRect = [90, 460, 290, 640];
    const { ok, override: addOvr, overrides } = appendAddOverride([], manualRect, { captionNumber: "1" });
    assert.equal(ok, true);

    const onEmpty = resolveEffectiveRegions([], overrides);
    assert.equal(onEmpty.regions.length, 1);
    assert.deepEqual(onEmpty.regions[0].rect, manualRect);
    assert.equal(onEmpty.regions[0].origin, "manual-add");

    // Later detector upgrade discovers practically identical Figure 1 box -> manual BBox MUST win, no duplicate.
    const laterAuto = serializeAutoRegions([{ rect: [88, 458, 292, 642], captionNumber: "1", sourceKinds: ["image"] }]);
    const afterDetect = resolveEffectiveRegions(laterAuto, overrides);
    assert.equal(afterDetect.regions.length, 1, "does not paint duplicate stacked box");
    assert.deepEqual(afterDetect.regions[0].rect, manualRect, "manual BBox takes priority over auto BBox");
    assert.equal(afterDetect.regions[0].origin, "manual-add");
    assert.equal(afterDetect.regions[0].overrideId, addOvr.id);
    assert.deepEqual(afterDetect.supersededAutoIds, [laterAuto[0].id]);

    // After resetting the manual add override, the auto region is restored cleanly.
    const resetRes = removeOverride(overrides, addOvr.id);
    const afterReset = resolveEffectiveRegions(laterAuto, resetRes.overrides);
    assert.equal(afterReset.regions.length, 1);
    assert.equal(afterReset.regions[0].origin, "auto");
    assert.deepEqual(afterReset.regions[0].rect, [88, 458, 292, 642]);

    // Adjacent distinct manual box is still preserved alongside the first manual box.
    const add2 = appendAddOverride(overrides, [320, 460, 520, 640]);
    const both = resolveEffectiveRegions(laterAuto, add2.overrides);
    assert.equal(both.regions.length, 2);
  });

  it("keeps slightly intersecting auto figure and distinct manual additions unmerged without resizing", () => {
    const auto = serializeAutoRegions([
      { rect: [100, 400, 300, 600], captionNumber: "1", sourceKinds: ["image"] },
    ]);
    // Slightly intersecting manual box (IoU << 0.85) must NOT delete adjacent auto region or resize user box.
    const add1Rect = [260, 420, 420, 580];
    const add2Rect = [265, 425, 425, 585];
    let overrides = appendAddOverride([], add1Rect).overrides;
    overrides = appendAddOverride(overrides, add2Rect, { allowDuplicate: true }).overrides;

    const merged = resolveEffectiveRegions(auto, overrides);
    assert.equal(merged.regions.length, 3, "adjacent auto figure and two manual adds stay distinct");
    assert.deepEqual(merged.regions[0].rect, [100, 400, 300, 600]);
    assert.deepEqual(merged.regions[1].rect, add1Rect);
    assert.deepEqual(merged.regions[2].rect, add2Rect);
  });

  it("still renders unmatched manual replace BBox without breaking reset or unrelated suppress (Section 2)", () => {
    const original = serializeAutoRegions([autoFig1]);
    const adjustedRect = [70, 440, 315, 665];
    const { ok, override: repOvr, overrides } = upsertReplaceOverride([], original[0].id, adjustedRect, {
      autoRegions: original,
    });
    assert.equal(ok, true);

    // Case 1: New detector fails to find any figure -> manual replace still renders and records diagnostic unresolved state.
    const emptyAutoRes = resolveEffectiveRegions([], overrides);
    assert.equal(emptyAutoRes.regions.length, 1, "unmatched replace must remain effective on empty auto result");
    assert.deepEqual(emptyAutoRes.regions[0].rect, adjustedRect);
    assert.equal(emptyAutoRes.regions[0].overrideId, repOvr.id);
    assert.equal(emptyAutoRes.regions[0].origin, "manual-replace");
    assert.equal(emptyAutoRes.unresolvedOverrides.length, 1);

    // Case 2: New detector outputs a drastically shifted unrelated Figure 2 -> manual replace remains alongside it without suppressing Fig 2.
    const shiftedUnrelated = serializeAutoRegions([autoFig2]);
    const withSuppress = upsertSuppressOverride(overrides, {
      targetRegionId: "missing-fig-3",
      targetCaptionNumber: "3",
      targetOriginalRect: [350, 100, 500, 300],
    }).overrides;
    const mixedRes = resolveEffectiveRegions(shiftedUnrelated, withSuppress);
    assert.equal(mixedRes.regions.length, 2, "auto Fig 2 preserved + unmatched replace rendered; unmatched suppress does nothing");
    assert.deepEqual(mixedRes.regions[0].rect, autoFig2.rect);
    assert.deepEqual(mixedRes.regions[1].rect, adjustedRect);
    assert.equal(mixedRes.unresolvedOverrides.length, 2);

    // Case 3: New detector eventually detects same area as adjustedRect -> manual replace keeps priority without duplicate.
    const autoMatchingAdjusted = serializeAutoRegions([
      { rect: [72, 442, 314, 664], captionNumber: "1", sourceKinds: ["image"] },
    ]);
    const dedupRes = resolveEffectiveRegions(autoMatchingAdjusted, overrides);
    assert.equal(dedupRes.regions.length, 1);
    assert.deepEqual(dedupRes.regions[0].rect, adjustedRect);
    assert.equal(dedupRes.regions[0].overrideId, repOvr.id);

    // Case 4: Reset removes unmatched replace cleanly and leaves only pure auto output.
    const resetRes = removeOverride(overrides, repOvr.id);
    const restored = resolveEffectiveRegions(shiftedUnrelated, resetRes.overrides);
    assert.equal(restored.regions.length, 1);
    assert.deepEqual(restored.regions[0].rect, autoFig2.rect);
    assert.equal(restored.regions[0].origin, "auto");
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

  it("hit-tests effective regions prioritizing manual overrides first, then smaller area", () => {
    const regions = [
      { id: "auto-big", origin: "auto", rect: [50, 50, 400, 400] },
      { id: "auto-small", origin: "auto", rect: [100, 100, 220, 220] },
      { id: "ovr-manual", overrideId: "ovr-manual", origin: "manual-add", rect: [120, 120, 350, 350] },
    ];
    // Point inside all three: manual region wins over smaller auto-small.
    const hitManual = hitTestRegions([150, 150], regions);
    assert.equal(hitManual?.region.id, "ovr-manual");
    assert.equal(hitManual?.isManual, true);

    // Point inside auto-big and auto-small only: smaller auto-small wins.
    const hitSmallAuto = hitTestRegions([110, 110], regions);
    assert.equal(hitSmallAuto?.region.id, "auto-small");
    assert.equal(hitSmallAuto?.isManual, false);

    // Point strictly outside with 0 tolerance misses, succeeds with tolerance=2.
    assert.equal(hitTestRegions([49, 200], regions), null);
    assert.equal(hitTestRegions([49, 200], regions, { tolerance: 2 })?.region.id, "auto-big");
  });

  it("locates suppressed auto figures by saved original rect and auto fallback", () => {
    const auto = serializeAutoRegions([autoFig1, autoFig2]);
    const overrides = [
      normalizeOverrideEntry({
        id: "ovr-sup-1",
        op: "suppress",
        targetRegionId: auto[0].id,
        targetOriginalRect: auto[0].rect,
      }),
      normalizeOverrideEntry({
        id: "ovr-sup-2",
        op: "suppress",
        targetRegionId: auto[1].id,
      }),
    ];
    const hit1 = findSuppressedTargetAtPoint([150, 520], { overrides, autoRegions: [] });
    assert.equal(hit1?.override.id, "ovr-sup-1");
    assert.deepEqual(hit1?.rect, auto[0].rect);

    const hit2 = findSuppressedTargetAtPoint([150, 240], { overrides, autoRegions: auto });
    assert.equal(hit2?.override.id, "ovr-sup-2");
    assert.deepEqual(hit2?.rect, auto[1].rect);

    assert.equal(findSuppressedTargetAtPoint([450, 500], { overrides, autoRegions: auto }), null);
  });

  it("edits and removes manual-add (even overlapping auto) and unmatched replace overrides in-place without duplicates", () => {
    const auto = serializeAutoRegions([autoFig1]);
    // Manual add intentionally sitting right over autoFig1.
    const added = appendAddOverride([], [...autoFig1.rect], { allowDuplicate: true });
    const addEff = resolveEffectiveRegions(auto, added.overrides).regions.find((r) => r.origin === "manual-add");
    assert.ok(addEff);

    // Re-adjusting that manual-add targets ONLY the manual add without replacing autoFig1.
    const repAdd = upsertReplaceOverride(added.overrides, addEff, [90, 460, 310, 660], { autoRegions: auto });
    assert.equal(repAdd.action, "update-add");
    assert.equal(repAdd.overrides.length, 1);
    assert.equal(repAdd.overrides[0].id, addEff.overrideId);

    // Removing protection on that manual-add removes it cleanly without creating a suppress entry.
    const supAdd = upsertSuppressOverride(repAdd.overrides, { ...addEff, rect: [90, 460, 310, 660] }, { autoRegions: auto });
    assert.equal(supAdd.action, "removed-add");
    assert.equal(supAdd.overrides.length, 0);

    // Unmatched replace fallback updates in place on repeat edit and deletes cleanly on suppress.
    const orphanReplace = [
      normalizeOverrideEntry({
        id: "ovr-orphan-r",
        op: "replace",
        targetRegionId: "missing-auto",
        targetOriginalRect: [20, 20, 120, 120],
        rect: [25, 25, 130, 130],
      }),
    ];
    const orphanEff = resolveEffectiveRegions([], orphanReplace).regions[0];
    const repOrphan = upsertReplaceOverride(orphanReplace, orphanEff, [30, 30, 150, 150], { autoRegions: [] });
    assert.equal(repOrphan.overrides.length, 1);
    assert.equal(repOrphan.overrides[0].id, "ovr-orphan-r");
    assert.deepEqual(repOrphan.overrides[0].rect, [30, 30, 150, 150]);

    const supOrphan = upsertSuppressOverride(repOrphan.overrides, { ...orphanEff, rect: [30, 30, 150, 150] }, { autoRegions: [] });
    assert.equal(supOrphan.action, "removed-replace");
    assert.equal(supOrphan.overrides.length, 0);
  });
});
