import { join } from "node:path";
import type { CoreAttendanceEntry, CoreAttendanceEvent } from "./core-attendance.js";
import { atomicWriteJson, JsonStore } from "./json-store.js";
import { isPizzaCoreEventTitle, type RaidAttendance, type RaidHelperEvent, type RaidRole, type RaidSignup } from "./ready.js";

const DEFAULT_STORE_FILE = join(process.cwd(), "data", "final-attendance.json");
const UNKNOWN_END_GRACE_MS = 18 * 60 * 60 * 1_000;
const FINALIZATION_SAFETY_MS = 5 * 60 * 1_000;
const attendanceStatuses = new Set<RaidAttendance>(["Signed", "Late", "Tentative", "Bench", "Absent"]);
const raidRoles = new Set<RaidRole>(["Tanks", "Healers", "Melee", "Ranged"]);

export type FinalAttendanceRecord = {
  event: CoreAttendanceEvent;
  raidHelper: RaidHelperEvent;
  completedAt: number;
  finalizedAt: number;
  rosterBasis: "snapshot" | "provider";
};

type FinalAttendanceFile = {
  version: 1;
  guilds: Record<string, { events: FinalAttendanceRecord[] }>;
};

type StoreWriter = (filePath: string, value: unknown) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requiredText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  const text = requiredText(value);
  return text ?? null;
}

function parseSignup(value: unknown): RaidSignup | undefined {
  if (!isRecord(value) || !validDiscordId(value.discordUserId)) return undefined;
  const displayName = requiredText(value.displayName);
  if (!displayName || typeof value.status !== "string" || !attendanceStatuses.has(value.status as RaidAttendance)) return undefined;
  const reportedClass = optionalText(value.reportedClass);
  const reportedSpec = optionalText(value.reportedSpec);
  const reportedRole = value.reportedRole;
  if (reportedClass === null || reportedSpec === null
    || (reportedRole !== undefined && (typeof reportedRole !== "string" || !raidRoles.has(reportedRole as RaidRole)))) return undefined;
  return {
    discordUserId: value.discordUserId,
    displayName,
    ...(reportedClass ? { reportedClass } : {}),
    ...(reportedSpec ? { reportedSpec } : {}),
    ...(reportedRole ? { reportedRole: reportedRole as RaidRole } : {}),
    status: value.status as RaidAttendance,
  };
}

function parseRaidHelperEvent(value: unknown, expectedGuildId?: string): RaidHelperEvent | undefined {
  if (!isRecord(value) || !validDiscordId(value.eventId) || !validDiscordId(value.guildId)
    || (expectedGuildId !== undefined && value.guildId !== expectedGuildId)) return undefined;
  const title = requiredText(value.title);
  if (!title || !isPizzaCoreEventTitle(title) || !finiteTimestamp(value.startsAt) || value.startsAt <= 0 || !Array.isArray(value.signups)) return undefined;
  const seen = new Set<string>();
  const signups: RaidSignup[] = [];
  for (const rawSignup of value.signups) {
    const signup = parseSignup(rawSignup);
    if (!signup || seen.has(signup.discordUserId)) return undefined;
    seen.add(signup.discordUserId);
    signups.push(signup);
  }
  if (value.endsAt !== undefined && !finiteTimestamp(value.endsAt)) return undefined;
  const endsAt = typeof value.endsAt === "number" && value.endsAt > value.startsAt ? value.endsAt : undefined;
  return {
    eventId: value.eventId,
    title,
    startsAt: value.startsAt,
    ...(endsAt !== undefined ? { endsAt } : {}),
    guildId: value.guildId,
    signups,
  };
}

function parseAttendanceEntry(value: unknown): CoreAttendanceEntry | undefined {
  if (!isRecord(value) || !validDiscordId(value.discordUserId)) return undefined;
  const displayName = requiredText(value.displayName);
  const status = value.status;
  if (!displayName || typeof status !== "string"
    || !(attendanceStatuses.has(status as RaidAttendance) || status === "Missing")) return undefined;
  return { discordUserId: value.discordUserId, displayName, status: status as CoreAttendanceEntry["status"] };
}

function parseCoreEvent(value: unknown): CoreAttendanceEvent | undefined {
  if (!isRecord(value) || !validDiscordId(value.eventId)) return undefined;
  const title = requiredText(value.title);
  if (!title || !isPizzaCoreEventTitle(title)
    || !finiteTimestamp(value.startsAt) || value.startsAt <= 0
    || !finiteTimestamp(value.capturedAt)
    || !finiteTimestamp(value.rosterUpdatedAt)
    || !Array.isArray(value.entries)) return undefined;
  const seen = new Set<string>();
  const entries: CoreAttendanceEntry[] = [];
  for (const rawEntry of value.entries) {
    const entry = parseAttendanceEntry(rawEntry);
    if (!entry || seen.has(entry.discordUserId)) return undefined;
    seen.add(entry.discordUserId);
    entries.push(entry);
  }
  return {
    eventId: value.eventId,
    title,
    startsAt: value.startsAt,
    capturedAt: value.capturedAt,
    rosterUpdatedAt: value.rosterUpdatedAt,
    entries,
  };
}

function completionTime(event: Pick<RaidHelperEvent, "startsAt" | "endsAt">): number | undefined {
  if (!finiteTimestamp(event.startsAt) || event.startsAt <= 0) return undefined;
  return finiteTimestamp(event.endsAt) && event.endsAt > event.startsAt
    ? event.endsAt
    : event.startsAt + UNKNOWN_END_GRACE_MS;
}

/** Earliest safe instant at which an event may be durably finalized. */
export function finalAttendanceDueAt(event: Pick<RaidHelperEvent, "startsAt" | "endsAt">): number | undefined {
  const completedAt = completionTime(event);
  return completedAt === undefined ? undefined : completedAt + FINALIZATION_SAFETY_MS;
}

function parseFinalRecord(value: unknown, guildId: string): FinalAttendanceRecord | undefined {
  if (!isRecord(value) || (value.rosterBasis !== "snapshot" && value.rosterBasis !== "provider")
    || !finiteTimestamp(value.completedAt) || !finiteTimestamp(value.finalizedAt)) return undefined;
  const event = parseCoreEvent(value.event);
  const raidHelper = parseRaidHelperEvent(value.raidHelper, guildId);
  if (!event || !raidHelper
    || event.eventId !== raidHelper.eventId
    || event.startsAt !== raidHelper.startsAt
    || event.capturedAt !== value.finalizedAt) return undefined;
  const dueAt = finalAttendanceDueAt(raidHelper);
  if (dueAt === undefined || value.completedAt !== dueAt - FINALIZATION_SAFETY_MS || value.finalizedAt < dueAt) return undefined;
  if (value.rosterBasis === "provider") {
    if (event.rosterUpdatedAt !== 0 || event.entries.length !== raidHelper.signups.length) return undefined;
    const signupById = new Map(raidHelper.signups.map((signup) => [signup.discordUserId, signup]));
    if (!event.entries.every((entry) => {
      const signup = signupById.get(entry.discordUserId);
      return signup?.displayName === entry.displayName && signup.status === entry.status;
    })) return undefined;
  } else {
    if (!event.entries.length) return undefined;
    const signupById = new Map(raidHelper.signups.map((signup) => [signup.discordUserId, signup.status]));
    if (!event.entries.every((entry) => entry.status === (signupById.get(entry.discordUserId) ?? "Missing"))) return undefined;
  }
  return {
    event,
    raidHelper,
    completedAt: value.completedAt,
    finalizedAt: value.finalizedAt,
    rosterBasis: value.rosterBasis,
  };
}

function parseFile(value: unknown): FinalAttendanceFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.guilds)) throw new Error("Invalid final attendance schema.");
  const guilds: FinalAttendanceFile["guilds"] = {};
  for (const [guildId, rawGuild] of Object.entries(value.guilds)) {
    if (!validDiscordId(guildId) || !isRecord(rawGuild) || !Array.isArray(rawGuild.events)) throw new Error("Invalid final attendance guild.");
    const seen = new Set<string>();
    const events: FinalAttendanceRecord[] = [];
    for (const rawEvent of rawGuild.events) {
      const event = parseFinalRecord(rawEvent, guildId);
      if (!event || seen.has(event.event.eventId)) throw new Error("Invalid final attendance event.");
      seen.add(event.event.eventId);
      events.push(event);
    }
    guilds[guildId] = { events };
  }
  return { version: 1, guilds };
}

function emptyFile(): FinalAttendanceFile {
  return { version: 1, guilds: {} };
}

function normalizedSnapshot(value: CoreAttendanceEvent): CoreAttendanceEvent {
  const snapshot = parseCoreEvent(value);
  if (!snapshot || !snapshot.entries.length) throw new Error("A valid historical core snapshot is required.");
  return snapshot;
}

/** Build a final record without performing I/O. */
export function finalizeAttendanceRecord(input: {
  guildId: string;
  event: RaidHelperEvent;
  snapshot?: CoreAttendanceEvent;
  now?: number;
}): FinalAttendanceRecord | undefined {
  if (!validDiscordId(input.guildId)) throw new Error("A valid Discord server ID is required.");
  const raidHelper = parseRaidHelperEvent(input.event, input.guildId);
  if (!raidHelper) throw new Error("A valid Pizza Core Raid-Helper event is required.");
  const finalizedAt = input.now ?? Date.now();
  if (!finiteTimestamp(finalizedAt)) throw new Error("A valid finalization time is required.");
  const dueAt = finalAttendanceDueAt(raidHelper);
  if (dueAt === undefined || finalizedAt < dueAt) return undefined;
  const completedAt = dueAt - FINALIZATION_SAFETY_MS;
  const signupById = new Map(raidHelper.signups.map((signup) => [signup.discordUserId, signup]));
  let event: CoreAttendanceEvent;
  let rosterBasis: FinalAttendanceRecord["rosterBasis"];
  if (input.snapshot) {
    const snapshot = normalizedSnapshot(input.snapshot);
    if (snapshot.eventId !== raidHelper.eventId || snapshot.startsAt !== raidHelper.startsAt || !isPizzaCoreEventTitle(snapshot.title)) {
      throw new Error("The historical core snapshot does not match the Raid-Helper event.");
    }
    event = {
      ...snapshot,
      capturedAt: finalizedAt,
      entries: snapshot.entries.map((entry) => ({
        discordUserId: entry.discordUserId,
        displayName: entry.displayName,
        status: signupById.get(entry.discordUserId)?.status ?? "Missing",
      })),
    };
    rosterBasis = "snapshot";
  } else {
    event = {
      eventId: raidHelper.eventId,
      title: raidHelper.title,
      startsAt: raidHelper.startsAt!,
      capturedAt: finalizedAt,
      rosterUpdatedAt: 0,
      entries: raidHelper.signups.map((signup) => ({
        discordUserId: signup.discordUserId,
        displayName: signup.displayName,
        status: signup.status,
      })),
    };
    rosterBasis = "provider";
  }
  return { event, raidHelper, completedAt, finalizedAt, rosterBasis };
}

function stableRecordContent(record: FinalAttendanceRecord): string {
  const { capturedAt: _capturedAt, ...event } = record.event;
  return JSON.stringify({ event, raidHelper: record.raidHelper, completedAt: record.completedAt, rosterBasis: record.rosterBasis });
}

function sameStoredIdentity(record: FinalAttendanceRecord, event: RaidHelperEvent): boolean {
  return record.event.eventId === event.eventId
    && record.event.startsAt === event.startsAt
    && isPizzaCoreEventTitle(record.event.title)
    && isPizzaCoreEventTitle(event.title);
}

/** Durable, unpruned archive of final Raid-Helper attendance records. */
export class FinalAttendanceStore {
  private readonly store: JsonStore<FinalAttendanceFile>;

  constructor(filePath = DEFAULT_STORE_FILE, write: StoreWriter = atomicWriteJson) {
    this.store = new JsonStore(filePath, parseFile, emptyFile, write);
  }

  async list(guildId: string): Promise<FinalAttendanceRecord[]> {
    if (!validDiscordId(guildId)) return [];
    const events = (await this.store.read()).guilds[guildId]?.events ?? [];
    return events.sort((left, right) => right.event.startsAt - left.event.startsAt || right.finalizedAt - left.finalizedAt);
  }

  async get(guildId: string, eventId: string): Promise<FinalAttendanceRecord | undefined> {
    if (!validDiscordId(guildId) || !validDiscordId(eventId)) return undefined;
    return (await this.list(guildId)).find((record) => record.event.eventId === eventId);
  }

  async capture(input: {
    guildId: string;
    event: RaidHelperEvent;
    snapshot?: CoreAttendanceEvent;
    now?: number;
  }): Promise<FinalAttendanceRecord | undefined> {
    let candidate = finalizeAttendanceRecord(input);
    if (!candidate) return undefined;
    const previous = await this.get(input.guildId, candidate.event.eventId);
    if (previous && !sameStoredIdentity(previous, candidate.raidHelper)) return previous;
    if (previous?.rosterBasis === "snapshot" && candidate.rosterBasis === "provider") {
      candidate = finalizeAttendanceRecord({ ...input, snapshot: previous.event })!;
    }
    if (previous && (previous.finalizedAt >= candidate.finalizedAt
      || stableRecordContent(previous) === stableRecordContent(candidate))) return previous;
    return this.store.update((file) => {
      const guild = file.guilds[input.guildId] ?? { events: [] };
      const current = guild.events.find((record) => record.event.eventId === candidate.event.eventId);
      if (current && !sameStoredIdentity(current, candidate.raidHelper)) return current;
      const next = current?.rosterBasis === "snapshot" && candidate.rosterBasis === "provider"
        ? finalizeAttendanceRecord({ ...input, snapshot: current.event })!
        : candidate;
      if (current && (current.finalizedAt >= next.finalizedAt
        || stableRecordContent(current) === stableRecordContent(next))) return current;
      guild.events = [next, ...guild.events.filter((record) => record.event.eventId !== next.event.eventId)]
        .sort((left, right) => right.event.startsAt - left.event.startsAt || right.finalizedAt - left.finalizedAt);
      file.guilds[input.guildId] = guild;
      return next;
    });
  }
}
