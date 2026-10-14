import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CoreAttendanceEvent } from "../src/core-attendance.js";
import { FinalAttendanceStore, finalAttendanceDueAt } from "../src/final-attendance.js";
import { isAttendedStatus, perfectAttendanceMembers, refreshRaidAttendance } from "../src/raid-attendance.js";
import type { CoreRosterSnapshot } from "../src/core-roster.js";
import type { RaidHelperEvent } from "../src/ready.js";

const guildId = "123456789012345600";
const memberA = { discordUserId: "123456789012345601", displayName: "Original Alpha" };
const memberB = { discordUserId: "123456789012345602", displayName: "Original Bravo" };
const newcomer = { discordUserId: "123456789012345603", displayName: "Current Charlie" };
const guest = { discordUserId: "123456789012345604", displayName: "Guest Delta" };
const baseNow = 2_000_000_000_000;

function roster(members = [memberA, newcomer]): CoreRosterSnapshot {
  return {
    sourceChannelId: "123456789012345610",
    sourceMessageId: "123456789012345611",
    sourceUrl: "https://discord.com/channels/123456789012345600/123456789012345610/123456789012345611",
    updatedAt: baseNow - 1_000,
    members,
  };
}

function snapshot(eventId: string, startsAt: number): CoreAttendanceEvent {
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
  };
}

function fresh(source: CoreAttendanceEvent, overrides: Partial<RaidHelperEvent> = {}): RaidHelperEvent {
  return {
    eventId: source.eventId,
    title: source.title,
    startsAt: source.startsAt,
    endsAt: source.startsAt + 4 * 60 * 60_000,
    guildId,
    signups: [],
    ...overrides,
  };
}

test("renders a completed fresh roster while preserving frozen core membership", async () => {
  const source = snapshot("123456789012345620", baseNow - 24 * 60 * 60_000);
  const original = structuredClone(source);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [source], guildId, now: baseNow,
    fetchEvent: async () => fresh(source, { signups: [
      { ...memberA, displayName: "Renamed Alpha", status: "Tentative" },
      { ...memberB, displayName: "Renamed Bravo", status: "Signed" },
      { ...guest, status: "Signed" },
    ] }),
  });

  assert.equal(result.requestedRaids, 1);
  assert.equal(result.unavailableRaids, 0);
  assert.deepEqual(result.history.events[0]?.entries, [
    { ...memberA, status: "Tentative" },
    { ...memberB, status: "Signed" },
  ]);
  assert.equal(result.history.events[0]?.capturedAt, baseNow);
  assert.deepEqual(source, original, "fresh rendering must not mutate the pre-raid snapshot");
  assert.deepEqual(result.history.members.find((member) => member.discordUserId === newcomer.discordUserId)?.statuses, [undefined]);
  assert.equal(result.history.members.some((member) => member.discordUserId === guest.discordUserId), false);
});

test("maps absent provider members to Missing and keeps Late distinct", async () => {
  const source = snapshot("123456789012345621", baseNow - 24 * 60 * 60_000);
  const result = await refreshRaidAttendance({
    roster: roster([memberA, memberB]), sourceEvents: [source], guildId, now: baseNow,
    fetchEvent: async () => fresh(source, { signups: [{ ...memberA, status: "Late" }] }),
  });
  assert.deepEqual(result.history.events[0]?.entries.map((entry) => entry.status), ["Late", "Missing"]);
});

test("stops after the default eight available final records", async () => {
  const sources = Array.from({ length: 12 }, (_, index) => snapshot(`12345678901234567${index}`, baseNow - (index + 1) * 24 * 60 * 60_000));
  let calls = 0;
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: sources, guildId, now: baseNow,
    fetchEvent: async (id) => {
      calls++;
      return fresh(sources.find((source) => source.eventId === id)!, { signups: [{ ...memberA, status: "Signed" }] });
    },
  });
  assert.equal(calls, 8);
  assert.equal(result.requestedRaids, 8);
  assert.equal(result.history.events.length, 8);
});

test("skips future and in-progress events and fills from older completed records", async () => {
  const future = snapshot("123456789012345630", baseNow + 60_000);
  const explicitInProgress = snapshot("123456789012345631", baseNow - 60 * 60_000);
  const unknownInProgress = snapshot("123456789012345632", baseNow - 17 * 60 * 60_000);
  const unknownComplete = snapshot("123456789012345633", baseNow - 19 * 60 * 60_000);
  const explicitComplete = snapshot("123456789012345634", baseNow - 30 * 60 * 60_000);
  const byId = new Map([
    [explicitInProgress.eventId, fresh(explicitInProgress, { endsAt: baseNow + 60 * 60_000 })],
    [unknownInProgress.eventId, fresh(unknownInProgress, { endsAt: undefined })],
    [unknownComplete.eventId, fresh(unknownComplete, { endsAt: undefined })],
    [explicitComplete.eventId, fresh(explicitComplete)],
  ]);
  const fetched: string[] = [];
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [explicitComplete, future, unknownComplete, explicitInProgress, unknownInProgress],
    guildId, limit: 2, now: baseNow,
    fetchEvent: async (id) => { fetched.push(id); return byId.get(id)!; },
  });
  assert.deepEqual(fetched, [explicitInProgress.eventId, unknownInProgress.eventId, unknownComplete.eventId, explicitComplete.eventId]);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [explicitComplete.eventId, unknownComplete.eventId]);
  assert.equal(result.requestedRaids, 2);
});

test("uses safely completed saved core snapshots when provider reads fail or mismatch", async () => {
  const failed = snapshot("123456789012345640", baseNow - 24 * 60 * 60_000);
  const wrongGuild = snapshot("123456789012345641", baseNow - 25 * 60 * 60_000);
  const successA = snapshot("123456789012345642", baseNow - 26 * 60 * 60_000);
  const successB = snapshot("123456789012345643", baseNow - 27 * 60 * 60_000);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [successB, wrongGuild, successA, failed], guildId, limit: 4, now: baseNow,
    fetchEvent: async (id) => {
      if (id === failed.eventId) throw new Error("404");
      if (id === wrongGuild.eventId) return fresh(wrongGuild, { guildId: "123456789012345699" });
      const source = id === successA.eventId ? successA : successB;
      return fresh(source, { signups: [{ ...memberA, status: "Signed" }] });
    },
  });
  assert.deepEqual(result.history.events.map((event) => event.eventId), [successB.eventId, successA.eventId, wrongGuild.eventId, failed.eventId]);
  assert.deepEqual(result.unavailableEventIds, []);
  assert.equal(result.requestedRaids, 4);
  assert.equal(result.history.events.find((event) => event.eventId === failed.eventId)?.entries[1]?.status, "Absent");
});

test("returns the latest eight raids from six final archives and two saved legacy snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-eight-week-history-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const finals = Array.from({ length: 6 }, (_, index) => snapshot(
      `1234567890123457${index}`,
      baseNow - (index + 1) * 24 * 60 * 60_000,
    ));
    for (const source of finals) {
      const event = fresh(source, { signups: [
        { ...memberA, status: "Signed" },
        { ...memberB, status: "Signed" },
      ] });
      await store.capture({ guildId, event, snapshot: source, now: finalAttendanceDueAt(event)! });
    }
    const legacyA = {
      ...snapshot("123456789012345780", baseNow - 7 * 24 * 60 * 60_000),
      entries: [
        { ...memberA, status: "Missing" as const },
        { ...memberB, status: "Signed" as const },
      ],
    };
    const legacyB = snapshot("123456789012345781", baseNow - 8 * 24 * 60 * 60_000);
    const outsideWindow = snapshot("123456789012345789", baseNow - 9 * 24 * 60 * 60_000);
    const fetched: string[] = [];

    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [outsideWindow, legacyB, legacyA], guildId, limit: 8, now: baseNow, finalStore: store,
      fetchEvent: async (id) => {
        fetched.push(id);
        const source = finals.find((candidate) => candidate.eventId === id);
        if (!source) throw new Error("legacy Raid-Helper event was deleted");
        return fresh(source, { signups: [
          { ...memberA, status: "Signed" },
          { ...memberB, status: "Signed" },
        ] });
      },
    });

    assert.equal(result.requestedRaids, 8);
    assert.deepEqual(result.history.events.map((event) => event.eventId), [
      legacyB.eventId,
      legacyA.eventId,
      ...finals.map((event) => event.eventId).reverse(),
    ]);
    assert.deepEqual(result.unavailableEventIds, []);
    assert.equal(fetched.includes(outsideWindow.eventId), false, "the eight-week window must not expand to older candidates");
    assert.deepEqual(perfectAttendanceMembers(result), [], "a legacy Missing status must block 100% attendance");
    assert.deepEqual(
      result.history.members.find((member) => member.discordUserId === newcomer.discordUserId)?.statuses,
      Array.from({ length: 8 }, () => undefined),
      "members who joined later must remain untracked in historical records",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not substitute an old-enough snapshot while a valid provider event is still in progress", async () => {
  const ongoing = snapshot("123456789012345784", baseNow - 19 * 60 * 60_000);
  ongoing.entries[0]!.status = "Signed";
  const completed = snapshot("123456789012345785", baseNow - 30 * 60 * 60_000);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [completed, ongoing], guildId, limit: 2, now: baseNow,
    fetchEvent: async (id) => id === ongoing.eventId
      ? fresh(ongoing, { endsAt: baseNow + 60_000, signups: [{ ...memberA, status: "Signed" }] })
      : fresh(completed, { signups: [{ ...memberA, status: "Signed" }] }),
  });

  assert.deepEqual(result.history.events.map((event) => event.eventId), [completed.eventId]);
  assert.equal(result.requestedRaids, 1);
  assert.deepEqual(result.unavailableEventIds, []);
});

test("excludes invalid IDs and non-core saved candidates before fetching attendance", async () => {
  const invalid = snapshot("not-a-discord-id", baseNow - 20 * 60 * 60_000);
  const nonCore = { ...snapshot("123456789012345786", baseNow - 21 * 60 * 60_000), title: "Community Alt Run" };
  const valid = snapshot("123456789012345787", baseNow - 22 * 60 * 60_000);
  const fetched: string[] = [];
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [valid, nonCore, invalid], guildId, now: baseNow,
    fetchEvent: async (id) => {
      fetched.push(id);
      if (id !== valid.eventId) throw new Error("invalid candidates must not be fetched");
      return fresh(valid, { signups: [{ ...memberA, status: "Signed" }] });
    },
  });

  assert.deepEqual(fetched, [valid.eventId]);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [valid.eventId]);
  assert.deepEqual(result.unavailableEventIds, []);
});

test("prefers a durable final archive over a stale saved snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-precedence-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const stale = snapshot("123456789012345782", baseNow - 24 * 60 * 60_000);
    stale.entries[0]!.status = "Missing";
    const archiveBasis = snapshot(stale.eventId, stale.startsAt);
    const event = fresh(archiveBasis, { signups: [
      { ...memberA, status: "Tentative" },
      { ...memberB, status: "Signed" },
    ] });
    await store.capture({ guildId, event, snapshot: archiveBasis, now: finalAttendanceDueAt(event)! });

    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [stale], guildId, now: baseNow, finalStore: store,
      fetchEvent: async () => { throw new Error("offline"); },
    });

    assert.equal(result.history.events[0]?.entries[0]?.status, "Tentative");
    assert.equal((await store.get(guildId, stale.eventId))?.event.entries[0]?.status, "Tentative");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reads a legacy snapshot without mutating it or promoting it into the final archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-legacy-readonly-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const source = snapshot("123456789012345783", baseNow - 24 * 60 * 60_000);
    const original = structuredClone(source);

    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [source], guildId, now: baseNow, finalStore: store,
      fetchEvent: async () => { throw new Error("deleted"); },
    });

    assert.equal(result.requestedRaids, 1);
    assert.deepEqual(result.history.events[0], original);
    assert.deepEqual(source, original);
    assert.deepEqual(await store.list(guildId), [], "legacy fallback must remain separate from durable final records");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires the unknown-end eighteen-hour safety window plus five-minute grace", async () => {
  const threshold = 18 * 60 * 60_000 + 5 * 60_000;
  const safelyCompleted = snapshot("123456789012345788", baseNow - threshold);
  const stillInsideGrace = snapshot("123456789012345798", baseNow - threshold + 1);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [safelyCompleted, stillInsideGrace], guildId, limit: 2, now: baseNow,
    fetchEvent: async () => { throw new Error("deleted"); },
  });

  assert.deepEqual(result.history.events.map((event) => event.eventId), [safelyCompleted.eventId]);
  assert.deepEqual(result.unavailableEventIds, []);
});

test("a recent failed read is neither historical attendance nor unavailable coverage", async () => {
  const recent = snapshot("123456789012345644", baseNow - 30_000);
  const completed = snapshot("123456789012345645", baseNow - 24 * 60 * 60_000);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [completed, recent], guildId, limit: 1, now: baseNow,
    fetchEvent: async (id) => {
      if (id === recent.eventId) throw new Error("temporary outage");
      return fresh(completed, { signups: [{ ...memberA, status: "Signed" }] });
    },
  });
  assert.deepEqual(result.unavailableEventIds, []);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [completed.eventId]);
});

test("falls back to a durable final record on provider outage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-refresh-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const source = snapshot("123456789012345646", baseNow - 24 * 60 * 60_000);
    const event = fresh(source, { signups: [{ ...memberA, status: "Tentative" }] });
    const dueAt = finalAttendanceDueAt(event)!;
    await store.capture({ guildId, event, snapshot: source, now: dueAt });

    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [source], guildId, now: baseNow, finalStore: new FinalAttendanceStore(join(directory, "final-attendance.json")),
      fetchEvent: async () => { throw new Error("404"); },
    });
    assert.equal(result.requestedRaids, 1);
    assert.equal(result.unavailableRaids, 0);
    assert.deepEqual(result.history.events[0]?.entries.map((entry) => entry.status), ["Tentative", "Missing"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an archive without a core snapshot never invents historical Missing members from the current role", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-provider-basis-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const source = snapshot("123456789012345650", baseNow - 24 * 60 * 60_000);
    const event = fresh(source, { signups: [{ ...memberA, status: "Signed" }] });
    await store.capture({ guildId, event, now: finalAttendanceDueAt(event)! });
    const result = await refreshRaidAttendance({
      roster: roster([memberA, memberB]), sourceEvents: [], guildId, now: baseNow, finalStore: store,
      fetchEvent: async () => { throw new Error("offline"); },
    });
    assert.deepEqual(result.history.events[0]?.entries, [{ ...memberA, status: "Signed" }]);
    assert.deepEqual(result.history.members.find((member) => member.discordUserId === memberB.discordUserId)?.statuses, [undefined]);
    assert.equal(result.history.members.find((member) => member.discordUserId === memberB.discordUserId)?.missingCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not replace an archive when the source snapshot identity mismatches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-identity-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const source = snapshot("123456789012345647", baseNow - 24 * 60 * 60_000);
    const event = fresh(source, { signups: [{ ...memberA, status: "Signed" }] });
    await store.capture({ guildId, event, snapshot: source, now: finalAttendanceDueAt(event)! });
    let calls = 0;
    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [{ ...source, startsAt: source.startsAt + 1 }], guildId, now: baseNow, finalStore: store,
      fetchEvent: async () => { calls++; return fresh(source, { signups: [{ ...memberA, status: "Absent" }] }); },
    });
    assert.equal(calls, 0);
    assert.equal(result.history.events[0]?.entries[0]?.status, "Signed");
    assert.equal((await store.get(guildId, source.eventId))?.event.entries[0]?.status, "Signed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists newer final corrections through the shared store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-final-correction-"));
  try {
    const store = new FinalAttendanceStore(join(directory, "final-attendance.json"));
    const source = snapshot("123456789012345648", baseNow - 24 * 60 * 60_000);
    const first = fresh(source, { signups: [{ ...memberA, status: "Absent" }] });
    await store.capture({ guildId, event: first, snapshot: source, now: finalAttendanceDueAt(first)! });
    const result = await refreshRaidAttendance({
      roster: roster(), sourceEvents: [source], guildId, now: baseNow, finalStore: store,
      fetchEvent: async () => fresh(source, { signups: [{ ...memberA, status: "Tentative" }] }),
    });
    assert.equal(result.history.events[0]?.entries[0]?.status, "Tentative");
    assert.equal((await store.get(guildId, source.eventId))?.event.entries[0]?.status, "Tentative");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attendance helpers require a nonempty included window and fail closed for invalid guilds", async () => {
  assert.equal(isAttendedStatus("Signed"), true);
  assert.equal(isAttendedStatus("Tentative"), true);
  for (const status of ["Late", "Bench", "Absent", "Missing", undefined] as const) assert.equal(isAttendedStatus(status), false);

  let calls = 0;
  const source = snapshot("123456789012345649", baseNow - 24 * 60 * 60_000);
  const summary = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [source], guildId: "", now: baseNow,
    fetchEvent: async () => { calls++; return fresh(source); },
  });
  assert.equal(calls, 0);
  assert.equal(summary.history.events.length, 0);
  assert.equal(summary.requestedRaids, 0);
  assert.deepEqual(perfectAttendanceMembers(summary), []);
});
