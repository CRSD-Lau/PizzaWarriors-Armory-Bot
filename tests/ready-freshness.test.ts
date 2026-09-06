import assert from "node:assert/strict";
import { buildReadyReport, getRaidHelperEvent, isCurrentGuildCoreEvent, type RaidHelperEvent } from "../src/ready.js";
import type { RaiderLinks } from "../src/raider-state.js";
import type { ArmoryCharacter, WarmaneArmory } from "../src/armory.js";

const event: RaidHelperEvent = {
  eventId: "123456789012345678", title: "Pizza Core ICC25", startsAt: Date.now(), guildId: "123456789012345681",
  signups: [
    { discordUserId: "123456789012345679", displayName: "Raider", status: "Signed", reportedClass: "Shaman", reportedSpec: "Elemental", reportedRole: "Ranged" },
    { discordUserId: "123456789012345680", displayName: "Away", status: "Absent" },
  ],
};
assert.equal(isCurrentGuildCoreEvent(event, event.guildId!), true);
assert.equal(isCurrentGuildCoreEvent(event, "123456789012345682"), false, "another server's identical title cannot authorize core actions");
assert.equal(isCurrentGuildCoreEvent({ ...event, guildId: undefined }, event.guildId!), false, "missing server ownership fails closed");
assert.equal(isCurrentGuildCoreEvent({ ...event, startsAt: Date.now() - 7 * 86_400_000 }, event.guildId!), false, "historical reads cannot overwrite today's core history");
const character: ArmoryCharacter = {
  armoryUrl: "https://armory.warmane.com/example", className: "Mage", primarySpec: "Fire",
  items: [{ id: 1, name: "Test helm", slot: "Head", itemLevel: 264, quality: "epic", equipLoc: "INVTYPE_HEAD" }],
  gearAudit: { status: "complete", missingEnchants: [], missingGems: [], unverifiedSlots: [], requiredEnchants: 1, presentEnchants: 1, requiredGems: 0, presentGems: 0 },
  freshness: { fetchedAt: Date.now() - 60 * 60_000, stale: true },
};
let lookups = 0;
const armory = { async getCharacterSummary() { lookups++; return character; } } as unknown as WarmaneArmory;
const links = { async get() { return undefined; } } as unknown as RaiderLinks;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Selected event must not be refetched"); };
try {
  const report = await buildReadyReport({ event, realm: "Lordaeron", guildId: "guild", armory, links });
  assert.equal(lookups, 1, "no gear lookup for deliberate absence");
  assert.equal(report.signups.length, 2);
  assert.equal(report.eventGuildId, event.guildId);
  assert.equal(report.members[0]?.preparation.status, "unverified");
  assert.equal(report.members[0]?.freshness?.stale, true);
  assert.equal(report.members[0]?.className, "Shaman");
  assert.equal(report.members[0]?.specName, "Elemental");
  assert.equal(character.gearAudit?.status, "complete", "must not mutate the cached audit");
  character.freshness = { fetchedAt: Date.now(), stale: false };
  assert.equal((await buildReadyReport({ event, realm: "Lordaeron", guildId: "guild", armory, links })).members[0]?.preparation.status, "complete");
  for (const key of ["serverId", "server_id", "guildId", "guild_id"]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ [key]: event.guildId, title: event.title, startTime: event.startsAt, signUps: [] }));
    assert.equal((await getRaidHelperEvent(event.eventId)).guildId, event.guildId);
  }
} finally { globalThis.fetch = originalFetch; }
console.log("Ready event snapshot and stale-gear tests passed.");
