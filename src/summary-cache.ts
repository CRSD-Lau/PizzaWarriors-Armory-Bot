export type SummarySnapshot<T> = { value: T; fetchedAt: number; stale: boolean };

export function cacheKeyForCharacter(name: string, realm: string): string {
  return JSON.stringify([realm.trim().toLowerCase(), name.trim().toLowerCase()]);
}

/** Bounded LRU storage with one shared refresh (including stale recovery) per character. */
export class SummaryCache<T> {
  private readonly entries = new Map<string, { value: T; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<SummarySnapshot<T>>>();

  constructor(
    private readonly freshAgeMs: number,
    private readonly staleAgeMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string, load: () => Promise<T>, onStale?: (error: unknown) => void): Promise<SummarySnapshot<T>> {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.fetchedAt >= this.staleAgeMs || entry.fetchedAt > now) this.entries.delete(entryKey);
    }
    const cached = this.entries.get(key);
    if (cached && now - cached.fetchedAt < this.freshAgeMs) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { ...cached, stale: false };
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const request = Promise.resolve().then(load).then((value) => {
      const entry = { value, fetchedAt: this.now() };
      this.entries.delete(key);
      this.entries.set(key, entry);
      while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
      return { ...entry, stale: false };
    }, (error: unknown) => {
      if (!cached || this.now() - cached.fetchedAt >= this.staleAgeMs) throw error;
      onStale?.(error);
      return { ...cached, stale: true };
    });
    this.inFlight.set(key, request);
    try { return await request; }
    finally { if (this.inFlight.get(key) === request) this.inFlight.delete(key); }
  }
}
