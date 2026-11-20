/**
 * Pure data structures, validation, target matching, and override resolution
 * for persistent auto-detected figure caches and user manual overrides.
 *
 * Zero Zotero or browser-DOM dependencies: runs identically in Node tests and
 * inside the Zotero chrome sandbox.
 */

import { coverageOf, iou, rectArea, roundRect, toRect } from "./geom.js";

/** Schema version for the per-attachment persistent JSON envelope. */
export const PERSISTENT_SCHEMA_VERSION = 1;

/**
 * Independent auto-detection cache revision.
 * Bump only when figure detection logic/heuristics change in a way that should
 * invalidate previously cached auto-detected bounding boxes while preserving
 * manual user overrides. Never couple to the add-on UI version.
 */
export const DETECTOR_CACHE_REVISION = 1;

let overrideCounter = 0;

/**
 * Validates and copies a PDF user-space bounding box `[x0, y0, x1, y1]`.
 * Requires finite coordinates with strictly positive width and height.
 *
 * @param {unknown} rect
 * @returns {number[]|null}
 */
export function validateBBox(rect) {
  const coerced = toRect(rect);
  if (!coerced) return null;
  const [x0, y0, x1, y1] = coerced;
  if (!(x1 > x0 && y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

function normalizeCaptionNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeSourceKinds(region) {
  const raw = Array.isArray(region?.sourceKinds)
    ? region.sourceKinds
    : region?.kind
      ? [region.kind]
      : ["figure"];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) seen.add(item.trim());
  }
  return seen.size ? [...seen] : ["figure"];
}

function nextTimestamp(now) {
  if (typeof now === "function") return String(now());
  if (typeof now === "string" && now) return now;
  return new Date().toISOString();
}

function mintOverrideId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `ovr-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // Fall back to monotonic counter id.
  }
  overrideCounter += 1;
  return `ovr-${Date.now().toString(36)}-${overrideCounter.toString(36)}`;
}

/**
 * Computes a deterministic identifier for an auto-detected figure region using
 * its caption label and quantized bounding box rather than array index alone.
 *
 * @param {object} region
 * @param {number} [index]
 * @returns {string}
 */
export function regionIdFor(region, index = 0) {
  if (typeof region?.id === "string" && region.id.trim()) {
    return region.id.trim();
  }
  const rect = validateBBox(region?.rect ?? region);
  if (!rect) return `auto-${index}`;
  const rounded = roundRect(rect, 2);
  const cap = normalizeCaptionNumber(region?.captionNumber);
  const capPart = cap !== null ? `cap-${cap}` : "nocap";
  return `${capPart}:${rounded.join(",")}`;
}

/**
 * Converts a detected figure region into a plain JSON-serializable auto-cache
 * record. Returns `null` if the region lacks a valid positive-area bounding box.
 *
 * @param {object} region
 * @param {number} [index]
 * @returns {object|null}
 */
export function serializeAutoRegion(region, index = 0) {
  if (!region || typeof region !== "object") return null;
  const rect = validateBBox(region.rect);
  if (!rect) return null;
  const captionNumber = normalizeCaptionNumber(region.captionNumber);
  const caption = typeof region.caption === "string" && region.caption.trim() ? region.caption : null;
  const sourceKinds = normalizeSourceKinds(region);
  const kind = typeof region.kind === "string" && region.kind.trim() ? region.kind.trim() : sourceKinds[0];
  const conf = Number(region.confidence);
  return {
    id: regionIdFor({ ...region, rect, captionNumber }, index),
    rect,
    captionNumber,
    caption,
    sourceKinds,
    kind,
    confidence: Number.isFinite(conf) ? conf : null,
  };
}

/**
 * Normalizes an array of auto-detected regions and guarantees unique region IDs
 * within a single page.
 *
 * @param {Array<object>|null|undefined} regions
 * @returns {Array<object>}
 */
export function serializeAutoRegions(regions) {
  if (!Array.isArray(regions)) return [];
  const out = [];
  const seenIds = new Map();
  for (let i = 0; i < regions.length; i += 1) {
    const serialized = serializeAutoRegion(regions[i], i);
    if (!serialized) continue;
    const baseId = serialized.id;
    const count = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, count + 1);
    if (count > 0) {
      serialized.id = `${baseId}#${count + 1}`;
    }
    out.push(serialized);
  }
  return out;
}

/**
 * Validates and normalizes a stored manual override entry loaded from disk.
 * Returns `null` if malformed so invalid records cannot corrupt resolution.
 *
 * @param {unknown} entry
 * @returns {object|null}
 */
export function normalizeOverrideEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const op = entry.op;
  if (op !== "suppress" && op !== "replace" && op !== "add") return null;
  const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : mintOverrideId();
  const createdAt = typeof entry.createdAt === "string" && entry.createdAt ? entry.createdAt : null;
  const updatedAt = typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : createdAt;

  if (op === "add") {
    const rect = validateBBox(entry.rect);
    if (!rect) return null;
    const captionNumber = normalizeCaptionNumber(entry.captionNumber);
    const caption = typeof entry.caption === "string" && entry.caption.trim() ? entry.caption : null;
    const out = { id, op: "add", rect, captionNumber, caption };
    if (entry.allowDuplicate === true) out.allowDuplicate = true;
    if (createdAt) out.createdAt = createdAt;
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  }

  const targetRegionId =
    typeof entry.targetRegionId === "string" && entry.targetRegionId.trim()
      ? entry.targetRegionId.trim()
      : null;
  const targetCaptionNumber = normalizeCaptionNumber(entry.targetCaptionNumber);
  const targetOriginalRect = entry.targetOriginalRect != null ? validateBBox(entry.targetOriginalRect) : null;
  if (!targetRegionId && !targetOriginalRect) return null;

  if (op === "replace") {
    const rect = validateBBox(entry.rect);
    if (!rect) return null;
    const out = {
      id,
      op: "replace",
      targetRegionId,
      targetCaptionNumber,
      targetOriginalRect,
      rect,
    };
    if (createdAt) out.createdAt = createdAt;
    if (updatedAt) out.updatedAt = updatedAt;
    return out;
  }

  const out = {
    id,
    op: "suppress",
    targetRegionId,
    targetCaptionNumber,
    targetOriginalRect,
  };
  if (createdAt) out.createdAt = createdAt;
  if (updatedAt) out.updatedAt = updatedAt;
  return out;
}

/**
 * Finds the auto-detected region on a page targeted by a `suppress` or `replace`
 * override. Matches by stable `targetRegionId` first, then by non-conflicting
 * caption number + geometric overlap fallback, never blindly by array index.
 *
 * @param {object} override
 * @param {Array<object>} autoRegions Normalized auto-region list.
 * @returns {number} Matched index in `autoRegions`, or `-1` when unresolved.
 */
export function matchOverrideTarget(override, autoRegions) {
  if (!override || !Array.isArray(autoRegions) || !autoRegions.length) return -1;

  if (override.targetRegionId) {
    const exactIndex = autoRegions.findIndex((region) => region.id === override.targetRegionId);
    if (exactIndex !== -1) return exactIndex;
  }

  const targetRect = validateBBox(override.targetOriginalRect);
  if (!targetRect) return -1;

  const targetCap = normalizeCaptionNumber(override.targetCaptionNumber);
  let bestIndex = -1;
  let bestSameCap = -1;
  let bestIou = 0;

  for (let i = 0; i < autoRegions.length; i += 1) {
    const candidate = autoRegions[i];
    const candRect = validateBBox(candidate?.rect);
    if (!candRect) continue;

    const candCap = normalizeCaptionNumber(candidate?.captionNumber);
    if (targetCap !== null && candCap !== null && targetCap !== candCap) {
      continue;
    }

    const sameCap = targetCap !== null && candCap === targetCap;
    const overlapIou = iou(targetRect, candRect);
    const covTarget = coverageOf(targetRect, candRect);
    const matches = sameCap
      ? overlapIou >= 0.35 || (covTarget >= 0.65 && overlapIou >= 0.2)
      : overlapIou >= 0.55;

    if (!matches) continue;
    const capScore = sameCap ? 1 : 0;
    if (capScore > bestSameCap || (capScore === bestSameCap && overlapIou > bestIou)) {
      bestIndex = i;
      bestSameCap = capScore;
      bestIou = overlapIou;
    }
  }

  return bestIndex;
}

function normalizeTargetDescriptor(target, autoRegions) {
  const auto = serializeAutoRegions(autoRegions);
  let targetRegionId = null;
  let targetCaptionNumber = null;
  let targetOriginalRect = null;

  if (typeof target === "string") {
    const trimmed = target.trim();
    if (trimmed) targetRegionId = trimmed;
  } else if (Array.isArray(target) || ArrayBuffer.isView(target)) {
    targetOriginalRect = validateBBox(target);
  } else if (target && typeof target === "object") {
    const rawId = target.targetRegionId ?? target.regionId ?? target.id ?? null;
    if (typeof rawId === "string" && rawId.trim()) targetRegionId = rawId.trim();
    targetCaptionNumber = normalizeCaptionNumber(target.targetCaptionNumber ?? target.captionNumber);
    targetOriginalRect = validateBBox(target.targetOriginalRect ?? target.originalRect ?? target.rect);
  }

  if (auto.length && (targetRegionId || targetOriginalRect)) {
    const matchedIdx = matchOverrideTarget(
      { targetRegionId, targetCaptionNumber, targetOriginalRect },
      auto,
    );
    if (matchedIdx !== -1) {
      const matched = auto[matchedIdx];
      targetRegionId ??= matched.id;
      targetCaptionNumber ??= matched.captionNumber;
      targetOriginalRect ??= [...matched.rect];
    }
  }

  if (!targetRegionId && !targetOriginalRect) return null;
  return {
    targetRegionId,
    targetCaptionNumber,
    targetOriginalRect,
  };
}

function sameOverrideTarget(existing, candidate) {
  if (!existing || existing.op === "add") return false;
  if (existing.targetRegionId && candidate.targetRegionId && existing.targetRegionId === candidate.targetRegionId) {
    return true;
  }
  if (existing.targetOriginalRect && candidate.targetOriginalRect) {
    if (
      existing.targetCaptionNumber !== null &&
      candidate.targetCaptionNumber !== null &&
      existing.targetCaptionNumber !== candidate.targetCaptionNumber
    ) {
      return false;
    }
    if (iou(existing.targetOriginalRect, candidate.targetOriginalRect) >= 0.85) {
      return true;
    }
  }
  return false;
}

function findExplicitOverrideIndex(overrides, target, { ops = ["add", "replace"] } = {}) {
  if (!Array.isArray(overrides) || !overrides.length || target == null) return -1;
  const opSet = new Set(ops);
  if (typeof target === "string") {
    const id = target.trim();
    return id ? overrides.findIndex((o) => opSet.has(o.op) && o.id === id) : -1;
  }
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const overrideId = typeof target.overrideId === "string" ? target.overrideId.trim() : null;
    if (overrideId) {
      const idx = overrides.findIndex((o) => opSet.has(o.op) && o.id === overrideId);
      if (idx !== -1) return idx;
    }
    const id = typeof target.id === "string" ? target.id.trim() : null;
    if (id) {
      const idx = overrides.findIndex((o) => opSet.has(o.op) && o.id === id);
      if (idx !== -1) return idx;
    }
    if (opSet.has("add") && target.origin === "manual-add") {
      const rect = validateBBox(target.rect);
      if (rect) {
        const idx = overrides.findIndex((o) => o.op === "add" && o.rect && iou(o.rect, rect) >= 0.95);
        if (idx !== -1) return idx;
      }
    }
  }
  return -1;
}

function findMatchingManualOverrideIndex(overrides, target, { ops = ["add"] } = {}) {
  const explicit = findExplicitOverrideIndex(overrides, target, { ops });
  if (explicit !== -1) return explicit;
  const opSet = new Set(ops);
  const rect = Array.isArray(target) ? validateBBox(target) : validateBBox(target?.rect);
  if (rect) {
    return overrides.findIndex((o) => opSet.has(o.op) && o.rect && iou(o.rect, rect) >= 0.95);
  }
  return -1;
}

function findSupersededAutoRegionForAdd(addOverride, autoRegions) {
  if (!addOverride || addOverride.allowDuplicate === true || !Array.isArray(autoRegions) || !autoRegions.length) {
    return null;
  }
  const addCap = normalizeCaptionNumber(addOverride.captionNumber);
  let best = null;
  let bestSameCap = -1;
  let bestIou = 0;

  for (let i = 0; i < autoRegions.length; i += 1) {
    const candidate = autoRegions[i];
    const candRect = validateBBox(candidate?.rect);
    if (!candRect) continue;
    const overlap = iou(candRect, addOverride.rect);
    if (overlap < 0.85) continue;
    const candCap = normalizeCaptionNumber(candidate?.captionNumber);
    if (addCap !== null && candCap !== null && addCap !== candCap) continue;
    const sameCap = addCap !== null && candCap === addCap ? 1 : 0;
    if (!best || sameCap > bestSameCap || (sameCap === bestSameCap && overlap > bestIou)) {
      best = { region: candidate, index: i };
      bestSameCap = sameCap;
      bestIou = overlap;
    }
  }
  return best;
}

function entryTargetsSameAutoFigure(entry, auto, { autoIndex = -1, reference = null } = {}) {
  if (!entry || entry.op === "add") return false;
  if (reference && sameOverrideTarget(entry, reference)) return true;
  if (autoIndex !== -1 && Array.isArray(auto) && auto.length) {
    return matchOverrideTarget(entry, auto) === autoIndex;
  }
  return false;
}

function applyAutoSuppress(list, auto, autoIndex, descriptor, ts, extra = {}) {
  const next = list.filter(
    (entry) => !entryTargetsSameAutoFigure(entry, auto, { autoIndex, reference: descriptor }),
  );
  const created = normalizeOverrideEntry({
    id: mintOverrideId(),
    op: "suppress",
    ...descriptor,
    createdAt: ts,
    updatedAt: ts,
  });
  next.push(created);
  return { ok: true, action: "suppress", override: created, ...extra, overrides: next };
}

/**
 * Purely inserts or updates a `suppress` override for a page's override list.
 * When removing a manual `"add"` override that superseded a matching auto region,
 * promotes that removal into a `suppress` override for that auto region so
 * Remove keeps Effective Regions suppressed instead of re-exposing the auto box.
 */
export function upsertSuppressOverride(overrides, target, { autoRegions = [], now } = {}) {
  const list = Array.isArray(overrides)
    ? overrides.map(normalizeOverrideEntry).filter(Boolean)
    : [];
  const auto = serializeAutoRegions(autoRegions);
  const ts = nextTimestamp(now);

  const explicitIdx = findExplicitOverrideIndex(list, target, { ops: ["add", "replace"] });
  if (explicitIdx !== -1) {
    const existing = list[explicitIdx];
    if (existing.op === "add") {
      const [removedAdd] = list.splice(explicitIdx, 1);
      const superseded = findSupersededAutoRegionForAdd(removedAdd, auto);
      if (!superseded) {
        return { ok: true, action: "removed-add", override: removedAdd, overrides: list };
      }
      const desc = {
        targetRegionId: superseded.region.id,
        targetCaptionNumber: superseded.region.captionNumber,
        targetOriginalRect: [...superseded.region.rect],
      };
      return applyAutoSuppress(list, auto, superseded.index, desc, ts, { removedAdd });
    }

    list.splice(explicitIdx, 1);
    const descriptor = normalizeTargetDescriptor(target, auto);
    let matchedAuto = matchOverrideTarget(existing, auto);
    if (matchedAuto === -1 && descriptor) matchedAuto = matchOverrideTarget(descriptor, auto);
    if (matchedAuto === -1) {
      return { ok: true, action: "removed-replace", override: existing, overrides: list };
    }
    const matchedRegion = auto[matchedAuto];
    const desc = {
      targetRegionId: matchedRegion.id,
      targetCaptionNumber: matchedRegion.captionNumber,
      targetOriginalRect: [...matchedRegion.rect],
    };
    return applyAutoSuppress(list, auto, matchedAuto, desc, ts);
  }

  const descriptor = normalizeTargetDescriptor(target, auto);
  const matchedAuto = descriptor ? matchOverrideTarget(descriptor, auto) : -1;
  if (matchedAuto === -1) {
    const manualIdx = findMatchingManualOverrideIndex(list, target, { ops: ["add", "replace"] });
    if (manualIdx !== -1) {
      const [removed] = list.splice(manualIdx, 1);
      if (removed.op === "add") {
        const superseded = findSupersededAutoRegionForAdd(removed, auto);
        if (superseded) {
          const desc = {
            targetRegionId: superseded.region.id,
            targetCaptionNumber: superseded.region.captionNumber,
            targetOriginalRect: [...superseded.region.rect],
          };
          return applyAutoSuppress(list, auto, superseded.index, desc, ts, { removedAdd: removed });
        }
      }
      return {
        ok: true,
        action: removed.op === "add" ? "removed-add" : "removed-replace",
        override: removed,
        overrides: list,
      };
    }
  }

  if (!descriptor) {
    return { ok: false, reason: "invalid-target", overrides: list };
  }

  return applyAutoSuppress(list, auto, matchedAuto, descriptor, ts);
}

/**
 * Purely inserts or updates a `replace` override for a page's override list.
 * Prioritizes explicit `overrideId` matching so repeated adjustments across
 * detector upgrades update the existing override in place without duplicates.
 */
export function upsertReplaceOverride(overrides, target, newRect, { autoRegions = [], now } = {}) {
  const list = Array.isArray(overrides)
    ? overrides.map(normalizeOverrideEntry).filter(Boolean)
    : [];
  const validRect = validateBBox(newRect);
  if (!validRect) {
    return { ok: false, reason: "invalid-rect", overrides: list };
  }

  const auto = serializeAutoRegions(autoRegions);
  const ts = nextTimestamp(now);
  const explicitIdx = findExplicitOverrideIndex(list, target, { ops: ["add", "replace"] });
  if (explicitIdx !== -1) {
    const existing = list[explicitIdx];
    if (existing.op === "add") {
      const updated = { ...existing, rect: validRect, updatedAt: ts };
      list[explicitIdx] = updated;
      return { ok: true, action: "update-add", override: updated, overrides: list };
    }
    const matchedAuto = auto.length ? matchOverrideTarget(existing, auto) : -1;
    const updated = { ...existing, rect: validRect, updatedAt: ts };
    const next = list.filter(
      (entry, idx) =>
        idx === explicitIdx ||
        !entryTargetsSameAutoFigure(entry, auto, { autoIndex: matchedAuto, reference: existing }),
    );
    const updatedIdx = next.indexOf(existing);
    next[updatedIdx] = updated;
    return { ok: true, action: "replace", override: updated, overrides: next };
  }

  const descriptor = normalizeTargetDescriptor(target, auto);
  const matchedAuto = descriptor ? matchOverrideTarget(descriptor, auto) : -1;
  if (matchedAuto === -1) {
    const manualIdx = findMatchingManualOverrideIndex(list, target, { ops: ["add", "replace"] });
    if (manualIdx !== -1) {
      const updated = { ...list[manualIdx], rect: validRect, updatedAt: ts };
      list[manualIdx] = updated;
      return {
        ok: true,
        action: updated.op === "add" ? "update-add" : "replace",
        override: updated,
        overrides: list,
      };
    }
  }

  if (!descriptor) {
    return { ok: false, reason: "invalid-target", overrides: list };
  }

  const matchesTarget = (entry) =>
    entryTargetsSameAutoFigure(entry, auto, { autoIndex: matchedAuto, reference: descriptor });
  const prior = list.find((entry) => entry.op === "replace" && matchesTarget(entry)) ?? list.find(matchesTarget);
  const next = list.filter((entry) => !matchesTarget(entry));
  const created = normalizeOverrideEntry({
    id: prior?.op === "replace" ? prior.id : mintOverrideId(),
    op: "replace",
    targetRegionId: prior?.targetRegionId ?? descriptor.targetRegionId,
    targetCaptionNumber: prior?.targetCaptionNumber ?? descriptor.targetCaptionNumber,
    targetOriginalRect: prior?.targetOriginalRect ?? descriptor.targetOriginalRect,
    rect: validRect,
    createdAt: prior?.createdAt ?? ts,
    updatedAt: ts,
  });
  next.push(created);
  return { ok: true, action: "replace", override: created, overrides: next };
}

/**
 * Purely appends a manual `"add"` override to a page's override list, avoiding
 * duplicate additions at the exact same coordinates unless `allowDuplicate` is set.
 */
export function appendAddOverride(
  overrides,
  rect,
  { captionNumber = null, caption = null, allowDuplicate = false, now } = {},
) {
  const list = Array.isArray(overrides)
    ? overrides.map(normalizeOverrideEntry).filter(Boolean)
    : [];
  const validRect = validateBBox(rect);
  if (!validRect) {
    return { ok: false, reason: "invalid-rect", overrides: list };
  }
  const ts = nextTimestamp(now);

  if (!allowDuplicate) {
    const existingIdx = list.findIndex((o) => o.op === "add" && iou(o.rect, validRect) >= 0.9);
    if (existingIdx !== -1) {
      const updated = {
        ...list[existingIdx],
        rect: validRect,
        captionNumber: normalizeCaptionNumber(captionNumber) ?? list[existingIdx].captionNumber,
        caption: typeof caption === "string" && caption.trim() ? caption : list[existingIdx].caption,
        updatedAt: ts,
      };
      list[existingIdx] = updated;
      return { ok: true, action: "update-existing-add", override: updated, overrides: list };
    }
  }

  const created = normalizeOverrideEntry({
    id: mintOverrideId(),
    op: "add",
    rect: validRect,
    captionNumber,
    caption,
    allowDuplicate,
    createdAt: ts,
    updatedAt: ts,
  });
  list.push(created);
  return { ok: true, action: "add", override: created, overrides: list };
}

/**
 * Purely removes one matching override (or all overrides when `all: true` or
 * `overrideIdOrTarget === "*"`).
 */
export function removeOverride(overrides, overrideIdOrTarget, { autoRegions = [], all = false } = {}) {
  const list = Array.isArray(overrides)
    ? overrides.map(normalizeOverrideEntry).filter(Boolean)
    : [];
  if (all === true || overrideIdOrTarget === "*") {
    return { ok: true, removed: list, removedCount: list.length, overrides: [] };
  }

  if (overrideIdOrTarget == null) {
    return { ok: false, reason: "invalid-target", removed: [], removedCount: 0, overrides: list };
  }

  const removed = [];
  let remaining = list;

  const targetId =
    typeof overrideIdOrTarget === "string"
      ? overrideIdOrTarget.trim()
      : typeof overrideIdOrTarget?.overrideId === "string"
        ? overrideIdOrTarget.overrideId.trim()
        : typeof overrideIdOrTarget?.id === "string"
          ? overrideIdOrTarget.id.trim()
          : null;

  const auto = serializeAutoRegions(autoRegions);

  if (targetId) {
    const byId = list.filter((entry) => entry.id === targetId);
    if (byId.length) {
      const autoIndices = new Set();
      for (const entry of byId) {
        if (entry.op !== "add" && auto.length) {
          const idx = matchOverrideTarget(entry, auto);
          if (idx !== -1) autoIndices.add(idx);
        }
      }
      remaining = [];
      for (const entry of list) {
        if (entry.id === targetId) {
          removed.push(entry);
          continue;
        }
        const dupByAuto = entry.op !== "add" && auto.length && autoIndices.has(matchOverrideTarget(entry, auto));
        const dupByRef = entry.op !== "add" && byId.some((ref) => ref.op !== "add" && sameOverrideTarget(entry, ref));
        if (dupByAuto || dupByRef) {
          removed.push(entry);
        } else {
          remaining.push(entry);
        }
      }
      return { ok: true, removed, removedCount: removed.length, overrides: remaining };
    }
  }

  const descriptor = normalizeTargetDescriptor(overrideIdOrTarget, auto);
  if (descriptor) {
    const matchedAuto = matchOverrideTarget(descriptor, auto);
    remaining = [];
    for (const entry of list) {
      if (entryTargetsSameAutoFigure(entry, auto, { autoIndex: matchedAuto, reference: descriptor })) {
        removed.push(entry);
      } else {
        remaining.push(entry);
      }
    }
  }

  if (!removed.length && (Array.isArray(overrideIdOrTarget) || validateBBox(overrideIdOrTarget?.rect))) {
    const rect = validateBBox(Array.isArray(overrideIdOrTarget) ? overrideIdOrTarget : overrideIdOrTarget.rect);
    if (rect) {
      remaining = [];
      for (const entry of list) {
        if (entry.op === "add" && iou(entry.rect, rect) >= 0.9) {
          removed.push(entry);
        } else {
          remaining.push(entry);
        }
      }
    }
  }

  return { ok: true, removed, removedCount: removed.length, overrides: remaining };
}

function toPoint(point) {
  if (Array.isArray(point) || ArrayBuffer.isView(point)) {
    const x = Number(point[0]);
    const y = Number(point[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (point && typeof point === "object") {
    const x = Number(point.x ?? point[0]);
    const y = Number(point.y ?? point[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  return null;
}

function pointInRectWithTolerance(pt, rect, tol) {
  return (
    pt[0] >= rect[0] - tol &&
    pt[0] <= rect[2] + tol &&
    pt[1] >= rect[1] - tol &&
    pt[1] <= rect[3] + tol
  );
}

/**
 * Finds the best effective region containing a PDF user-space point.
 * Overlapping candidates prefer manual regions (`manual-add`, `manual-replace`)
 * over auto regions, then smaller bounding-box area.
 *
 * @param {number[]|{x:number,y:number}} point
 * @param {Array<object>} regions
 * @param {{tolerance?: number}} [options]
 * @returns {{region: object, index: number, rect: number[], isManual: boolean, area: number}|null}
 */
export function hitTestRegions(point, regions, { tolerance = 0 } = {}) {
  const pt = toPoint(point);
  if (!pt || !Array.isArray(regions) || !regions.length) return null;
  const tol = Math.max(0, Number.isFinite(Number(tolerance)) ? Number(tolerance) : 0);

  let best = null;
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const rect = validateBBox(region?.rect ?? region);
    if (!rect || !pointInRectWithTolerance(pt, rect, tol)) continue;
    const isManual =
      region?.origin === "manual-add" ||
      region?.origin === "manual-replace" ||
      Boolean(region?.manual || region?.overrideId);
    const area = rectArea(rect);
    if (!best) {
      best = { region, index: i, rect, isManual, area };
      continue;
    }
    if (isManual !== best.isManual) {
      if (isManual) best = { region, index: i, rect, isManual, area };
      continue;
    }
    if (area < best.area - 1e-6) {
      best = { region, index: i, rect, isManual, area };
      continue;
    }
    if (Math.abs(area - best.area) <= 1e-6) {
      const id = String(region?.id ?? "");
      const bestId = String(best.region?.id ?? "");
      if (id && (!bestId || id < bestId)) {
        best = { region, index: i, rect, isManual, area };
      }
    }
  }
  return best;
}

/**
 * Finds the suppressed region whose saved original bounding box contains `point`,
 * allowing right-click recovery of previously suppressed figures.
 *
 * @param {number[]|{x:number,y:number}} point
 * @param {{overrides?: Array<object>, autoRegions?: Array<object>, tolerance?: number}} [options]
 * @returns {{override: object, rect: number[], autoRegion: object|null, area: number}|null}
 */
export function findSuppressedTargetAtPoint(point, { overrides = [], autoRegions = [], tolerance = 0 } = {}) {
  const pt = toPoint(point);
  if (!pt || !Array.isArray(overrides) || !overrides.length) return null;
  const tol = Math.max(0, Number.isFinite(Number(tolerance)) ? Number(tolerance) : 0);
  const auto = serializeAutoRegions(autoRegions);

  let best = null;
  for (const raw of overrides) {
    const override = normalizeOverrideEntry(raw);
    if (!override || override.op !== "suppress") continue;
    const matchedIdx = auto.length ? matchOverrideTarget(override, auto) : -1;
    const autoRegion = matchedIdx !== -1 ? auto[matchedIdx] : null;
    const rect = validateBBox(override.targetOriginalRect) ?? (autoRegion ? [...autoRegion.rect] : null);
    if (!rect || !pointInRectWithTolerance(pt, rect, tol)) continue;
    const area = rectArea(rect);
    if (!best || area < best.area - 1e-6) {
      best = { override, rect, autoRegion, area };
    }
  }
  return best;
}

/**
 * Pure merge of auto-detected page regions with persisted manual overrides.
 * Never mutates either input array.
 *
 * Resolution rules:
 *   1. Match `suppress` and `replace` entries against `autoRegions` using
 *      stable region ID first, then caption/geometry fallback.
 *   2. Unmatched `suppress` entries remain in `unresolvedOverrides` without
 *      hiding unrelated figures on the page.
 *   3. Matched `replace` entries swap the target bounding box; unmatched
 *      `replace` entries still render their saved manual bounding box
 *      independently (while also recording in `unresolvedOverrides` for
 *      diagnostics) and supersede any duplicate automatic box.
 *   4. Manual `add` regions always take priority over automatic regions
 *      (`Manual Region > Automatic Region`): if an automatic region overlaps
 *      with `iou >= 0.85`, remove the redundant automatic box and keep the
 *      exact manual bounding box and metadata. Distinct manual regions are
 *      never merged or dropped.
 *
 * @param {Array<object>|null|undefined} autoRegions
 * @param {Array<object>|null|undefined} overrides
 * @returns {{
 *   regions: Array<object>,
 *   unresolvedOverrides: Array<object>,
 *   matchedOverrideIds: string[],
 *   suppressedRegionIds: string[],
 *   replacedRegionIds: string[],
 *   fallbackReplaceIds: string[],
 *   addedOverrideIds: string[],
 *   supersededAutoIds: string[],
 *   dedupedAddIds: string[]
 * }}
 */
export function resolveEffectiveRegions(autoRegions, overrides) {
  const normalizedAuto = serializeAutoRegions(autoRegions).map((region) => ({
    ...region,
    origin: "auto",
  }));
  const normalizedOverrides = Array.isArray(overrides)
    ? overrides.map(normalizeOverrideEntry).filter(Boolean)
    : [];

  const states = new Map();
  const unresolvedOverrides = [];
  const unmatchedReplaceOverrides = [];
  const matchedOverrideIds = [];
  const addOverrides = [];

  for (const override of normalizedOverrides) {
    if (override.op === "add") {
      addOverrides.push(override);
      continue;
    }
    const targetIdx = matchOverrideTarget(override, normalizedAuto);
    if (targetIdx === -1) {
      unresolvedOverrides.push({ ...override });
      if (override.op === "replace") {
        unmatchedReplaceOverrides.push(override);
      }
      continue;
    }
    matchedOverrideIds.push(override.id);
    if (override.op === "suppress") {
      states.set(targetIdx, { op: "suppress", override });
    } else if (override.op === "replace") {
      states.set(targetIdx, { op: "replace", override, rect: [...override.rect] });
    }
  }

  let regions = [];
  const suppressedRegionIds = [];
  const replacedRegionIds = [];

  for (let i = 0; i < normalizedAuto.length; i += 1) {
    const base = normalizedAuto[i];
    const state = states.get(i);
    if (state?.op === "suppress") {
      suppressedRegionIds.push(base.id);
      continue;
    }
    if (state?.op === "replace") {
      replacedRegionIds.push(base.id);
      const sourceKinds = base.sourceKinds.includes("manual")
        ? [...base.sourceKinds]
        : [...base.sourceKinds, "manual"];
      regions.push({
        ...base,
        rect: [...state.rect],
        originalRect: [...base.rect],
        origin: "manual-replace",
        overrideId: state.override.id,
        sourceKinds,
      });
      continue;
    }
    regions.push({
      ...base,
      rect: [...base.rect],
      sourceKinds: [...base.sourceKinds],
    });
  }

  const supersededAutoIds = [];
  const dropDuplicateAuto = (manualRect) => {
    const remaining = [];
    for (const existing of regions) {
      if (existing.origin === "auto" && iou(existing.rect, manualRect) >= 0.85) {
        supersededAutoIds.push(existing.id);
        continue;
      }
      remaining.push(existing);
    }
    regions = remaining;
  };

  const fallbackReplaceIds = [];
  for (const rep of unmatchedReplaceOverrides) {
    dropDuplicateAuto(rep.rect);
    fallbackReplaceIds.push(rep.id);
    regions.push({
      id: rep.id,
      overrideId: rep.id,
      rect: [...rep.rect],
      originalRect: rep.targetOriginalRect ? [...rep.targetOriginalRect] : null,
      captionNumber: rep.targetCaptionNumber ?? null,
      caption: null,
      kind: "manual",
      sourceKinds: ["manual"],
      confidence: 1,
      origin: "manual-replace",
      unresolvedTarget: true,
    });
  }

  const addedOverrideIds = [];
  const dedupedAddIds = [];
  for (const add of addOverrides) {
    if (add.allowDuplicate !== true) {
      dropDuplicateAuto(add.rect);
    }
    addedOverrideIds.push(add.id);
    regions.push({
      id: add.id,
      overrideId: add.id,
      rect: [...add.rect],
      captionNumber: add.captionNumber ?? null,
      caption: add.caption ?? null,
      kind: "manual",
      sourceKinds: ["manual"],
      confidence: 1,
      origin: "manual-add",
    });
  }

  return {
    regions,
    unresolvedOverrides,
    matchedOverrideIds,
    suppressedRegionIds,
    replacedRegionIds,
    fallbackReplaceIds,
    addedOverrideIds,
    supersededAutoIds,
    dedupedAddIds,
  };
}
