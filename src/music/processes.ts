import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type { MusicReadiness, MusicStream } from "./types.js";

const METADATA_TIMEOUT_MS = 30_000;
const METADATA_IDLE_MS = 10_000;
const STREAM_STARTUP_MS = 20_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

const ENV_ALLOWLIST = [
  "APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LANG", "LOCALAPPDATA",
  "PATH", "PATHEXT", "PROGRAMDATA", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR",
] as const;

export interface SpawnedProcess extends ChildProcessWithoutNullStreams {}
export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => SpawnedProcess;

export interface MusicProcessOptions {
  ytDlpPath: string;
  ffmpegPath: string;
  nodePath?: string;
}

export interface MusicProcessDependencies {
  spawn?: SpawnProcess;
  environment?: NodeJS.ProcessEnv;
  access?: typeof access;
  stat?: typeof stat;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  platform?: NodeJS.Platform;
}

interface CapturedProcess {
  stdout: Buffer;
  stderr: string;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function abortError(message = "Music operation was cancelled"): Error {
  return new DOMException(message, "AbortError");
}

export function sanitizedChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  return clean;
}

export class MusicProcesses {
  readonly ytDlpPath: string;
  readonly ffmpegPath: string;
  readonly nodePath: string;
  private readonly spawnProcess: SpawnProcess;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly checkAccess: typeof access;
  private readonly checkStat: typeof stat;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly platform: NodeJS.Platform;
  private readonly children = new Set<SpawnedProcess>();
  private readonly treeKillers = new Set<SpawnedProcess>();

  constructor(options: MusicProcessOptions, dependencies: MusicProcessDependencies = {}) {
    this.ytDlpPath = options.ytDlpPath;
    this.ffmpegPath = options.ffmpegPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.spawnProcess = dependencies.spawn ?? (spawn as SpawnProcess);
    this.environment = sanitizedChildEnvironment(dependencies.environment);
    this.checkAccess = dependencies.access ?? access;
    this.checkStat = dependencies.stat ?? stat;
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
    this.platform = dependencies.platform ?? process.platform;
  }

  private commonYtDlpArguments(): string[] {
    return [
      "--ignore-config",
      "--no-cookies",
      "--no-cookies-from-browser",
      "--no-cache-dir",
      "--no-remote-components",
      "--js-runtimes", `node:${this.nodePath}`,
      "--no-warnings",
    ];
  }

  private spawn(command: string, args: readonly string[]): SpawnedProcess {
    const child = this.spawnProcess(command, args, {
      shell: false,
      windowsHide: true,
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    child.stdin.on("error", () => {});
    child.once("close", () => this.children.delete(child));
    child.once("error", () => this.children.delete(child));
    return child;
  }

  private terminate(child: SpawnedProcess): void {
    if (!this.children.has(child) || child.killed) return;
    const pid = child.pid;
    if (this.platform !== "win32" || !Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
      child.kill();
      return;
    }

    // yt-dlp can own an EJS Node child. taskkill is scoped to the exact PID
    // spawned by this instance, so descendants are reaped without scanning or
    // touching unrelated user processes.
    const systemRoot = this.environment.SYSTEMROOT ?? this.environment.WINDIR;
    const taskkillPath = systemRoot && isAbsolute(systemRoot) ? join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
    try {
      const killer = this.spawnProcess(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.treeKillers.add(killer);
      killer.stdin.on("error", () => {});
      killer.stdin.end();
      killer.stdout.resume();
      killer.stderr.resume();
      const fallback = () => {
        this.treeKillers.delete(killer);
        if (this.children.has(child) && !child.killed) child.kill();
      };
      killer.once("error", fallback);
      killer.once("close", (code) => {
        this.treeKillers.delete(killer);
        if (code !== 0 && this.children.has(child) && !child.killed) child.kill();
      });
    } catch {
      child.kill();
    }
  }

  private capture(command: string, args: readonly string[], signal?: AbortSignal, timeoutMs = METADATA_TIMEOUT_MS): Promise<CapturedProcess> {
    if (signal?.aborted) return Promise.reject(abortError());
    const child = this.spawn(command, args);
    child.stdin.end();

    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout>;

      const finish = (error?: Error, result?: CapturedProcess) => {
        if (settled) return;
        settled = true;
        this.clearTimer(idleTimer);
        this.clearTimer(totalTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result!);
      };
      const stopWith = (error: Error) => {
        this.terminate(child);
        finish(error);
      };
      const resetIdle = () => {
        this.clearTimer(idleTimer);
        idleTimer = this.setTimer(() => stopWith(new Error("Media helper produced no output for 10 seconds")), METADATA_IDLE_MS);
      };
      const onAbort = () => stopWith(abortError());
      const totalTimer = this.setTimer(() => stopWith(new Error(`Media helper exceeded ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);

      resetIdle();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => {
        resetIdle();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > MAX_METADATA_BYTES) {
          stopWith(new Error("Media helper output exceeded 4 MiB"));
          return;
        }
        stdout.push(buffer);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        resetIdle();
        if (Buffer.byteLength(stderr) < MAX_ERROR_BYTES) stderr += chunk.toString();
      });
      child.once("error", (error) => finish(new Error(`Could not start media helper: ${safeMessage(error)}`)));
      child.once("close", (code, killedSignal) => {
        if (settled) return;
        if (code !== 0) {
          const detail = safeMessage(stderr) || `exit code ${code ?? "unknown"}${killedSignal ? ` (${killedSignal})` : ""}`;
          finish(new Error(`Media helper failed: ${detail}`));
          return;
        }
        finish(undefined, { stdout: Buffer.concat(stdout), stderr });
      });
    });
  }

  async ytDlpJson(args: readonly string[], signal: AbortSignal): Promise<unknown> {
    const result = await this.capture(this.ytDlpPath, [...this.commonYtDlpArguments(), ...args], signal);
    try {
      return JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("yt-dlp returned invalid metadata");
    }
  }

  async inspect(): Promise<MusicReadiness> {
    try {
      for (const [label, executable] of [["yt-dlp", this.ytDlpPath], ["FFmpeg", this.ffmpegPath], ["Node.js", this.nodePath]] as const) {
        if (!isAbsolute(executable)) return { ready: false, reason: `${label} path must be absolute` };
        const file = await this.checkStat(executable);
        if (!file.isFile()) return { ready: false, reason: `${label} path is not a file: ${executable}` };
        await this.checkAccess(executable);
      }

      const ytVersion = (await this.capture(this.ytDlpPath, [...this.commonYtDlpArguments(), "--version"], undefined, 10_000)).stdout.toString("utf8").trim();
      if (!/^\d{4}\.\d{2}\.\d{2}/.test(ytVersion)) return { ready: false, reason: "yt-dlp did not report an official date-based version" };

      const ffmpeg = await this.capture(this.ffmpegPath, ["-hide_banner", "-version"], undefined, 10_000);
      const ffmpegText = `${ffmpeg.stdout.toString("utf8")}\n${ffmpeg.stderr}`;
      if (!/^ffmpeg version /im.test(ffmpegText)) return { ready: false, reason: "FFmpeg did not report a usable version" };

      const encoders = await this.capture(this.ffmpegPath, ["-hide_banner", "-encoders"], undefined, 10_000);
      if (!/\blibopus\b/i.test(`${encoders.stdout.toString("utf8")}\n${encoders.stderr}`)) {
        return { ready: false, reason: "FFmpeg is installed but its libopus encoder is unavailable" };
      }
      return { ready: true };
    } catch (error) {
      return { ready: false, reason: safeMessage(error) || "Media helpers are unavailable" };
    }
  }

  stream(youtubeUrl: string, signal: AbortSignal): MusicStream {
    const output = new PassThrough();
    // A consumer may rely only on `done`; keep stream errors from becoming an
    // uncaught EventEmitter error while still exposing them to other listeners.
    output.on("error", () => {});
    if (signal.aborted) {
      const error = abortError();
      output.destroy(error);
      const done = Promise.reject(error);
      void done.catch(() => {});
      return { stream: output, done, stop() {} };
    }

    const ytDlp = this.spawn(this.ytDlpPath, [
      ...this.commonYtDlpArguments(),
      // YouTube's current visionOS DASH URLs can advertise format 251 and
      // then reject the media request with HTTP 403. Public audio HLS formats
      // 234/233 are playable without authentication; retain generic fallbacks
      // for videos/extractors where those format IDs do not exist. Let the
      // existing FFmpeg read HLS so yt-dlp does not create fragment temp files.
      "--no-playlist", "--no-progress", "--downloader", "ffmpeg", "--ffmpeg-location", this.ffmpegPath,
      "--format", "234/233/bestaudio/best", "--output", "-", "--", youtubeUrl,
    ]);
    const ffmpeg = this.spawn(this.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", "-vn",
      "-c:a", "libopus", "-b:a", "128k", "-vbr", "on", "-f", "ogg", "pipe:1",
    ]);
    ytDlp.stdin.end();
    // FFmpeg can close stdin first when playback stops or a downstream
    // decoder intentionally consumes only a sample. Process exit is reported
    // through `done`; do not let the pipe's expected EPIPE/EOF escape.
    ffmpeg.stdin.on("error", () => {});
    ytDlp.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(output);

    let stopped = false;
    let settled = false;
    let stderr = "";
    let watchdog: ReturnType<typeof setTimeout>;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      this.clearTimer(watchdog);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        output.destroy(error);
        rejectDone(error);
      } else {
        output.end();
        resolveDone();
      }
    };
    const killOwned = () => {
      this.terminate(ytDlp);
      this.terminate(ffmpeg);
    };
    const fail = (error: Error) => {
      killOwned();
      finish(error);
    };
    const resetWatchdog = () => {
      this.clearTimer(watchdog);
      watchdog = this.setTimer(() => fail(new Error("Audio stream did not start within 20 seconds")), STREAM_STARTUP_MS);
    };
    const onAbort = () => fail(abortError());
    const recordError = (chunk: Buffer | string) => {
      if (Buffer.byteLength(stderr) < MAX_ERROR_BYTES) stderr += chunk.toString();
    };

    resetWatchdog();
    signal.addEventListener("abort", onAbort, { once: true });
    ytDlp.stderr.on("data", recordError);
    ffmpeg.stderr.on("data", recordError);
    // Once audio starts, downstream backpressure may legitimately stop reads
    // for an arbitrarily long pause. Only bound startup silence here.
    ffmpeg.stdout.once("data", () => this.clearTimer(watchdog));
    ytDlp.once("error", (error) => fail(new Error(`Could not start yt-dlp: ${safeMessage(error)}`)));
    ffmpeg.once("error", (error) => fail(new Error(`Could not start FFmpeg: ${safeMessage(error)}`)));
    ytDlp.once("close", (code) => {
      if (!stopped && code !== 0 && !settled) fail(new Error(`yt-dlp stream failed: ${safeMessage(stderr) || `exit code ${code ?? "unknown"}`}`));
    });
    ffmpeg.once("close", (code) => {
      if (stopped || settled) return;
      if (code === 0) finish();
      else fail(new Error(`FFmpeg stream failed: ${safeMessage(stderr) || `exit code ${code ?? "unknown"}`}`));
    });

    const stop = () => {
      if (stopped) return;
      stopped = true;
      killOwned();
      finish();
    };
    return { stream: output as Readable, done, stop };
  }

  stopAll(): void {
    for (const child of [...this.children]) this.terminate(child);
  }
}
