import assert from "node:assert/strict";
import { buildReadyReport, parseRaidHelperSignups, RaiderLinks } from "../src/ready.js";
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
  { discordUserId: "123456789012345678", displayName: "Lausudo", reportedSpec: "Protection", status: "Signed" },
  { discordUserId: "123456789012345679", displayName: "Qwark", reportedSpec: "Retribution", status: "Signed" },
  { discordUserId: "123456789012345680", displayName: "Benchwarrior", reportedSpec: "Fury", status: "Bench" },
  { discordUserId: "123456789012345681", displayName: "Maybepriest", reportedSpec: "Discipline", status: "Tentative" },
  { discordUserId: "123456789012345682", displayName: "Awaymage", status: "Absent" },
]);

const v4Signups = parseRaidHelperSignups({
  signUps: [
    { userId: "123456789012345690", name: "Activepal", cClassName: "Paladin", specName: "Retribution", status: "primary" },
    { userId: "123456789012345691", name: "Benchdruid", cClassName: "Bench", specName: "Feral", status: "primary" },
    { userId: "123456789012345692", name: "Awayrogue", cClassName: "Absence", status: "primary" },
  ],
});

assert.deepEqual(v4Signups, [
  { discordUserId: "123456789012345690", displayName: "Activepal", reportedSpec: "Retribution", status: "Signed" },
  { discordUserId: "123456789012345691", displayName: "Benchdruid", reportedSpec: "Feral", status: "Bench" },
  { discordUserId: "123456789012345692", displayName: "Awayrogue", status: "Absent" },
]);

async function verifyReadyReportUsesEventNameAndSpec(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const armoryCalls: Array<{ name: string; realm: string }> = [];
  const armory = {
    async getCharacter(name: string, realm: string) {
      armoryCalls.push({ name, realm });
      return {
        armoryUrl: "https://armory.warmane.com/example",
        className: "Paladin",
        primarySpec: "Protection", // Must never replace the event's selection.
        items: [{ id: 1, slot: "Head", name: "Test helm", itemLevel: 264, quality: "epic", equipLoc: "INVTYPE_HEAD" as const }],
      };
    },
  } as unknown as WarmaneArmory;
  const links = new RaiderLinks();
  (links as unknown as { store: Record<string, { name: string; realm: string }> }).store = {
    "guild:123456789012345699": { name: "FallbackCharacter", realm: "Icecrown" },
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "1538061412356722709",
    title: "Test raid",
    signUps: [
      { userId: "123456789012345699", name: "EventCharacter", cClassName: "Paladin", specName: "Retribution", status: "primary" },
      { userId: "123456789012345698", name: "BenchCharacter", cClassName: "Bench", specName: "Feral", status: "primary" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const report = await buildReadyReport({ event: "1538061412356722709", realm: "Lordaeron", guildId: "guild", armory, links });
    assert.deepEqual(armoryCalls, [{ name: "EventCharacter", realm: "Lordaeron" }]);
    assert.equal(report.signups.length, 2);
    assert.equal(report.activeSignups.length, 1);
    assert.equal(report.members[0]?.signup.displayName, "EventCharacter");
    assert.equal(report.members[0]?.specName, "Retribution");
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
