/** Bounded, single-process read-through cache. Failed loads are never cached. */
export class AsyncTtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();
  private readonly pending = new Map<K, Promise<V>>();

  constructor(private readonly ttlMs: number, private readonly capacity: number, private readonly now = Date.now) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Cache lifetime and capacity must be positive.");
    }
  }

  get(key: K, loader: () => Promise<V>): Promise<V> {
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(entryKey);
    }
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return Promise.resolve(cached.value);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const result = Promise.resolve().then(loader).then((value) => {
      while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, result);
    return result;
  }
}
