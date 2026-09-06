import assert from "node:assert/strict";
import { AsyncTtlCache } from "../src/async-cache.js";

let now = 0;
let loads = 0;
const cache = new AsyncTtlCache<string, number>(100, 2, () => now);
const load = async () => ++loads;
assert.deepEqual(await Promise.all(Array.from({ length: 20 }, () => cache.get("same", load))), Array(20).fill(1));
assert.equal(await cache.get("same", load), 1);
now = 100;
assert.equal(await cache.get("same", load), 2, "expiry is measured from completion and is inclusive");
await cache.get("second", load);
await cache.get("same", load); // touch to keep the first key
await cache.get("third", load);
assert.equal(await cache.get("same", load), 2, "recently read entry survives capacity eviction");
assert.equal(await cache.get("second", load), 5, "least recently used entry is evicted");
await assert.rejects(cache.get("broken", async () => { throw new Error("source offline"); }), /source offline/);
assert.equal(await cache.get("broken", load), 6, "a rejected flight must not poison the key");
await assert.rejects(cache.get("sync-error", () => { throw new Error("sync"); }), /sync/);
assert.equal(await cache.get("sync-error", load), 7);
console.log("Bounded asynchronous cache tests passed.");
