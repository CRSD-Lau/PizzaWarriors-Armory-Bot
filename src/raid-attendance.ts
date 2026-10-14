import {
  buildCoreAttendanceHistory,
  type CoreAttendanceEntry,
  type CoreAttendanceEvent,
  type CoreAttendanceHistory,
} from "./core-attendance.js";
import type { CoreRosterSnapshot, CoreRosterStatus } from "./core-roster.js";
import { getRaidHelperEvent, isPizzaCoreEventTitle, type RaidHelperEvent } from "./ready.js";

const DEFAULT_RAID_LIMIT = 8;
const MAX_RAID_LIMIT = 52;
const UNKNOWN_END_GRACE_MS = 18 * 60 * 60 * 1_000;

export type RaidAttendanceSummary = {
  history: CoreAttendanceHistory;
  requestedRaids: number;
  unavailableRaids: number;
  /**
   * Saved snapshot IDs whose final Raid-Helper roster could not be verified.
   * With a valid guild these IDs identify fallback rows in `history.events`.
   * An invalid guild fails closed, so IDs are reported without history rows.
   */
  unavailableEventIds: string[];
  refreshedAt: number;
};

export function isAttendedStatus(status: CoreRosterStatus | undefined): boolean {
  return status === "Signed" || status === "Tentative";
}

/** Select full-window attendance candidates; callers must disclose unavailable rows. */
export function perfectAttendanceMembers(summary: RaidAttendanceSummary): CoreAttendanceHistory["members"] {
  const { events, members } = summary.history;
  if (summary.requestedRaids <= 0 || events.length !== summary.requestedRaids) return [];
  return members.filter((member) => (
    member.statuses.length === summary.requestedRaids
    && member.statuses.every(isAttendedStatus)
  ));
}

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
    const unavailableEventIds = candidates
      .filter((event) => isSafelyHistorical(event, refreshedAt))
      .slice(0, target)
      .map((event) => event.eventId);
    return {
      history: buildCoreAttendanceHistory(input.roster, [], MAX_RAID_LIMIT),
      requestedRaids: unavailableEventIds.length,
      unavailableRaids: unavailableEventIds.length,
      unavailableEventIds,
      refreshedAt,
    };
  }
  const events: CoreAttendanceEvent[] = [];
  const unavailableEventIds: string[] = [];
  let requestedRaids = 0;
  let unavailableRaids = 0;
  const retainUnavailable = (snapshot: CoreAttendanceEvent): void => {
    requestedRaids++;
    unavailableRaids++;
    unavailableEventIds.push(snapshot.eventId);
    events.push(snapshot);
  };

  for (const snapshot of candidates) {
    if (requestedRaids >= target) break;
    let event: RaidHelperEvent;
    try {
      event = await fetchEvent(snapshot.eventId);
    } catch {
      if (!isSafelyHistorical(snapshot, refreshedAt)) continue;
      retainUnavailable(snapshot);
      continue;
    }

    if (!verifiesSnapshot(event, snapshot, input.guildId)) {
      if (!isSafelyHistorical(snapshot, refreshedAt)) continue;
      retainUnavailable(snapshot);
      continue;
    }

    const endsAt = completionTime(event);
    if (endsAt === undefined) {
      retainUnavailable(snapshot);
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
    unavailableEventIds,
    refreshedAt,
  };
}
