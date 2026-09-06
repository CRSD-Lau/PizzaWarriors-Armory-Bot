import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, JsonStore, JsonStoreError } from "../src/json-store.js";
import { auditCoreRoster, CoreRosterStore, type CoreRosterSnapshot } from "../src/core-roster.js";
import { CoreAttendanceStore } from "../src/core-attendance.js";
import { RaiderLinks, RecentReadyEvents } from "../src/raider-state.js";

const guildId = "123456789012345600";
const otherGuildId = "123456789012345601";
const memberA = "123456789012345602";
const memberB = "123456789012345603";
const eventA = "123456789012345604";
const eventB = "123456789012345605";
const roster: CoreRosterSnapshot = {
  sourceChannelId: "123456789012345606",
  sourceMessageId: "123456789012345607",
  sourceUrl: `https://discord.com/channels/${guildId}/123456789012345606/123456789012345607`,
  updatedAt: 1_000,
  members: [{ discordUserId: memberA, displayName: "First raider" }],
};

function parseCounter(value: unknown): { count: number } {
  if (typeof value !== "object" || value === null || !("count" in value)
    || typeof value.count !== "number" || !Number.isFinite(value.count)) throw new Error("Invalid counter.");
  return { count: value.count };
}

const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-persistence-"));
try {
  const counterPath = join(directory, "counter.json");
  await atomicWriteJson(counterPath, { count: 7 });
  const counter = new JsonStore(counterPath, parseCounter, () => ({ count: 0 }));
  await Promise.all(Array.from({ length: 30 }, () => counter.update((draft) => { draft.count++; })));
  assert.deepEqual(await counter.read(), { count: 37 }, "concurrent initial loads must not lose mutations");
  assert.deepEqual(await new JsonStore(counterPath, parseCounter, () => ({ count: 0 })).read(), { count: 37 });
  const snapshot = await counter.read();
  snapshot.count = 500;
  assert.equal((await counter.read()).count, 37, "readers must not mutate the stored state by reference");

  let rejectWrite = true;
  const recoverable = new JsonStore(counterPath, parseCounter, () => ({ count: 0 }), async (filePath, value) => {
    if (rejectWrite) throw Object.assign(new Error("Simulated disk failure"), { code: "EIO" });
    await atomicWriteJson(filePath, value);
  });
  const beforeFailedWrite = await readFile(counterPath, "utf8");
  await assert.rejects(recoverable.update((draft) => { draft.count = 900; }), JsonStoreError);
  assert.equal(await readFile(counterPath, "utf8"), beforeFailedWrite);
  assert.equal((await recoverable.read()).count, 37, "failed writes must roll back the in-memory mutation");
  rejectWrite = false;
  await recoverable.update((draft) => { draft.count++; });
  assert.equal((await recoverable.read()).count, 38, "the transaction queue must recover after a failed write");
  const beforeInvalidMutation = await readFile(counterPath, "utf8");
  await assert.rejects(recoverable.update((draft) => { draft.count = Number.NaN; }), JsonStoreError);
  assert.equal(await readFile(counterPath, "utf8"), beforeInvalidMutation);
  assert.equal((await recoverable.read()).count, 38);

  await assert.rejects(atomicWriteJson(counterPath, { count: 1n }), TypeError);
  assert.equal(await readFile(counterPath, "utf8"), beforeInvalidMutation, "serialization failures must leave the original file intact");
  const blockedTarget = join(directory, "blocked.json");
  await mkdir(blockedTarget);
  await writeFile(join(blockedTarget, "sentinel.txt"), "unchanged");
  await assert.rejects(atomicWriteJson(blockedTarget, { count: 1 }));
  assert.equal(await readFile(join(blockedTarget, "sentinel.txt"), "utf8"), "unchanged");
  assert.equal((await readdir(directory)).some((entry) => entry.endsWith(".tmp")), false, "failed replacement cleans only its own temporary file");

  const linksPath = join(directory, "raider-links.json");
  const links = new RaiderLinks(linksPath);
  await Promise.all([
    links.set(guildId, memberA, { name: "First", realm: "Lordaeron" }),
    links.set(guildId, memberB, { name: "Second", realm: "Icecrown" }),
  ]);
  const reloadedLinks = new RaiderLinks(linksPath);
  assert.deepEqual(await reloadedLinks.get(guildId, memberA), { name: "First", realm: "Lordaeron" });
  assert.deepEqual(await reloadedLinks.get(guildId, memberB), { name: "Second", realm: "Icecrown" });
  await Promise.all([links.remove(guildId, memberA), links.set(otherGuildId, memberA, { name: "Alt", realm: "Lordaeron" })]);
  const afterRemoval = new RaiderLinks(linksPath);
  assert.equal(await afterRemoval.get(guildId, memberA), undefined);
  assert.equal((await afterRemoval.get(guildId, memberB))?.name, "Second");
  assert.equal((await afterRemoval.get(otherGuildId, memberA))?.name, "Alt");

  const eventsPath = join(directory, "recent-ready-events.json");
  const events = new RecentReadyEvents(eventsPath);
  await Promise.all([
    events.rememberCore(guildId, { eventId: eventA, title: "Pizza Core ICC25" }),
    events.rememberCore(guildId, { eventId: eventB, title: "Pizza Core ICC25 next" }),
    events.rememberCore(otherGuildId, { eventId: eventA, title: "Pizza Core ICC25" }),
    events.rememberCore(guildId, { eventId: "123456789012345699", title: "Casual raid" }),
  ]);
  const reloadedEvents = new RecentReadyEvents(eventsPath);
  assert.deepEqual((await reloadedEvents.listCore(guildId)).map((event) => event.eventId), [eventB, eventA]);
  assert.equal((await reloadedEvents.core(otherGuildId))?.eventId, eventA);

  const rostersPath = join(directory, "core-rosters.json");
  const rosters = new CoreRosterStore(rostersPath);
  await Promise.all([
    rosters.setRoster(guildId, roster),
    rosters.setRoster(otherGuildId, { ...roster, members: [{ discordUserId: memberB, displayName: "Second raider" }] }),
    rosters.recordPing(guildId, eventA, "missing-first", 2_000),
  ]);
  const reloadedRosters = new CoreRosterStore(rostersPath);
  assert.equal((await reloadedRosters.getRoster(guildId))?.members[0].discordUserId, memberA);
  assert.equal((await reloadedRosters.getRoster(otherGuildId))?.members[0].discordUserId, memberB);
  assert.equal((await reloadedRosters.recentMatchingPing(guildId, eventA, "missing-first", 2_100))?.sentAt, 2_000);

  const attendancePath = join(directory, "core-attendance.json");
  const attendance = new CoreAttendanceStore(attendancePath);
  const audit = auditCoreRoster(roster, []);
  await Promise.all([
    attendance.record({ guildId, eventId: eventA, title: "Pizza Core ICC25", startsAt: 10_000, audit }),
    attendance.record({ guildId, eventId: eventB, title: "Pizza Core ICC25", startsAt: 20_000, audit }),
  ]);
  assert.deepEqual((await new CoreAttendanceStore(attendancePath).list(guildId)).map((event) => event.eventId), [eventB, eventA]);

  const invalidCases: Array<{ name: string; invalid: string; mutate: (filePath: string) => Promise<unknown> }> = [
    { name: "invalid-json", invalid: '{"private":"must not be exposed",', mutate: (path) => new RaiderLinks(path).set(guildId, memberA, { name: "First", realm: "Lordaeron" }) },
    { name: "invalid-links", invalid: JSON.stringify({ [`${guildId}:${memberA}`]: { name: 42, realm: "Lordaeron" } }), mutate: (path) => new RaiderLinks(path).set(guildId, memberB, { name: "Second", realm: "Lordaeron" }) },
    { name: "invalid-events", invalid: JSON.stringify({ [guildId]: [{ eventId: eventA, title: 42, usedAt: 1 }] }), mutate: (path) => new RecentReadyEvents(path).rememberCore(guildId, { eventId: eventB, title: "Pizza Core ICC25" }) },
    { name: "invalid-roster", invalid: JSON.stringify({ version: 1, guilds: { [guildId]: { roster: { ...roster, members: [{ discordUserId: memberA, displayName: 42 }] } } } }), mutate: (path) => new CoreRosterStore(path).recordPing(guildId, eventA, "missing", 3_000) },
    { name: "invalid-attendance", invalid: JSON.stringify({ version: 1, guilds: { [guildId]: { events: [{ eventId: eventA, title: "Pizza Core ICC25", startsAt: 1, capturedAt: 2, rosterUpdatedAt: 0, entries: [{ discordUserId: memberA, displayName: "First", status: "INVALID" }] }] } } }), mutate: (path) => new CoreAttendanceStore(path).record({ guildId, eventId: eventB, title: "Pizza Core ICC25", audit }) },
    { name: "future-version", invalid: JSON.stringify({ version: 2, guilds: {} }), mutate: (path) => new CoreRosterStore(path).setRoster(guildId, roster) },
  ];
  for (const testCase of invalidCases) {
    const filePath = join(directory, `${testCase.name}.json`);
    await writeFile(filePath, testCase.invalid);
    await assert.rejects(testCase.mutate(filePath), (error: unknown) => {
      assert.ok(error instanceof JsonStoreError);
      assert.doesNotMatch(error.message, /must not be exposed/);
      return true;
    });
    assert.equal(await readFile(filePath, "utf8"), testCase.invalid, `${testCase.name} must remain available for recovery`);
  }
  const unreadable = new RaiderLinks(blockedTarget);
  await assert.rejects(unreadable.set(guildId, memberA, { name: "First", realm: "Lordaeron" }), JsonStoreError);
  assert.equal(await readFile(join(blockedTarget, "sentinel.txt"), "utf8"), "unchanged", "non-ENOENT read failures are not empty stores");

  console.log("Atomic JSON persistence and private-store regression tests passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
