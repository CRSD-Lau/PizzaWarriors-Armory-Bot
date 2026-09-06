import assert from "node:assert/strict";
import { buildReadyReport, eventIdFromInput, parseRaidHelperSignups, RaiderLinks, selectCurrentPizzaCoreEvent } from "../src/ready.js";
import { raidSignupNameColor } from "../src/card.js";
import type { WarmaneArmory } from "../src/armory.js";

const signups = parseRaidHelperSignups({
  title: "Pizza ICC 25",
  signups: {
    signed: {
      "123456789012345678": { name: "Lausudo", specs: ["Protection"] },
      "123456789012345679": { display_name: "Qwark", spec: "Retribution" },
    },
    bench: {
      "123456789012345680": { name: "Benchwarrior", spec: "Fury" },
    },
    tentative: {
      "123456789012345681": { name: "Maybepriest", spec: "Discipline" },
    },
    absence: {
      "123456789012345682": { name: "Awaymage" },
    },
  },
});

assert.deepEqual(signups, [
  { discordUserId: "123456789012345678", displayName: "Lausudo", reportedSpec: "Protection", reportedRole: "Tanks", status: "Signed" },
  { discordUserId: "123456789012345679", displayName: "Qwark", reportedSpec: "Retribution", reportedRole: "Melee", status: "Signed" },
  { discordUserId: "123456789012345680", displayName: "Benchwarrior", reportedSpec: "Fury", reportedRole: "Melee", status: "Bench" },
  { discordUserId: "123456789012345681", displayName: "Maybepriest", reportedSpec: "Discipline", reportedRole: "Healers", status: "Tentative" },
  { discordUserId: "123456789012345682", displayName: "Awaymage", status: "Absent" },
]);

const v4Signups = parseRaidHelperSignups({
  signUps: [
    { userId: "123456789012345690", name: "Activepal", cClassName: "Paladin", specName: "Retribution", roleName: "Melee", status: "primary" },
    { userId: "123456789012345693", name: "Fathermonster", cClassName: "Paladin", cSpecName: "Holy1", cRoleName: "Healers", status: "primary" },
    { userId: "123456789012345694", name: "Nanie", cClassName: "Shaman", cSpecName: "Elemental", cRoleName: "Ranged", status: "primary" },
    { userId: "123456789012345691", name: "Benchdruid", cClassName: "Bench", specName: "Feral", status: "primary" },
    { userId: "123456789012345692", name: "Awayrogue", cClassName: "Absence", status: "primary" },
  ],
});

assert.deepEqual(v4Signups, [
  { discordUserId: "123456789012345690", displayName: "Activepal", reportedClass: "Paladin", reportedSpec: "Retribution", reportedRole: "Melee", status: "Signed" },
  { discordUserId: "123456789012345693", displayName: "Fathermonster", reportedClass: "Paladin", reportedSpec: "Holy1", reportedRole: "Healers", status: "Signed" },
  { discordUserId: "123456789012345694", displayName: "Nanie", reportedClass: "Shaman", reportedSpec: "Elemental", reportedRole: "Ranged", status: "Signed" },
  { discordUserId: "123456789012345691", displayName: "Benchdruid", reportedSpec: "Feral", reportedRole: "Melee", status: "Bench" },
  { discordUserId: "123456789012345692", displayName: "Awayrogue", status: "Absent" },
]);

assert.equal(raidSignupNameColor(v4Signups[1]!), "#f58cba", "unresolved Holy Paladins must remain Paladin pink");
assert.equal(raidSignupNameColor(v4Signups[2]!), "#0070de", "unresolved Elemental Shamans must remain Shaman blue");
assert.equal(raidSignupNameColor({}), "#f1f3f7", "unknown classes keep the neutral fallback");

assert.equal(
  eventIdFromInput("https://discord.com/channels/613250899548307466/1517578708704170045/1540594340462592054"),
  "1540594340462592054",
  "Discord message links must resolve to the final message/event ID",
);

const oldCoreEvent = { eventId: "1", title: "Pizza Core ICC25", startsAt: Date.UTC(2026, 7, 22, 2), signups: [] };
const currentCoreEvent = { eventId: "2", title: "Pizza Core ICC25", startsAt: Date.UTC(2026, 7, 29, 2), signups: [] };
const otherRaid = { eventId: "3", title: "Brother Raid Pt. 1", startsAt: Date.UTC(2026, 7, 30, 2), signups: [] };
assert.equal(
  selectCurrentPizzaCoreEvent([oldCoreEvent, otherRaid, currentCoreEvent], Date.UTC(2026, 7, 28, 12))?.eventId,
  currentCoreEvent.eventId,
);
assert.equal(
  selectCurrentPizzaCoreEvent([oldCoreEvent], Date.UTC(2026, 7, 28, 12)),
  undefined,
  "a completed saved event must not become the plain /ready default",
);
assert.equal(
  selectCurrentPizzaCoreEvent([
    currentCoreEvent,
    { ...currentCoreEvent, eventId: "4", startsAt: Date.UTC(2026, 8, 5, 2) },
  ], Date.UTC(2026, 7, 29, 4))?.eventId,
  currentCoreEvent.eventId,
  "the raid that recently started must win over next week's signup",
);

async function verifyReadyReportUsesEventNameAndSpec(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const armoryCalls: Array<{ name: string; realm: string }> = [];
  const armory = {
    async getCharacterSummary(name: string, realm: string) {
      armoryCalls.push({ name, realm });
      return {
        armoryUrl: "https://armory.warmane.com/example",
        className: "Warlock", // Must never replace Raid-Helper's selected class.
        primarySpec: "Affliction", // Must never replace the event's selected spec.
        items: [{ id: 1, slot: "Head", name: "Test helm", itemLevel: 264, quality: "epic", equipLoc: "INVTYPE_HEAD" as const }],
      };
    },
  } as unknown as WarmaneArmory;
  const links = new RaiderLinks();
  links.get = async (guildId, discordUserId) => guildId === "guild" && discordUserId === "123456789012345699"
    ? { name: "FallbackCharacter", realm: "Icecrown" }
    : undefined;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "1538061412356722709",
    title: "Test raid",
    startTime: 1_787_364_000,
    signUps: [
      { userId: "123456789012345699", name: "Drancor", cClassName: "Shaman", specName: "Elemental", roleName: "Ranged", status: "primary" },
      { userId: "123456789012345698", name: "BenchCharacter", cClassName: "Bench", specName: "Feral", status: "primary" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const report = await buildReadyReport({ event: "1538061412356722709", realm: "Lordaeron", guildId: "guild", armory, links });
    assert.deepEqual(armoryCalls, [{ name: "Drancor", realm: "Lordaeron" }]);
    assert.equal(report.signups.length, 2);
    assert.equal(report.activeSignups.length, 1);
    assert.equal(report.eventStartsAt, 1_787_364_000_000);
    assert.equal(report.members[0]?.signup.displayName, "Drancor");
    assert.equal(report.members[0]?.signup.reportedClass, "Shaman");
    assert.equal(report.members[0]?.className, "Shaman");
    assert.equal(report.members[0]?.specName, "Elemental");
    assert.equal(report.members[0]?.signup.reportedRole, "Ranged");
    assert.equal(report.signups[1]?.status, "Bench");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

verifyReadyReportUsesEventNameAndSpec().then(() => {
  console.log("Raid-Helper signup parsing tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
