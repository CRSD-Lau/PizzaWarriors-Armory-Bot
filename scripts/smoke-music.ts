import "dotenv/config";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MusicSources } from "../src/music/sources.js";
import type { MusicTrack } from "../src/music/types.js";

// Author / Creator / Last Modified By: Neil Mitchell
// Explicit, opt-in real-provider check. No Discord login or audio files.
const queryIndex = process.argv.indexOf("--query");
const query = queryIndex >= 0 ? process.argv[queryIndex + 1] : "SOPHIE Immaterial official audio";
if (!query) throw new Error("Provide a query after --query.");
const ffmpegPath = process.env.MUSIC_FFMPEG_PATH || "";
const source = new MusicSources({
  ytDlpPath: process.env.MUSIC_YTDLP_PATH || resolve("runtime/music/yt-dlp-2026.08.19.exe"),
  ffmpegPath,
});
const readiness = await source.inspect();
if (!readiness.ready) throw new Error(readiness.reason || "Music dependencies are unavailable.");
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 60_000);
let media: ReturnType<MusicSources["stream"]> | undefined;
let decoder: ReturnType<typeof spawn> | undefined;
try {
  const selection = await source.resolve(query, controller.signal, 100);
  if (!selection.tracks.length) throw new Error("Source returned no playable tracks.");
  let track: MusicTrack | undefined;
  let skippedBeforePlayback = 0;
  for (const candidate of selection.tracks.slice(0, 5)) {
    try { track = await source.prepare(candidate, controller.signal); break; }
    catch (error) {
      if (controller.signal.aborted) throw error;
      skippedBeforePlayback++;
    }
  }
  if (!track) throw new Error("No playable match in the first five source tracks.");
  const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && ["systemroot", "windir", "temp", "tmp", "path"].includes(key.toLowerCase()))) as NodeJS.ProcessEnv;
  decoder = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-nostats", "-progress", "pipe:1", "-i", "pipe:0", "-t", "5", "-af", "volumedetect", "-f", "null", "-"], {
    shell: false, windowsHide: true, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], signal: controller.signal,
  });
  let diagnostic = "";
  let progress = "";
  decoder.stdout!.on("data", (chunk: Buffer) => { progress = (progress + chunk.toString()).slice(-16_384); });
  decoder.stderr!.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-16_384); });
  decoder.stdin!.on("error", () => { /* Decoder deliberately closes after five seconds. */ });
  const decoded = new Promise<number | null>((resolveExit, reject) => {
    decoder!.once("error", reject);
    decoder!.once("close", resolveExit);
  });
  media = source.stream(track, controller.signal);
  const mediaFailure = media.done.then(() => new Promise<never>(() => {}));
  media.stream.on("error", () => { /* Report through media.done. */ });
  media.stream.pipe(decoder.stdin!);
  const code = await Promise.race([decoded, mediaFailure]);
  if (code !== 0) throw new Error("FFmpeg could not decode the source audio.");
  const volume = diagnostic.match(/mean_volume:\s*(-?[\d.]+) dB/);
  const decodedUs = [...progress.matchAll(/out_time_us=(\d+)/g)].at(-1)?.[1];
  if (!volume || !decodedUs || Number(decodedUs) < 4_900_000 || Number(volume[1]) <= -85) {
    throw new Error("Source did not produce enough non-silent decoded audio.");
  }
  console.log(JSON.stringify({ query, imported: selection.tracks.length, omitted: selection.omitted, unavailable: selection.unavailable, truncated: selection.truncated, skippedBeforePlayback, playing: track.title, url: track.url, originalUrl: track.originalUrl, decodedSeconds: Number(decodedUs) / 1_000_000, meanVolumeDb: Number(volume[1]), discordListeningVerified: false }, null, 2));
} finally {
  clearTimeout(deadline);
  media?.stop();
  controller.abort();
  decoder?.kill();
  await media?.done.catch(() => {});
}
