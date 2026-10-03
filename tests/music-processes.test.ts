import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MusicProcesses, sanitizedChildEnvironment, type SpawnProcess, type SpawnedProcess } from "../src/music/processes.js";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  pid: number | undefined;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, "SIGTERM"));
    return true;
  }

  complete(stdout = "", stderr = "", code = 0): void {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, null));
  }

  asProcess(): SpawnedProcess {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  child: FakeChild;
}

function factory(onSpawn?: (call: SpawnCall) => void): { calls: SpawnCall[]; spawn: SpawnProcess } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn(command, args, options) {
      const child = new FakeChild();
      const call = { command, args: [...args], options, child };
      calls.push(call);
      if (onSpawn) queueMicrotask(() => onSpawn(call));
      return child.asProcess();
    },
  };
}

const paths = { ytDlpPath: "C:\\tools\\yt-dlp.exe", ffmpegPath: "C:\\tools\\ffmpeg.exe", nodePath: "C:\\Program Files\\nodejs\\node.exe" };

test("builds a minimal child environment without Discord or generic secret variables", () => {
  const env = sanitizedChildEnvironment({
    PATH: "fixture-path", SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Temp",
    DISCORD_TOKEN: "never-forward", API_KEY: "never-forward", NODE_OPTIONS: "--require malicious.js",
  });
  assert.deepEqual(env, { PATH: "fixture-path", SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Temp" });
});

test("runs yt-dlp without a shell, config, cache, remote components, cookies, or downloads", async () => {
  const fake = factory(({ child }) => child.complete('{"id":"PB5tnokRFS0","title":"Immaterial"}'));
  const processes = new MusicProcesses(paths, {
    spawn: fake.spawn,
    environment: { PATH: "fixture", DISCORD_TOKEN: "secret", MUSIC_API_TOKEN: "secret" },
  });
  const result = await processes.ytDlpJson(["--dump-single-json", "--skip-download", "--", "ytsearch1:test"], new AbortController().signal);
  assert.deepEqual(result, { id: "PB5tnokRFS0", title: "Immaterial" });
  const call = fake.calls[0]!;
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.env, { PATH: "fixture" });
  assert.ok(call.args.includes("--ignore-config"));
  assert.ok(call.args.includes("--no-cookies"));
  assert.ok(call.args.includes("--no-cookies-from-browser"));
  assert.ok(call.args.includes("--no-cache-dir"));
  assert.ok(call.args.includes("--no-remote-components"));
  assert.equal(call.args[call.args.indexOf("--js-runtimes") + 1], `node:${paths.nodePath}`);
  assert.ok(call.args.includes("--skip-download"));
  assert.equal(call.args.at(-1), "ytsearch1:test");
});

test("aborting metadata kills only the owned child and rejects cleanly", async () => {
  const fake = factory();
  const processes = new MusicProcesses(paths, { spawn: fake.spawn });
  const controller = new AbortController();
  const result = processes.ytDlpJson(["--dump-single-json", "--", "ytsearch1:test"], controller.signal);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.child.killed, true);
});

test("on Windows termination reaps only the exact owned PID and its descendants", async () => {
  const fake = factory((call) => {
    if (call.command.toLowerCase().endsWith("taskkill.exe")) call.child.complete("SUCCESS");
  });
  const processes = new MusicProcesses(paths, {
    spawn: fake.spawn,
    platform: "win32",
    environment: { SYSTEMROOT: "C:\\Windows" },
  });
  const controller = new AbortController();
  const result = processes.ytDlpJson(["--dump-single-json", "--", "ytsearch1:test"], controller.signal);
  fake.calls[0]!.child.pid = 43210;
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1]!.command, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(fake.calls[1]!.args, ["/PID", "43210", "/T", "/F"]);
  assert.equal(fake.calls[1]!.options.shell, false);
  assert.equal(fake.calls[0]!.child.killed, false, "does not race a direct kill that could orphan descendants");
});

test("a silent metadata process is bounded by the helper timeout", async () => {
  const fake = factory();
  const immediateTimer = ((callback: (...args: unknown[]) => void) => {
    queueMicrotask(callback);
    return { fixture: true } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const processes = new MusicProcesses(paths, {
    spawn: fake.spawn,
    setTimer: immediateTimer,
    clearTimer: (() => {}) as typeof clearTimeout,
  });
  await assert.rejects(processes.ytDlpJson(["--dump-single-json", "--", "ytsearch1:test"], new AbortController().signal), /exceeded 30 seconds|no output/);
  assert.equal(fake.calls[0]!.child.killed, true);
});

test("inspect validates official yt-dlp, FFmpeg, and libopus readiness", async () => {
  const fake = factory(({ args, child }) => {
    if (args.includes("--version")) child.complete("2026.08.19\n");
    else if (args.includes("-version")) child.complete("ffmpeg version 9.0.2-full_build\n");
    else child.complete(" A..... libopus libopus Opus\n");
  });
  const processes = new MusicProcesses(paths, {
    spawn: fake.spawn,
    stat: (async () => ({ isFile: () => true })) as never,
    access: (async () => {}) as never,
  });
  assert.deepEqual(await processes.inspect(), { ready: true });
  assert.equal(fake.calls.length, 3);
});

test("inspect returns an actionable reason when a configured path is relative", async () => {
  const processes = new MusicProcesses({ ...paths, ytDlpPath: "runtime\\yt-dlp.exe" });
  assert.deepEqual(await processes.inspect(), { ready: false, reason: "yt-dlp path must be absolute" });
});

test("streams yt-dlp stdout through FFmpeg libopus to an Ogg output", async () => {
  const fake = factory(({ command, child }) => {
    if (command === paths.ytDlpPath) {
      child.stdout.write("source-audio");
      child.stdout.end();
      queueMicrotask(() => child.emit("close", 0, null));
    } else {
      child.stdout.write(Buffer.from("OggSfixture"));
      child.stdout.end();
      queueMicrotask(() => child.emit("close", 0, null));
    }
  });
  const processes = new MusicProcesses(paths, { spawn: fake.spawn });
  const audio = processes.stream("https://www.youtube.com/watch?v=PB5tnokRFS0", new AbortController().signal);
  const chunks: Buffer[] = [];
  audio.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  await audio.done;
  assert.equal(Buffer.concat(chunks).toString(), "OggSfixture");
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls[0]!.args.includes("--output"));
  assert.equal(fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--downloader") + 1], "ffmpeg");
  assert.equal(fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--ffmpeg-location") + 1], paths.ffmpegPath);
  assert.equal(fake.calls[0]!.args[fake.calls[0]!.args.indexOf("--format") + 1], "234/233/bestaudio/best");
  assert.equal(fake.calls[0]!.args.at(-1), "https://www.youtube.com/watch?v=PB5tnokRFS0");
  assert.deepEqual(fake.calls[1]!.args.slice(-4), ["on", "-f", "ogg", "pipe:1"]);
  assert.ok(fake.calls[1]!.args.includes("libopus"));
});

test("stop kills the two stream children and settles the completion promise", async () => {
  const fake = factory();
  const processes = new MusicProcesses(paths, { spawn: fake.spawn });
  const audio = processes.stream("https://www.youtube.com/watch?v=PB5tnokRFS0", new AbortController().signal);
  audio.stop();
  await audio.done;
  assert.equal(fake.calls.length, 2);
  assert.ok(fake.calls.every(({ child }) => child.killed));
});
