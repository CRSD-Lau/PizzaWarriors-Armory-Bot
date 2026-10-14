import {
  buildCoreAttendanceHistory,
  type CoreAttendanceEvent,
  type CoreAttendanceHistory,
} from "./core-attendance.js";
import {
  finalAttendanceDueAt,
  finalizeAttendanceRecord,
  type FinalAttendanceRecord,
  type FinalAttendanceStore,
} from "./final-attendance.js";
import type { CoreRosterSnapshot, CoreRosterStatus } from "./core-roster.js";
import { getRaidHelperEvent, isPizzaCoreEventTitle, type RaidHelperEvent } from "./ready.js";

const DEFAULT_RAID_LIMIT = 8;
const MAX_RAID_LIMIT = 52;

export type RaidAttendanceSummary = {
  history: CoreAttendanceHistory;
  /** Number of durable or freshly finalized raids included in the card. */
  requestedRaids: number;
  /** Completed candidates omitted because neither a fresh read nor final archive was available. */
  unavailableRaids: number;
  unavailableEventIds: string[];
  refreshedAt: number;
};

export function isAttendedStatus(status: CoreRosterStatus | undefined): boolean {
  return status === "Signed" || status === "Tentative";
}

export function perfectAttendanceMembers(summary: RaidAttendanceSummary): CoreAttendanceHistory["members"] {
  const { events, members } = summary.history;
  if (summary.requestedRaids <= 0 || events.length !== summary.requestedRaids) return [];
  return members.filter((member) => (
    member.statuses.length === summary.requestedRaids
    && member.statuses.every(isAttendedStatus)
  ));
}

type AttendanceCandidate = {
  eventId: string;
  startsAt: number;
  title: string;
  snapshot?: CoreAttendanceEvent;
  archive?: FinalAttendanceRecord;
  sourceMismatch?: boolean;
};

function boundedLimit(value: number | undefined): number {
  return Math.min(Math.max(Math.trunc(value ?? DEFAULT_RAID_LIMIT), 1), MAX_RAID_LIMIT);
}

function validDiscordId(value: string): boolean {
  return /^\d{16,22}$/.test(value);
}

function sameIdentity(
  left: Pick<CoreAttendanceEvent, "eventId" | "title" | "startsAt">,
  right: Pick<CoreAttendanceEvent, "eventId" | "title" | "startsAt">,
): boolean {
  return left.eventId === right.eventId
    && left.startsAt === right.startsAt
    && isPizzaCoreEventTitle(left.title)
    && isPizzaCoreEventTitle(right.title);
}

function verifiesCandidate(event: RaidHelperEvent, candidate: AttendanceCandidate, guildId: string): boolean {
  return event.eventId === candidate.eventId
    && event.startsAt === candidate.startsAt
    && event.guildId === guildId
    && isPizzaCoreEventTitle(candidate.title)
    && isPizzaCoreEventTitle(event.title);
}

function safelyDue(candidate: AttendanceCandidate, now: number): boolean {
  const dueAt = finalAttendanceDueAt({ startsAt: candidate.startsAt });
  return dueAt !== undefined && dueAt <= now;
}

/**
 * Build a report exclusively from final provider data. Fresh reads are archived
 * when a shared store is supplied; pre-raid snapshots are never report fallback.
 */
export async function refreshRaidAttendance(input: {
  roster: CoreRosterSnapshot;
  sourceEvents: readonly CoreAttendanceEvent[];
  guildId: string;
  limit?: number;
  now?: number;
  fetchEvent?: (id: string) => Promise<RaidHelperEvent>;
  finalStore?: FinalAttendanceStore;
}): Promise<RaidAttendanceSummary> {
  const refreshedAt = input.now ?? Date.now();
  const empty = (): RaidAttendanceSummary => ({
    history: buildCoreAttendanceHistory(input.roster, [], MAX_RAID_LIMIT),
    requestedRaids: 0,
    unavailableRaids: 0,
    unavailableEventIds: [],
    refreshedAt,
  });
  if (!validDiscordId(input.guildId)) return empty();

  const target = boundedLimit(input.limit);
  const fetchEvent = input.fetchEvent ?? getRaidHelperEvent;
  const archiveRecords = input.finalStore ? await input.finalStore.list(input.guildId) : [];
  const candidates = new Map<string, AttendanceCandidate>();
  for (const archive of archiveRecords) {
    candidates.set(archive.event.eventId, {
      eventId: archive.event.eventId,
      startsAt: archive.event.startsAt,
      title: archive.event.title,
      archive,
    });
  }
  for (const snapshot of input.sourceEvents) {
    const previous = candidates.get(snapshot.eventId);
    if (!previous) {
      candidates.set(snapshot.eventId, {
        eventId: snapshot.eventId,
        startsAt: snapshot.startsAt,
        title: snapshot.title,
        snapshot,
      });
      continue;
    }
    if (!previous.archive) {
      if (previous.snapshot && sameIdentity(snapshot, previous.snapshot) && snapshot.capturedAt > previous.snapshot.capturedAt) {
        previous.snapshot = snapshot;
      }
      continue;
    }
    if (!sameIdentity(snapshot, previous.archive.event)) {
      previous.sourceMismatch = true;
      continue;
    }
    previous.snapshot = snapshot;
  }

  const selected: CoreAttendanceEvent[] = [];
  const unavailableEventIds: string[] = [];
  const ordered = [...candidates.values()]
    .filter((candidate) => candidate.startsAt <= refreshedAt)
    .sort((left, right) => right.startsAt - left.startsAt)
    .slice(0, MAX_RAID_LIMIT);

  for (const candidate of ordered) {
    if (selected.length >= target) break;
    if (candidate.sourceMismatch && candidate.archive) {
      selected.push(candidate.archive.event);
      continue;
    }

    let providerEvent: RaidHelperEvent;
    try {
      providerEvent = await fetchEvent(candidate.eventId);
    } catch {
      if (candidate.archive) selected.push(candidate.archive.event);
      else if (safelyDue(candidate, refreshedAt)) unavailableEventIds.push(candidate.eventId);
      continue;
    }

    if (!verifiesCandidate(providerEvent, candidate, input.guildId)) {
      if (candidate.archive) selected.push(candidate.archive.event);
      else if (safelyDue(candidate, refreshedAt)) unavailableEventIds.push(candidate.eventId);
      continue;
    }

    const snapshot = candidate.snapshot
      ?? (candidate.archive?.rosterBasis === "snapshot" ? candidate.archive.event : undefined);
    const record = input.finalStore
      ? await input.finalStore.capture({ guildId: input.guildId, event: providerEvent, ...(snapshot ? { snapshot } : {}), now: refreshedAt })
      : finalizeAttendanceRecord({ guildId: input.guildId, event: providerEvent, ...(snapshot ? { snapshot } : {}), now: refreshedAt });
    if (record) selected.push(record.event);
    else if (candidate.archive) selected.push(candidate.archive.event);
  }

  return {
    history: buildCoreAttendanceHistory(input.roster, selected, MAX_RAID_LIMIT),
    requestedRaids: selected.length,
    unavailableRaids: unavailableEventIds.length,
    unavailableEventIds,
    refreshedAt,
  };
}
