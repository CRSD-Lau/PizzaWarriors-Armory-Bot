import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Client, type Guild, type VoiceState } from "discord.js";
import { MusicService, type MusicTransport, type MusicTransportCallbacks, type MusicTransportSession } from "../src/music/service.js";
import type { MusicReadiness, MusicSelection, MusicSource, MusicStream, MusicTrack } from "../src/music/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const track = (title: string): MusicTrack => ({ title, url: `https://example.test/${encodeURIComponent(title)}`, source: "youtube" });
const selection = (...titles: string[]): MusicSelection => ({ tracks: titles.map(track), omitted: 0, unavailable: 0, truncated: false });

class FakeSource implements MusicSource {
  readonly lookups = new Map<string, ReturnType<typeof deferred<MusicSelection>>>();
  readonly prepared: string[] = [];
  inspectResult: MusicReadiness = { ready: true };

  async inspect(): Promise<MusicReadiness> {
    return this.inspectResult;
  }

  resolve(query: string, signal: AbortSignal): Promise<MusicSelection> {
    if (query === "sync-invalid") throw new TypeError("invalid URL");
    const lookup = deferred<MusicSelection>();
    this.lookups.set(query, lookup);
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Cancelled", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      lookup.promise.then(resolve, reject);
    });
  }

  async prepare(value: MusicTrack, signal: AbortSignal): Promise<MusicTrack> {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    this.prepared.push(value.title);
    return value;
  }

  stream(_value: MusicTrack, _signal: AbortSignal): MusicStream {
    return { stream: new PassThrough(), done: new Promise<void>(() => undefined), stop() {} };
  }
}

class FakeTransportSession implements MusicTransportSession {
  readonly played: number[] = [];
  playing = false;
  destroyed = false;
  paused = false;

  constructor(readonly callbacks: MusicTransportCallbacks) {}

  play(): void {
    this.playing = true;
    this.played.push(this.played.length + 1);
  }

  pause(): boolean {
    if (!this.playing || this.paused) return false;
    this.paused = true;
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    return true;
  }

  stop(): boolean {
    const wasPlaying = this.playing;
    this.playing = false;
    this.paused = false;
    return wasPlaying;
  }

  destroy(): void {
    this.destroyed = true;
    this.playing = false;
  }

  idle(): void {
    this.playing = false;
    this.callbacks.onIdle();
  }

  staleIdle(): void {
    this.callbacks.onIdle();
  }

  error(): void {
    this.callbacks.onError();
  }
}

class FakeTransport implements MusicTransport {
  readonly sessions: FakeTransportSession[] = [];
  failConnect = false;

  async connect(_guild: Guild, _channelId: string, callbacks: MusicTransportCallbacks): Promise<MusicTransportSession> {
    if (this.failConnect) throw new Error("simulated connection failure");
    const session = new FakeTransportSession(callbacks);
    this.sessions.push(session);
    return session;
  }
}

class DelayedTransport implements MusicTransport {
  readonly started = deferred<void>();
  readonly released = deferred<FakeTransportSession>();
  signal?: AbortSignal;
  callbacks?: MusicTransportCallbacks;

  async connect(_guild: Guild, _channelId: string, callbacks: MusicTransportCallbacks, signal?: AbortSignal): Promise<MusicTransportSession> {
    this.signal = signal;
    this.callbacks = callbacks;
    this.started.resolve();
    return this.released.promise;
  }

  release(): FakeTransportSession {
    assert.ok(this.callbacks);
    const session = new FakeTransportSession(this.callbacks);
    this.released.resolve(session);
    return session;
  }
}

interface Harness {
  guild: Guild;
  voiceChannel: { id: string; type: ChannelType; members: Collection<string, unknown>; userLimit: number; isVoiceBased(): boolean };
  human: { id: string; user: { bot: boolean }; voice: { channel: unknown; channelId: string | null } };
  permissions: { allowed: boolean; moveMembers: boolean; administrator: boolean };
}

function harness(guildId = "guild-1", channelId = "voice-1"): Harness {
  const members = new Collection<string, unknown>();
  const voiceChannel = { id: channelId, type: ChannelType.GuildVoice, members, userLimit: 0, isVoiceBased: () => true };
  const human = { id: "human-1", displayName: "Neil", user: { bot: false }, voice: { channel: voiceChannel, channelId } };
  members.set(human.id, human);
  const permissions = { allowed: true, moveMembers: false, administrator: false };
  const bot = { id: "music-bot", user: { bot: true }, voice: { channel: null, channelId: null } };
  const guild = {
    id: guildId,
    afkChannelId: null,
    voiceAdapterCreator: {},
    members: { me: { ...bot, permissionsIn: () => ({
      has: (requested: bigint | bigint[]) => (Array.isArray(requested) ? requested : [requested]).every((flag) => {
        if (flag === PermissionFlagsBits.MoveMembers) return permissions.moveMembers || permissions.administrator;
        if (flag === PermissionFlagsBits.Administrator) return permissions.administrator;
        return permissions.allowed || permissions.administrator;
      }),
    }) } },
    channels: { cache: new Collection([[channelId, voiceChannel]]) },
  } as unknown as Guild;
  return { guild, voiceChannel, human, permissions };
}

function interaction(
  state: Harness,
  commandName: string,
  query?: string,
  voiceChannelId: string | null = state.voiceChannel.id,
): { value: ChatInputCommandInteraction; replies: string[]; deferred: unknown[]; followUps: Array<{ content: string; flags?: number }>; publicMessages: unknown[] } {
  const replies: string[] = [];
  const acknowledged: unknown[] = [];
  const followUps: Array<{ content: string; flags?: number }> = [];
  const publicMessages: unknown[] = [];
  const member = { ...state.human, voice: { channel: voiceChannelId ? state.voiceChannel : null, channelId: voiceChannelId } };
  const value = {
    commandName,
    guildId: state.guild.id,
    guild: state.guild,
    member,
    channel: { isSendable: () => true, send: async (message: unknown) => { publicMessages.push(message); } },
    inGuild: () => true,
    options: { getString: () => query ?? null },
    deferReply: async (options: unknown) => { acknowledged.push(options); },
    editReply: async (message: string | { content: string }) => { replies.push(typeof message === "string" ? message : message.content); },
    followUp: async (message: { content: string; flags?: number }) => { followUps.push(message); },
  } as unknown as ChatInputCommandInteraction;
  return { value, replies, deferred: acknowledged, followUps, publicMessages };
}

const fakeClient = { user: { id: "music-bot" } } as unknown as Client;

async function flush(): Promise<void> {
  await setImmediate();
  await setImmediate();
}

async function verifyOrderedAdmissionsAndControls(): Promise<void> {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const state = harness();
  const service = new MusicService(fakeClient, source, { enabled: true, transport });
  await service.initialize();

  const unrelated = interaction(state, "armory");
  assert.equal(await service.handle(unrelated.value), false);
  assert.equal(unrelated.deferred.length, 0);

  const first = interaction(state, "play", "first");
  const second = interaction(state, "play", "second");
  const firstRequest = service.handle(first.value);
  const secondRequest = service.handle(second.value);
  await flush();
  assert.deepEqual(first.deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(second.deferred, [{ flags: MessageFlags.Ephemeral }]);
  source.lookups.get("second")?.resolve(selection("Second"));
  await flush();
  assert.equal(transport.sessions[0].played.length, 0, "later lookup must wait behind the earlier admission");
  source.lookups.get("first")?.resolve(selection("First"));
  await Promise.all([firstRequest, secondRequest]);
  await flush();
  assert.equal(transport.sessions[0].played.length, 1);

  const queue = interaction(state, "queue");
  await service.handle(queue.value);
  assert.match(queue.replies[0], /Now playing: \*\*First /);
  assert.match(queue.replies[0], /https:\/\/example\.test\/First/);
  assert.match(queue.replies[0], /requested by Neil/);
  assert.match(queue.replies[0], /1\. Second/);

  const wrongChannel = interaction(state, "skip", undefined, "voice-elsewhere");
  await service.handle(wrongChannel.value);
  assert.match(wrongChannel.replies[0], /Join my current voice channel/);
  assert.equal(transport.sessions[0].played.length, 1);

  const skip = interaction(state, "skip");
  await service.handle(skip.value);
  await flush();
  assert.equal(transport.sessions[0].played.length, 2, "skip must advance exactly once");
  transport.sessions[0].staleIdle();
  await flush();
  assert.equal(transport.sessions[0].played.length, 2, "Idle caused by skip must not skip the replacement");
  transport.sessions[0].error();
  await flush();
  assert.equal(transport.sessions[0].played.length, 2, "a failed final track must advance only once");
  assert.equal(second.followUps.length, 1, "playback errors should privately notify the requesting user");
  assert.equal(second.followUps[0].flags, MessageFlags.Ephemeral);
  assert.equal(second.publicMessages.length, 0, "playback errors must never fall back to public channel messages");
  transport.sessions[0].staleIdle();
  await flush();
  assert.equal(transport.sessions[0].played.length, 2, "Idle following an error must be ignored once");
  await service.close();
}

async function verifyStopCancelsLateLookup(): Promise<void> {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const state = harness("guild-stop");
  const service = new MusicService(fakeClient, source, { enabled: true, transport });
  await service.initialize();
  const play = interaction(state, "play", "slow");
  const pendingPlay = service.handle(play.value);
  await flush();
  const stop = interaction(state, "stop");
  await service.handle(stop.value);
  await pendingPlay;
  source.lookups.get("slow")?.resolve(selection("Too Late"));
  await flush();
  assert.match(play.replies[0], /cancelled/);
  assert.equal(transport.sessions[0].played.length, 0);
  assert.equal(transport.sessions[0].destroyed, true);
  assert.match(stop.replies[0], /queue was cleared/);
}

async function verifyPendingJoinCancellationAndWaiters(): Promise<void> {
  const source = new FakeSource();
  const transport = new DelayedTransport();
  const state = harness("guild-joining");
  const service = new MusicService(fakeClient, source, { enabled: true, transport });
  await service.initialize();
  const play = interaction(state, "play", "must-not-start");
  const playRequest = service.handle(play.value);
  await transport.started.promise;

  const wrongStop = interaction(state, "stop", undefined, "other-voice");
  await service.handle(wrongStop.value);
  assert.match(wrongStop.replies[0], /pending music voice channel/);
  assert.equal(transport.signal?.aborted, false, "a user in another channel cannot cancel the pending join");

  const stop = interaction(state, "stop");
  await service.handle(stop.value);
  assert.equal(transport.signal?.aborted, true);
  assert.match(stop.replies[0], /Cancelled the pending music connection/);
  const lateSession = transport.release();
  await playRequest;
  assert.equal(lateSession.destroyed, true, "a transport resolving after cancellation must be destroyed");
  assert.equal(source.lookups.has("must-not-start"), false, "cancelled joins must not continue into source lookup");

  const waiterSource = new FakeSource();
  const waiterTransport = new DelayedTransport();
  const waiterState = harness("guild-waiters");
  const waiterService = new MusicService(fakeClient, waiterSource, { enabled: true, transport: waiterTransport });
  await waiterService.initialize();
  const first = interaction(waiterState, "play", "left-before-connect");
  const firstRequest = waiterService.handle(first.value);
  await waiterTransport.started.promise;
  waiterState.voiceChannel.userLimit = 1;
  const second = interaction(waiterState, "play", "still-here");
  const secondRequest = waiterService.handle(second.value);
  await flush();
  (first.value.member as unknown as { voice: { channelId: string | null } }).voice.channelId = null;
  const sharedSession = waiterTransport.release();
  await firstRequest;
  assert.match(first.replies[0], /left that voice channel/);
  await flush();
  assert.equal(waiterSource.lookups.has("left-before-connect"), false);
  assert.equal(waiterSource.lookups.has("still-here"), true, "the valid waiter must retain the shared connection");
  waiterSource.lookups.get("still-here")?.resolve(selection("Still Here"));
  await secondRequest;
  await flush();
  assert.equal(sharedSession.played.length, 1, "one stale waiter must not detach or hang another waiter");
  await waiterService.close();
}

async function verifyRequesterRevalidation(): Promise<void> {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const state = harness("guild-left");
  const service = new MusicService(fakeClient, source, { enabled: true, transport });
  await service.initialize();
  const play = interaction(state, "play", "slow-left");
  const request = service.handle(play.value);
  await flush();
  const member = play.value.member as unknown as { voice: { channelId: string | null } };
  member.voice.channelId = null;
  source.lookups.get("slow-left")?.resolve(selection("Must Not Start"));
  await request;
  await flush();
  assert.match(play.replies[0], /cancelled/);
  assert.equal(transport.sessions[0].played.length, 0, "a requester who leaves during lookup must not start playback");
  await service.close();

  const invalidSource = new FakeSource();
  const invalidTransport = new FakeTransport();
  const invalidState = harness("guild-invalid");
  const invalid = new MusicService(fakeClient, invalidSource, { enabled: true, transport: invalidTransport });
  await invalid.initialize();
  const invalidPlay = interaction(invalidState, "play", "sync-invalid");
  await invalid.handle(invalidPlay.value);
  assert.match(invalidPlay.replies[0], /could not find playable music/);
  assert.equal(invalidTransport.sessions[0].played.length, 0);
  await invalid.close();
}

async function verifyBoundedQueueRenderingAndValidation(): Promise<void> {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const state = harness("guild-render");
  const service = new MusicService(fakeClient, source, { enabled: true, transport });
  await service.initialize();

  const whitespace = interaction(state, "play", "   ");
  await service.handle(whitespace.value);
  assert.match(whitespace.replies[0], /Enter a song/);
  assert.equal(transport.sessions.length, 0, "blank queries must not join voice or start lookup work");

  const current = interaction(state, "play", "current");
  const currentRequest = service.handle(current.value);
  await flush();
  source.lookups.get("current")?.resolve(selection("Current"));
  await currentRequest;
  await flush();

  const longTracks = Array.from({ length: 10 }, (_, index): MusicTrack => ({
    title: `Long ${index + 1} ${"T".repeat(230)}`,
    artist: `Artist ${"A".repeat(150)}`,
    url: `https://example.test/${index + 1}/${"u".repeat(220)}`,
    source: "spotify",
  }));
  const playlist = interaction(state, "play", "long-playlist");
  const playlistRequest = service.handle(playlist.value);
  await flush();
  source.lookups.get("long-playlist")?.resolve({ tracks: longTracks, omitted: 0, unavailable: 0, truncated: true });
  await playlistRequest;
  assert.match(playlist.replies[0], /limited to its first 100 tracks/);

  const queue = interaction(state, "queue");
  await service.handle(queue.value);
  const rendered = queue.replies[0];
  assert.ok(rendered.length <= 1_900, `queue response was ${rendered.length} characters`);
  assert.match(rendered, /…and \d+ more\./, "truncated rendering must accurately report hidden queue rows");
  const links = rendered.match(/<https:\/\/[^>]+>/g) ?? [];
  assert.ok(links.length > 0);
  assert.equal((rendered.match(/<https:\/\//g) ?? []).length, links.length, "source links must never be cut mid-link");
  await service.close();
}

async function verifyPermissionsConnectionAndDeparture(): Promise<void> {
  const deniedSource = new FakeSource();
  const deniedTransport = new FakeTransport();
  const deniedState = harness("guild-denied");
  deniedState.permissions.allowed = false;
  const denied = new MusicService(fakeClient, deniedSource, { enabled: true, transport: deniedTransport });
  await denied.initialize();
  const deniedPlay = interaction(deniedState, "play", "nope");
  await denied.handle(deniedPlay.value);
  assert.match(deniedPlay.replies[0], /View Channel, Connect, and Speak/);
  assert.equal(deniedTransport.sessions.length, 0);

  const failedSource = new FakeSource();
  const failedTransport = new FakeTransport();
  failedTransport.failConnect = true;
  const failedState = harness("guild-failed");
  const failed = new MusicService(fakeClient, failedSource, { enabled: true, transport: failedTransport });
  await failed.initialize();
  const failedPlay = interaction(failedState, "play", "nope");
  await failed.handle(failedPlay.value);
  assert.match(failedPlay.replies[0], /could not connect/);

  const callbacks: Array<() => void> = [];
  const source = new FakeSource();
  const transport = new FakeTransport();
  const state = harness("guild-timer");
  const service = new MusicService(fakeClient, source, {
    enabled: true,
    transport,
    idleMs: 60_000,
    setTimer: (callback) => { callbacks.push(callback); return callbacks.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => undefined,
  });
  await service.initialize();
  const play = interaction(state, "play", "alone");
  const request = service.handle(play.value);
  await flush();
  source.lookups.get("alone")?.resolve(selection("Alone"));
  await request;
  await flush();
  state.voiceChannel.members.delete(state.human.id);
  service.onVoiceStateUpdate(
    { guild: state.guild, id: state.human.id, channelId: state.voiceChannel.id } as VoiceState,
    { guild: state.guild, id: state.human.id, channelId: null } as VoiceState,
  );
  assert.equal(callbacks.length, 1, "last human leaving must arm the departure timer");
  callbacks[0]();
  assert.equal(transport.sessions[0].destroyed, true, "60-second alone timeout must destroy voice state");

  const emptyCallbacks: Array<() => void> = [];
  const emptySource = new FakeSource();
  const emptyTransport = new FakeTransport();
  const emptyState = harness("guild-empty");
  const empty = new MusicService(fakeClient, emptySource, {
    enabled: true,
    transport: emptyTransport,
    idleMs: 60_000,
    setTimer: (callback) => { emptyCallbacks.push(callback); return emptyCallbacks.length as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => undefined,
  });
  await empty.initialize();
  const emptyPlay = interaction(emptyState, "play", "short");
  const emptyRequest = empty.handle(emptyPlay.value);
  await flush();
  emptySource.lookups.get("short")?.resolve(selection("Short"));
  await emptyRequest;
  await flush();
  emptyTransport.sessions[0].idle();
  await flush();
  assert.equal(emptyCallbacks.length, 1, "an exhausted queue must arm the departure timer");
  emptyCallbacks[0]();
  assert.equal(emptyTransport.sessions[0].destroyed, true);

  const lostSource = new FakeSource();
  const lostTransport = new FakeTransport();
  const lostState = harness("guild-lost");
  const lost = new MusicService(fakeClient, lostSource, { enabled: true, transport: lostTransport });
  await lost.initialize();
  const lostPlay = interaction(lostState, "play", "disconnect");
  const lostRequest = lost.handle(lostPlay.value);
  await flush();
  lostSource.lookups.get("disconnect")?.resolve(selection("Disconnect"));
  await lostRequest;
  await flush();
  lostTransport.sessions[0].callbacks.onDisconnect();
  assert.equal(lostTransport.sessions[0].destroyed, true, "irrecoverable voice disconnect must clean the session");
  await flush();
  assert.equal(lostPlay.followUps.length, 1);
  assert.equal(lostPlay.followUps[0].flags, MessageFlags.Ephemeral);
  assert.equal(lostPlay.publicMessages.length, 0, "connection errors must never post to the public channel");
}

async function verifyVoiceChannelCapacity(): Promise<void> {
  const fullSource = new FakeSource();
  const fullTransport = new FakeTransport();
  const fullState = harness("guild-full");
  fullState.voiceChannel.userLimit = 2;
  fullState.voiceChannel.members.set("human-2", { id: "human-2", user: { bot: false } });
  const full = new MusicService(fakeClient, fullSource, { enabled: true, transport: fullTransport });
  await full.initialize();
  const fullPlay = interaction(fullState, "play", "blocked");
  const fullRequest = full.handle(fullPlay.value);
  await flush();
  fullSource.lookups.get("blocked")?.resolve(selection("Blocked"));
  await fullRequest;
  assert.match(fullPlay.replies[0], /full.*2\/2.*free (?:a slot|room)/i);
  assert.equal(fullTransport.sessions.length, 0, "a new join must stop before transport when the channel is full");
  assert.equal(fullSource.lookups.size, 0, "a full-channel rejection must not resolve media");

  for (const [name, configure] of [
    ["move", (state: Harness) => { state.permissions.moveMembers = true; }],
    ["admin", (state: Harness) => { state.permissions.administrator = true; }],
    ["unlimited", (state: Harness) => { state.voiceChannel.userLimit = 0; }],
    ["not-full", (state: Harness) => { state.voiceChannel.userLimit = 3; }],
    ["bot-state", (state: Harness) => {
      (state.guild.members.me as unknown as { voice: { channelId: string | null } }).voice.channelId = state.voiceChannel.id;
    }],
    ["bot-member", (state: Harness) => {
      state.voiceChannel.members.set("music-bot", state.guild.members.me);
    }],
  ] as const) {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const state = harness(`guild-${name}`);
    state.voiceChannel.userLimit = 2;
    state.voiceChannel.members.set("human-2", { id: "human-2", user: { bot: false } });
    configure(state);
    const service = new MusicService(fakeClient, source, { enabled: true, transport });
    await service.initialize();
    const play = interaction(state, "play", name);
    const request = service.handle(play.value);
    await flush();
    source.lookups.get(name)?.resolve(selection(name));
    await request;
    assert.equal(transport.sessions.length, 1, `${name} should permit a new voice join`);
    await service.close();
  }

  const activeSource = new FakeSource();
  const activeTransport = new FakeTransport();
  const activeState = harness("guild-active");
  const active = new MusicService(fakeClient, activeSource, { enabled: true, transport: activeTransport });
  await active.initialize();
  const first = interaction(activeState, "play", "first-active");
  const firstRequest = active.handle(first.value);
  await flush();
  activeSource.lookups.get("first-active")?.resolve(selection("First Active"));
  await firstRequest;
  activeState.voiceChannel.userLimit = 2;
  activeState.voiceChannel.members.set("human-2", { id: "human-2", user: { bot: false } });
  const second = interaction(activeState, "play", "second-active");
  const secondRequest = active.handle(second.value);
  await flush();
  activeSource.lookups.get("second-active")?.resolve(selection("Second Active"));
  await secondRequest;
  assert.equal(activeTransport.sessions.length, 1, "an active same-channel session must accept requests after the room becomes full");

  const otherState = harness("guild-active", "voice-other");
  otherState.voiceChannel.userLimit = 1;
  const crossRoom = interaction(otherState, "play", "cross-room");
  await active.handle(crossRoom.value);
  assert.match(crossRoom.replies[0], /already playing in another voice channel/i);
  assert.doesNotMatch(crossRoom.replies[0], /full/i, "cross-room restriction must take priority over target capacity");
  await active.close();
}

await verifyOrderedAdmissionsAndControls();
await verifyStopCancelsLateLookup();
await verifyPendingJoinCancellationAndWaiters();
await verifyRequesterRevalidation();
await verifyBoundedQueueRenderingAndValidation();
await verifyPermissionsConnectionAndDeparture();
await verifyVoiceChannelCapacity();
console.log("Music service tests passed.");
