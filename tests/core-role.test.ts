import assert from "node:assert/strict";
import { CoreRoleRosterError, coreMembersFromGuildPage, fetchCoreRoleMembers, roleBackedCoreRoster } from "../src/core-role.js";

const guildId = "123456789012345670";
const roleId = "123456789012345671";
const firstMemberId = "123456789012345672";
const secondMemberId = "123456789012345673";

const page = [
  { user: { id: firstMemberId, username: "first-user", global_name: "First global", bot: false }, nick: "First nick", roles: [roleId] },
  { user: { id: secondMemberId, username: "second-user", global_name: "Second global", bot: false }, roles: [roleId] },
  { user: { id: "123456789012345674", username: "not-core", bot: false }, roles: [] },
  { user: { id: "123456789012345675", username: "core-bot", bot: true }, roles: [roleId] },
  { user: { id: firstMemberId, username: "duplicate", bot: false }, roles: [roleId] },
];

assert.deepEqual(coreMembersFromGuildPage(page, roleId), [
  { discordUserId: firstMemberId, displayName: "First nick" },
  { discordUserId: secondMemberId, displayName: "Second global" },
]);

async function verifyRoleRoster(): Promise<void> {
  const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
    user: { id: `1234567890${String(index).padStart(8, "0")}`, username: `member-${index}`, bot: false },
    roles: [],
  }));
  const requests: string[] = [];
  const rest = {
    async get(_route: string, options?: { query?: URLSearchParams }) {
      requests.push(options?.query?.get("after") ?? "");
      return requests.length === 1 ? firstPage : page;
    },
  };
  assert.deepEqual(await fetchCoreRoleMembers(rest, guildId, roleId), [
    { discordUserId: firstMemberId, displayName: "First nick" },
    { discordUserId: secondMemberId, displayName: "Second global" },
  ]);
  assert.deepEqual(requests, ["0", firstPage.at(-1)?.user.id]);

  await assert.rejects(
    fetchCoreRoleMembers({ async get() { throw new Error("Missing Access"); } }, guildId, roleId),
    (error) => error instanceof CoreRoleRosterError && error.message.includes("did not use the older saved roster"),
  );
  await assert.rejects(
    fetchCoreRoleMembers({ async get() { return []; } }, guildId, roleId),
    (error) => error instanceof CoreRoleRosterError && error.message.includes("no readable non-bot members"),
  );

  const previous = {
    sourceChannelId: "123456789012345676",
    sourceMessageId: "123456789012345677",
    sourceUrl: "https://discord.com/channels/123456789012345670/123456789012345676/123456789012345677",
    updatedAt: 1,
    members: [],
  };
  assert.deepEqual(roleBackedCoreRoster({
    guildId,
    roleId,
    members: coreMembersFromGuildPage(page, roleId),
    previous,
    now: 2,
  }), {
    ...previous,
    updatedAt: 2,
    members: [
      { discordUserId: firstMemberId, displayName: "First nick" },
      { discordUserId: secondMemberId, displayName: "Second global" },
    ],
  });
}

verifyRoleRoster().then(() => {
  console.log("Discord core-role roster tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
