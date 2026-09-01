import { ChannelType, Routes } from "discord.js";

const MAX_DISCORD_CANDIDATES = 25;
const DISCORD_PAGE_SIZE = 100;

type DiscordRestReader = {
  get(route: string, options?: { query?: URLSearchParams }): Promise<unknown>;
};

type RawForumThread = {
  id: string;
  parentId: string;
  ownerId: string;
  appliedTags: string[];
};

export class RaidHelperDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RaidHelperDiscoveryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function uniqueNewest(ids: readonly string[]): string[] {
  return [...new Set(ids)]
    .sort((left, right) => left === right ? 0 : BigInt(left) > BigInt(right) ? -1 : 1)
    .slice(0, MAX_DISCORD_CANDIDATES);
}

function textChannelCandidateIds(payload: unknown, raidHelperBotId: string): string[] {
  if (!Array.isArray(payload)) {
    throw new RaidHelperDiscoveryError("Discord returned an unexpected message list for the configured Raid-Helper channel.");
  }
  return uniqueNewest(payload.flatMap((value) => {
    if (!isRecord(value) || !validDiscordId(value.id) || !isRecord(value.author) || value.author.id !== raidHelperBotId) return [];
    return [value.id];
  }));
}

function forumThreads(payload: unknown): RawForumThread[] {
  if (!isRecord(payload) || !Array.isArray(payload.threads)) {
    throw new RaidHelperDiscoveryError("Discord returned an unexpected forum-post list for the configured Raid-Helper forum.");
  }
  return payload.threads.flatMap((value) => {
    if (!isRecord(value) || !validDiscordId(value.id) || !validDiscordId(value.parent_id) || !validDiscordId(value.owner_id)) return [];
    return [{
      id: value.id,
      parentId: value.parent_id,
      ownerId: value.owner_id,
      appliedTags: Array.isArray(value.applied_tags) ? value.applied_tags.filter(validDiscordId) : [],
    }];
  });
}

function coreTagIds(channel: Record<string, unknown>): Set<string> {
  if (!Array.isArray(channel.available_tags)) return new Set();
  return new Set(channel.available_tags.flatMap((value) => {
    if (!isRecord(value) || !validDiscordId(value.id) || typeof value.name !== "string") return [];
    const name = normalizeLabel(value.name);
    return name === "pizzacore" || name === "pizzaraid" ? [value.id] : [];
  }));
}

/**
 * Load recent Raid-Helper event IDs from either a legacy text channel or a
 * forum whose posts are threads. Forum discovery checks active and archived
 * posts and trusts only threads created by the configured Raid-Helper bot.
 */
export async function fetchRaidHelperCandidateIds(
  rest: DiscordRestReader,
  guildId: string,
  channelId: string,
  raidHelperBotId: string,
): Promise<string[]> {
  if (![guildId, channelId, raidHelperBotId].every(validDiscordId)) {
    throw new RaidHelperDiscoveryError("The configured Discord server, Raid-Helper channel, or Raid-Helper bot ID is invalid.");
  }

  let channel: unknown;
  try {
    channel = await rest.get(Routes.channel(channelId));
  } catch {
    throw new RaidHelperDiscoveryError("I cannot access the configured Raid-Helper channel. Update RAID_HELPER_CHANNEL_ID to the current raid-signups forum ID.");
  }
  if (!isRecord(channel) || channel.id !== channelId || channel.guild_id !== guildId) {
    throw new RaidHelperDiscoveryError("RAID_HELPER_CHANNEL_ID does not identify an accessible channel in this Discord server.");
  }

  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    let messages: unknown;
    try {
      messages = await rest.get(Routes.channelMessages(channelId), {
        query: new URLSearchParams({ limit: String(DISCORD_PAGE_SIZE) }),
      });
    } catch {
      throw new RaidHelperDiscoveryError("I cannot read recent Raid-Helper messages from the configured signup channel.");
    }
    return textChannelCandidateIds(messages, raidHelperBotId);
  }

  if (channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia) {
    let activePayload: unknown;
    let archivedPayload: unknown;
    try {
      [activePayload, archivedPayload] = await Promise.all([
        rest.get(Routes.guildActiveThreads(guildId)),
        rest.get(Routes.channelThreads(channelId, "public"), {
          query: new URLSearchParams({ limit: String(DISCORD_PAGE_SIZE) }),
        }),
      ]);
    } catch {
      throw new RaidHelperDiscoveryError("I cannot list the active and archived Raid-Helper posts in the configured signup forum.");
    }

    const tagIds = coreTagIds(channel);
    const candidates = [...forumThreads(activePayload), ...forumThreads(archivedPayload)]
      .filter((thread) => thread.parentId === channelId && thread.ownerId === raidHelperBotId)
      .filter((thread) => !tagIds.size || thread.appliedTags.some((tagId) => tagIds.has(tagId)))
      .map((thread) => thread.id);
    return uniqueNewest(candidates);
  }

  throw new RaidHelperDiscoveryError("RAID_HELPER_CHANNEL_ID must identify a Discord text, announcement, forum, or media channel.");
}
