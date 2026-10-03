import spotifyUrlInfoPackage, { type Details as SpotifyDetails, type SpotifyUrlInfo, type SpotifyUrlInfoModule } from "spotify-url-info";
import { MUSIC_QUEUE_LIMIT, type MusicSelection, type MusicSource, type MusicStream, type MusicTrack } from "./types.js";
import { MusicProcesses, type MusicProcessDependencies, type MusicProcessOptions } from "./processes.js";

const SPOTIFY_BODY_LIMIT = 2 * 1024 * 1024;
const RESOLVE_TIMEOUT_MS = 30_000;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_PLAYLIST_ID = /^[A-Za-z0-9_-]{10,80}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const PRIVATE_AVAILABILITY = new Set(["private", "needs_auth", "subscriber_only", "premium_only"]);

type MediaInput =
  | { kind: "search"; query: string }
  | { kind: "youtube-track"; id: string; url: string }
  | { kind: "youtube-playlist"; id: string; url: string }
  | { kind: "spotify-track"; id: string; url: string }
  | { kind: "spotify-playlist"; id: string; url: string };

interface YoutubeMetadata {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  artist?: unknown;
  uploader?: unknown;
  channel?: unknown;
  availability?: unknown;
  is_live?: unknown;
  live_status?: unknown;
  entries?: unknown;
  playlist_count?: unknown;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

class AbortableSemaphore {
  private active = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(private readonly capacity: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve(this.releaseFunction());
    }
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseFunction(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.queue.length) {
        const waiter = this.queue.shift()!;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        if (!waiter.signal.aborted) {
          waiter.resolve(this.releaseFunction());
          return;
        }
      }
      this.active--;
    };
  }
}

const metadataSlots = new AbortableSemaphore(2);
const createSpotifyUrlInfo = spotifyUrlInfoPackage as unknown as SpotifyUrlInfoModule;

export interface MusicSourceDependencies {
  processes?: MusicProcesses;
  processDependencies?: MusicProcessDependencies;
  fetch?: typeof fetch;
  spotifyClient?: Pick<SpotifyUrlInfo, "getDetails">;
}

function abortError(message = "Music operation was cancelled"): Error {
  return new DOMException(message, "AbortError");
}

function cleanText(value: unknown, maximum = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maximum) : undefined;
}

function positiveSeconds(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined;
}

function parseStrictHttps(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("That media URL is invalid");
  }
  const authority = raw.match(/^https:\/\/([^/?#]+)/i)?.[1] ?? "";
  const explicitPort = /:\d+$/.test(authority);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || explicitPort) {
    throw new Error("Media links must use HTTPS without credentials or a custom port");
  }
  return parsed;
}

function canonicalYoutube(parsed: URL): MediaInput {
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) throw new Error("Only YouTube and Spotify track or playlist links are supported");
  let videoId: string | null = null;
  let playlistId = parsed.searchParams.get("list");

  if (host === "youtu.be") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) throw new Error("That youtu.be link is not a supported video link");
    videoId = parts[0] ?? null;
  } else if (parsed.pathname === "/watch") {
    videoId = parsed.searchParams.get("v");
  } else if (parsed.pathname === "/playlist") {
    playlistId = parsed.searchParams.get("list");
  } else {
    const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/);
    if (match) videoId = match[1] ?? null;
    else throw new Error("That YouTube URL is not a supported video or playlist link");
  }

  if (playlistId !== null) {
    if (!YOUTUBE_PLAYLIST_ID.test(playlistId)) throw new Error("That YouTube playlist ID is invalid");
    return { kind: "youtube-playlist", id: playlistId, url: `https://www.youtube.com/playlist?list=${playlistId}` };
  }
  if (!videoId || !YOUTUBE_ID.test(videoId)) throw new Error("That YouTube video ID is invalid");
  return { kind: "youtube-track", id: videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

function canonicalSpotify(parsed: URL): MediaInput {
  if (parsed.hostname.toLowerCase() !== "open.spotify.com") {
    if (parsed.hostname.toLowerCase() === "spotify.link") {
      throw new Error("Spotify short links are not accepted; paste the canonical open.spotify.com track or playlist link");
    }
    throw new Error("Only YouTube and Spotify track or playlist links are supported");
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase().startsWith("intl-")) parts.shift();
  if (parts.length !== 2 || !["track", "playlist"].includes(parts[0]!.toLowerCase()) || !SPOTIFY_ID.test(parts[1]!)) {
    throw new Error("Only public Spotify track and playlist links are supported");
  }
  const type = parts[0]!.toLowerCase() as "track" | "playlist";
  const id = parts[1]!;
  return { kind: `spotify-${type}`, id, url: `https://open.spotify.com/${type}/${id}` };
}

export function canonicalizeMediaInput(input: string): MediaInput {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a song search or a YouTube/Spotify link");
  const looksLikeUrl = /^[a-z][a-z\d+.-]*:/i.test(trimmed) || /^(?:www\.|\/\/|[\w.-]+\.[a-z]{2,}(?:\/|$))/i.test(trimmed);
  if (!looksLikeUrl) return { kind: "search", query: trimmed.slice(0, 500) };
  const parsed = parseStrictHttps(trimmed);
  const hostname = parsed.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(hostname)) return canonicalYoutube(parsed);
  return canonicalSpotify(parsed);
}

function isUnavailableYoutube(entry: YoutubeMetadata): boolean {
  const title = cleanText(entry.title)?.toLowerCase();
  const availability = cleanText(entry.availability)?.toLowerCase();
  return !cleanText(entry.id) || !title || title === "[private video]" || title === "[deleted video]"
    || (availability !== undefined && PRIVATE_AVAILABILITY.has(availability))
    || entry.is_live === true || entry.live_status === "is_live" || entry.live_status === "is_upcoming";
}

function youtubeTrack(entry: YoutubeMetadata): MusicTrack | undefined {
  if (isUnavailableYoutube(entry)) return undefined;
  const id = cleanText(entry.id, 20);
  const title = cleanText(entry.title);
  if (!id || !YOUTUBE_ID.test(id) || !title) return undefined;
  return {
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    source: "youtube",
    artist: cleanText(entry.artist) ?? cleanText(entry.uploader) ?? cleanText(entry.channel),
    durationSeconds: positiveSeconds(entry.duration),
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return MUSIC_QUEUE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Music result limit must be a positive integer");
  return Math.min(limit, MUSIC_QUEUE_LIMIT);
}

function spotifyTrackUrl(uri: string): string | undefined {
  const match = uri.match(/^spotify:track:([A-Za-z0-9]{22})$/);
  return match ? `https://open.spotify.com/track/${match[1]}` : undefined;
}

function spotifySelection(details: SpotifyDetails, limit: number): MusicSelection {
  const tracks: MusicTrack[] = [];
  let unavailable = 0;
  let playable = 0;
  for (const item of details.tracks) {
    const url = typeof item.uri === "string" ? spotifyTrackUrl(item.uri) : undefined;
    const title = cleanText(item.name);
    const artist = cleanText(item.artist);
    if (!url || !title || !artist) {
      unavailable++;
      continue;
    }
    playable++;
    if (tracks.length >= limit) continue;
    tracks.push({
      title,
      artist,
      durationSeconds: positiveSeconds(typeof item.duration === "number" ? item.duration / 1000 : undefined),
      source: "spotify",
      url,
      originalUrl: url,
    });
  }
  const omitted = Math.max(0, playable - tracks.length);
  // Spotify's public embed surface exposes no more than 100 entries and does
  // not disclose the full playlist count. Exactly 100 therefore means more
  // may exist even when this response itself did not omit a known item.
  return { tracks, unavailable, omitted, truncated: omitted > 0 || details.tracks.length >= MUSIC_QUEUE_LIMIT };
}

function normalizedWords(value: string): string[] {
  return value.toLowerCase()
    .replace(/\b(?:official\s+)?(?:music\s+)?video\b|\bofficial audio\b|\blyric(?:s| video)?\b|\bvisuali[sz]er\b/g, " ")
    .replace(/\b(?:feat|ft)\.?\s+[^()[\]-]+/g, " ")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function similarity(left: string, right: string): number {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (!a.length || !b.length) return 0;
  const one = a.join(" ");
  const two = b.join(" ");
  if (one === two) return 1;
  if (one.includes(two) || two.includes(one)) return 0.9;
  const aa = new Set(a);
  const bb = new Set(b);
  let intersection = 0;
  for (const word of aa) if (bb.has(word)) intersection++;
  return intersection / new Set([...aa, ...bb]).size;
}

function bestYoutubeMatch(original: MusicTrack, candidates: MusicTrack[]): MusicTrack | undefined {
  let best: { track: MusicTrack; score: number } | undefined;
  for (const candidate of candidates.slice(0, 5)) {
    const titleScore = similarity(original.title, candidate.title);
    const artistScore = original.artist && candidate.artist ? similarity(original.artist, candidate.artist) : 0;
    const durationDifference = original.durationSeconds && candidate.durationSeconds
      ? Math.abs(original.durationSeconds - candidate.durationSeconds)
      : undefined;
    const durationScore = durationDifference === undefined ? 0 : durationDifference <= 3 ? 1 : durationDifference <= 10 ? 0.7 : durationDifference <= 20 ? 0.3 : 0;
    const score = titleScore * 0.65 + artistScore * 0.25 + durationScore * 0.1;
    if (titleScore < 0.55 || (durationDifference !== undefined && durationDifference > 20)) continue;
    if (original.artist && candidate.artist && artistScore < 0.2) continue;
    if (score >= 0.68 && (!best || score > best.score)) best = { track: candidate, score };
  }
  return best?.track;
}

async function boundedSpotifyFetch(fetchImpl: typeof fetch, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const raw = input instanceof Request ? input.url : input.toString();
  const url = parseStrictHttps(raw);
  const pathMatch = url.hostname === "open.spotify.com" ? url.pathname.match(/^\/embed\/(track|playlist)\/([A-Za-z0-9]{22})\/?$/) : null;
  const embedUri = url.hostname === "embed.spotify.com" && url.pathname === "/" && !url.hash && [...url.searchParams.keys()].length === 1
    ? url.searchParams.get("uri")?.match(/^spotify:(track|playlist):([A-Za-z0-9]{22})$/)
    : null;
  if ((!pathMatch || url.search || url.hash) && !embedUri) throw new Error("Blocked an unexpected Spotify metadata endpoint");

  const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const signals = [timeout, init?.signal].filter((item): item is AbortSignal => item !== undefined && item !== null);
  const response = await fetchImpl(url, { ...init, redirect: "error", signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) });
  if (!response.ok) throw new Error(`Spotify metadata request failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > SPOTIFY_BODY_LIMIT) throw new Error("Spotify metadata response exceeded 2 MiB");
  if (!response.body) return new Response("", { status: response.status, headers: response.headers });

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SPOTIFY_BODY_LIMIT) {
      await reader.cancel();
      throw new Error("Spotify metadata response exceeded 2 MiB");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export class MusicSources implements MusicSource {
  private readonly processes: MusicProcesses;
  private readonly spotify: Pick<SpotifyUrlInfo, "getDetails">;

  constructor(options: MusicProcessOptions, dependencies: MusicSourceDependencies = {}) {
    this.processes = dependencies.processes ?? new MusicProcesses(options, dependencies.processDependencies);
    const fetchImpl = dependencies.fetch ?? fetch;
    this.spotify = dependencies.spotifyClient ?? createSpotifyUrlInfo((input: string | URL | Request, init?: RequestInit) => boundedSpotifyFetch(fetchImpl, input, init));
  }

  inspect() {
    return this.processes.inspect();
  }

  private async metadata<T>(signal: AbortSignal, operation: (combined: AbortSignal) => Promise<T>): Promise<T> {
    const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    let release: (() => void) | undefined;
    try {
      release = await metadataSlots.acquire(combined);
      return await operation(combined);
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error("Music metadata lookup exceeded 30 seconds");
      throw error;
    } finally {
      release?.();
    }
  }

  private async youtube(args: readonly string[], signal: AbortSignal, limit: number): Promise<MusicSelection> {
    const data = await this.processes.ytDlpJson(args, signal) as YoutubeMetadata;
    const rawEntries = Array.isArray(data.entries) ? data.entries : [data];
    const available: MusicTrack[] = [];
    let unavailable = 0;
    for (const raw of rawEntries) {
      const track = raw && typeof raw === "object" ? youtubeTrack(raw as YoutubeMetadata) : undefined;
      if (track) available.push(track);
      else unavailable++;
    }
    const tracks = available.slice(0, limit);
    const declaredCount = positiveSeconds(data.playlist_count) ?? rawEntries.length;
    const omitted = Math.max(0, available.length - tracks.length, declaredCount - tracks.length - unavailable);
    return { tracks, unavailable, omitted, truncated: omitted > 0 };
  }

  resolve(query: string, signal: AbortSignal, requestedLimit?: number): Promise<MusicSelection> {
    const limit = normalizeLimit(requestedLimit);
    const input = canonicalizeMediaInput(query);
    return this.metadata(signal, async (combined) => {
      if (input.kind === "spotify-track" || input.kind === "spotify-playlist") {
        const details = await this.spotify.getDetails(input.url, { signal: combined });
        return spotifySelection(details, limit);
      }
      if (input.kind === "youtube-playlist") {
        return this.youtube([
          "--dump-single-json", "--skip-download", "--flat-playlist", "--playlist-end", String(limit + 1), "--", input.url,
        ], combined, limit);
      }
      const target = input.kind === "search" ? `ytsearch1:${input.query}` : input.url;
      return this.youtube(["--dump-single-json", "--skip-download", "--no-playlist", "--", target], combined, 1);
    });
  }

  prepare(track: MusicTrack, signal: AbortSignal): Promise<MusicTrack> {
    return this.metadata(signal, async (combined) => {
      if (track.source === "youtube") {
        const canonical = canonicalizeMediaInput(track.url);
        if (canonical.kind !== "youtube-track") throw new Error("Queued YouTube item is not an individual video");
        const result = await this.youtube(["--dump-single-json", "--skip-download", "--no-playlist", "--", canonical.url], combined, 1);
        const fresh = result.tracks[0];
        if (!fresh) throw new Error("That YouTube track is no longer available");
        return fresh;
      }

      const original = canonicalizeMediaInput(track.url);
      if (original.kind !== "spotify-track") throw new Error("Queued Spotify item is not an individual track");
      const search = [track.artist, track.title].filter(Boolean).join(" - ");
      const candidates = await this.youtube(["--dump-single-json", "--skip-download", "--flat-playlist", "--no-playlist", "--", `ytsearch5:${search}`], combined, 5);
      const match = bestYoutubeMatch(track, candidates.tracks);
      if (!match) throw new Error(`No convincing YouTube match was found for ${track.artist ? `${track.artist} - ` : ""}${track.title}`);
      const fresh = await this.youtube(["--dump-single-json", "--skip-download", "--no-playlist", "--", match.url], combined, 1);
      if (!fresh.tracks[0]) throw new Error("The matched YouTube track is no longer available");
      return { ...fresh.tracks[0], source: "youtube", originalUrl: track.originalUrl ?? original.url };
    });
  }

  stream(track: MusicTrack, signal: AbortSignal): MusicStream {
    if (track.source !== "youtube") throw new Error("Spotify tracks must be prepared before streaming");
    const input = canonicalizeMediaInput(track.url);
    if (input.kind !== "youtube-track") throw new Error("Only individual YouTube videos can be streamed");
    return this.processes.stream(input.url, signal);
  }
}
