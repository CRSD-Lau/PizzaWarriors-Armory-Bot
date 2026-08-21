import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditCoreRoster,
  CORE_PING_COOLDOWN_MS,
  coreReminderText,
  CoreRosterStore,
  type CoreRosterSnapshot,
} from "../src/core-roster.js";
import type { RaidSignup } from "../src/ready.js";

const roster: CoreRosterSnapshot = {
  sourceChannelId: "123456789012345670",
  sourceMessageId: "123456789012345671",
  sourceUrl: "https://discord.com/channels/123456789012345672/123456789012345670/123456789012345671",
  updatedAt: 1_000,
  members: [
    { discordUserId: "123456789012345601", displayName: "Signed core" },
    { discordUserId: "123456789012345602", displayName: "Late core" },
    { discordUserId: "123456789012345603", displayName: "Tentative core" },
    { discordUserId: "123456789012345604", displayName: "Benched core" },
    { discordUserId: "123456789012345605", displayName: "Absent core" },
    { discordUserId: "123456789012345606", displayName: "Missing core" },
  ],
};

const signups: RaidSignup[] = [
  { discordUserId: "123456789012345601", displayName: "Signedchar", status: "Signed" },
  { discordUserId: "123456789012345602", displayName: "Latechar", status: "Late" },
  { discordUserId: "123456789012345603", displayName: "Tentativechar", status: "Tentative" },
  { discordUserId: "123456789012345604", displayName: "Benchchar", status: "Bench" },
  { discordUserId: "123456789012345605", displayName: "Absentchar", status: "Absent" },
  { discordUserId: "123456789012345699", displayName: "Noncore", status: "Signed" },
];

const audit = auditCoreRoster(roster, signups);
assert.equal(audit.entries.length, 6);
assert.equal(audit.respondedCount, 5);
assert.equal(audit.signed.length, 1);
assert.equal(audit.late.length, 1);
assert.equal(audit.tentative.length, 1);
assert.equal(audit.bench.length, 1);
assert.equal(audit.absent.length, 1);
assert.equal(audit.missing.length, 1);
assert.deepEqual(audit.actionable.map((entry) => [entry.discordUserId, entry.status]), [
  ["123456789012345606", "Missing"],
]);
assert.match(coreReminderText(audit), /Not signed up.*<@123456789012345606>/);
assert.doesNotMatch(coreReminderText(audit), /123456789012345603/);
assert.doesNotMatch(coreReminderText(audit), /123456789012345604/);
assert.doesNotMatch(coreReminderText(audit), /123456789012345605/);

async function verifyPersistenceAndCooldown(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-core-roster-"));
  const filePath = join(directory, "core-rosters.json");
  try {
    const store = new CoreRosterStore(filePath);
    const saved = await store.setRoster("123456789012345672", {
      sourceChannelId: roster.sourceChannelId,
      sourceMessageId: roster.sourceMessageId,
      sourceUrl: roster.sourceUrl,
      members: [...roster.members, roster.members[0]],
    }, 2_000);
    assert.equal(saved.members.length, roster.members.length, "duplicate Discord IDs must be removed");
    assert.equal(saved.updatedAt, 2_000);

    const reloaded = await new CoreRosterStore(filePath).getRoster("123456789012345672");
    assert.deepEqual(reloaded, saved);

    assert.equal(await store.recentMatchingPing("123456789012345672", "123456789012345673", audit.fingerprint, 10_000), undefined);
    await store.recordPing("123456789012345672", "123456789012345673", audit.fingerprint, 10_000);
    assert.deepEqual(await store.recentMatchingPing("123456789012345672", "123456789012345673", audit.fingerprint, 11_000), {
      fingerprint: audit.fingerprint,
      sentAt: 10_000,
    });
    assert.equal(await store.recentMatchingPing("123456789012345672", "123456789012345673", "changed", 11_000), undefined);
    assert.equal(await store.recentMatchingPing("123456789012345672", "123456789012345673", audit.fingerprint, 10_000 + CORE_PING_COOLDOWN_MS), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

verifyPersistenceAndCooldown().then(() => {
  console.log("Pizza Core roster comparison tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
