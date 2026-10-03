import type { Readable } from "node:stream";

export interface MusicTrack {
  title: string;
  url: string;
  source: "youtube" | "spotify";
  artist?: string;
  durationSeconds?: number;
  originalUrl?: string;
  requestedBy?: string;
}

export interface MusicSelection {
  tracks: MusicTrack[];
  omitted: number;
  unavailable: number;
  truncated: boolean;
}

export interface MusicReadiness {
  ready: boolean;
  reason?: string;
}

export interface MusicStream {
  stream: Readable;
  done: Promise<void>;
  stop(): void;
}

export interface MusicSource {
  inspect(): Promise<MusicReadiness>;
  resolve(query: string, signal: AbortSignal, limit?: number): Promise<MusicSelection>;
  prepare(track: MusicTrack, signal: AbortSignal): Promise<MusicTrack>;
  stream(track: MusicTrack, signal: AbortSignal): MusicStream;
}

export const MUSIC_QUEUE_LIMIT = 100;
export const MUSIC_IDLE_MS = 60_000;
