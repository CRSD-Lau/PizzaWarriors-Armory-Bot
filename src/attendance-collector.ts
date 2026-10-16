import type { CoreAttendanceEvent } from "./core-attendance.js";
import type { CoreRosterSnapshot } from "./core-roster.js";
import { finalAttendanceDueAt } from "./final-attendance.js";
import { collectSuccessful } from "./interaction-safety.js";
import { isPizzaCoreEventTitle, RaidHelperEventError, type RaidHelperEvent } from "./ready.js";

export const ATTENDANCE_POLL_MS = 5 * 60_000;
const DISCOVERY_INTERVAL_MS = 60 * 60_000;
const MAX_RETRY_MS = 6 * 60 * 60_000;

export type AttendanceCollectorDependencies = {
  guildId: string;
  listSnapshots: () => Promise<CoreAttendanceEvent[]>;
  listFinals: () => Promise<Array<{ event: CoreAttendanceEvent }>>;
  discoverEvents: () => Promise<RaidHelperEvent[]>;
  fetchEvent: (id: string) => Promise<RaidHelperEvent>;
  currentRoster: () => Promise<CoreRosterSnapshot | undefined>;
  saveSnapshot: (event: RaidHelperEvent, roster: CoreRosterSnapshot, now: number) => Promise<CoreAttendanceEvent>;
  saveFinal: (event: RaidHelperEvent, snapshot: CoreAttendanceEvent | undefined, now: number) => Promise<boolean>;
  now?: () => number;
  onError?: (error: unknown) => void;
};

/** One local writer, with automatic discovery and restart catch-up. No Discord messages. */
export class AttendanceCollector {
  private readonly known = new Map<string, RaidHelperEvent>();
  private readonly discoveredIds = new Set<string>();
  private readonly retries = new Map<string, { after: number; failures: number }>();
  private discoveryAfter = 0;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private lastAttemptAt?: number;
  private lastSuccessAt?: number;
  private lastSavedAt?: number;
  private lastSavedCount = 0;
  private lastError?: string;

  constructor(private readonly deps: AttendanceCollectorDependencies) {}

  health() {
    return { enabled: true, running: this.inFlight !== undefined, lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt, lastSavedAt: this.lastSavedAt, lastSavedCount: this.lastSavedCount,
      ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce(); }, ATTENDANCE_POLL_MS);
    this.timer.unref();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().catch((error: unknown) => this.recordError(error))
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private recordError(error: unknown): void {
    this.lastError = "Attendance capture will retry; existing records were preserved.";
    this.deps.onError?.(error);
  }

  private valid(event: RaidHelperEvent): boolean {
    return /^\d{16,22}$/.test(this.deps.guildId)
      && event.guildId === this.deps.guildId && /^\d{16,22}$/.test(event.eventId)
      && isPizzaCoreEventTitle(event.title)
      && event.startsAt !== undefined && Number.isFinite(event.startsAt);
  }

  private async fetch(id: string): Promise<RaidHelperEvent> {
    const fetched = await this.deps.fetchEvent(id);
    // Only Discord-verified forum discovery can establish legacy guild provenance.
    const event = !fetched.guildId && this.discoveredIds.has(id)
      ? { ...fetched, guildId: this.deps.guildId } : fetched;
    if (event.eventId !== id || !this.valid(event)) throw new Error("Attendance event identity could not be verified.");
    this.known.set(id, event);
    return event;
  }

  private async collect(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    this.lastAttemptAt = now;
    this.lastSavedCount = 0;
    this.lastError = undefined;
    const [snapshots, finals] = await Promise.all([this.deps.listSnapshots(), this.deps.listFinals()]);
    const snapshotById = new Map(snapshots.map((event) => [event.eventId, event]));
    const finalized = new Set(finals.map((record) => record.event.eventId));

    if (now >= this.discoveryAfter) {
      try {
        const discovered = await this.deps.discoverEvents();
        for (const event of discovered) {
          if (!this.valid(event)) continue;
          this.known.set(event.eventId, event);
          this.discoveredIds.add(event.eventId);
        }
        this.discoveryAfter = now + DISCOVERY_INTERVAL_MS;
      } catch (error) {
        this.discoveryAfter = now + ATTENDANCE_POLL_MS;
        this.recordError(error);
      }
    }

    let rosterPromise: Promise<CoreRosterSnapshot | undefined> | undefined;
    const candidates = [...new Set([...snapshotById.keys(), ...this.known.keys()])]
      .filter((id) => !finalized.has(id) && now >= (this.retries.get(id)?.after ?? 0));
    await collectSuccessful(candidates, async (id) => {
      try {
        let event = this.known.get(id) ?? await this.fetch(id);
        if (event.startsAt! > now) {
          // Refresh reschedules before deciding whether the roster is still pre-raid.
          event = await this.fetch(id);
          if (event.startsAt! > now) {
            rosterPromise ??= this.deps.currentRoster();
            const roster = await rosterPromise;
            if (!roster) throw new Error("No core roster is available for the upcoming raid.");
            const previous = snapshotById.get(id);
            const membersUnchanged = previous !== undefined && previous.startsAt === event.startsAt
              && previous.entries.length === roster.members.length
              && roster.members.every((member) => previous.entries.some((entry) => (
                entry.discordUserId === member.discordUserId && entry.displayName === member.displayName
              )));
            if (!membersUnchanged) await this.deps.saveSnapshot(event, roster, now);
            this.retries.delete(id);
            return;
          }
        }

        const dueAt = finalAttendanceDueAt(event);
        if (dueAt === undefined || dueAt > now) return;
        // Always obtain a fresh post-raid response, never promote a cached pre-raid roster.
        const fresh = await this.fetch(id);
        if (await this.deps.saveFinal(fresh, snapshotById.get(id), now)) {
          this.lastSavedCount++;
          this.lastSavedAt = now;
        }
        this.retries.delete(id);
      } catch (error) {
        const failures = (this.retries.get(id)?.failures ?? 0) + 1;
        if (error instanceof RaidHelperEventError && error.status === 404) {
          // Deleted historical events have no final data to save. Keep retrying
          // occasionally without reporting an expected omission as a worker failure.
          this.retries.set(id, { failures, after: now + MAX_RETRY_MS });
          return;
        }
        this.retries.set(id, { failures, after: now + Math.min(ATTENDANCE_POLL_MS * 2 ** (failures - 1), MAX_RETRY_MS) });
        this.recordError(error);
      }
    }, 3);

    // Drop completed work from memory; final records are durable and are never pruned here.
    for (const id of finalized) { this.known.delete(id); this.discoveredIds.delete(id); this.retries.delete(id); }
    if (!this.lastError) this.lastSuccessAt = now;
  }
}
