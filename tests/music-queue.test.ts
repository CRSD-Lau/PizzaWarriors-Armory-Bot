import assert from "node:assert/strict";
import { MusicQueue } from "../src/music/queue.js";
import type { MusicTrack } from "../src/music/types.js";

const tracks = (count: number): MusicTrack[] => Array.from({ length: count }, (_, index) => ({
  title: `Track ${index + 1}`,
  url: `https://example.test/${index + 1}`,
  source: "youtube",
}));

const queue = new MusicQueue(3);
assert.deepEqual(queue.add(tracks(2)), { added: 2, omitted: 0 });
assert.deepEqual(queue.add(tracks(3).map((track, index) => ({ ...track, title: `Later ${index + 1}` }))), { added: 1, omitted: 2 });
assert.equal(queue.length, 3);
assert.equal(queue.remaining, 0);
assert.deepEqual(queue.snapshot().map((track) => track.title), ["Track 1", "Track 2", "Later 1"], "playlist order must be stable");
assert.equal(queue.shift()?.title, "Track 1");
assert.equal(queue.shift()?.title, "Track 2");
assert.equal(queue.shift()?.title, "Later 1");
assert.equal(queue.shift(), undefined);

const copy = queue.snapshot() as MusicTrack[];
copy.push(tracks(1)[0]);
assert.equal(queue.length, 0, "snapshot callers must not mutate the queue");
assert.throws(() => new MusicQueue(0), /positive integer/);

console.log("Music queue tests passed.");
