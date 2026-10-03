import { MUSIC_QUEUE_LIMIT, type MusicTrack } from "./types.js";

export interface QueueAddResult {
  added: number;
  omitted: number;
}

/** A bounded FIFO containing only tracks waiting to be played. */
export class MusicQueue<T extends MusicTrack = MusicTrack> {
  readonly #tracks: T[] = [];

  constructor(readonly limit = MUSIC_QUEUE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Music queue limit must be a positive integer");
  }

  get length(): number {
    return this.#tracks.length;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.#tracks.length);
  }

  add(tracks: readonly T[]): QueueAddResult {
    const accepted = tracks.slice(0, this.remaining);
    this.#tracks.push(...accepted);
    return { added: accepted.length, omitted: tracks.length - accepted.length };
  }

  shift(): T | undefined {
    return this.#tracks.shift();
  }

  clear(): void {
    this.#tracks.length = 0;
  }

  snapshot(): readonly T[] {
    return [...this.#tracks];
  }
}
