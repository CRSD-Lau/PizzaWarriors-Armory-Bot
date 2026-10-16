import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoreAttendanceEvent } from "../src/core-attendance.js";
import { FinalAttendanceStore, finalAttendanceDueAt, finalizeAttendanceRecord } from "../src/final-attendance.js";
import { atomicWriteJson, JsonStoreError } from "../src/json-store.js";
import type { RaidHelperEvent } from "../src/ready.js";

const guildId = "123456789012345600";
const eventId = "123456789012345610";
const memberA = { discordUserId: "123456789012345601", displayName: "Saved Alpha" };
const memberB = { discordUserId: "123456789012345602", displayName: "Saved Bravo" };
const providerOnly = { discordUserId: "123456789012345603", displayName: "Provider Guest" };
const startsAt = 1_800_000_000_000;
const endsAt = startsAt + 4 * 60 * 60_000;
const dueAt = endsAt + 5 * 60_000;

function provider(overrides: Partial<RaidHelperEvent> = {}): RaidHelperEvent {
  return {
    eventId,
    title: "Pizza Core ICC25",
    startsAt,
    endsAt,
    guildId,
    signups: [
      { ...memberA, displayName: "Current Alpha", status: "Tentative", reportedClass: "Shaman", reportedSpec: "Elemental", reportedRole: "Ranged" },
      { ...providerOnly, status: "Signed" },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<CoreAttendanceEvent> = {}): CoreAttendanceEvent {
  return {
    eventId,
    title: "Pizza Core ICC25",
    startsAt,
    capturedAt: startsAt - 1_000,
    rosterUpdatedAt: startsAt - 2_000,
    entries: [
      { ...memberA, status: "Signed" },
      { ...memberB, status: "Absent" },
    ],
    ...overrides,
  };
}

test("computes the explicit or conservative final-attendance safety deadline", () => {
  assert.equal(finalAttendanceDueAt({ startsAt, endsAt }), dueAt);
  const fallbackDueAt = startsAt + 18 * 60 * 60_000 + 5 * 60_000;
  assert.equal(finalAttendanceDueAt({ startsAt, endsAt: startsAt }), fallbackDueAt);
  assert.equal(finalizeAttendanceRecord({ guildId, event: provider({ endsAt: undefined }), now: fallbackDueAt - 1 }), undefined);
  assert.equal(finalizeAttendanceRecord({ guildId, event: provider({ endsAt: undefined }), now: fallbackDueAt })?.completedAt, startsAt + 18 * 60 * 60_000);
  assert.equal(finalAttendanceDueAt({}), undefined);
});

test("captures after the safety grace and reloads the full parsed provider roster", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-attendance-"));
  const filePath = join(directory, "final-attendance.json");
  try {
    const store = new FinalAttendanceStore(filePath);
    assert.equal(await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt - 1 }), undefined);
    assert.equal((await store.list(guildId)).length, 0);

    const record = await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt });
    assert.ok(record);
    assert.equal(record.completedAt, endsAt);
    assert.equal(record.finalizedAt, dueAt);
    assert.equal(record.rosterBasis, "snapshot");
    assert.deepEqual(record.raidHelper.signups[0], {
      ...memberA,
      displayName: "Current Alpha",
      status: "Tentative",
      reportedClass: "Shaman",
      reportedSpec: "Elemental",
      reportedRole: "Ranged",
    });
    assert.deepEqual(record.event.entries, [
      { ...memberA, status: "Tentative" },
      { ...memberB, status: "Missing" },
    ]);

    const reloaded = new FinalAttendanceStore(filePath);
    assert.deepEqual(await reloaded.get(guildId, eventId), record);
    assert.equal((await reloaded.list(guildId))[0]?.event.eventId, eventId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses only actual provider signups when no historical core snapshot exists", () => {
  const record = finalizeAttendanceRecord({ guildId, event: provider(), now: dueAt });
  assert.ok(record);
  assert.equal(record.rosterBasis, "provider");
  assert.equal(record.event.rosterUpdatedAt, 0);
  assert.deepEqual(record.event.entries, [
    { discordUserId: memberA.discordUserId, displayName: "Current Alpha", status: "Tentative" },
    { ...providerOnly, status: "Signed" },
  ]);
  assert.equal(record.event.entries.some((entry) => entry.discordUserId === memberB.discordUserId), false);
});

test("upserts corrections, avoids identical writes, and never overwrites with an older finalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-upsert-"));
  const filePath = join(directory, "final-attendance.json");
  let writes = 0;
  const store = new FinalAttendanceStore(filePath, async (path, value) => {
    writes++;
    await atomicWriteJson(path, value);
  });
  try {
    const first = await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt });
    const identical = await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt + 1_000 });
    assert.equal(writes, 1);
    assert.equal(identical?.finalizedAt, first?.finalizedAt);

    const correctedEvent = provider({ signups: [
      { ...memberA, status: "Signed" },
      { ...providerOnly, status: "Absent" },
    ] });
    const corrected = await store.capture({ guildId, event: correctedEvent, snapshot: snapshot(), now: dueAt + 2_000 });
    assert.equal(writes, 2);
    assert.equal(corrected?.event.entries[0]?.status, "Signed");

    const older = await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt + 1_500 });
    assert.equal(writes, 2);
    assert.equal(older?.finalizedAt, corrected?.finalizedAt);
    assert.equal((await store.get(guildId, eventId))?.event.entries[0]?.status, "Signed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never downgrades frozen snapshot membership on a provider-only recapture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-basis-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    await store.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt });
    const corrected = await store.capture({
      guildId,
      event: provider({ signups: [{ ...memberA, displayName: "Current Alpha", status: "Signed" }] }),
      now: dueAt + 1_000,
    });
    assert.equal(corrected?.rosterBasis, "snapshot");
    assert.deepEqual(corrected?.event.entries, [
      { ...memberA, status: "Signed" },
      { ...memberB, status: "Missing" },
    ]);
    assert.equal(corrected?.raidHelper.signups.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects mismatched identity, invalid ownership, and corrupt or failed storage", async () => {
  assert.throws(() => finalizeAttendanceRecord({
    guildId,
    event: provider(),
    snapshot: snapshot({ startsAt: startsAt + 1 }),
    now: dueAt,
  }), /does not match/);
  assert.throws(() => finalizeAttendanceRecord({ guildId, event: provider({ guildId: "123456789012345699" }), now: dueAt }), /valid Pizza Core/);
  assert.throws(() => finalizeAttendanceRecord({ guildId, event: provider({ title: "Other raid" }), now: dueAt }), /valid Pizza Core/);

  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-failure-"));
  const failedPath = join(directory, "failed.json");
  try {
    const failing = new FinalAttendanceStore(failedPath, async () => {
      throw Object.assign(new Error("disk unavailable"), { code: "EIO" });
    });
    await assert.rejects(failing.capture({ guildId, event: provider(), snapshot: snapshot(), now: dueAt }), JsonStoreError);
    assert.equal(await failing.get(guildId, eventId), undefined, "failed writes cannot change the in-memory archive");

    const corruptPath = join(directory, "corrupt.json");
    await writeFile(corruptPath, JSON.stringify({ version: 1, guilds: { [guildId]: { events: [{ private: "do not expose" }] } } }));
    await assert.rejects(new FinalAttendanceStore(corruptPath).list(guildId), (error: unknown) => {
      assert.ok(error instanceof JsonStoreError);
      assert.doesNotMatch(error.message, /do not expose/);
      return true;
    });
    assert.match(await readFile(corruptPath, "utf8"), /do not expose/);

    const inconsistentPath = join(directory, "inconsistent.json");
    const record = finalizeAttendanceRecord({ guildId, event: provider(), snapshot: snapshot(), now: dueAt })!;
    record.event.entries[0]!.status = "Absent";
    await writeFile(inconsistentPath, JSON.stringify({ version: 1, guilds: { [guildId]: { events: [record] } } }));
    await assert.rejects(new FinalAttendanceStore(inconsistentPath).list(guildId), JsonStoreError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the complete durable archive without report-window pruning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-unpruned-"));
  const store = new FinalAttendanceStore(join(directory, "memory-only.json"), async () => undefined);
  try {
    for (let index = 0; index < 55; index++) {
      const id = `12345678901234${String(5700 + index)}`;
      const start = startsAt + index * 86_400_000;
      const end = start + 60 * 60_000;
      await store.capture({
        guildId,
        event: provider({ eventId: id, startsAt: start, endsAt: end }),
        now: end + 5 * 60_000,
      });
    }
    const records = await store.list(guildId);
    assert.equal(records.length, 55);
    assert.ok(records[0]!.event.startsAt > records.at(-1)!.event.startsAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
