import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RegionCache, scopedDocumentId } from "../../src/core/cache.js";

describe("cache: regions", () => {
  it("stores and reads per document and page", () => {
    const cache = new RegionCache();
    assert.equal(cache.get("doc-a", 4), null);
    cache.set("doc-a", 4, [{ rect: [0, 0, 1, 1] }]);
    assert.equal(cache.get("doc-a", 4)[0].rect[2], 1);
    assert.equal(cache.get("doc-a", 5), null);
    assert.equal(cache.get("doc-b", 4), null);
  });

  it("evicts the least recently used entry", () => {
    const cache = new RegionCache({ maxEntries: 2 });
    cache.set("doc", 0, "a");
    cache.set("doc", 1, "b");
    cache.get("doc", 0);
    cache.set("doc", 2, "c");
    assert.equal(cache.get("doc", 1), null, "page 1 was used least recently");
    assert.equal(cache.get("doc", 0), "a");
    assert.equal(cache.get("doc", 2), "c");
    assert.equal(cache.size, 2);
  });

  it("tracks generations so stale work can be dropped", () => {
    const cache = new RegionCache();
    cache.set("doc", 3, ["first"]);
    const task = cache.begin("doc", 3);
    assert.deepEqual(cache.get("doc", 3), ["first"], "old value stays until the new one lands");
    assert.equal(cache.isCurrent(task), true);
    const newer = cache.begin("doc", 3);
    assert.equal(cache.isCurrent(task), false, "a superseded task must discard its result");
    assert.equal(cache.isCurrent(newer), true);
  });

  it("invalidates one document at a time", () => {
    const cache = new RegionCache();
    cache.set("doc-a", 0, 1);
    cache.set("doc-a", 1, 2);
    cache.set("doc-b", 0, 3);
    cache.invalidateDocument("doc-a");
    assert.equal(cache.get("doc-a", 0), null);
    assert.equal(cache.get("doc-a", 1), null);
    assert.equal(cache.get("doc-b", 0), 3);
    assert.equal(cache.hasDocument("doc-a"), false, "an invalidated key holds nothing");
    assert.equal(cache.hasDocument("doc-b"), true, "the other document's pages are still there");
  });

  it("makes tokens from before an invalidation stale", () => {
    const cache = new RegionCache();
    const before = cache.begin("doc", 0);
    cache.invalidateDocument("doc");
    assert.equal(cache.isCurrent(before), false);
    const after = cache.begin("doc", 0);
    assert.equal(cache.isCurrent(after), true);
    cache.invalidateDocument("doc");
    assert.equal(cache.isCurrent(after), false);
  });

  it("treats a missing token as stale", () => {
    const cache = new RegionCache();
    assert.equal(cache.isCurrent(null), false);
    assert.equal(cache.isCurrent(undefined), false);
  });
});


describe("cache: per-reader scope", () => {
  it("keeps two readers of one document id apart", () => {
    const cache = new RegionCache();
    const fluidkv = scopedDocumentId("item:317", "fcp:3e708112401a3e23");
    const pipe = scopedDocumentId("item:308", "fcp:3e708112401a3e23");

    assert.notEqual(fluidkv, pipe, "one printed fingerprint, two keys");
    cache.set(fluidkv, 6, "fluidkv p6");
    cache.set(pipe, 6, "pipe p6");
    assert.equal(cache.get(fluidkv, 6), "fluidkv p6", "the visible document keeps its own regions");
    assert.equal(cache.get(pipe, 6), "pipe p6", "and the background document keeps its own");
    assert.equal(cache.get("fcp:3e708112401a3e23", 6), null, "the unsolved key holds nothing");
  });

  it("invalidates one reader without touching the other", () => {
    const cache = new RegionCache();
    const fluidkv = scopedDocumentId("item:317", "fcp:same");
    const pipe = scopedDocumentId("item:308", "fcp:same");
    cache.set(fluidkv, 1, "a");
    cache.set(pipe, 1, "b");

    cache.invalidateDocument(fluidkv);

    assert.equal(cache.get(fluidkv, 1), null, "the closed document's page is gone");
    assert.equal(cache.get(pipe, 1), "b", "the reader that stayed open keeps its cache");
  });

  it("drops evicted keys from the document index", () => {
    const cache = new RegionCache({ maxEntries: 2 });
    cache.set("doc-a", 0, "a0");
    cache.set("doc-a", 1, "a1");
    cache.set("doc-b", 0, "b0");
    assert.equal(cache.get("doc-a", 0), null, "the eviction took doc-a's first page");
    assert.equal(cache.keysByDocument.get("doc-a")?.size, 1, "the index no longer lists the evicted key");

    cache.invalidateDocument("doc-a");
    assert.equal(cache.get("doc-a", 1), null, "invalidation still clears the pages that remain");
    assert.equal(cache.keysByDocument.has("doc-a"), false, "a document with no pages leaves the index");

    cache.set("doc-a", 0, "again");
    assert.equal(cache.get("doc-a", 0), "again", "the document can be repopulated after its index was dropped");
  });

  it("catches unindexed entries through the prefix fallback", () => {
    const cache = new RegionCache();
    // An entry written before the index existed: in `entries`, absent from `keysByDocument`.
    cache.entries.set(RegionCache.key("doc-legacy", 2), { value: "old", generation: 0 });
    assert.equal(cache.hasDocument("doc-legacy"), true, "the read-only question sees an unindexed entry too");
    cache.invalidateDocument("doc-legacy");
    assert.equal(cache.get("doc-legacy", 2), null, "the fallback pass deletes what the index never knew about");
    assert.equal(cache.hasDocument("doc-legacy"), false, "and the key reports empty afterwards");
  });

  it("stalems only the invalidated document's in-flight tokens", () => {
    const cache = new RegionCache();
    const a = cache.begin("doc-a", 0);
    const b = cache.begin("doc-b", 0);
    cache.invalidateDocument("doc-a");
    assert.equal(cache.isCurrent(a), false, "doc-a's running detection is cancelled");
    assert.equal(cache.isCurrent(b), true, "doc-b's epoch is untouched");
  });

  it("leaves the key bare when there is no scope", () => {
    assert.equal(scopedDocumentId(null, "fcp:x"), "fcp:x", "no scope, no prefix");
    assert.equal(scopedDocumentId(undefined, "fcp:x"), "fcp:x", "an unknown reader is not a scope");
    assert.equal(scopedDocumentId("", "fcp:x"), "fcp:x", "an empty scope is not a scope either");
    assert.equal(scopedDocumentId("item:7", "fcp:x"), "item:7|fcp:x", "a reader id is");
    assert.equal(scopedDocumentId(7, "fcp:x"), "7|fcp:x", "and a numeric item id is composed the same way");
  });
});
