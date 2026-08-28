import { Routes } from "discord.js";
import type { CoreRosterMember, CoreRosterSnapshot } from "./core-roster.js";

const PAGE_SIZE = 1_000;
const MAX_MEMBER_PAGES = 100;

type DiscordRestReader = {
  get(route: string, options?: { query?: URLSearchParams }): Promise<unknown>;
};

type RawGuildMember = {
  user: {
    id: string;
    username: string;
    globalName?: string;
    bot: boolean;
  };
  nick?: string;
  roles: string[];
};

export class CoreRoleRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreRoleRosterError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

function parseGuildMember(value: unknown): RawGuildMember | undefined {
  if (!isRecord(value) || !isRecord(value.user) || !validDiscordId(value.user.id)) return undefined;
  const username = typeof value.user.username === "string" ? value.user.username.trim() : "";
  if (!username || !Array.isArray(value.roles)) return undefined;
  return {
    user: {
      id: value.user.id,
      username,
      ...(typeof value.user.global_name === "string" && value.user.global_name.trim()
        ? { globalName: value.user.global_name.trim() }
        : {}),
      bot: value.user.bot === true,
    },
    ...(typeof value.nick === "string" && value.nick.trim() ? { nick: value.nick.trim() } : {}),
    roles: value.roles.filter((roleId): roleId is string => validDiscordId(roleId)),
  };
}

export function coreMembersFromGuildPage(payload: unknown, roleId: string): CoreRosterMember[] {
  if (!validDiscordId(roleId) || !Array.isArray(payload)) return [];
  const members = new Map<string, CoreRosterMember>();
  for (const value of payload) {
    const member = parseGuildMember(value);
    if (!member || member.user.bot || !member.roles.includes(roleId)) continue;
    if (!members.has(member.user.id)) {
      members.set(member.user.id, {
        discordUserId: member.user.id,
        displayName: member.nick ?? member.user.globalName ?? member.user.username,
      });
    }
  }
  return [...members.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

/** Load the complete role roster on demand without subscribing to member gateway events. */
export async function fetchCoreRoleMembers(
  rest: DiscordRestReader,
  guildId: string,
  roleId: string,
): Promise<CoreRosterMember[]> {
  if (!validDiscordId(guildId) || !validDiscordId(roleId)) {
    throw new CoreRoleRosterError("The configured Pizza Core Discord server or role ID is invalid.");
  }
  const members = new Map<string, CoreRosterMember>();
  let after = "0";
  let complete = false;
  for (let pageNumber = 0; pageNumber < MAX_MEMBER_PAGES; pageNumber++) {
    let payload: unknown;
    try {
      payload = await rest.get(Routes.guildMembers(guildId), {
        query: new URLSearchParams({ limit: String(PAGE_SIZE), after }),
      });
    } catch {
      throw new CoreRoleRosterError("I could not refresh the Well Timed Pizza role from Discord, so I did not use the older saved roster. Verify that Server Members Intent is enabled for the bot.");
    }
    if (!Array.isArray(payload)) {
      throw new CoreRoleRosterError("Discord returned an unexpected member list for the Well Timed Pizza role.");
    }
    for (const member of coreMembersFromGuildPage(payload, roleId)) {
      if (!members.has(member.discordUserId)) members.set(member.discordUserId, member);
    }
    if (payload.length < PAGE_SIZE) {
      complete = true;
      break;
    }
    const lastMember = parseGuildMember(payload.at(-1));
    if (!lastMember || lastMember.user.id === after) {
      throw new CoreRoleRosterError("Discord member pagination stopped before the Well Timed Pizza role was fully loaded.");
    }
    after = lastMember.user.id;
  }
  if (!complete) {
    throw new CoreRoleRosterError("Discord member pagination exceeded the safety limit before the Well Timed Pizza role was fully loaded.");
  }
  if (!members.size) {
    throw new CoreRoleRosterError("The Well Timed Pizza role currently has no readable non-bot members, so no core comparison was generated.");
  }
  return [...members.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function roleBackedCoreRoster(input: {
  guildId: string;
  roleId: string;
  members: CoreRosterMember[];
  previous?: CoreRosterSnapshot;
  now?: number;
}): CoreRosterSnapshot {
  return {
    sourceChannelId: input.previous?.sourceChannelId ?? input.guildId,
    sourceMessageId: input.previous?.sourceMessageId ?? input.roleId,
    sourceUrl: input.previous?.sourceUrl ?? `https://discord.com/channels/${input.guildId}`,
    updatedAt: input.now ?? Date.now(),
    members: input.members,
  };
}
