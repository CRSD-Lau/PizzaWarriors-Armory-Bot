import assert from "node:assert/strict";
import test from "node:test";
import { AttendanceCollector, ATTENDANCE_POLL_MS, type AttendanceCollectorDependencies } from "../src/attendance-collector.js";
import type { CoreAttendanceEvent } from "../src/core-attendance.js";
import type { CoreRosterSnapshot } from "../src/core-roster.js";
import { RaidHelperEventError, type RaidHelperEvent } from "../src/ready.js";

const guildId = "123456789012345600";
const member = { discordUserId: "123456789012345601", displayName: "Core Raider" };
const guest = { discordUserId: "123456789012345602", displayName: "Guest Raider" };
const startsAt = 200_000_000;
const raid: RaidHelperEvent = { eventId: "123456789012345610", guildId, title: "Pizza Core ICC25", startsAt,
  endsAt: startsAt + 4 * 60 * 60_000, signups: [{ ...member, status: "Signed" }] };
const roster: CoreRosterSnapshot = { sourceChannelId: guildId, sourceMessageId: guildId, sourceUrl: "https://discord.com/channels/example",
  updatedAt: 1, members: [member] };
function snapshot(event = raid): CoreAttendanceEvent {
  return { eventId: event.eventId, title: event.title, startsAt: event.startsAt!, capturedAt: startsAt - 1,
    rosterUpdatedAt: 1, entries: [{ ...member, status: "Signed" }] };
}
function harness() {
  let now = startsAt - 60_000;
  let provider = structuredClone(raid);
  let snapshots: CoreAttendanceEvent[] = [];
  const finals: Array<{ event: CoreAttendanceEvent }> = [];
  const saved: Array<{ event: RaidHelperEvent; baseline: CoreAttendanceEvent | undefined }> = [];
  let roleReads = 0;
  let providerReads = 0;
  let discoverFailure = false;
  let providerError: Error | undefined;
  const deps: AttendanceCollectorDependencies = {
    guildId, now: () => now, listSnapshots: async () => structuredClone(snapshots), listFinals: async () => structuredClone(finals),
    discoverEvents: async () => { if (discoverFailure) throw new Error("Discovery offline"); return [structuredClone(provider)]; },
    fetchEvent: async () => { providerReads++; if (providerError) throw providerError; return structuredClone(provider); },
    currentRoster: async () => { roleReads++; return roster; },
    saveSnapshot: async (event, current, time) => {
      const record = { ...snapshot(event), capturedAt: time, entries: current.members.map((item) => ({ ...item, status: "Signed" as const })) };
      snapshots = [record]; return record;
    },
    saveFinal: async (event, baseline) => { saved.push({ event: structuredClone(event), baseline }); finals.push({ event: snapshot(event) }); return true; },
  };
  return { deps, finals, saved, setNow: (value: number) => { now = value; }, setProvider: (value: RaidHelperEvent) => { provider = value; },
    setSnapshots: (value: CoreAttendanceEvent[]) => { snapshots = value; }, failDiscovery: () => { discoverFailure = true; },
    failProvider: (value?: Error) => { providerError = value; }, roleReads: () => roleReads, providerReads: () => providerReads };
}

test("collector discovers without a command, freezes pre-start membership and fetches a fresh final roster", async () => {
  const h = harness(); const collector = new AttendanceCollector(h.deps);
  await collector.runOnce();
  assert.equal(h.roleReads(), 1);
  assert.equal(h.saved.length, 0);
  h.setNow(startsAt + 1); await collector.runOnce();
  assert.equal(h.roleReads(), 1, "must never read today's role to rebuild started-raid membership");
  assert.equal(h.saved.length, 0);
  h.setProvider({ ...raid, signups: [{ ...guest, status: "Tentative" }] });
  h.setNow(raid.endsAt! + 5 * 60_000 + 1); await collector.runOnce();
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0]!.event.signups, [{ ...guest, status: "Tentative" }]);
  assert.deepEqual(h.saved[0]!.baseline?.entries, [{ ...member, status: "Signed" }]);
  h.setNow(raid.endsAt! + 10 * 60_000); await collector.runOnce();
  assert.equal(h.saved.length, 1, "finalized raids must not be repeatedly captured by the background worker");
  assert.equal(collector.health().lastError, undefined);
});

test("restart catches completed raids even if discovery is down and does not duplicate an archive", async () => {
  const h = harness(); h.setSnapshots([snapshot()]); h.setNow(raid.endsAt! + 6 * 60_000); h.failDiscovery();
  await new AttendanceCollector(h.deps).runOnce();
  assert.equal(h.saved.length, 1);
  assert.equal(h.roleReads(), 0);
  await new AttendanceCollector(h.deps).runOnce();
  assert.equal(h.saved.length, 1);
});

test("completed discovery without a baseline saves provider evidence without today's role", async () => {
  const h = harness(); h.setNow(raid.endsAt! + 6 * 60_000);
  await new AttendanceCollector(h.deps).runOnce();
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0]!.baseline, undefined);
  assert.equal(h.roleReads(), 0);
});

test("transient failures retry without overwriting records; overlapping ticks share one pass", async () => {
  const h = harness(); h.setSnapshots([snapshot()]); h.setNow(raid.endsAt! + 6 * 60_000);
  h.failProvider(new Error("network unavailable"));
  const collector = new AttendanceCollector(h.deps);
  await Promise.all([collector.runOnce(), collector.runOnce()]);
  assert.equal(h.providerReads(), 1);
  assert.equal(h.saved.length, 0);
  assert.ok(collector.health().lastError);
  h.failProvider(); h.setNow(raid.endsAt! + 6 * 60_000 + ATTENDANCE_POLL_MS);
  await collector.runOnce();
  assert.equal(h.saved.length, 1);
  assert.equal(collector.health().lastError, undefined);
});

test("unavailable historical events are omitted quietly and retried with a bounded delay", async () => {
  const h = harness(); h.setSnapshots([snapshot()]); h.setNow(raid.endsAt! + 6 * 60_000);
  h.failProvider(new RaidHelperEventError(404)); const collector = new AttendanceCollector(h.deps);
  await collector.runOnce();
  h.setNow(raid.endsAt! + 12 * 60_000); await collector.runOnce();
  assert.equal(h.providerReads(), 1);
  assert.equal(h.saved.length, 0);
  assert.equal(collector.health().lastError, undefined);
});

test("foreign events and returned identity mismatches cannot be captured", async () => {
  const h = harness(); h.setSnapshots([snapshot()]); h.setNow(raid.endsAt! + 6 * 60_000);
  h.setProvider({ ...raid, guildId: "123456789012345699" });
  await new AttendanceCollector(h.deps).runOnce();
  assert.equal(h.saved.length, 0);
  assert.equal(h.roleReads(), 0);
});
