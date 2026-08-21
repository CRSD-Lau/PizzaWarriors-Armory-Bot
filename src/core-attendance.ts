import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CoreRosterAudit,
  CoreRosterMember,
  CoreRosterSnapshot,
  CoreRosterStatus,
} from "./core-roster.js";

const DEFAULT_STORE_FILE = join(process.cwd(), "data", "core-attendance.json");
const MAX_STORED_EVENTS = 52;
const validStatuses = new Set<CoreRosterStatus>(["Signed", "Late", "Tentative", "Bench", "Absent", "Missing"]);

export type CoreAttendanceEntry = CoreRosterMember & {
  status: CoreRosterStatus;
};

export type CoreAttendanceEvent = {
  eventId: string;
  title: string;
  startsAt: number;
  capturedAt: number;
  rosterUpdatedAt: number;
  entries: CoreAttendanceEntry[];
};

export type CoreAttendanceMemberHistory = CoreRosterMember & {
  statuses: Array<CoreRosterStatus | undefined>;
  trackedCount: number;
  missingCount: number;
  absentCount: number;
  tentativeCount: number;
  benchCount: number;
};

export type CoreAttendanceHistory = {
  events: CoreAttendanceEvent[];
  members: CoreAttendanceMemberHistory[];
  trackedResponses: number;
  missingSignups: number;
  explicitAbsences: number;
  responseRate: number;
  reliableMembers: number;
};

type CoreAttendanceFile = {
  version: 1;
  guilds: Record<string, { events: CoreAttendanceEvent[] }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyStore(): CoreAttendanceFile {
  return { version: 1, guilds: {} };
}

function validDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

function parseEntry(value: unknown): CoreAttendanceEntry | undefined {
  if (!isRecord(value)
    || !validDiscordId(value.discordUserId)
    || typeof value.displayName !== "string"
    || !value.displayName.trim()
    || typeof value.status !== "string"
    || !validStatuses.has(value.status as CoreRosterStatus)) return undefined;
  return {
    discordUserId: value.discordUserId,
    displayName: value.displayName.trim(),
    status: value.status as CoreRosterStatus,
  };
}

function parseEvent(value: unknown): CoreAttendanceEvent | undefined {
  if (!isRecord(value)
    || !validDiscordId(value.eventId)
    || typeof value.title !== "string"
    || !value.title.trim()
    || typeof value.startsAt !== "number"
    || !Number.isFinite(value.startsAt)
    || typeof value.capturedAt !== "number"
    || !Number.isFinite(value.capturedAt)
    || typeof value.rosterUpdatedAt !== "number"
    || !Number.isFinite(value.rosterUpdatedAt)
    || !Array.isArray(value.entries)) return undefined;
  const seen = new Set<string>();
  const entries = value.entries.flatMap((rawEntry) => {
    const entry = parseEntry(rawEntry);
    if (!entry || seen.has(entry.discordUserId)) return [];
    seen.add(entry.discordUserId);
    return [entry];
  });
  if (!entries.length) return undefined;
  return {
    eventId: value.eventId,
    title: value.title.trim(),
    startsAt: value.startsAt,
    capturedAt: value.capturedAt,
    rosterUpdatedAt: value.rosterUpdatedAt,
    entries,
  };
}

function parseStore(value: unknown): CoreAttendanceFile {
  if (!isRecord(value) || !isRecord(value.guilds)) return emptyStore();
  const guilds: CoreAttendanceFile["guilds"] = {};
  for (const [guildId, rawGuild] of Object.entries(value.guilds)) {
    if (!validDiscordId(guildId) || !isRecord(rawGuild) || !Array.isArray(rawGuild.events)) continue;
    const seen = new Set<string>();
    const events = rawGuild.events.flatMap((rawEvent) => {
      const event = parseEvent(rawEvent);
      if (!event || seen.has(event.eventId)) return [];
      seen.add(event.eventId);
      return [event];
    }).sort((left, right) => right.startsAt - left.startsAt || right.capturedAt - left.capturedAt)
      .slice(0, MAX_STORED_EVENTS);
    guilds[guildId] = { events };
  }
  return { version: 1, guilds };
}

function countStatus(statuses: ReadonlyArray<CoreRosterStatus | undefined>, status: CoreRosterStatus): number {
  return statuses.filter((value) => value === status).length;
}

/** Build a current-core view without treating weeks before a member joined as missed signups. */
export function buildCoreAttendanceHistory(
  roster: CoreRosterSnapshot,
  sourceEvents: readonly CoreAttendanceEvent[],
  limit = 8,
): CoreAttendanceHistory {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_STORED_EVENTS);
  const events = [...sourceEvents]
    .sort((left, right) => right.startsAt - left.startsAt || right.capturedAt - left.capturedAt)
    .slice(0, boundedLimit)
    .sort((left, right) => left.startsAt - right.startsAt || left.capturedAt - right.capturedAt);
  const entryMaps = events.map((event) => new Map(event.entries.map((entry) => [entry.discordUserId, entry.status])));
  const members = roster.members.map((member): CoreAttendanceMemberHistory => {
    const statuses = entryMaps.map((entries) => entries.get(member.discordUserId));
    return {
      ...member,
      statuses,
      trackedCount: statuses.filter((status) => status !== undefined).length,
      missingCount: countStatus(statuses, "Missing"),
      absentCount: countStatus(statuses, "Absent"),
      tentativeCount: countStatus(statuses, "Tentative"),
      benchCount: countStatus(statuses, "Bench"),
    };
  }).sort((left, right) => right.missingCount - left.missingCount
    || right.absentCount - left.absentCount
    || right.tentativeCount - left.tentativeCount
    || right.benchCount - left.benchCount
    || left.displayName.localeCompare(right.displayName));
  const trackedResponses = members.reduce((total, member) => total + member.trackedCount, 0);
  const missingSignups = members.reduce((total, member) => total + member.missingCount, 0);
  const explicitAbsences = members.reduce((total, member) => total + member.absentCount, 0);
  return {
    events,
    members,
    trackedResponses,
    missingSignups,
    explicitAbsences,
    responseRate: trackedResponses ? Math.round(((trackedResponses - missingSignups) / trackedResponses) * 100) : 0,
    reliableMembers: members.filter((member) => member.trackedCount > 0 && member.missingCount === 0).length,
  };
}

/** Private local history keyed by Discord guild and Raid-Helper event ID. */
export class CoreAttendanceStore {
  private store?: CoreAttendanceFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = DEFAULT_STORE_FILE) {}

  private async load(): Promise<CoreAttendanceFile> {
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

  async list(guildId: string, limit = MAX_STORED_EVENTS): Promise<CoreAttendanceEvent[]> {
    const events = (await this.load()).guilds[guildId]?.events ?? [];
    return events.slice(0, Math.min(Math.max(Math.trunc(limit), 1), MAX_STORED_EVENTS));
  }

  async hasEvent(guildId: string, eventId: string): Promise<boolean> {
    return (await this.load()).guilds[guildId]?.events.some((event) => event.eventId === eventId) ?? false;
  }

  async record(input: {
    guildId: string;
    eventId: string;
    title: string;
    startsAt?: number;
    audit: CoreRosterAudit;
    capturedAt?: number;
  }): Promise<CoreAttendanceEvent> {
    if (!validDiscordId(input.guildId)) throw new Error("A valid Discord server ID is required.");
    if (!validDiscordId(input.eventId)) throw new Error("A valid Raid-Helper event ID is required.");
    const capturedAt = input.capturedAt ?? Date.now();
    const event: CoreAttendanceEvent = {
      eventId: input.eventId,
      title: input.title.trim() || "Pizza Core raid",
      startsAt: input.startsAt ?? capturedAt,
      capturedAt,
      rosterUpdatedAt: input.audit.roster.updatedAt,
      entries: input.audit.entries.map((entry) => ({
        discordUserId: entry.discordUserId,
        displayName: entry.displayName,
        status: entry.status,
      })),
    };
    const store = await this.load();
    const previous = store.guilds[input.guildId]?.events ?? [];
    store.guilds[input.guildId] = {
      events: [event, ...previous.filter((entry) => entry.eventId !== event.eventId)]
        .sort((left, right) => right.startsAt - left.startsAt || right.capturedAt - left.capturedAt)
        .slice(0, MAX_STORED_EVENTS),
    };
    await this.persist();
    return event;
  }
}
