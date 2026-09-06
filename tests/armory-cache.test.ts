import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeMetadata, decodeHtmlText, ItemMetadataCache, mergeMetadataSources, parseMetadata, type MetadataFields } from "../src/item-metadata.js";
import { cacheKeyForCharacter, SummaryCache } from "../src/summary-cache.js";

const complete: MetadataFields = { name: "Verified Helm", itemLevel: 277, quality: "epic", equipLoc: "INVTYPE_HEAD", socketCount: 2 };
const day = 24 * 60 * 60 * 1_000;
let now = 40 * day;

for (const [slot, equipLoc] of [
  ["One-Hand", "INVTYPE_WEAPON"], ["Shirt", "INVTYPE_BODY"], ["Tabard", "INVTYPE_TABARD"],
  ["Two-Hand", "INVTYPE_2HWEAPON"], ["Held In Off-hand", "INVTYPE_HOLDABLE"], ["Main Hand", "INVTYPE_WEAPONMAINHAND"],
]) {
  const parsed = parseMetadata(`<title>Fixture&#039;s Item - Item - WotLK</title><b class="q4">Fixture Item</b><span>Item Level 277</span><table><tr><th>Slot</th><td>${slot}</td></tr></table>`, true);
  assert.equal(parsed.equipLoc, equipLoc, `${slot} must be recognized before caching a complete item`);
  assert.equal(parsed.name, "Fixture's Item");
  assert.ok(completeMetadata(parsed));
  assert.equal(parsed.socketCount, 0);
}
assert.equal(parseMetadata("<title>Just a moment</title>", true).socketCount, undefined);
assert.equal(decodeHtmlText("out of range &#999999999;"), "out of range &#999999999;");

assert.deepEqual(mergeMetadataSources(
  { name: "First source", itemLevel: undefined, equipLoc: undefined, socketCount: 0 },
  { name: "Second source", itemLevel: 277, equipLoc: "INVTYPE_HEAD", quality: "epic", socketCount: 2 },
), { name: "First source", itemLevel: 277, equipLoc: "INVTYPE_HEAD", quality: "epic", socketCount: 0 });

// A fresh provider response replaces the old zero/default cache rather than being shadowed by it.
const poisoned = new ItemMetadataCache("unused", async () => complete, {
  now: () => now,
  read: async () => ({ items: { "1": { name: "Item 1", itemLevel: 0, quality: "epic", fetchedAt: now } } }),
  write: async () => undefined,
});
assert.equal((await poisoned.get(1)).itemLevel, 277);
assert.equal((await poisoned.get(1)).name, "Verified Helm");

// A genuine fresh source also replaces stale complete values.
const expired = new ItemMetadataCache("unused", async () => ({ ...complete, quality: "legendary", name: "Updated Helm" }), {
  now: () => now,
  read: async () => ({ items: { "2": { ...complete, itemLevel: 264, fetchedAt: day } } }),
  write: async () => undefined,
});
assert.equal((await expired.get(2)).itemLevel, 277);
assert.equal((await expired.get(2)).quality, "legendary");

let attempts = 0;
let saved: unknown;
const recovering = new ItemMetadataCache("unused", async () => {
  attempts++;
  return attempts === 1 ? { name: undefined, itemLevel: 0 } : complete;
}, { now: () => now, read: async () => ({}), write: async (value) => { saved = structuredClone(value); } });
assert.equal((await recovering.get(3, "INVTYPE_HEAD", "Fallback Helm")).name, "Fallback Helm");
assert.equal((await recovering.get(3)).itemLevel, 0);
assert.equal(attempts, 1, "one-minute retry interval avoids repeatedly hitting failed providers");
assert.equal((saved as { items: Record<string, { name?: string; complete: boolean }> }).items["3"].name, undefined,
  "display fallback must not become cached item metadata");
now += 60_001;
assert.equal((await recovering.get(3)).itemLevel, 277);
assert.equal(attempts, 2, "an incomplete result must not remain cached for 30 days");

let staleAttempts = 0;
const stale = new ItemMetadataCache("unused", async () => { staleAttempts++; throw new Error("offline"); }, {
  now: () => now,
  read: async () => ({ items: { "4": { ...complete, fetchedAt: day } } }),
  write: async () => undefined,
});
assert.equal((await stale.get(4)).fetchedAt, day);
assert.equal((await stale.get(4)).itemLevel, 277, "preserve known item facts during provider failure");
now += 60_001;
assert.equal((await stale.get(4)).fetchedAt, day, "a failed refresh must not renew stale metadata age");
assert.equal(staleAttempts, 2);

const partialRefresh = new ItemMetadataCache("unused", async () => ({ name: "Updated name", itemLevel: undefined }), {
  now: () => now,
  read: async () => ({ items: { "5": { ...complete, fetchedAt: day } } }),
  write: async () => undefined,
});
const partial = await partialRefresh.get(5);
assert.equal(partial.name, "Updated name");
assert.equal(partial.itemLevel, 277);
assert.equal(partial.fetchedAt, day);

const originalWarn = console.warn;
let cacheWarnings = 0;
try {
  console.warn = () => { cacheWarnings++; };
  const diskFailure = new ItemMetadataCache("unused", async () => complete, {
    read: async () => { throw new SyntaxError("corrupt disposable cache"); },
    write: async () => { throw new Error("disk full"); },
  });
  assert.equal((await diskFailure.get(6)).itemLevel, 277, "cache failure must not discard verified fetched gear");
  assert.equal(cacheWarnings, 1);
} finally { console.warn = originalWarn; }

// First-load and item fetches coalesce, and writes serialize while preserving every item.
let reads = 0;
let activeWrites = 0;
let maxWrites = 0;
const fetches = new Map<number, number>();
const concurrent = new ItemMetadataCache("unused", async (id) => {
  fetches.set(id, (fetches.get(id) ?? 0) + 1);
  await new Promise((resolve) => setImmediate(resolve));
  return { ...complete, name: `Verified item ${id}` };
}, {
  now: () => now,
  read: async () => { reads++; await new Promise((resolve) => setImmediate(resolve)); return {}; },
  write: async (value) => {
    activeWrites++;
    maxWrites = Math.max(maxWrites, activeWrites);
    await new Promise((resolve) => setImmediate(resolve));
    saved = structuredClone(value);
    activeWrites--;
  },
});
await Promise.all([concurrent.get(10), concurrent.get(11), concurrent.get(10), concurrent.get(12)]);
assert.equal(reads, 1);
assert.equal(fetches.get(10), 1);
assert.equal(maxWrites, 1);
assert.deepEqual(Object.keys((saved as { items: object }).items), ["10", "11", "12"]);

// Exercise the real atomic disk writer and restart from its output, using only a temporary directory.
const directory = await mkdtemp(join(tmpdir(), "armory-cache-test-"));
try {
  const filePath = join(directory, "items.json");
  const disk = new ItemMetadataCache(filePath, async (id) => ({ ...complete, name: `Verified item ${id}` }));
  await Promise.all([disk.get(21), disk.get(22), disk.get(23)]);
  assert.deepEqual(Object.keys((JSON.parse(await readFile(filePath, "utf8")) as { items: object }).items), ["21", "22", "23"]);
  const restarted = new ItemMetadataCache(filePath, async () => { throw new Error("should use disk cache"); });
  assert.equal((await restarted.get(22)).name, "Verified item 22");
} finally { await rm(directory, { recursive: true, force: true }); }

assert.equal(cacheKeyForCharacter(" LAUSUDO ", "Lordaeron"), cacheKeyForCharacter("lausudo", " lordaeron "));
const summaries = new SummaryCache<string>(100, 1_000, 2, () => now);
let summaryLoads = 0;
const load = async () => { summaryLoads++; await new Promise((resolve) => setImmediate(resolve)); return "original"; };
const first = await Promise.all([summaries.get("one", load), summaries.get("one", load)]);
assert.equal(summaryLoads, 1);
assert.equal(first[0].stale, false);
const originalTime = first[0].fetchedAt;
now += 101;
let failureLoads = 0;
const failing = async (): Promise<string> => { failureLoads++; throw new Error("provider unavailable"); };
const fallback = await Promise.all([summaries.get("one", failing), summaries.get("one", failing)]);
assert.equal(failureLoads, 1, "duplicate callers must share stale fallback, not receive different outcomes");
assert.ok(fallback.every((value) => value.stale && value.fetchedAt === originalTime && value.value === "original"));
now += 1_000;
await assert.rejects(summaries.get("one", failing), /provider unavailable/, "expired stale fallback must not live forever");

await summaries.get("a", async () => "a");
await summaries.get("b", async () => "b");
await summaries.get("a", async () => "wrong");
await summaries.get("c", async () => "c");
let evictedReloads = 0;
assert.equal((await summaries.get("b", async () => { evictedReloads++; return "b refreshed"; })).value, "b refreshed");
assert.equal(evictedReloads, 1, "least-recently-used entries must be evicted at the configured bound");
console.log("armory metadata and summary cache tests passed");
