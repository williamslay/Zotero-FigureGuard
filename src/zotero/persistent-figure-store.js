/**
 * Per-attachment persistent storage for auto-detected figure bounding boxes
 * and user manual overrides.
 *
 * Storage layout (inside Zotero's data directory):
 *   <Zotero Data Directory>/figureguard/cache/item-<attachmentItemID>.json
 *
 * Design invariants:
 *   - Never writes to the XPI, extension install directory, or PDF file.
 *   - Never keys disk cache by PDF fingerprint alone: attachment item ID is
 *     required, and provisional WeakMap ids (`fcp:doc-N`) are never persisted.
 *   - Serializes mutations per attachment and commits atomically via temp file.
 *   - Deduplicates concurrent loads per attachment during multi-page startup.
 */

import {
  DETECTOR_CACHE_REVISION,
  PERSISTENT_SCHEMA_VERSION,
  appendAddOverride,
  normalizeOverrideEntry,
  removeOverride,
  resolveEffectiveRegions,
  serializeAutoRegions,
  upsertReplaceOverride,
  upsertSuppressOverride,
  validateBBox,
} from "../core/region-overrides.js";
import { isProvisionalDocumentId, warnOnce } from "./overlay.js";

const SAFE_ITEM_ID_RE = /^[A-Za-z0-9_-]+$/;
const PROVISIONAL_RAW_RE = /^fcp:doc-\d+$/i;

function defaultJoinPath(...parts) {
  const cleaned = parts.filter((p) => typeof p === "string" && p.length > 0);
  if (!cleaned.length) return "";
  if (globalThis.PathUtils && typeof globalThis.PathUtils.join === "function") {
    try {
      return globalThis.PathUtils.join(...cleaned);
    } catch {
      // Fall back to pure join below when PathUtils rejects mocked paths.
    }
  }
  const sep = cleaned[0].includes("\\") && !cleaned[0].includes("/") ? "\\" : "/";
  let acc = cleaned[0].replace(/[\\/]+$/, "");
  if (!acc && (cleaned[0].startsWith("/") || cleaned[0].startsWith("\\"))) acc = sep;
  for (let i = 1; i < cleaned.length; i += 1) {
    const seg = cleaned[i].replace(/^[\\/]+|[\\/]+$/g, "");
    if (!seg) continue;
    acc = acc === sep ? `${acc}${seg}` : `${acc}${sep}${seg}`;
  }
  return acc;
}

function defaultDirname(filePath) {
  if (typeof filePath !== "string" || !filePath) return "";
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : "";
}

function createGeckoIO() {
  return {
    joinPath: (...parts) => defaultJoinPath(...parts),
    async exists(filePath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.exists !== "function") return false;
      return Boolean(await io.exists(filePath));
    },
    async readUTF8(filePath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.readUTF8 !== "function") {
        throw new Error("IOUtils.readUTF8 is unavailable");
      }
      return String(await io.readUTF8(filePath));
    },
    async makeDirectory(dirPath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.makeDirectory !== "function") {
        throw new Error("IOUtils.makeDirectory is unavailable");
      }
      await io.makeDirectory(dirPath, { createAncestors: true, ignoreExisting: true });
    },
    async writeUTF8Atomic(filePath, content, tmpPath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.writeUTF8 !== "function") {
        throw new Error("IOUtils.writeUTF8 is unavailable");
      }
      await io.writeUTF8(filePath, content, tmpPath ? { tmpPath } : undefined);
    },
    async move(srcPath, destPath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.move !== "function") {
        throw new Error("IOUtils.move is unavailable");
      }
      await io.move(srcPath, destPath);
    },
    async stat(filePath) {
      const io = globalThis.IOUtils;
      if (!io || typeof io.stat !== "function") return null;
      const info = await io.stat(filePath);
      if (!info) return null;
      const size = Number(info.size);
      const mtimeMs = Number(info.lastModified ?? info.mtimeMs ?? info.mtime);
      return {
        size: Number.isFinite(size) && size >= 0 ? size : null,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      };
    },
    isAvailable() {
      const io = globalThis.IOUtils;
      return Boolean(io && typeof io.readUTF8 === "function" && typeof io.writeUTF8 === "function");
    },
  };
}

function normalizeOptionalSize(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function normalizeOptionalMtime(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Validates and canonicalizes an attachment document identity.
 * Returns `null` when attachment identity is absent, malformed, or uses a
 * provisional runtime key (`fcp:doc-N`) so it is never persisted to disk.
 *
 * @param {object|null|undefined} input
 * @returns {{
 *   attachmentItemID: number|string,
 *   storageKey: string,
 *   fingerprint: string,
 *   fileSize: number|null,
 *   fileMtime: number|null
 * }|null}
 */
export function normalizeAttachmentIdentity(input) {
  if (!input || typeof input !== "object") return null;
  if (input.provisional === true) return null;

  const rawItem = input.attachmentItemID ?? input.itemID ?? null;
  if (rawItem === null || rawItem === undefined || typeof rawItem === "boolean" || typeof rawItem === "object") {
    return null;
  }

  let attachmentItemID;
  if (typeof rawItem === "number") {
    if (!Number.isSafeInteger(rawItem) || rawItem < 0) return null;
    attachmentItemID = rawItem;
  } else {
    const trimmed = String(rawItem).trim();
    if (!trimmed || !SAFE_ITEM_ID_RE.test(trimmed)) return null;
    attachmentItemID = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
  }

  const rawFp = input.fingerprint ?? input.docId ?? null;
  if (typeof rawFp !== "string") return null;
  const trimmedFp = rawFp.trim();
  if (!trimmedFp || isProvisionalDocumentId(trimmedFp) || PROVISIONAL_RAW_RE.test(trimmedFp)) {
    return null;
  }
  const fingerprint = trimmedFp.startsWith("fcp:") ? trimmedFp.slice(4).trim() : trimmedFp;
  if (!fingerprint) return null;

  return {
    attachmentItemID,
    storageKey: String(attachmentItemID),
    fingerprint,
    fileSize: normalizeOptionalSize(input.fileSize),
    fileMtime: normalizeOptionalMtime(input.fileMtime),
  };
}

/**
 * Resolves `{ attachmentItemID, fingerprint, fileSize, fileMtime }` from a
 * live Zotero reader/document pair when available. Never throws.
 *
 * @param {object} input
 * @param {object|null} [input.reader]
 * @param {object|null} [input.pdfDocument]
 * @param {string|null} [input.docId]
 * @param {number|string|null} [input.itemID]
 * @param {object|null} [input.zotero]
 * @param {object|null} [input.io]
 * @param {boolean} [input.includeFileStat]
 * @returns {Promise<ReturnType<typeof normalizeAttachmentIdentity>>}
 */
export async function resolveAttachmentIdentity({
  reader = null,
  pdfDocument = null,
  docId = null,
  itemID = null,
  zotero = globalThis.Zotero ?? null,
  io = null,
  includeFileStat = true,
} = {}) {
  const rawItem = itemID ?? reader?.itemID ?? null;
  let fingerprint = null;
  let runtimeTaskId = null;
  let inspectablePdfDoc = Boolean(pdfDocument);
  try {
    const fp = pdfDocument?.fingerprints?.[0];
    if (typeof fp === "string" && fp.trim()) {
      fingerprint = fp.trim();
    }
    const taskId = pdfDocument?.loadingTask?.docId ?? pdfDocument?._pdfDocument?.docId;
    if (typeof taskId === "string" && taskId.trim()) {
      runtimeTaskId = taskId.trim();
    }
  } catch {
    // Xray wrapper prevented direct property read; only allow non-ephemeral docId fallback below.
    inspectablePdfDoc = false;
  }
  if (!fingerprint && !inspectablePdfDoc && typeof docId === "string") {
    const rawDoc = docId.trim();
    const cleaned = rawDoc.startsWith("fcp:") ? rawDoc.slice(4).trim() : rawDoc;
    if (cleaned && cleaned !== runtimeTaskId && !/^d\d+$/.test(cleaned)) {
      fingerprint = rawDoc;
    }
  }

  const base = normalizeAttachmentIdentity({
    attachmentItemID: rawItem,
    fingerprint,
  });
  if (!base) return null;

  if (!includeFileStat || !zotero?.Items) return base;

  try {
    const itemsAPI = zotero.Items;
    const item =
      typeof itemsAPI.getAsync === "function"
        ? await itemsAPI.getAsync(base.attachmentItemID)
        : typeof itemsAPI.get === "function"
          ? itemsAPI.get(base.attachmentItemID)
          : null;
    if (!item) return base;

    const filePath =
      typeof item.getFilePathAsync === "function"
        ? await item.getFilePathAsync()
        : typeof item.getFilePath === "function"
          ? item.getFilePath()
          : null;
    if (typeof filePath !== "string" || !filePath) return base;

    const statReader = io ?? createGeckoIO();
    const stats = typeof statReader.stat === "function" ? await statReader.stat(filePath) : null;
    if (!stats) return base;

    return {
      ...base,
      fileSize: normalizeOptionalSize(stats.size),
      fileMtime: normalizeOptionalMtime(stats.mtimeMs ?? stats.lastModified),
    };
  } catch {
    return base;
  }
}

/**
 * Checks whether an on-disk `document` descriptor still describes the same
 * underlying PDF file as `currentIdentity`.
 *
 * @param {object|null|undefined} storedDoc
 * @param {ReturnType<typeof normalizeAttachmentIdentity>} currentIdentity
 * @returns {boolean}
 */
export function documentMatches(storedDoc, currentIdentity) {
  if (!storedDoc || typeof storedDoc !== "object" || !currentIdentity) return false;
  if (String(storedDoc.attachmentItemID) !== currentIdentity.storageKey) return false;
  if (String(storedDoc.fingerprint ?? "") !== currentIdentity.fingerprint) return false;

  const oldSize = normalizeOptionalSize(storedDoc.fileSize);
  const newSize = currentIdentity.fileSize;
  if (oldSize !== null && newSize !== null && oldSize !== newSize) {
    return false;
  }

  const oldMtime = normalizeOptionalMtime(storedDoc.fileMtime);
  const newMtime = currentIdentity.fileMtime;
  if (oldMtime !== null && newMtime !== null && Math.abs(oldMtime - newMtime) > 1) {
    return false;
  }

  return true;
}

function normalizePageNumberKey(pageNumber) {
  const n = Number(pageNumber);
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

function createFreshRecord(identity, { archivedOverrides = [] } = {}) {
  return {
    schemaVersion: PERSISTENT_SCHEMA_VERSION,
    document: {
      attachmentItemID: identity.attachmentItemID,
      fingerprint: identity.fingerprint,
      fileSize: identity.fileSize,
      fileMtime: identity.fileMtime,
    },
    autoCache: {
      detectorRevision: DETECTOR_CACHE_REVISION,
      pages: {},
    },
    manualOverrides: {
      pages: {},
    },
    ...(archivedOverrides.length ? { archivedOverrides } : {}),
  };
}

function normalizeAutoPageEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.complete !== true || !Array.isArray(entry.regions)) return null;
  const serialized = [];
  const seenIds = new Set();
  for (let i = 0; i < entry.regions.length; i += 1) {
    const raw = entry.regions[i];
    if (!raw || typeof raw !== "object" || !validateBBox(raw.rect)) {
      return null;
    }
    const clean = serializeAutoRegions([raw])[0];
    if (!clean) return null;
    if (seenIds.has(clean.id)) {
      clean.id = `${clean.id}#${i + 1}`;
    }
    seenIds.add(clean.id);
    serialized.push(clean);
  }
  return {
    complete: true,
    updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt ? entry.updatedAt : null,
    regions: serialized,
  };
}

function normalizeManualPages(rawPages) {
  const out = {};
  if (!rawPages || typeof rawPages !== "object") return out;
  for (const [key, list] of Object.entries(rawPages)) {
    const pageKey = normalizePageNumberKey(key);
    if (!pageKey || !Array.isArray(list)) continue;
    const valid = list.map(normalizeOverrideEntry).filter(Boolean);
    if (valid.length) out[pageKey] = valid;
  }
  return out;
}

function normalizeArchivedList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const pages = normalizeManualPages(item.pages);
    if (!Object.keys(pages).length) continue;
    out.push({
      archivedAt: typeof item.archivedAt === "string" ? item.archivedAt : null,
      reason: typeof item.reason === "string" ? item.reason : "document-replaced",
      document: item.document && typeof item.document === "object" ? { ...item.document } : null,
      pages,
    });
  }
  return out;
}

function sameAutoRegions(aList, bList) {
  if (!Array.isArray(aList) || !Array.isArray(bList) || aList.length !== bList.length) {
    return false;
  }
  for (let i = 0; i < aList.length; i += 1) {
    const a = aList[i];
    const b = bList[i];
    if (!a || !b) return false;
    if (a.id !== b.id || a.captionNumber !== b.captionNumber || a.caption !== b.caption || a.kind !== b.kind) {
      return false;
    }
    for (let k = 0; k < 4; k += 1) {
      if (a.rect[k] !== b.rect[k]) return false;
    }
    const ak = a.sourceKinds ?? [];
    const bk = b.sourceKinds ?? [];
    if (ak.length !== bk.length) return false;
    for (let k = 0; k < ak.length; k += 1) {
      if (ak[k] !== bk[k]) return false;
    }
  }
  return true;
}

function identitySignature(identity) {
  return `${identity.storageKey}|${identity.fingerprint}|${identity.fileSize ?? ""}|${identity.fileMtime ?? ""}`;
}

function clonePageOverrides(record, pageKey) {
  const list = record?.manualOverrides?.pages?.[pageKey];
  return Array.isArray(list) ? list.map((item) => ({ ...item, ...(item.rect ? { rect: [...item.rect] } : {}) })) : [];
}

/**
 * Persistent JSON store for per-attachment figure bounding boxes and manual
 * overrides. Safe to instantiate in both Zotero/Gecko and pure Node tests.
 */
export class PersistentFigureStore {
  /**
   * @param {object} [options]
   * @param {string|(() => string|null)|null} [options.dataDir]
   * @param {object|null} [options.io]
   * @param {() => string} [options.now]
   * @param {number} [options.detectorRevision] Defaults to `DETECTOR_CACHE_REVISION`.
   */
  constructor(options = {}) {
    this.dataDirOption = options.dataDir ?? null;
    this.io = options.io ?? createGeckoIO();
    this.now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
    this.detectorRevision = Number.isInteger(options.detectorRevision)
      ? options.detectorRevision
      : DETECTOR_CACHE_REVISION;
    /** @type {Map<string, object>} storageKey -> per-attachment runtime state */
    this.entries = new Map();
    this.tmpCounter = 0;
    this.closed = false;
    this.abortQueuedWrites = false;
  }

  resolveDataDir() {
    if (typeof this.dataDirOption === "function") {
      try {
        const val = this.dataDirOption();
        return typeof val === "string" && val.trim() ? val.trim() : null;
      } catch {
        return null;
      }
    }
    if (typeof this.dataDirOption === "string" && this.dataDirOption.trim()) {
      return this.dataDirOption.trim();
    }
    try {
      const dir = globalThis.Zotero?.DataDirectory?.dir;
      return typeof dir === "string" && dir.trim() ? dir.trim() : null;
    } catch {
      return null;
    }
  }

  getCacheDir() {
    const base = this.resolveDataDir();
    if (!base) return null;
    return this.io.joinPath(base, "figureguard", "cache");
  }

  getFilePath(attachmentItemID) {
    const dir = this.getCacheDir();
    if (!dir) return null;
    if (attachmentItemID === null || attachmentItemID === undefined) return null;
    const raw = String(attachmentItemID).trim();
    if (!raw || !SAFE_ITEM_ID_RE.test(raw)) return null;
    return this.io.joinPath(dir, `item-${raw}.json`);
  }

  hasWritableStorage() {
    if (!this.resolveDataDir()) return false;
    if (typeof this.io?.isAvailable === "function") return this.io.isAvailable();
    return Boolean(this.io && typeof this.io.readUTF8 === "function" && typeof this.io.writeUTF8Atomic === "function");
  }

  getEntry(storageKey) {
    let entry = this.entries.get(storageKey);
    if (!entry) {
      entry = {
        storageKey,
        record: null,
        loadedSig: null,
        existsOnDisk: false,
        schemaLocked: false,
        writeBlocked: false,
        writeBlockedReason: null,
        autoEpoch: 1,
        overrideVersion: 1,
        loadPromise: null,
        loadPromiseSig: null,
        writeQueue: Promise.resolve(),
        dirtyReset: false,
        lastLoadStatus: "unloaded",
      };
      this.entries.set(storageKey, entry);
    }
    return entry;
  }

  /**
   * Stops accepting new disk operations and waits for in-flight write queues
   * to settle (used by shutdown and uninstall cleanup).
   *
   * @param {{abortQueuedWrites?: boolean}} [options]
   * @returns {Promise<void>}
   */
  close({ abortQueuedWrites = false } = {}) {
    this.closed = true;
    if (abortQueuedWrites) {
      this.abortQueuedWrites = true;
    }
    const queues = [];
    for (const entry of this.entries.values()) {
      queues.push(entry.writeQueue.catch(() => {}));
    }
    return Promise.allSettled(queues).then(() => undefined);
  }

  /**
   * Synchronous check used by live `RegionCache` consumers to detect whether
   * overrides or auto-cache epochs changed since the cache entry was stored.
   */
  getVersionsSync(identityInput) {
    const identity = normalizeAttachmentIdentity(identityInput);
    if (!identity) return null;
    const entry = this.entries.get(identity.storageKey);
    if (!entry) return null;
    return {
      autoEpoch: entry.autoEpoch,
      overrideVersion: entry.overrideVersion,
      schemaLocked: entry.schemaLocked,
    };
  }

  /**
   * Synchronous lookup for active `autoEpoch` before launching async detection.
   */
  getAutoEpoch(identityInput) {
    const identity = normalizeAttachmentIdentity(identityInput);
    if (!identity) return null;
    return this.getEntry(identity.storageKey).autoEpoch;
  }

  async backupCorruptFile(filePath, attachmentKey) {
    if (!filePath || typeof this.io?.move !== "function") {
      return { ok: false, error: "IOUtils.move is unavailable" };
    }
    try {
      const dir = defaultDirname(filePath);
      this.tmpCounter += 1;
      const stamp = `${Date.now().toString(36)}-${this.tmpCounter}`;
      const backupPath = dir
        ? this.io.joinPath(dir, `item-${attachmentKey}.corrupt-${stamp}.json`)
        : `${filePath}.corrupt-${stamp}`;
      await this.io.move(filePath, backupPath);
      return { ok: true, backupPath };
    } catch (err) {
      warnOnce("persistent-corrupt-backup", err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  shouldRetryDiskLoad(entry) {
    if (!entry) return true;
    if (entry.lastLoadStatus === "no-storage") return this.hasWritableStorage();
    return (
      entry.lastLoadStatus === "exists-failed" ||
      entry.lastLoadStatus === "read-failed" ||
      entry.lastLoadStatus === "corrupt-backup-failed"
    );
  }

  async handleCorruptDiskFile(entry, identity, filePath, sig, err) {
    warnOnce("persistent-corrupt-json", err);
    const backup = await this.backupCorruptFile(filePath, identity.storageKey);
    if (backup.ok) {
      entry.record = createFreshRecord(identity);
      entry.record.autoCache.detectorRevision = this.detectorRevision;
      entry.loadedSig = sig;
      entry.existsOnDisk = false;
      entry.schemaLocked = false;
      entry.writeBlocked = false;
      entry.writeBlockedReason = null;
      entry.dirtyReset = false;
      entry.lastLoadStatus = "corrupt";
      return entry.lastLoadStatus;
    }
    if (!entry.record || !documentMatches(entry.record.document, identity)) {
      entry.record = createFreshRecord(identity);
      entry.record.autoCache.detectorRevision = this.detectorRevision;
    }
    entry.loadedSig = sig;
    entry.existsOnDisk = true;
    entry.schemaLocked = false;
    entry.writeBlocked = true;
    entry.writeBlockedReason = "corrupt-backup-failed";
    entry.dirtyReset = false;
    entry.lastLoadStatus = "corrupt-backup-failed";
    return entry.lastLoadStatus;
  }

  async writeRecordToDisk(entry, filePath, record) {
    if (this.abortQueuedWrites) {
      return { ok: false, persisted: false, reason: "store-closed" };
    }
    if (entry.writeBlocked || entry.schemaLocked) {
      return {
        ok: false,
        persisted: false,
        reason: entry.writeBlockedReason || "incompatible-schema-version",
      };
    }
    if (!filePath || !this.hasWritableStorage()) {
      return { ok: false, persisted: false, reason: "no-storage" };
    }
    const cacheDir = defaultDirname(filePath);
    this.tmpCounter += 1;
    const tmpPath = `${filePath}.tmp-${Date.now().toString(36)}-${this.tmpCounter}`;
    const payload = JSON.stringify(record, null, 2);
    try {
      if (this.abortQueuedWrites) {
        return { ok: false, persisted: false, reason: "store-closed" };
      }
      if (cacheDir && typeof this.io.makeDirectory === "function") {
        await this.io.makeDirectory(cacheDir);
      }
      if (this.abortQueuedWrites) {
        return { ok: false, persisted: false, reason: "store-closed" };
      }
      await this.io.writeUTF8Atomic(filePath, payload, tmpPath);
      entry.existsOnDisk = true;
      entry.dirtyReset = false;
      return { ok: true, persisted: true };
    } catch (err) {
      warnOnce("persistent-write", err);
      return {
        ok: false,
        persisted: false,
        reason: "write-failed",
        error: err?.message ?? String(err),
      };
    }
  }

  async readAndPrepareFromDisk(entry, identity) {
    const filePath = this.getFilePath(identity.attachmentItemID);
    const sig = identitySignature(identity);

    if (!filePath || !this.hasWritableStorage()) {
      if (!entry.record || !documentMatches(entry.record.document, identity)) {
        entry.record = createFreshRecord(identity);
        entry.record.autoCache.detectorRevision = this.detectorRevision;
      }
      entry.loadedSig = sig;
      entry.existsOnDisk = false;
      entry.schemaLocked = false;
      entry.writeBlocked = false;
      entry.writeBlockedReason = null;
      entry.dirtyReset = false;
      entry.lastLoadStatus = "no-storage";
      return entry.lastLoadStatus;
    }

    let exists = false;
    try {
      exists = await this.io.exists(filePath);
    } catch (err) {
      warnOnce("persistent-exists", err);
      if (!entry.record || !documentMatches(entry.record.document, identity)) {
        entry.record = createFreshRecord(identity);
        entry.record.autoCache.detectorRevision = this.detectorRevision;
      }
      entry.loadedSig = sig;
      entry.existsOnDisk = true;
      entry.schemaLocked = false;
      entry.writeBlocked = true;
      entry.writeBlockedReason = "exists-check-failed";
      entry.dirtyReset = false;
      entry.lastLoadStatus = "exists-failed";
      return entry.lastLoadStatus;
    }

    if (!exists) {
      entry.record = createFreshRecord(identity);
      entry.record.autoCache.detectorRevision = this.detectorRevision;
      entry.loadedSig = sig;
      entry.existsOnDisk = false;
      entry.schemaLocked = false;
      entry.writeBlocked = false;
      entry.writeBlockedReason = null;
      entry.dirtyReset = false;
      entry.lastLoadStatus = "missing";
      return entry.lastLoadStatus;
    }

    let rawText = "";
    try {
      rawText = await this.io.readUTF8(filePath);
    } catch (err) {
      warnOnce("persistent-read", err);
      if (!entry.record || !documentMatches(entry.record.document, identity)) {
        entry.record = createFreshRecord(identity);
        entry.record.autoCache.detectorRevision = this.detectorRevision;
      }
      entry.loadedSig = sig;
      entry.existsOnDisk = true;
      entry.schemaLocked = false;
      entry.writeBlocked = true;
      entry.writeBlockedReason = "read-failed";
      entry.dirtyReset = false;
      entry.lastLoadStatus = "read-failed";
      return entry.lastLoadStatus;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      return this.handleCorruptDiskFile(entry, identity, filePath, sig, err);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return this.handleCorruptDiskFile(
        entry,
        identity,
        filePath,
        sig,
        new Error(`Invalid persistent JSON envelope for item ${identity.storageKey}`),
      );
    }

    if (parsed.schemaVersion !== PERSISTENT_SCHEMA_VERSION) {
      warnOnce(
        "persistent-schema-version",
        new Error(`Unsupported persistent schemaVersion=${parsed.schemaVersion} for item ${identity.storageKey}`),
      );
      entry.record = createFreshRecord(identity);
      entry.record.autoCache.detectorRevision = this.detectorRevision;
      entry.loadedSig = sig;
      entry.existsOnDisk = true;
      entry.schemaLocked = true;
      entry.writeBlocked = true;
      entry.writeBlockedReason = "incompatible-schema-version";
      entry.dirtyReset = false;
      entry.lastLoadStatus = "incompatible-schema";
      return entry.lastLoadStatus;
    }

    const wasWriteBlocked = entry.writeBlocked;
    entry.schemaLocked = false;
    entry.writeBlocked = false;
    entry.writeBlockedReason = null;
    entry.existsOnDisk = true;

    const storedDoc = parsed.document && typeof parsed.document === "object" ? parsed.document : null;
    const archivedOverrides = normalizeArchivedList(parsed.archivedOverrides);
    const storedManualPages = normalizeManualPages(parsed.manualOverrides?.pages);

    if (!documentMatches(storedDoc, identity)) {
      const nextArchived = [...archivedOverrides];
      if (Object.keys(storedManualPages).length) {
        nextArchived.push({
          archivedAt: this.now(),
          reason: "document-replaced",
          document: storedDoc ? { ...storedDoc } : null,
          pages: storedManualPages,
        });
      }
      entry.record = createFreshRecord(identity, { archivedOverrides: nextArchived });
      entry.record.autoCache.detectorRevision = this.detectorRevision;
      entry.loadedSig = sig;
      entry.autoEpoch += 1;
      entry.overrideVersion += 1;
      entry.dirtyReset = true;
      entry.lastLoadStatus = "document-replaced";
      return entry.lastLoadStatus;
    }

    const mergedDoc = {
      attachmentItemID: identity.attachmentItemID,
      fingerprint: identity.fingerprint,
      fileSize: identity.fileSize ?? normalizeOptionalSize(storedDoc?.fileSize),
      fileMtime: identity.fileMtime ?? normalizeOptionalMtime(storedDoc?.fileMtime),
    };

    const diskRevision = Number(parsed.autoCache?.detectorRevision);
    if (diskRevision !== this.detectorRevision) {
      const hadAutoPages = Object.keys(parsed.autoCache?.pages ?? {}).length > 0;
      entry.record = {
        schemaVersion: PERSISTENT_SCHEMA_VERSION,
        document: mergedDoc,
        autoCache: {
          detectorRevision: this.detectorRevision,
          pages: {},
        },
        manualOverrides: {
          pages: storedManualPages,
        },
        ...(archivedOverrides.length ? { archivedOverrides } : {}),
      };
      entry.loadedSig = sig;
      entry.autoEpoch += 1;
      if (wasWriteBlocked) entry.overrideVersion += 1;
      entry.dirtyReset = hadAutoPages;
      entry.lastLoadStatus = "detector-revision-mismatch";
      return entry.lastLoadStatus;
    }

    const validAutoPages = {};
    const rawAutoPages = parsed.autoCache?.pages;
    if (rawAutoPages && typeof rawAutoPages === "object") {
      for (const [rawPage, pageEntry] of Object.entries(rawAutoPages)) {
        const pageKey = normalizePageNumberKey(rawPage);
        if (!pageKey) continue;
        const normalized = normalizeAutoPageEntry(pageEntry);
        if (normalized) validAutoPages[pageKey] = normalized;
      }
    }

    entry.record = {
      schemaVersion: PERSISTENT_SCHEMA_VERSION,
      document: mergedDoc,
      autoCache: {
        detectorRevision: this.detectorRevision,
        pages: validAutoPages,
      },
      manualOverrides: {
        pages: storedManualPages,
      },
      ...(archivedOverrides.length ? { archivedOverrides } : {}),
    };
    if (wasWriteBlocked) {
      entry.overrideVersion += 1;
      entry.autoEpoch += 1;
    }
    entry.loadedSig = sig;
    entry.dirtyReset = false;
    entry.lastLoadStatus = "loaded";
    return entry.lastLoadStatus;
  }

  /**
   * Ensures the per-attachment record is loaded (deduplicating concurrent reads
   * per attachment and handling mid-session document replacement cleanly).
   */
  async ensureLoaded(identityInput) {
    if (this.closed) return null;
    const identity = normalizeAttachmentIdentity(identityInput);
    if (!identity) return null;

    const entry = this.getEntry(identity.storageKey);
    const sig = identitySignature(identity);

    if (entry.record && !this.shouldRetryDiskLoad(entry) && entry.loadedSig === sig) {
      return { entry, identity, status: entry.lastLoadStatus };
    }

    if (
      entry.record &&
      !this.shouldRetryDiskLoad(entry) &&
      !entry.schemaLocked &&
      documentMatches(entry.record.document, identity)
    ) {
      if (identity.fileSize !== null && entry.record.document.fileSize === null) {
        entry.record.document.fileSize = identity.fileSize;
      }
      if (identity.fileMtime !== null && entry.record.document.fileMtime === null) {
        entry.record.document.fileMtime = identity.fileMtime;
      }
      entry.loadedSig = sig;
      return { entry, identity, status: entry.lastLoadStatus };
    }

    if (entry.loadPromise && entry.loadPromiseSig === sig) {
      await entry.loadPromise;
      return { entry, identity, status: entry.lastLoadStatus };
    }

    const pendingWrites = entry.writeQueue;
    const run = (async () => {
      try {
        await pendingWrites.catch(() => {});
      } catch {
        // Previous write failure never blocks subsequent reads.
      }
      if (this.closed) return entry.lastLoadStatus;
      // Re-check whether an earlier write operation already loaded/migrated this doc.
      if (entry.record && !this.shouldRetryDiskLoad(entry) && entry.loadedSig === sig) {
        return entry.lastLoadStatus;
      }
      if (
        entry.record &&
        !this.shouldRetryDiskLoad(entry) &&
        !entry.schemaLocked &&
        documentMatches(entry.record.document, identity)
      ) {
        entry.loadedSig = sig;
        return entry.lastLoadStatus;
      }
      return this.readAndPrepareFromDisk(entry, identity);
    })();

    entry.loadPromise = run;
    entry.loadPromiseSig = sig;
    try {
      const status = await run;
      return { entry, identity, status };
    } finally {
      if (entry.loadPromise === run) {
        entry.loadPromise = null;
        entry.loadPromiseSig = null;
      }
    }
  }

  enqueueMutation(identityInput, mutator) {
    if (this.closed) {
      return Promise.resolve({ ok: false, persisted: false, reason: "store-closed" });
    }
    const identity = normalizeAttachmentIdentity(identityInput);
    if (!identity) {
      return Promise.resolve({ ok: false, persisted: false, reason: "invalid-identity" });
    }
    const entry = this.getEntry(identity.storageKey);
    const sig = identitySignature(identity);

    const run = entry.writeQueue
      .catch(() => {})
      .then(async () => {
        if (this.abortQueuedWrites) {
          return { ok: false, persisted: false, reason: "store-closed" };
        }
        if (
          !entry.record ||
          this.shouldRetryDiskLoad(entry) ||
          !documentMatches(entry.record.document, identity) ||
          (entry.schemaLocked && entry.loadedSig !== sig)
        ) {
          await this.readAndPrepareFromDisk(entry, identity);
        } else if (entry.loadedSig !== sig) {
          if (identity.fileSize !== null && entry.record.document.fileSize === null) {
            entry.record.document.fileSize = identity.fileSize;
          }
          if (identity.fileMtime !== null && entry.record.document.fileMtime === null) {
            entry.record.document.fileMtime = identity.fileMtime;
          }
          entry.loadedSig = sig;
        }
        if (this.abortQueuedWrites) {
          return { ok: false, persisted: false, reason: "store-closed" };
        }
        return mutator(entry, identity);
      });

    entry.writeQueue = run.catch(() => {});
    return run;
  }

  /**
   * Loads the full normalized document record and flushes pending migration
   * state (such as archiving replaced-PDF manual overrides) if needed.
   */
  async loadDocument(identityInput) {
    const loaded = await this.ensureLoaded(identityInput);
    if (!loaded) {
      return { status: "invalid-identity", persisted: false, record: null };
    }
    const { entry, identity, status } = loaded;
    let persisted = entry.existsOnDisk && !entry.dirtyReset && !entry.schemaLocked && !entry.writeBlocked;

    if (entry.dirtyReset && !entry.schemaLocked && !entry.writeBlocked) {
      const flushResult = await this.enqueueMutation(identity, async (liveEntry, liveId) => {
        if (!liveEntry.dirtyReset) return { ok: true, persisted: liveEntry.existsOnDisk };
        const filePath = this.getFilePath(liveId.attachmentItemID);
        return this.writeRecordToDisk(liveEntry, filePath, liveEntry.record);
      });
      persisted = Boolean(flushResult?.persisted);
    }

    return {
      status,
      persisted,
      schemaLocked: entry.schemaLocked,
      autoEpoch: entry.autoEpoch,
      overrideVersion: entry.overrideVersion,
      record: entry.record,
    };
  }

  /**
   * Queries cached auto-detection regions and manual overrides for one page.
   */
  async getPageAutoCache(identityInput, pageNumber) {
    const pageKey = normalizePageNumberKey(pageNumber);
    const loaded = await this.loadDocument(identityInput);
    if (!loaded.record || !pageKey) {
      return {
        hit: false,
        complete: false,
        regions: [],
        overrides: [],
        overrideVersion: 0,
        autoEpoch: 0,
        status: !pageKey ? "invalid-page" : loaded.status,
      };
    }

    const norm = normalizeAttachmentIdentity(identityInput);
    const entry = norm ? this.entries.get(norm.storageKey) : null;
    const autoEntry = loaded.record.autoCache.pages[pageKey] ?? null;
    const overrides = clonePageOverrides(loaded.record, pageKey);
    const hit = Boolean(autoEntry && autoEntry.complete === true);

    return {
      hit,
      complete: hit,
      regions: hit ? autoEntry.regions.map((r) => ({ ...r, rect: [...r.rect], sourceKinds: [...r.sourceKinds] })) : [],
      overrides,
      detectorRevision: loaded.record.autoCache.detectorRevision,
      overrideVersion: entry?.overrideVersion ?? loaded.overrideVersion,
      autoEpoch: entry?.autoEpoch ?? loaded.autoEpoch,
      status: loaded.status,
      schemaLocked: loaded.schemaLocked,
    };
  }

  /**
   * Synchronous in-memory read of cached auto regions and manual overrides for
   * one page when the attachment record is already loaded in memory. Never runs
   * disk IO or detection (used by synchronous context-menu construction).
   */
  getPageStateSync(identityInput, pageNumber) {
    const pageKey = normalizePageNumberKey(pageNumber);
    const norm = normalizeAttachmentIdentity(identityInput);
    if (!pageKey || !norm) {
      return {
        loaded: false,
        hit: false,
        autoRegions: [],
        overrides: [],
        overrideVersion: 0,
        autoEpoch: 0,
      };
    }
    const entry = this.entries.get(norm.storageKey);
    if (!entry?.record || !documentMatches(entry.record.document, norm)) {
      return {
        loaded: false,
        hit: false,
        autoRegions: [],
        overrides: [],
        overrideVersion: entry?.overrideVersion ?? 0,
        autoEpoch: entry?.autoEpoch ?? 0,
      };
    }
    const autoEntry = entry.record.autoCache.pages[pageKey] ?? null;
    const hit = Boolean(autoEntry && autoEntry.complete === true);
    return {
      loaded: true,
      hit,
      autoRegions: hit
        ? autoEntry.regions.map((r) => ({ ...r, rect: [...r.rect], sourceKinds: [...r.sourceKinds] }))
        : [],
      overrides: clonePageOverrides(entry.record, pageKey),
      overrideVersion: entry.overrideVersion,
      autoEpoch: entry.autoEpoch,
    };
  }

  /**
   * Resolves effective regions (auto + manual overrides) for a known array of
   * auto regions without re-running detection.
   */
  async resolveEffectiveForAuto(identityInput, pageNumber, autoRegions) {
    const pageKey = normalizePageNumberKey(pageNumber);
    const cleanAuto = serializeAutoRegions(autoRegions);
    const loaded = await this.loadDocument(identityInput);
    if (!loaded.record || !pageKey) {
      return {
        ...resolveEffectiveRegions(cleanAuto, []),
        overrides: [],
        overrideVersion: 0,
        autoEpoch: 0,
      };
    }
    const overrides = clonePageOverrides(loaded.record, pageKey);
    return {
      ...resolveEffectiveRegions(cleanAuto, overrides),
      overrides,
      overrideVersion: loaded.overrideVersion,
      autoEpoch: loaded.autoEpoch,
    };
  }

  /**
   * Persists auto-detected regions for one page (including empty pages with
   * `regions: []` as `complete: true`), preserving all `manualOverrides`.
   * Rejects stale auto saves when `expectedAutoEpoch` no longer matches.
   */
  async savePageAutoCache(identityInput, pageNumber, rawRegions, options = {}) {
    const pageKey = normalizePageNumberKey(pageNumber);
    if (!pageKey) {
      return { ok: false, persisted: false, reason: "invalid-page", overrides: [] };
    }
    const cleanRegions = serializeAutoRegions(rawRegions);
    const expectedAutoEpoch = options.expectedAutoEpoch ?? null;

    return this.enqueueMutation(identityInput, async (entry, identity) => {
      if (expectedAutoEpoch !== null && expectedAutoEpoch !== entry.autoEpoch) {
        return {
          ok: false,
          persisted: false,
          reason: "stale-auto-epoch",
          overrides: clonePageOverrides(entry.record, pageKey),
          overrideVersion: entry.overrideVersion,
          autoEpoch: entry.autoEpoch,
        };
      }

      const existing = entry.record.autoCache.pages[pageKey];
      const unchanged =
        existing &&
        sameAutoRegions(existing.regions, cleanRegions) &&
        entry.record.autoCache.detectorRevision === this.detectorRevision &&
        !entry.dirtyReset &&
        !entry.writeBlocked &&
        entry.existsOnDisk;

      const overrides = clonePageOverrides(entry.record, pageKey);
      if (unchanged) {
        return {
          ok: true,
          persisted: false,
          unchanged: true,
          regions: existing.regions,
          overrides,
          overrideVersion: entry.overrideVersion,
          autoEpoch: entry.autoEpoch,
        };
      }

      entry.record.autoCache.detectorRevision = this.detectorRevision;
      entry.record.autoCache.pages[pageKey] = {
        complete: true,
        updatedAt: this.now(),
        regions: cleanRegions,
      };

      const filePath = this.getFilePath(identity.attachmentItemID);
      const writeRes = await this.writeRecordToDisk(entry, filePath, entry.record);
      return {
        ok: true,
        persisted: writeRes.persisted,
        reason: writeRes.reason,
        error: writeRes.error,
        regions: cleanRegions,
        overrides,
        overrideVersion: entry.overrideVersion,
        autoEpoch: entry.autoEpoch,
      };
    });
  }

  /**
   * Cache-first page retrieval helper:
   *   1. Check persisted `autoCache` + resolve against `manualOverrides`.
   *   2. On miss, invoke `detectFn()`, persist `autoCache` if complete, and
   *      resolve effective regions with `manualOverrides`.
   */
  async getEffectivePageRegions(identityInput, pageNumber, detectFn = null) {
    const pageKey = normalizePageNumberKey(pageNumber);
    if (!pageKey) {
      return {
        source: "invalid",
        regions: [],
        autoRegions: [],
        overrides: [],
        unresolvedOverrides: [],
        persisted: false,
      };
    }

    const cached = await this.getPageAutoCache(identityInput, pageNumber);
    if (cached.hit) {
      const effective = resolveEffectiveRegions(cached.regions, cached.overrides);
      return {
        source: "persistent-cache",
        ...effective,
        autoRegions: cached.regions,
        overrides: cached.overrides,
        overrideVersion: cached.overrideVersion,
        autoEpoch: cached.autoEpoch,
        persisted: true,
        status: cached.status,
      };
    }

    if (typeof detectFn !== "function") {
      const effective = resolveEffectiveRegions([], cached.overrides);
      return {
        source: "miss",
        ...effective,
        autoRegions: [],
        overrides: cached.overrides,
        overrideVersion: cached.overrideVersion,
        autoEpoch: cached.autoEpoch,
        persisted: false,
        status: cached.status,
      };
    }

    const startEpoch = cached.autoEpoch;
    const detected = await detectFn();
    const rawAuto = Array.isArray(detected) ? detected : (detected?.regions ?? []);
    const cleanAuto = serializeAutoRegions(rawAuto);

    const identity = normalizeAttachmentIdentity(identityInput);
    let persisted = false;
    let overrides = cached.overrides;
    let overrideVersion = cached.overrideVersion;
    let autoEpoch = cached.autoEpoch;

    if (identity) {
      const saveRes = await this.savePageAutoCache(identity, pageNumber, cleanAuto, {
        expectedAutoEpoch: startEpoch,
      });
      persisted = Boolean(saveRes?.persisted || saveRes?.unchanged);
      if (saveRes?.overrides) overrides = saveRes.overrides;
      if (saveRes?.overrideVersion != null) overrideVersion = saveRes.overrideVersion;
      if (saveRes?.autoEpoch != null) autoEpoch = saveRes.autoEpoch;
    }

    const effective = resolveEffectiveRegions(cleanAuto, overrides);
    return {
      source: "detected",
      ...effective,
      autoRegions: cleanAuto,
      overrides,
      overrideVersion,
      autoEpoch,
      persisted,
      status: cached.status,
    };
  }

  async mutatePageOverrides(identityInput, pageNumber, updater) {
    const pageKey = normalizePageNumberKey(pageNumber);
    if (!pageKey) {
      return { ok: false, persisted: false, reason: "invalid-page" };
    }

    return this.enqueueMutation(identityInput, async (entry, identity) => {
      const autoRegions = entry.record.autoCache.pages[pageKey]?.regions ?? [];
      const currentOverrides = clonePageOverrides(entry.record, pageKey);
      const outcome = updater(currentOverrides, autoRegions);
      if (!outcome?.ok) {
        return {
          ok: false,
          persisted: false,
          reason: outcome?.reason ?? "invalid-override",
          overrides: currentOverrides,
          effective: resolveEffectiveRegions(autoRegions, currentOverrides),
          overrideVersion: entry.overrideVersion,
          autoEpoch: entry.autoEpoch,
        };
      }

      if (outcome.overrides.length) {
        entry.record.manualOverrides.pages[pageKey] = outcome.overrides;
      } else {
        delete entry.record.manualOverrides.pages[pageKey];
      }
      entry.overrideVersion += 1;

      const filePath = this.getFilePath(identity.attachmentItemID);
      const writeRes = await this.writeRecordToDisk(entry, filePath, entry.record);
      const nextOverrides = clonePageOverrides(entry.record, pageKey);
      return {
        ok: true,
        action: outcome.action,
        persisted: writeRes.persisted,
        reason: writeRes.reason,
        error: writeRes.error,
        override: outcome.override ?? null,
        removed: outcome.removed ?? null,
        removedCount: outcome.removedCount ?? 0,
        overrides: nextOverrides,
        autoRegions: serializeAutoRegions(autoRegions),
        effective: resolveEffectiveRegions(autoRegions, nextOverrides),
        overrideVersion: entry.overrideVersion,
        autoEpoch: entry.autoEpoch,
      };
    });
  }

  /**
   * Suppresses a specific auto-detected region on a page (or removes a matching
   * manual addition).
   */
  suppressRegion(identity, pageNumber, target, options = {}) {
    return this.mutatePageOverrides(identity, pageNumber, (current, autoRegions) =>
      upsertSuppressOverride(current, target, {
        autoRegions: options.autoRegions ?? autoRegions,
        now: this.now,
      }),
    );
  }

  /**
   * Replaces a target region's bounding box with `newRect` (no duplicate old box).
   */
  replaceRegion(identity, pageNumber, target, newRect, options = {}) {
    return this.mutatePageOverrides(identity, pageNumber, (current, autoRegions) =>
      upsertReplaceOverride(current, target, newRect, {
        autoRegions: options.autoRegions ?? autoRegions,
        now: this.now,
      }),
    );
  }

  /**
   * Adds a manual figure bounding box on a page (even when `autoCache` is empty).
   */
  addRegion(identity, pageNumber, rect, options = {}) {
    return this.mutatePageOverrides(identity, pageNumber, (current) =>
      appendAddOverride(current, rect, {
        captionNumber: options.captionNumber ?? null,
        caption: options.caption ?? null,
        allowDuplicate: Boolean(options.allowDuplicate),
        now: this.now,
      }),
    );
  }

  /**
   * Removes one override by override ID or target descriptor (or all overrides
   * on the page when `overrideIdOrTarget === "*"` or `options.all === true`).
   */
  resetOverride(identity, pageNumber, overrideIdOrTarget, options = {}) {
    return this.mutatePageOverrides(identity, pageNumber, (current, autoRegions) =>
      removeOverride(current, overrideIdOrTarget, {
        autoRegions: options.autoRegions ?? autoRegions,
        all: Boolean(options.all),
      }),
    );
  }

  /**
   * Invalidates persisted auto-detection cache for one document (or one page
   * when `options.pageNumber` is set) while preserving all `manualOverrides`.
   */
  invalidateAutoCache(identityInput, options = {}) {
    const pageKey =
      options.pageNumber !== undefined && options.pageNumber !== null
        ? normalizePageNumberKey(options.pageNumber)
        : null;
    if (options.pageNumber !== undefined && options.pageNumber !== null && !pageKey) {
      return Promise.resolve({ ok: false, persisted: false, reason: "invalid-page" });
    }

    return this.enqueueMutation(identityInput, async (entry, identity) => {
      if (pageKey) {
        delete entry.record.autoCache.pages[pageKey];
      } else {
        entry.record.autoCache.pages = {};
      }
      entry.autoEpoch += 1;

      const filePath = this.getFilePath(identity.attachmentItemID);
      const writeRes = await this.writeRecordToDisk(entry, filePath, entry.record);
      return {
        ok: true,
        persisted: writeRes.persisted,
        reason: writeRes.reason,
        error: writeRes.error,
        autoEpoch: entry.autoEpoch,
        overrideVersion: entry.overrideVersion,
        preservedOverridePages: Object.keys(entry.record.manualOverrides.pages),
      };
    });
  }
}
