import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Details as SpotifyDetails } from "spotify-url-info";
import { canonicalizeMediaInput, MusicSources } from "../src/music/sources.js";
import type { MusicReadiness, MusicStream, MusicTrack } from "../src/music/types.js";
import type { MusicProcesses } from "../src/music/processes.js";

const options = { ytDlpPath: "C:\\tools\\yt-dlp.exe", ffmpegPath: "C:\\tools\\ffmpeg.exe" };

class FakeProcesses {
  calls: string[][] = [];
  responses: unknown[] = [];

  async inspect(): Promise<MusicReadiness> { return { ready: true }; }
  async ytDlpJson(args: readonly string[], signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    this.calls.push([...args]);
    if (!this.responses.length) throw new Error("Missing fake yt-dlp response");
    return this.responses.shift();
  }
  stream(_url: string, _signal: AbortSignal): MusicStream {
    const stream = new PassThrough();
    stream.end();
    return { stream, done: Promise.resolve(), stop() {} };
  }
}

function source(processes: FakeProcesses, spotifyDetails?: SpotifyDetails): MusicSources {
  return new MusicSources(options, {
    processes: processes as unknown as MusicProcesses,
    spotifyClient: {
      getDetails: async () => {
        if (!spotifyDetails) throw new Error("Unexpected Spotify lookup");
        return spotifyDetails;
      },
    },
  });
}

function details(tracks: SpotifyDetails["tracks"]): SpotifyDetails {
  return {
    preview: {
      date: null, title: "Fixture", type: "playlist", track: tracks[0]?.name ?? "",
      artist: tracks[0]?.artist ?? "", link: "https://open.spotify.com/playlist/3Q4cPwMHY95ZHXtmcU2xvH", embed: "fixture",
    },
    tracks,
  };
}

test("canonicalizes supported media links and treats ordinary text as a search", () => {
  assert.deepEqual(canonicalizeMediaInput("SOPHIE Immaterial"), { kind: "search", query: "SOPHIE Immaterial" });
  assert.deepEqual(canonicalizeMediaInput("https://youtu.be/PB5tnokRFS0?t=12"), {
    kind: "youtube-track", id: "PB5tnokRFS0", url: "https://www.youtube.com/watch?v=PB5tnokRFS0",
  });
  assert.deepEqual(canonicalizeMediaInput("https://music.youtube.com/watch?v=PB5tnokRFS0"), {
    kind: "youtube-track", id: "PB5tnokRFS0", url: "https://www.youtube.com/watch?v=PB5tnokRFS0",
  });
  assert.deepEqual(canonicalizeMediaInput("https://open.spotify.com/intl-ca/track/3Q4cPwMHY95ZHXtmcU2xvH?si=tracking"), {
    kind: "spotify-track", id: "3Q4cPwMHY95ZHXtmcU2xvH", url: "https://open.spotify.com/track/3Q4cPwMHY95ZHXtmcU2xvH",
  });
});

test("rejects insecure, credentialed, lookalike, short, and unsupported links", () => {
  for (const candidate of [
    "http://youtube.com/watch?v=PB5tnokRFS0",
    "youtube.com/watch?v=PB5tnokRFS0",
    "https://user:pass@youtube.com/watch?v=PB5tnokRFS0",
    "https://youtube.com:444/watch?v=PB5tnokRFS0",
    "https://youtube.com:443/watch?v=PB5tnokRFS0",
    "https://youtube.com.evil.example/watch?v=PB5tnokRFS0",
    "https://127.0.0.1/watch?v=PB5tnokRFS0",
    "https://spotify.link/abc123",
    "https://open.spotify.com/album/3Q4cPwMHY95ZHXtmcU2xvH",
  ]) assert.throws(() => canonicalizeMediaInput(candidate), /invalid|HTTPS|supported|short links|public Spotify/i, candidate);
});

test("keeps playlist order, drops unavailable and live entries, and reports truncation", async () => {
  const processes = new FakeProcesses();
  processes.responses.push({
    playlist_count: 4,
    entries: [
      { id: "AAAAAAAAAAA", title: "First", duration: 120 },
      { id: "BBBBBBBBBBB", title: "Private", availability: "private" },
      { id: "CCCCCCCCCCC", title: "Second", duration: 180 },
      { id: "DDDDDDDDDDD", title: "Live", is_live: true },
    ],
  });
  const result = await source(processes).resolve("https://www.youtube.com/playlist?list=PL1234567890", new AbortController().signal, 1);
  assert.deepEqual(result.tracks.map((track) => track.title), ["First"]);
  assert.deepEqual({ omitted: result.omitted, unavailable: result.unavailable, truncated: result.truncated }, { omitted: 1, unavailable: 2, truncated: true });
  assert.ok(processes.calls[0]!.includes("--flat-playlist"));
  assert.ok(processes.calls[0]!.includes("2"), "fetches one extra item to detect truncation");
  assert.equal(processes.calls[0]!.at(-1), "https://www.youtube.com/playlist?list=PL1234567890");
});

test("normalizes Spotify playlist metadata, preserves order, and caps results", async () => {
  const spotify = details([
    { name: " First\nSong ", artist: " Artist A ", duration: 201_400, uri: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA" },
    { name: "Unavailable", artist: "", duration: 10_000, uri: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB" },
    { name: "Second Song", artist: "Artist B", duration: 179_500, uri: "spotify:track:CCCCCCCCCCCCCCCCCCCCCC" },
  ]);
  let requested = "";
  const media = new MusicSources(options, {
    processes: new FakeProcesses() as unknown as MusicProcesses,
    spotifyClient: { getDetails: async (url) => { requested = url; return spotify; } },
  });
  const result = await media.resolve("https://open.spotify.com/intl-de/playlist/3Q4cPwMHY95ZHXtmcU2xvH?si=ignored", new AbortController().signal, 1);
  assert.equal(requested, "https://open.spotify.com/playlist/3Q4cPwMHY95ZHXtmcU2xvH");
  assert.deepEqual(result.tracks, [{
    title: "First Song", artist: "Artist A", durationSeconds: 201, source: "spotify",
    url: "https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA",
    originalUrl: "https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA",
  }]);
  assert.deepEqual({ omitted: result.omitted, unavailable: result.unavailable, truncated: result.truncated }, { omitted: 1, unavailable: 1, truncated: true });
});

test("uses only Spotify's canonical public embed endpoint through the bounded fetch wrapper", async () => {
  const id = "3Q4cPwMHY95ZHXtmcU2xvH";
  const resource = Buffer.from(JSON.stringify({
    type: "track", name: "Fixture Song", title: "Fixture Song", uri: `spotify:track:${id}`,
    artists: [{ name: "Fixture Artist" }], duration: 120_000, isPlayable: false,
    coverArt: { sources: [{ url: "https://i.scdn.co/image/fixture", width: 64, height: 64 }] },
  })).toString("base64");
  let requested = "";
  const fetchFixture: typeof fetch = async (input, init) => {
    requested = input.toString();
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return new Response(`<html><body><script id="resource">${resource}</script></body></html>`, {
      status: 200, headers: { "content-type": "text/html" },
    });
  };
  const media = new MusicSources(options, { processes: new FakeProcesses() as unknown as MusicProcesses, fetch: fetchFixture });
  const result = await media.resolve(`https://open.spotify.com/track/${id}`, new AbortController().signal);
  assert.equal(requested, `https://embed.spotify.com/?uri=spotify:track:${id}`);
  assert.equal(result.tracks[0]?.title, "Fixture Song");
  assert.equal(result.tracks[0]?.artist, "Fixture Artist");
});

test("rejects an oversized Spotify embed response before parsing it", async () => {
  const fetchFixture: typeof fetch = async () => new Response("small fixture", {
    status: 200, headers: { "content-length": String(2 * 1024 * 1024 + 1) },
  });
  const media = new MusicSources(options, { processes: new FakeProcesses() as unknown as MusicProcesses, fetch: fetchFixture });
  await assert.rejects(media.resolve(
    "https://open.spotify.com/track/3Q4cPwMHY95ZHXtmcU2xvH",
    new AbortController().signal,
  ), /exceeded 2 MiB/);
});

test("marks a 100-item Spotify embed response as possibly truncated", async () => {
  const spotify = details(Array.from({ length: 100 }, (_, index) => ({
    name: `Song ${index + 1}`,
    artist: "Fixture Artist",
    duration: 180_000,
    uri: `spotify:track:${index.toString(36).padStart(22, "A")}`,
  })));
  const result = await source(new FakeProcesses(), spotify).resolve(
    "https://open.spotify.com/playlist/3Q4cPwMHY95ZHXtmcU2xvH",
    new AbortController().signal,
  );
  assert.equal(result.tracks.length, 100);
  assert.equal(result.omitted, 0);
  assert.equal(result.truncated, true);
});

test("matches Spotify tracks against the first five YouTube results and returns actual YouTube metadata", async () => {
  const processes = new FakeProcesses();
  processes.responses.push({ entries: [
    { id: "AAAAAAAAAAA", title: "Immaterial", uploader: "Unrelated Cover Band", duration: 233 },
    { id: "PB5tnokRFS0", title: "Immaterial (Official Audio)", channel: "SOPHIE", duration: 234 },
  ] });
  processes.responses.push({ id: "PB5tnokRFS0", title: "Immaterial (Official Audio)", channel: "SOPHIE", duration: 234 });
  const spotifyTrack: MusicTrack = {
    title: "Immaterial", artist: "SOPHIE", durationSeconds: 233, source: "spotify",
    url: "https://open.spotify.com/track/3Q4cPwMHY95ZHXtmcU2xvH",
  };
  const prepared = await source(processes).prepare(spotifyTrack, new AbortController().signal);
  assert.deepEqual(prepared, {
    title: "Immaterial (Official Audio)", artist: "SOPHIE", durationSeconds: 234, source: "youtube",
    url: "https://www.youtube.com/watch?v=PB5tnokRFS0",
    originalUrl: spotifyTrack.url,
  });
  assert.equal(processes.calls[0]!.at(-1), "ytsearch5:SOPHIE - Immaterial");
  assert.ok(processes.calls[0]!.includes("--flat-playlist"));
  assert.equal(processes.calls[1]!.at(-1), "https://www.youtube.com/watch?v=PB5tnokRFS0");
});

test("refuses a Spotify result when artist or duration evidence is not convincing", async () => {
  const processes = new FakeProcesses();
  processes.responses.push({ entries: [
    { id: "AAAAAAAAAAA", title: "Immaterial", uploader: "Wrong Artist", duration: 400 },
  ] });
  await assert.rejects(source(processes).prepare({
    title: "Immaterial", artist: "SOPHIE", durationSeconds: 233, source: "spotify",
    url: "https://open.spotify.com/track/3Q4cPwMHY95ZHXtmcU2xvH",
  }, new AbortController().signal), /No convincing YouTube match/);
});

test("re-resolves YouTube metadata immediately before playback", async () => {
  const processes = new FakeProcesses();
  processes.responses.push({ id: "PB5tnokRFS0", title: "Fresh title", uploader: "SOPHIE", duration: 233 });
  const prepared = await source(processes).prepare({
    title: "Old title", source: "youtube", url: "https://youtu.be/PB5tnokRFS0",
  }, new AbortController().signal);
  assert.equal(prepared.title, "Fresh title");
  assert.equal(processes.calls[0]!.at(-1), "https://www.youtube.com/watch?v=PB5tnokRFS0");
});

test("limits metadata work globally to two calls and lets a queued call abort", async () => {
  let active = 0;
  let maximum = 0;
  const pending: Array<() => void> = [];
  const processes = new FakeProcesses();
  processes.ytDlpJson = async (_args, signal) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      pending.push(() => { signal.removeEventListener("abort", onAbort); resolve(); });
    });
    active--;
    return { id: "PB5tnokRFS0", title: "Fixture" };
  };
  const media = source(processes);
  const first = media.resolve("first", new AbortController().signal);
  const second = media.resolve("second", new AbortController().signal);
  const thirdController = new AbortController();
  const third = media.resolve("third", thirdController.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.equal(pending.length, 2);
  thirdController.abort();
  await assert.rejects(third, { name: "AbortError" });
  pending.splice(0).forEach((release) => release());
  await Promise.all([first, second]);
});
