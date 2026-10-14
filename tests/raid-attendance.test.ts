import assert from "node:assert/strict";
import test from "node:test";
import type { CoreAttendanceEvent } from "../src/core-attendance.js";
import { isAttendedStatus, perfectAttendanceMembers, refreshRaidAttendance } from "../src/raid-attendance.js";
import type { CoreRosterSnapshot } from "../src/core-roster.js";
import type { RaidHelperEvent } from "../src/ready.js";

const guildId = "123456789012345600";
const memberA = { discordUserId: "123456789012345601", displayName: "Original Alpha" };
const memberB = { discordUserId: "123456789012345602", displayName: "Original Bravo" };
const currentMember = { discordUserId: "123456789012345603", displayName: "Current Charlie" };
const guest = { discordUserId: "123456789012345604", displayName: "Guest Delta" };

function roster(members = [memberA, currentMember]): CoreRosterSnapshot {
  return {
    sourceChannelId: "123456789012345610",
    sourceMessageId: "123456789012345611",
    sourceUrl: "https://discord.com/channels/123456789012345600/123456789012345610/123456789012345611",
    updatedAt: 99_000,
    members,
  };
}

function snapshot(eventId: string, startsAt: number, capturedAt = startsAt - 1_000): CoreAttendanceEvent {
  return {
    eventId,
    title: "Pizza Core ICC25",
    startsAt,
    capturedAt,
    rosterUpdatedAt: 12_345,
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

test("refreshes completed status from Raid-Helper while preserving the event-time roster", async () => {
  const source = snapshot("123456789012345620", 1_000_000);
  const original = structuredClone(source);
  const result = await refreshRaidAttendance({
    roster: roster(),
    sourceEvents: [source],
    guildId,
    now: source.startsAt + 5 * 60 * 60_000,
    fetchEvent: async () => fresh(source, { signups: [
      { ...memberA, displayName: "Renamed Alpha", status: "Absent" },
      { ...memberB, displayName: "Renamed Bravo", status: "Signed" },
      { ...guest, status: "Signed" },
    ] }),
  });

  assert.equal(result.requestedRaids, 1);
  assert.equal(result.unavailableRaids, 0);
  assert.deepEqual(result.unavailableEventIds, []);
  assert.equal(result.history.events.length, 1);
  assert.deepEqual(result.history.events[0], {
    ...original,
    entries: [
      { ...memberA, status: "Absent" },
      { ...memberB, status: "Signed" },
    ],
  });
  assert.deepEqual(source, original, "the saved pre-raid snapshot must remain unchanged");
  assert.deepEqual(result.history.members.map((member) => member.displayName).sort(), [memberA.displayName, currentMember.displayName].sort());
  assert.equal(result.history.members.some((member) => member.discordUserId === memberB.discordUserId), false, "former members must remain in event rows without reappearing in the current-core summary");
  assert.deepEqual(result.history.members.find((member) => member.discordUserId === currentMember.discordUserId)?.statuses, [undefined], "current newcomers must remain untracked for historical raids");
  assert.equal(result.history.members.some((member) => member.discordUserId === guest.discordUserId), false, "fresh signup guests must not enter core history");
});

test("maps a missing final signup to Missing and preserves Late as a separate status", async () => {
  const source = snapshot("123456789012345621", 2_000_000);
  const result = await refreshRaidAttendance({
    roster: roster([memberA, memberB]), sourceEvents: [source], guildId, now: source.startsAt + 5 * 60 * 60_000,
    fetchEvent: async () => fresh(source, { signups: [{ ...memberA, status: "Late" }] }),
  });
  assert.deepEqual(result.history.events[0]?.entries.map((entry) => entry.status), ["Late", "Missing"]);
  assert.equal(result.history.members.find((member) => member.discordUserId === memberB.discordUserId)?.missingCount, 1);
});

test("stops at the default eight completed or unavailable slots", async () => {
  const now = 40_000_000;
  const sources = Array.from({ length: 12 }, (_, index) => snapshot(`12345678901234567${index}`, now - (index + 1) * 100_000));
  let calls = 0;
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: sources, guildId, now,
    fetchEvent: async (id) => {
      calls++;
      const source = sources.find((entry) => entry.eventId === id)!;
      return fresh(source, { endsAt: now - 1 });
    },
  });
  assert.equal(calls, 8);
  assert.equal(result.requestedRaids, 8);
  assert.equal(result.history.events.length, 8);
});

test("skips future and in-progress raids, then fills the window from older completed raids", async () => {
  const now = 10_000_000;
  const future = snapshot("123456789012345630", now + 1_000);
  const durationInProgress = snapshot("123456789012345631", now - 60 * 60_000);
  const unknownEndInProgress = snapshot("123456789012345632", now - 17 * 60 * 60_000);
  const unknownEndComplete = snapshot("123456789012345633", now - 19 * 60 * 60_000);
  const explicitComplete = snapshot("123456789012345634", now - 30 * 60 * 60_000);
  const fetched: string[] = [];
  const byId = new Map([
    [durationInProgress.eventId, fresh(durationInProgress, { endsAt: now + 3 * 60 * 60_000 })],
    [unknownEndInProgress.eventId, fresh(unknownEndInProgress, { endsAt: undefined })],
    [unknownEndComplete.eventId, fresh(unknownEndComplete, { endsAt: undefined })],
    [explicitComplete.eventId, fresh(explicitComplete)],
  ]);
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [explicitComplete, future, unknownEndComplete, durationInProgress, unknownEndInProgress],
    guildId, limit: 2, now,
    fetchEvent: async (id) => {
      fetched.push(id);
      const event = byId.get(id);
      if (!event) throw new Error("unexpected event");
      return event;
    },
  });

  assert.deepEqual(fetched, [durationInProgress.eventId, unknownEndInProgress.eventId, unknownEndComplete.eventId, explicitComplete.eventId]);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [explicitComplete.eventId, unknownEndComplete.eventId]);
  assert.equal(result.requestedRaids, 2);
  assert.equal(result.unavailableRaids, 0);
  assert.deepEqual(result.unavailableEventIds, []);
});

test("keeps failed and unverifiable reads in coverage without an older success hiding them", async () => {
  const now = 50_000_000;
  const failed = snapshot("123456789012345640", now - 19 * 60 * 60_000);
  const wrongGuild = snapshot("123456789012345641", now - 20 * 60 * 60_000);
  const olderSuccess = snapshot("123456789012345642", now - 21 * 60 * 60_000);
  const hiddenSuccess = snapshot("123456789012345643", now - 22 * 60 * 60_000);
  const fetched: string[] = [];
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [hiddenSuccess, wrongGuild, olderSuccess, failed], guildId, limit: 3, now,
    fetchEvent: async (id) => {
      fetched.push(id);
      if (id === failed.eventId) throw new Error("404");
      if (id === wrongGuild.eventId) return fresh(wrongGuild, { guildId: "123456789012345699" });
      return fresh(id === olderSuccess.eventId ? olderSuccess : hiddenSuccess, { endsAt: now - 1 });
    },
  });

  assert.deepEqual(fetched, [failed.eventId, wrongGuild.eventId, olderSuccess.eventId]);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [olderSuccess.eventId, wrongGuild.eventId, failed.eventId]);
  assert.equal(result.requestedRaids, 3);
  assert.equal(result.unavailableRaids, 2);
  assert.deepEqual(result.unavailableEventIds, [failed.eventId, wrongGuild.eventId]);
});

test("a recent unreadable raid does not displace an older completed raid", async () => {
  const now = 80_000_000;
  const recentUnreadable = snapshot("123456789012345644", now - 30_000);
  const completed = snapshot("123456789012345645", now - 24 * 60 * 60_000);
  const fetched: string[] = [];
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: [completed, recentUnreadable], guildId, limit: 1, now,
    fetchEvent: async (id) => {
      fetched.push(id);
      if (id === recentUnreadable.eventId) throw new Error("temporary Raid-Helper failure");
      return fresh(completed, { endsAt: now - 1 });
    },
  });
  assert.deepEqual(fetched, [recentUnreadable.eventId, completed.eventId]);
  assert.equal(result.requestedRaids, 1);
  assert.equal(result.unavailableRaids, 0);
  assert.deepEqual(result.unavailableEventIds, []);
  assert.deepEqual(result.history.events.map((event) => event.eventId), [completed.eventId]);
});

test("retains an unavailable saved Missing row with its event-time name and provenance", async () => {
  const now = 90_000_000;
  const source = snapshot("123456789012345646", now - 24 * 60 * 60_000);
  source.entries = [{ discordUserId: memberA.discordUserId, displayName: "Saved Alpha", status: "Missing" }];
  const original = structuredClone(source);
  const result = await refreshRaidAttendance({
    roster: roster([{ discordUserId: memberA.discordUserId, displayName: "Current Alpha" }]),
    sourceEvents: [source], guildId, now,
    fetchEvent: async () => { throw new Error("404"); },
  });
  assert.deepEqual(result.history.events, [original]);
  assert.deepEqual(result.unavailableEventIds, [source.eventId]);
  assert.equal(result.unavailableRaids, 1);
  assert.equal(result.history.members[0]?.displayName, "Current Alpha");
  assert.deepEqual(result.history.members[0]?.statuses, ["Missing"]);
  assert.deepEqual(source, original, "fallback provenance must not mutate the saved snapshot");
});

test("uses Signed or Tentative for a complete eight-event attendance window without shrinking unavailable rows", async () => {
  const now = 900_000_000;
  const always = { discordUserId: "123456789012345701", displayName: "Always" };
  const late = { discordUserId: "123456789012345702", displayName: "Late once" };
  const bench = { discordUserId: "123456789012345703", displayName: "Benched once" };
  const absent = { discordUserId: "123456789012345704", displayName: "Absent once" };
  const missing = { discordUserId: "123456789012345705", displayName: "Missing once" };
  const newcomer = { discordUserId: "123456789012345706", displayName: "Newcomer" };
  const members = [always, late, bench, absent, missing];
  const sources = Array.from({ length: 8 }, (_, index): CoreAttendanceEvent => ({
    ...snapshot(`12345678901234572${index}`, now - (19 * 60 * 60_000 + index * 100_000)),
    entries: members.map((member) => ({
      ...member,
      status: member === always
        ? (index % 2 === 0 ? "Signed" : "Tentative")
        : index !== 0
          ? "Signed"
          : member === late
            ? "Late"
            : member === bench
              ? "Bench"
              : member === absent
                ? "Absent"
                : "Missing",
    })),
  }));
  const unavailable = sources[3]!;
  const result = await refreshRaidAttendance({
    roster: roster([...members, newcomer]), sourceEvents: sources, guildId, now,
    fetchEvent: async (id) => {
      const source = sources.find((event) => event.eventId === id)!;
      if (source === unavailable) throw new Error("historical event unavailable");
      return fresh(source, {
        endsAt: now - 1,
        signups: source.entries.flatMap((entry) => entry.status === "Missing" ? [] : [{
          discordUserId: entry.discordUserId,
          displayName: entry.displayName,
          status: entry.status,
        }]),
      });
    },
  });

  assert.equal(isAttendedStatus("Signed"), true);
  assert.equal(isAttendedStatus("Tentative"), true);
  for (const status of ["Late", "Bench", "Absent", "Missing", undefined] as const) assert.equal(isAttendedStatus(status), false);
  assert.equal(result.requestedRaids, 8);
  assert.equal(result.history.events.length, 8);
  assert.deepEqual(result.unavailableEventIds, [unavailable.eventId]);
  assert.deepEqual(perfectAttendanceMembers(result).map((member) => member.displayName), [always.displayName]);
  assert.deepEqual(perfectAttendanceMembers({ ...result, requestedRaids: 9 }), [], "an incomplete window cannot produce perfect attendance");
  assert.equal(result.history.members.find((member) => member.discordUserId === late.discordUserId)?.statuses.length, 8);
  assert.equal(result.history.members.find((member) => member.discordUserId === newcomer.discordUserId)?.trackedCount, 0);
});

test("rejects each event identity mismatch and fails closed without a guild", async () => {
  const now = 100_000_000;
  const sources = Array.from({ length: 5 }, (_, index) => snapshot(`12345678901234565${index}`, now - (19 * 60 * 60_000 + index * 100_000)));
  const mismatches: Array<Partial<RaidHelperEvent>> = [
    { eventId: "123456789012345659" },
    { title: "Pizza Raid ICC25" },
    { guildId: undefined },
    { startsAt: sources[3]!.startsAt + 1_000 },
  ];
  const result = await refreshRaidAttendance({
    roster: roster(), sourceEvents: sources, guildId, limit: 5, now,
    fetchEvent: async (id) => {
      const index = sources.findIndex((source) => source.eventId === id);
      if (index === 4) throw new Error("unavailable");
      return fresh(sources[index]!, mismatches[index]);
    },
  });
  assert.equal(result.requestedRaids, 5);
  assert.equal(result.unavailableRaids, 5);
  assert.equal(result.history.events.length, 5);
  assert.equal(result.history.members.length, 2);
  assert.deepEqual(result.unavailableEventIds, sources.map((source) => source.eventId));

  let calls = 0;
  const noGuild = await refreshRaidAttendance({
    roster: roster(), sourceEvents: sources, guildId: "", limit: 3, now,
    fetchEvent: async () => { calls++; throw new Error("must not fetch"); },
  });
  assert.equal(calls, 0);
  assert.equal(noGuild.requestedRaids, 3);
  assert.equal(noGuild.unavailableRaids, 3);
  assert.deepEqual(noGuild.unavailableEventIds, sources.slice(0, 3).map((source) => source.eventId));
  assert.equal(noGuild.history.events.length, 0);
});
