import assert from "node:assert/strict";
import { ChannelType, Routes } from "discord.js";
import { fetchRaidHelperCandidateIds, RaidHelperDiscoveryError } from "../src/raid-helper-discovery.js";

const guildId = "123456789012345670";
const channelId = "123456789012345671";
const coreTagId = "123456789012345672";
const otherTagId = "123456789012345673";
const raidHelperBotId = "579155972115660803";
const oldCoreThreadId = "123456789012345680";
const currentCoreThreadId = "123456789012345690";

async function verifyForumDiscovery(): Promise<void> {
  const requestedRoutes: string[] = [];
  const rest = {
    async get(route: string) {
      requestedRoutes.push(route);
      if (route === Routes.channel(channelId)) {
        return {
          id: channelId,
          guild_id: guildId,
          type: ChannelType.GuildForum,
          available_tags: [
            { id: coreTagId, name: "PizzaCore" },
            { id: otherTagId, name: "Event" },
          ],
        };
      }
      if (route === Routes.guildActiveThreads(guildId)) {
        return { threads: [
          { id: currentCoreThreadId, parent_id: channelId, owner_id: raidHelperBotId, applied_tags: [coreTagId] },
          { id: "123456789012345691", parent_id: channelId, owner_id: raidHelperBotId, applied_tags: [otherTagId] },
          { id: "123456789012345692", parent_id: channelId, owner_id: "123456789012345674", applied_tags: [coreTagId] },
        ] };
      }
      if (route === Routes.channelThreads(channelId, "public")) {
        return { threads: [
          { id: oldCoreThreadId, parent_id: channelId, owner_id: raidHelperBotId, applied_tags: [coreTagId] },
          { id: currentCoreThreadId, parent_id: channelId, owner_id: raidHelperBotId, applied_tags: [coreTagId] },
        ] };
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  };

  assert.deepEqual(
    await fetchRaidHelperCandidateIds(rest, guildId, channelId, raidHelperBotId),
    [currentCoreThreadId, oldCoreThreadId],
    "forum discovery must keep only unique Raid-Helper-authored Pizza Core posts",
  );
  assert.deepEqual(requestedRoutes, [
    Routes.channel(channelId),
    Routes.guildActiveThreads(guildId),
    Routes.channelThreads(channelId, "public"),
  ]);
}

async function verifyTextChannelCompatibility(): Promise<void> {
  const rest = {
    async get(route: string) {
      if (route === Routes.channel(channelId)) return { id: channelId, guild_id: guildId, type: ChannelType.GuildText };
      if (route === Routes.channelMessages(channelId)) return [
        { id: currentCoreThreadId, author: { id: raidHelperBotId } },
        { id: "123456789012345689", author: { id: "123456789012345674" } },
        { id: oldCoreThreadId, author: { id: raidHelperBotId } },
      ];
      throw new Error(`Unexpected route: ${route}`);
    },
  };
  assert.deepEqual(await fetchRaidHelperCandidateIds(rest, guildId, channelId, raidHelperBotId), [currentCoreThreadId, oldCoreThreadId]);
}

async function verifyFailureIsExplicit(): Promise<void> {
  await assert.rejects(
    fetchRaidHelperCandidateIds({ async get() { throw new Error("Unknown Channel"); } }, guildId, channelId, raidHelperBotId),
    (error) => error instanceof RaidHelperDiscoveryError && error.message.includes("current raid-signups forum ID"),
  );
  await assert.rejects(
    fetchRaidHelperCandidateIds({ async get() { return { id: channelId, guild_id: guildId, type: ChannelType.GuildVoice }; } }, guildId, channelId, raidHelperBotId),
    (error) => error instanceof RaidHelperDiscoveryError && error.message.includes("forum"),
  );
}

Promise.all([
  verifyForumDiscovery(),
  verifyTextChannelCompatibility(),
  verifyFailureIsExplicit(),
]).then(() => {
  console.log("Raid-Helper Discord discovery tests passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
