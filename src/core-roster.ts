import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  if (!isRecord(value) || !isRecord(value.guilds)) return emptyStore();
  const guilds: Record<string, GuildCoreState> = {};
  for (const [guildId, rawState] of Object.entries(value.guilds)) {
    if (!/^\d{16,22}$/.test(guildId) || !isRecord(rawState)) continue;
    const rawRoster = rawState.roster;
    const state: GuildCoreState = {};
    if (isRecord(rawRoster)
      && typeof rawRoster.sourceChannelId === "string"
      && typeof rawRoster.sourceMessageId === "string"
      && typeof rawRoster.sourceUrl === "string"
      && typeof rawRoster.updatedAt === "number"
      && Array.isArray(rawRoster.members)) {
      const members = rawRoster.members.filter(validMember);
      if (members.length) state.roster = { ...rawRoster, members } as CoreRosterSnapshot;
    }
    if (isRecord(rawState.lastPings)) {
      state.lastPings = Object.fromEntries(Object.entries(rawState.lastPings).flatMap(([eventId, rawPing]) => {
        if (!/^\d{16,22}$/.test(eventId) || !isRecord(rawPing) || typeof rawPing.fingerprint !== "string" || typeof rawPing.sentAt !== "number") return [];
        return [[eventId, { fingerprint: rawPing.fingerprint, sentAt: rawPing.sentAt }]];
      }));
    }
    guilds[guildId] = state;
  }
  return { version: 1, guilds };
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
  const actionable = [...missing, ...tentative, ...absent];
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

/** Render a safe public reminder; Discord controls the actual pings separately. */
export function coreReminderText(audit: CoreRosterAudit): string {
  const lines = ["**Pizza Core signup response needed**"];
  const add = (label: string, entries: readonly CoreRosterAuditEntry[]) => {
    if (entries.length) lines.push(`**${label}:** ${entries.map((entry) => `<@${entry.discordUserId}>`).join(" ")}`);
  };
  add("Not signed up", audit.missing);
  add("Tentative", audit.tentative);
  add("Absent", audit.absent);
  return lines.join("\n");
}

/** Small local store for one roster snapshot and per-event ping cooldowns. */
export class CoreRosterStore {
  private store?: CoreRosterFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = DEFAULT_STORE_FILE) {}

  private async load(): Promise<CoreRosterFile> {
    if (this.store) return this.store;
    try { this.store = parseStore(JSON.parse(await readFile(this.filePath, "utf8")) as unknown); }
    catch { this.store = emptyStore(); }
    return this.store;
  }

  private async persist(): Promise<void> {
    const store = await this.load();
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(store, null, 2));
    });
    await this.writeQueue;
  }

  async getRoster(guildId: string): Promise<CoreRosterSnapshot | undefined> {
    return (await this.load()).guilds[guildId]?.roster;
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
    const store = await this.load();
    const previous = store.guilds[guildId];
    store.guilds[guildId] = { roster, lastPings: previous?.lastPings ?? {} };
    await this.persist();
    return roster;
  }

  async recentMatchingPing(guildId: string, eventId: string, fingerprint: string, now = Date.now()): Promise<CorePingRecord | undefined> {
    const ping = (await this.load()).guilds[guildId]?.lastPings?.[eventId];
    return ping && ping.fingerprint === fingerprint && now - ping.sentAt < CORE_PING_COOLDOWN_MS ? ping : undefined;
  }

  async recordPing(guildId: string, eventId: string, fingerprint: string, now = Date.now()): Promise<void> {
    const store = await this.load();
    const state = store.guilds[guildId] ?? {};
    state.lastPings ??= {};
    state.lastPings[eventId] = { fingerprint, sentAt: now };
    store.guilds[guildId] = state;
    await this.persist();
  }
}
