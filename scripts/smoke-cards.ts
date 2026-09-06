// Author and last modified by: Neil Mitchell.
// Local-only visual verification. All characters, events, and guild members below are synthetic.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ArmoryCardRenderer } from "../src/card.js";
import { auditCoreRoster, type CoreRosterSnapshot } from "../src/core-roster.js";
import { buildCoreAttendanceHistory, type CoreAttendanceEvent } from "../src/core-attendance.js";
import { auditGearPreparation } from "../src/gear-audit.js";
import { calculateGearScore, type GearItem, type GearScoreEquipLoc } from "../src/gearscore.js";
import type { GuildRoster } from "../src/guild.js";
import type { RaidSignup, ReadyMember, ReadyReport } from "../src/ready.js";
import type { UpgradeProfile } from "../src/upgrade.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, ".cache", "card-smoke");
const fixtureNow = Date.UTC(2026, 8, 6, 12);
const injectionText = "O'Neil <b data-smoke-injected> & Co";
const escapedText = "O&#39;Neil &lt;b data-smoke-injected&gt; &amp; Co";
const localLogo = await readFile(join(root, "assets", "pizzawarriors-armory-discord-icon-1024.png"));

const equipment: Array<[string, GearScoreEquipLoc]> = [
  ["Head", "INVTYPE_HEAD"], ["Neck", "INVTYPE_NECK"], ["Shoulder", "INVTYPE_SHOULDER"],
  ["Back", "INVTYPE_CLOAK"], ["Chest", "INVTYPE_CHEST"], ["Shirt", "INVTYPE_BODY"],
  ["Wrist", "INVTYPE_WRIST"], ["Hands", "INVTYPE_HAND"], ["Waist", "INVTYPE_WAIST"],
  ["Legs", "INVTYPE_LEGS"], ["Feet", "INVTYPE_FEET"], ["Ring 1", "INVTYPE_FINGER"],
  ["Ring 2", "INVTYPE_FINGER"], ["Trinket 1", "INVTYPE_TRINKET"], ["Trinket 2", "INVTYPE_TRINKET"],
  ["Main Hand", "INVTYPE_WEAPONMAINHAND"], ["Off Hand", "INVTYPE_SHIELD"], ["Ranged", "INVTYPE_RELIC"],
];
const items: GearItem[] = equipment.map(([slot, equipLoc], index) => ({
  id: 900_000 + index, slot, equipLoc,
  name: index === 0 ? injectionText : `Demonstration ${slot}`,
  itemLevel: slot === "Shirt" ? 1 : index % 2 ? 264 : 277,
  quality: slot === "Shirt" ? "common" : "epic",
  auditDataAvailable: true, enchantId: 1, socketCount: slot === "Shirt" ? 0 : 1,
  gemIds: [1, 2],
}));
const summary = calculateGearScore(items);
assert.ok(summary);
const preparation = auditGearPreparation(items, [], "Paladin");
assert.equal(preparation.status, "complete");

const signup = (number: number, displayName: string, status: RaidSignup["status"],
  reportedClass?: string, reportedSpec?: string, reportedRole?: RaidSignup["reportedRole"]): RaidSignup => ({
  discordUserId: `123456789012345${String(number).padStart(3, "0")}`,
  displayName, status, reportedClass, reportedSpec, reportedRole,
});
const signups: RaidSignup[] = [
  signup(1, injectionText, "Signed", "Paladin", "Protection", "Tanks"),
  signup(2, "Demo Healer", "Signed", "Priest", "Discipline", "Healers"),
  signup(3, "Demo Melee", "Signed", "Warrior", "Fury", "Melee"),
  signup(4, "Demo Shaman", "Signed", "Shaman", "Elemental", "Ranged"),
  signup(5, "Guest Mage", "Signed", "Mage", "Fire", "Ranged"),
  signup(6, "Tentative Raider", "Tentative"),
  signup(7, "Absent Raider", "Absent"),
  signup(8, "Benched Raider", "Bench"),
];
const coreRoster: CoreRosterSnapshot = {
  sourceChannelId: "123456789012346000", sourceMessageId: "123456789012346001",
  sourceUrl: "https://discord.com/channels/123456789012340000/123456789012346000/123456789012346001",
  updatedAt: fixtureNow,
  members: [
    ...signups.filter((member) => member.displayName !== "Guest Mage").map(({ discordUserId, displayName }) => ({ discordUserId, displayName })),
    { discordUserId: "123456789012345009", displayName: "Missing Raider" },
  ],
};
const coreAudit = auditCoreRoster(coreRoster, signups);
const activeSignups = signups.filter((member) => member.status === "Signed");
const members: ReadyMember[] = activeSignups.map((member, index) => ({
  signup: member, characterName: member.displayName, className: member.reportedClass,
  specName: member.reportedSpec, summary,
  preparation: index === 3 ? { ...preparation, status: "unverified" } : preparation,
  freshness: { fetchedAt: index === 3 ? fixtureNow - 60 * 60_000 : fixtureNow, stale: index === 3 },
  armoryUrl: "https://armory.warmane.com/character/Demonstration/Lordaeron/summary",
}));
const report: ReadyReport = {
  eventId: "123456789012349000", eventTitle: "Pizza Core ICC25 · Demonstration", eventStartsAt: fixtureNow,
  signups, activeSignups, members, unresolved: [],
};
const events: CoreAttendanceEvent[] = Array.from({ length: 4 }, (_, week) => ({
  eventId: `12345678901234900${week}`, title: "Pizza Core ICC25 · Demonstration",
  startsAt: fixtureNow - (3 - week) * 7 * 24 * 60 * 60_000,
  capturedAt: fixtureNow, rosterUpdatedAt: fixtureNow,
  entries: coreAudit.entries.map((entry, index) => ({
    discordUserId: entry.discordUserId, displayName: entry.displayName,
    status: index === 0 && week === 0 ? "Missing" : entry.status,
  })),
}));
const history = buildCoreAttendanceHistory(coreRoster, events);
const profile: UpgradeProfile = {
  id: "visual-smoke", className: "Paladin", specName: "Protection", status: "research", content: "ICC / Ruby Sanctum",
  reviewNote: "Synthetic local visual fixture only.",
  sources: [{ title: "Demonstration item targets", url: "https://example.invalid/fixture", publishedYear: 2026, note: "Synthetic fixture" }],
  targets: items.filter((item) => item.slot !== "Shirt").map((item, index) => ({
    id: index % 2 ? item.id + 100 : item.id, slot: item.slot, name: item.name, icon: "smoke_fixture",
  })),
};
const roster: GuildRoster = {
  guildName: injectionText, realm: "Lordaeron", faction: "Alliance", memberCount: 10,
  armoryUrl: "https://armory.warmane.com/guild/Demonstration/Lordaeron/summary",
  members: Array.from({ length: 10 }, (_, index) => ({
    name: index ? `Demo Raider ${index + 1}` : injectionText,
    race: "Human", className: ["Paladin", "Shaman", "Mage", "Warrior", "Priest"][index % 5],
    faction: "Alliance", level: 80, rank: index ? "Core Raider" : "Guild Master", achievementPoints: 7_000 - index * 250,
    professions: [],
  })),
};

let contextsCreated = 0;
let contextsClosed = 0;
let htmlChecks = 0;
let mockedIcons = 0;
const unexpectedRequests: string[] = [];
const originalLaunch = chromium.launch;
const originalNow = Date.now;
const renderer = new ArmoryCardRenderer();

// Instrument only this isolated process: inspect the real rendered DOM and fulfil icons from disk.
chromium.launch = async (options) => {
  assert.equal(options?.headless, true, "the visual smoke browser must stay hidden");
  const browser = await originalLaunch.call(chromium, options);
  const originalContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await originalContext(options);
    contextsCreated++;
    context.once("close", () => { contextsClosed++; });
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://wow.zamimg.com/images/wow/icons/large/smoke_fixture.jpg") {
        mockedIcons++;
        await route.fulfill({ status: 200, contentType: "image/png", body: localLogo });
      } else {
        unexpectedRequests.push(url);
        await route.abort();
      }
    });
    const originalPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await originalPage();
      const setContent = page.setContent.bind(page);
      page.setContent = async (html, options) => {
        assert.ok(html.includes(escapedText), "fixture punctuation and HTML must be escaped in every card");
        await setContent(html, options);
        const inspection = await page.evaluate((literal) => ({
          injectedElements: document.querySelectorAll("[data-smoke-injected]").length,
          containsLiteralName: document.querySelector(".card")?.textContent?.includes(literal),
        }), injectionText);
        assert.equal(inspection.injectedElements, 0);
        assert.equal(inspection.containsLiteralName, true);
        htmlChecks++;
      };
      return page;
    };
    return context;
  };
  return browser;
};

const results: Array<{ card: string; path: string; width: number; height: number; bytes: number }> = [];
try {
  Date.now = () => fixtureNow;
  await mkdir(output, { recursive: true });
  const renders: Array<[string, () => Promise<Buffer>]> = [
    ["armory", () => renderer.render({ name: injectionText, realm: "Lordaeron", className: "Paladin", primarySpec: "Protection", items, summary })],
    ["upgrade", () => renderer.renderUpgrade({ name: injectionText, realm: "Lordaeron", className: "Paladin", specName: "Protection", profile, items })],
    ["ready", () => renderer.renderReady({ report, realm: "Lordaeron", coreRoster: coreAudit })],
    ["attendance", () => renderer.renderAttendance({ history })],
    ["roster", () => renderer.renderRoster({ roster, page: 0, pageSize: 10 })],
  ];
  for (const [card, render] of renders) {
    const png = await render();
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.toString("ascii", 12, 16), "IHDR");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert.ok(width >= 2_616 && height > 0, `${card} must retain its high-resolution PNG dimensions`);
    const path = join(output, `${card}.png`);
    await writeFile(path, png);
    results.push({ card, path, width, height, bytes: png.length });
  }
  assert.equal(htmlChecks, 5);
  assert.equal(contextsCreated, 5);
  assert.equal(contextsClosed, 5);
  assert.ok(mockedIcons > 0, "upgrade target icons must be served by the local mock");
  assert.deepEqual(unexpectedRequests, [], "rendering must not initiate unexpected page requests");
} finally {
  await renderer.close();
  chromium.launch = originalLaunch;
  Date.now = originalNow;
}
console.log(JSON.stringify({ ok: true, syntheticFixtures: true, networkRequestsAllowed: 0, htmlChecks, contextsClosed, results }, null, 2));
