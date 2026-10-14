import {
  buildCoreAttendanceHistory,
  type CoreAttendanceEntry,
  type CoreAttendanceEvent,
  type CoreAttendanceHistory,
} from "./core-attendance.js";
import type { CoreRosterSnapshot } from "./core-roster.js";
import { getRaidHelperEvent, isPizzaCoreEventTitle, type RaidHelperEvent } from "./ready.js";

const DEFAULT_RAID_LIMIT = 8;
const MAX_RAID_LIMIT = 52;
const UNKNOWN_END_GRACE_MS = 18 * 60 * 60 * 1_000;

export type RaidAttendanceSummary = {
  history: CoreAttendanceHistory;
  requestedRaids: number;
  unavailableRaids: number;
  refreshedAt: number;
};

function boundedLimit(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? DEFAULT_RAID_LIMIT), 1), MAX_RAID_LIMIT);
}

function validDiscordId(value: string): boolean {
  return /^\d{16,22}$/.test(value);
}

function verifiesSnapshot(event: RaidHelperEvent, snapshot: CoreAttendanceEvent, guildId: string): boolean {
  return event.eventId === snapshot.eventId
    && isPizzaCoreEventTitle(snapshot.title)
    && isPizzaCoreEventTitle(event.title)
    && event.guildId === guildId
    && event.startsAt === snapshot.startsAt;
}

function completionTime(event: RaidHelperEvent): number | undefined {
  if (event.startsAt === undefined) return undefined;
  return event.endsAt !== undefined && event.endsAt > event.startsAt
    ? event.endsAt
    : event.startsAt + UNKNOWN_END_GRACE_MS;
}

function isSafelyHistorical(snapshot: CoreAttendanceEvent, now: number): boolean {
  return snapshot.startsAt + UNKNOWN_END_GRACE_MS <= now;
}

function refreshedEvent(snapshot: CoreAttendanceEvent, event: RaidHelperEvent): CoreAttendanceEvent {
  const statuses = new Map(event.signups.map((signup) => [signup.discordUserId, signup.status]));
  const entries = snapshot.entries.map((entry): CoreAttendanceEntry => ({
    discordUserId: entry.discordUserId,
    displayName: entry.displayName,
    status: statuses.get(entry.discordUserId) ?? "Missing",
  }));
  return { ...snapshot, entries };
}

/**
 * Re-read completed Raid-Helper events without mutating the saved signup-time
 * snapshots. Coverage failures remain visible instead of shrinking the window.
 */
export async function refreshRaidAttendance(input: {
  roster: CoreRosterSnapshot;
  sourceEvents: readonly CoreAttendanceEvent[];
  guildId: string;
  limit?: number;
  now?: number;
  fetchEvent?: (id: string) => Promise<RaidHelperEvent>;
}): Promise<RaidAttendanceSummary> {
  const refreshedAt = input.now ?? Date.now();
  const target = boundedLimit(input.limit);
  const fetchEvent = input.fetchEvent ?? getRaidHelperEvent;
  const candidates = [...input.sourceEvents]
    .filter((event) => event.startsAt <= refreshedAt)
    .sort((left, right) => right.startsAt - left.startsAt || right.capturedAt - left.capturedAt)
    .slice(0, MAX_RAID_LIMIT);
  if (!validDiscordId(input.guildId)) {
    const unavailableRaids = Math.min(target, candidates.filter((event) => isSafelyHistorical(event, refreshedAt)).length);
    return {
      history: buildCoreAttendanceHistory(input.roster, [], MAX_RAID_LIMIT),
      requestedRaids: unavailableRaids,
      unavailableRaids,
      refreshedAt,
    };
  }
  const events: CoreAttendanceEvent[] = [];
  let requestedRaids = 0;
  let unavailableRaids = 0;

  for (const snapshot of candidates) {
    if (requestedRaids >= target) break;
    let event: RaidHelperEvent;
    try {
      event = await fetchEvent(snapshot.eventId);
    } catch {
      if (!isSafelyHistorical(snapshot, refreshedAt)) continue;
      requestedRaids++;
      unavailableRaids++;
      continue;
    }

    if (!verifiesSnapshot(event, snapshot, input.guildId)) {
      if (!isSafelyHistorical(snapshot, refreshedAt)) continue;
      requestedRaids++;
      unavailableRaids++;
      continue;
    }

    const endsAt = completionTime(event);
    if (endsAt === undefined) {
      requestedRaids++;
      unavailableRaids++;
      continue;
    }
    if (endsAt > refreshedAt) continue;

    requestedRaids++;
    events.push(refreshedEvent(snapshot, event));
  }

  return {
    history: buildCoreAttendanceHistory(input.roster, events, MAX_RAID_LIMIT),
    requestedRaids,
    unavailableRaids,
    refreshedAt,
  };
}
