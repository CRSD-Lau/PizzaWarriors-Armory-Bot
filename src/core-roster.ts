import { join } from "node:path";
import { JsonStore } from "./json-store.js";
import type { RaidAttendance, RaidSignup } from "./ready.js";

const DEFAULT_STORE_FILE = join(process.cwd(), "data", "core-rosters.json");
export const CORE_PING_COOLDOWN_MS = 30 * 60 * 1_000;

export type CoreRosterMember = {
  discordUserId: string;
  displayName: string;
};

export type CoreRosterSnapshot = {
  sourceChannelId: string;
  sourceMessageId: string;
  sourceUrl: string;
  updatedAt: number;
  members: CoreRosterMember[];
};

export type CoreRosterStatus = RaidAttendance | "Missing";
export type CoreRosterAuditEntry = CoreRosterMember & {
  status: CoreRosterStatus;
  signup?: RaidSignup;
};

export type CoreRosterAudit = {
  roster: CoreRosterSnapshot;
  entries: CoreRosterAuditEntry[];
  signed: CoreRosterAuditEntry[];
  late: CoreRosterAuditEntry[];
  tentative: CoreRosterAuditEntry[];
  bench: CoreRosterAuditEntry[];
  absent: CoreRosterAuditEntry[];
  missing: CoreRosterAuditEntry[];
  actionable: CoreRosterAuditEntry[];
  respondedCount: number;
  fingerprint: string;
};

export type CorePingRecord = {
  fingerprint: string;
  sentAt: number;
};

type GuildCoreState = {
  roster?: CoreRosterSnapshot;
  lastPings?: Record<string, CorePingRecord>;
};

type CoreRosterFile = {
  version: 1;
  guilds: Record<string, GuildCoreState>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyStore(): CoreRosterFile {
  return { version: 1, guilds: {} };
}

function validMember(value: unknown): value is CoreRosterMember {
  return isRecord(value)
    && typeof value.discordUserId === "string"
    && /^\d{16,22}$/.test(value.discordUserId)
    && typeof value.displayName === "string"
    && Boolean(value.displayName.trim());
}

function parseStore(value: unknown): CoreRosterFile {
  const invalid = () => { throw new Error("Invalid core roster schema."); };
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.guilds)) return invalid();
  for (const [guildId, rawState] of Object.entries(value.guilds)) {
    if (!/^\d{16,22}$/.test(guildId) || !isRecord(rawState)) return invalid();
    const rawRoster = rawState.roster;
    if (rawRoster !== undefined) {
      if (!isRecord(rawRoster)
        || typeof rawRoster.sourceChannelId !== "string"
        || !/^\d{16,22}$/.test(rawRoster.sourceChannelId)
        || typeof rawRoster.sourceMessageId !== "string"
        || !/^\d{16,22}$/.test(rawRoster.sourceMessageId)
        || typeof rawRoster.sourceUrl !== "string"
        || !rawRoster.sourceUrl.trim()
        || typeof rawRoster.updatedAt !== "number"
        || !Number.isFinite(rawRoster.updatedAt)
        || !Array.isArray(rawRoster.members)
        || !rawRoster.members.length
        || !rawRoster.members.every(validMember)) return invalid();
    }
    if (rawState.lastPings !== undefined) {
      if (!isRecord(rawState.lastPings)) return invalid();
      for (const [eventId, rawPing] of Object.entries(rawState.lastPings)) {
        if (!/^\d{16,22}$/.test(eventId) || !isRecord(rawPing)
          || typeof rawPing.fingerprint !== "string" || typeof rawPing.sentAt !== "number"
          || !Number.isFinite(rawPing.sentAt)) return invalid();
      }
    }
  }
  return value as CoreRosterFile;
}

function entriesForStatus(entries: CoreRosterAuditEntry[], status: CoreRosterStatus): CoreRosterAuditEntry[] {
  return entries.filter((entry) => entry.status === status);
}

/** Compare the canonical Pizza Core Discord IDs with every Raid-Helper state. */
export function auditCoreRoster(roster: CoreRosterSnapshot, signups: readonly RaidSignup[]): CoreRosterAudit {
  const signupByUser = new Map(signups.map((signup) => [signup.discordUserId, signup]));
  const entries = roster.members.map((member): CoreRosterAuditEntry => {
    const signup = signupByUser.get(member.discordUserId);
    return { ...member, status: signup?.status ?? "Missing", ...(signup ? { signup } : {}) };
  });
  const signed = entriesForStatus(entries, "Signed");
  const late = entriesForStatus(entries, "Late");
  const tentative = entriesForStatus(entries, "Tentative");
  const bench = entriesForStatus(entries, "Bench");
  const absent = entriesForStatus(entries, "Absent");
  const missing = entriesForStatus(entries, "Missing");
  // Tentative, bench, and absent are deliberate responses. Only members who
  // do not appear anywhere in the event should receive a signup reminder.
  const actionable = [...missing];
  const fingerprint = actionable
    .map((entry) => `${entry.discordUserId}:${entry.status}`)
    .sort()
    .join("|");
  return {
    roster,
    entries,
    signed,
    late,
    tentative,
    bench,
    absent,
    missing,
    actionable,
    respondedCount: entries.length - missing.length,
    fingerprint,
  };
}

/** Active Raid-Helper attendees who are not part of the saved Pizza Core roster. */
export function activeSignupsOutsideCore(audit: Pick<CoreRosterAudit, "entries">, signups: readonly RaidSignup[]): RaidSignup[] {
  const coreUserIds = new Set(audit.entries.map((entry) => entry.discordUserId));
  return signups.filter((signup) => (
    (signup.status === "Signed" || signup.status === "Late")
    && !coreUserIds.has(signup.discordUserId)
  ));
}

/** Render a safe public reminder; Discord controls the actual pings separately. */
export function coreReminderText(audit: CoreRosterAudit): string {
  const lines = ["**Pizza Core signup response needed**"];
  const add = (label: string, entries: readonly CoreRosterAuditEntry[]) => {
    if (entries.length) lines.push(`**${label}:** ${entries.map((entry) => `<@${entry.discordUserId}>`).join(" ")}`);
  };
  add("Not signed up", audit.missing);
  return lines.join("\n");
}

/** Small local store for one roster snapshot and per-event ping cooldowns. */
export class CoreRosterStore {
  private readonly store: JsonStore<CoreRosterFile>;

  constructor(filePath = DEFAULT_STORE_FILE) {
    this.store = new JsonStore(filePath, parseStore, emptyStore);
  }

  async getRoster(guildId: string): Promise<CoreRosterSnapshot | undefined> {
    return (await this.store.read()).guilds[guildId]?.roster;
  }

  async setRoster(guildId: string, input: Omit<CoreRosterSnapshot, "updatedAt">, now = Date.now()): Promise<CoreRosterSnapshot> {
    if (!/^\d{16,22}$/.test(guildId)) throw new Error("A valid Discord server ID is required.");
    const seen = new Set<string>();
    const members = input.members.filter((member) => {
      if (!/^\d{16,22}$/.test(member.discordUserId) || seen.has(member.discordUserId)) return false;
      seen.add(member.discordUserId);
      return true;
    }).slice(0, 100)
      .map((member) => ({ discordUserId: member.discordUserId, displayName: member.displayName.trim() || member.discordUserId }));
    if (!members.length) throw new Error("The roster message must mention at least one Discord member.");
    const roster = { ...input, members, updatedAt: now };
    return this.store.update((store) => {
      const previous = store.guilds[guildId];
      store.guilds[guildId] = { roster, lastPings: previous?.lastPings ?? {} };
      return roster;
    });
  }

  async recentMatchingPing(guildId: string, eventId: string, fingerprint: string, now = Date.now()): Promise<CorePingRecord | undefined> {
    const ping = (await this.store.read()).guilds[guildId]?.lastPings?.[eventId];
    return ping && ping.fingerprint === fingerprint && now - ping.sentAt < CORE_PING_COOLDOWN_MS ? ping : undefined;
  }

  async recordPing(guildId: string, eventId: string, fingerprint: string, now = Date.now()): Promise<void> {
    await this.store.update((store) => {
      const state = store.guilds[guildId] ?? {};
      state.lastPings ??= {};
      state.lastPings[eventId] = { fingerprint, sentAt: now };
      store.guilds[guildId] = state;
    });
  }
}
