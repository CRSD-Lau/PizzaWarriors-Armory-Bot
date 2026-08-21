import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoreAttendanceHistory, CoreAttendanceStore } from "../src/core-attendance.js";
import { auditCoreRoster, type CoreRosterSnapshot } from "../src/core-roster.js";
import type { RaidSignup } from "../src/ready.js";

const guildId = "123456789012345672";
const firstEventId = "123456789012345673";
const secondEventId = "123456789012345674";
const memberA = { discordUserId: "123456789012345601", displayName: "Always responds" };
const memberB = { discordUserId: "123456789012345602", displayName: "Missed once" };
const formerMember = { discordUserId: "123456789012345603", displayName: "Former core" };
const newMember = { discordUserId: "123456789012345604", displayName: "New core" };

function roster(members: CoreRosterSnapshot["members"], updatedAt: number): CoreRosterSnapshot {
  return {
    sourceChannelId: "123456789012345670",
    sourceMessageId: "123456789012345671",
    sourceUrl: "https://discord.com/channels/123456789012345672/123456789012345670/123456789012345671",
    updatedAt,
    members,
  };
}

function signup(discordUserId: string, displayName: string, status: RaidSignup["status"]): RaidSignup {
  return { discordUserId, displayName, status };
}

async function verifyAttendanceHistory(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pizzawarriors-core-attendance-"));
  const filePath = join(directory, "core-attendance.json");
  try {
    const store = new CoreAttendanceStore(filePath);
    const firstRoster = roster([memberA, memberB, formerMember], 1_000);
    await store.record({
      guildId,
      eventId: firstEventId,
      title: "Pizza Core ICC25",
      startsAt: 10_000,
      capturedAt: 11_000,
      audit: auditCoreRoster(firstRoster, [
        signup(memberA.discordUserId, "Alwayschar", "Signed"),
        signup(formerMember.discordUserId, "Formerchar", "Absent"),
      ]),
    });

    const currentRoster = roster([memberA, memberB, newMember], 2_000);
    await store.record({
      guildId,
      eventId: secondEventId,
      title: "Pizza Core ICC25",
      startsAt: 20_000,
      capturedAt: 21_000,
      audit: auditCoreRoster(currentRoster, [
        signup(memberA.discordUserId, "Alwayschar", "Signed"),
        signup(memberB.discordUserId, "Maybechar", "Tentative"),
      ]),
    });

    assert.equal(await store.hasEvent(guildId, firstEventId), true);
    assert.deepEqual((await store.list(guildId)).map((event) => event.eventId), [secondEventId, firstEventId]);

    const history = buildCoreAttendanceHistory(currentRoster, await store.list(guildId), 8);
    assert.deepEqual(history.events.map((event) => event.eventId), [firstEventId, secondEventId]);
    assert.equal(history.missingSignups, 2);
    assert.equal(history.explicitAbsences, 0, "former members should not clutter the current-core report");
    assert.equal(history.trackedResponses, 5, "weeks before a new member joined must remain untracked");
    assert.equal(history.responseRate, 60);
    assert.equal(history.reliableMembers, 1);
    assert.deepEqual(history.members.map((member) => [member.displayName, member.statuses]), [
      [memberB.displayName, ["Missing", "Tentative"]],
      [newMember.displayName, [undefined, "Missing"]],
      [memberA.displayName, ["Signed", "Signed"]],
    ]);

    await store.record({
      guildId,
      eventId: secondEventId,
      title: "Pizza Core ICC25",
      startsAt: 20_000,
      capturedAt: 22_000,
      audit: auditCoreRoster(currentRoster, [
        signup(memberA.discordUserId, "Alwayschar", "Signed"),
        signup(memberB.discordUserId, "Backchar", "Signed"),
        signup(newMember.discordUserId, "Newchar", "Signed"),
      ]),
    });
    assert.equal((await store.list(guildId)).length, 2, "refreshing one event must replace rather than duplicate it");

    const reloaded = new CoreAttendanceStore(filePath);
    const refreshed = buildCoreAttendanceHistory(currentRoster, await reloaded.list(guildId), 8);
    assert.equal(refreshed.missingSignups, 1);
    assert.equal(refreshed.responseRate, 80);
    assert.equal(refreshed.reliableMembers, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

verifyAttendanceHistory().then(() => {
  console.log("Pizza Core attendance history tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
