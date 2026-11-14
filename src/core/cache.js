/**
 * Per-document, per-page cache for detected regions, with cancellation of
 * stale work so a zoom burst does not parse the same page repeatedly.
 *
 * Two levels of staleness are tracked:
 *   - a per page *generation*, bumped whenever a new detection task starts for
 *     that page, so only the newest task may paint;
 *   - a per document *epoch*, bumped on invalidation (document closed, source
 *     changed), so results of an entire previous run become stale at once.
 */
export class RegionCache {
  /** @param {{maxEntries?: number}} [options] */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    /** @type {Map<string, {value: any, generation: number}>} */
    this.entries = new Map();
    /** @type {Map<string, number>} */
    this.epoch = new Map();
    // Document key -> the entry keys written for it. A document key may itself
    // contain the characters an entry key is built from, because the reader
    // session scopes a key as `itemID|fingerprint`. An index lets invalidation
    // delete exactly one document's pages instead of guessing from a prefix.
    /** @type {Map<string, Set<string>>} */
    this.keysByDocument = new Map();
  }

  static key(documentId, pageIndex) {
    return `${documentId}::${pageIndex}`;
  }

  get(documentId, pageIndex) {
    const key = RegionCache.key(documentId, pageIndex);
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Touch the entry so eviction follows last use, not first insertion.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(documentId, pageIndex, value) {
    const key = RegionCache.key(documentId, pageIndex);
    const generation = this.entries.get(key)?.generation ?? 0;
    this.entries.set(key, { value, generation });
    this.indexKey(documentId, key);
    while (this.entries.size > this.maxEntries) {
      const evicted = this.entries.keys().next().value;
      this.entries.delete(evicted);
      this.unindexKey(evicted);
    }
    return value;
  }

  /**
   * Records that an entry key belongs to a document key, so invalidation can
   * delete exactly that document's pages.
   *
   * @param {string|number|null} documentId
   * @param {string} entryKey
   */
  indexKey(documentId, entryKey) {
    const docKey = String(documentId);
    let keys = this.keysByDocument.get(docKey);
    if (!keys) {
      keys = new Set();
      this.keysByDocument.set(docKey, keys);
    }
    keys.add(entryKey);
  }

  /**
   * Drops an evicted entry key from the document index.
   *
   * @param {string} entryKey
   */
  unindexKey(entryKey) {
    for (const [docKey, keys] of this.keysByDocument) {
      keys.delete(entryKey);
      if (keys.size === 0) this.keysByDocument.delete(docKey);
    }
  }

  /**
   * Marks the start of a detection task. Store the returned token and ask
   * `isCurrent(token)` before applying results.
   */
  begin(documentId, pageIndex) {
    const key = RegionCache.key(documentId, pageIndex);
    const previous = this.entries.get(key);
    const generation = (previous?.generation ?? 0) + 1;
    // The previous value stays readable until the new result replaces it, so a
    // re-detection does not leave the page uncovered for a moment.
    this.entries.set(key, { value: previous?.value ?? null, generation });
    this.indexKey(documentId, key);
    return {
      documentId,
      pageIndex,
      key,
      generation,
      epoch: this.epoch.get(documentId) ?? 0,
    };
  }

  isCurrent(token) {
    if (!token) return false;
    const entry = this.entries.get(token.key);
    if (!entry || entry.generation !== token.generation) return false;
    return (this.epoch.get(token.documentId) ?? 0) === token.epoch;
  }

  /**
   * Drops every entry for one document, then blocks results still in flight by
   * bumping the document epoch. The index deletes exactly this document's
   * pages; the prefix pass stays as the fallback for entries whose document key
   * predates the index. A document that carries another document's scoped key
   * therefore no longer loses pages it does not own.
   *
   * @param {string|number|null} documentId
   */
  invalidateDocument(documentId) {
    const docKey = String(documentId);
    for (const key of this.keysByDocument.get(docKey) ?? []) this.entries.delete(key);
    this.keysByDocument.delete(docKey);
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${docKey}::`)) this.entries.delete(key);
    }
    this.epoch.set(documentId, (this.epoch.get(documentId) ?? 0) + 1);
  }

  clear() {
    this.entries.clear();
    this.epoch.clear();
    this.keysByDocument.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Composes the RegionCache document scope with a document id.
 *
 * The printed fingerprint is not unique per file: two PDFs side by side in the
 * real machine printed the same `fcp:3e708112401a3e23` tail. With two reader tabs
 * open, both sessions read the same cache key, so one document's regions were
 * painted over the other's. The per-reader scope keeps the entries of two readers
 * apart even when the printed identity claims they are the same document. An empty
 * scope leaves the key as the bare document id.
 *
 * @param {string|number|null|undefined} scope Per-reader scope, normally the reader item id.
 * @param {string} documentId Document id produced by `resolveDocumentId()`.
 * @returns {string} The key `RegionCache` stores this document's pages under.
 */
export function scopedDocumentId(scope, documentId) {
  const raw = String(documentId ?? "");
  const prefix = scope === null || scope === undefined || scope === "" ? "" : `${String(scope)}|`;
  return `${prefix}${raw}`;
}
