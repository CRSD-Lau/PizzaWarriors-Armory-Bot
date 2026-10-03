import type { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceState,
} from "discord.js";
import { MusicQueue } from "./queue.js";
import { MUSIC_IDLE_MS, MUSIC_QUEUE_LIMIT, type MusicSelection, type MusicSource, type MusicStream, type MusicTrack } from "./types.js";

const MUSIC_COMMANDS = new Set(["play", "queue", "nowplaying", "pause", "resume", "skip", "stop"]);
const RECOVERY_TIMEOUT_MS = 5_000;
const READY_TIMEOUT_MS = 15_000;
const NOTICE_COOLDOWN_MS = 30_000;

export interface MusicTransportCallbacks {
  onIdle(): void;
  onError(): void;
  onDisconnect(): void;
}

export interface MusicTransportSession {
  play(stream: Readable): void;
  pause(): boolean;
  resume(): boolean;
  stop(): boolean;
  destroy(): void;
}

export interface MusicTransport {
  connect(guild: Guild, channelId: string, callbacks: MusicTransportCallbacks, signal?: AbortSignal): Promise<MusicTransportSession>;
}

export interface MusicServiceOptions {
  enabled: boolean;
  guildId?: string;
  /** Test seam; production uses the Discord voice transport. */
  transport?: MusicTransport;
  idleMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface AdmissionResult {
  added: number;
  omitted: number;
  unavailable: number;
  truncated?: boolean;
  cancelled?: boolean;
  error?: boolean;
}

interface PendingAdmission {
  sequence: number;
  generation: number;
  controller: AbortController;
  state: "pending" | "resolved" | "failed";
  requester: GuildMember;
  requesterId: string;
  selection?: MusicSelection;
  interaction: ChatInputCommandInteraction;
  complete(result: AdmissionResult): void;
}

type QueuedTrack = MusicTrack & { requestedBy: string; requestInteraction: ChatInputCommandInteraction };

interface JoinAttempt {
  channelId: string;
  controller: AbortController;
  promise: Promise<Session>;
}

interface Session {
  guild: Guild;
  channelId: string;
  transport: MusicTransportSession;
  queue: MusicQueue<QueuedTrack>;
  current?: QueuedTrack;
  currentAbort?: AbortController;
  currentStream?: MusicStream;
  playbackToken: number;
  ignoredIdle: number;
  generation: number;
  nextAdmission: number;
  commitAdmission: number;
  pending: Map<number, PendingAdmission>;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastPrivateInteraction?: ChatInputCommandInteraction;
  lastNoticeAt: number;
}

class DiscordMusicTransport implements MusicTransport {
  async connect(guild: Guild, channelId: string, callbacks: MusicTransportCallbacks, signal?: AbortSignal): Promise<MusicTransportSession> {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    const connection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });
    const subscription = connection.subscribe(player);
    if (!subscription) {
      connection.destroy();
      throw new Error("Voice player subscription failed");
    }

    const handle = new DiscordTransportSession(connection, player);
    player.on(AudioPlayerStatus.Idle, callbacks.onIdle);
    player.on("error", callbacks.onError);
    let recovering = false;
    let failed = false;
    const failConnection = () => {
      if (failed) return;
      failed = true;
      handle.destroy();
      callbacks.onDisconnect();
    };
    connection.on("error", failConnection);
    connection.on(VoiceConnectionStatus.Ready, () => { recovering = false; });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (recovering || connection.state.status === VoiceConnectionStatus.Destroyed) return;
      recovering = true;
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, RECOVERY_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Connecting, RECOVERY_TIMEOUT_MS),
        entersState(connection, VoiceConnectionStatus.Ready, RECOVERY_TIMEOUT_MS),
      ]).then(() => entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS))
        .then(() => { recovering = false; })
        .catch(failConnection);
    });

    try {
      const readinessSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(READY_TIMEOUT_MS)])
        : AbortSignal.timeout(READY_TIMEOUT_MS);
      await entersState(connection, VoiceConnectionStatus.Ready, readinessSignal);
      return handle;
    } catch (error) {
      handle.destroy();
      throw error;
    }
  }
}

class DiscordTransportSession implements MusicTransportSession {
  #destroyed = false;

  constructor(private readonly connection: VoiceConnection, private readonly player: AudioPlayer) {}

  play(stream: Readable): void {
    this.player.play(createAudioResource(stream, { inputType: StreamType.OggOpus }));
  }

  pause(): boolean {
    return this.player.pause();
  }

  resume(): boolean {
    return this.player.unpause();
  }

  stop(): boolean {
    return this.player.stop(true);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.player.stop(true);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
  }
}

export function musicCommands(): SlashCommandBuilder[] {
  const command = (name: string, description: string) => {
    const builder = new SlashCommandBuilder();
    builder.setName(name).setDescription(description).setDMPermission(false);
    return builder;
  };
  const play = command("play", "Play or queue music in your voice channel");
  play.addStringOption((option) => option.setName("query").setDescription("Song, YouTube URL, or Spotify URL").setRequired(true).setMaxLength(500));
  return [
    play,
    command("queue", "Show the current music queue"),
    command("nowplaying", "Show the currently playing track"),
    command("pause", "Pause music playback"),
    command("resume", "Resume music playback"),
    command("skip", "Skip the current track"),
    command("stop", "Stop music, clear the queue, and leave voice"),
  ];
}

export class MusicService {
  readonly #sessions = new Map<string, Session>();
  readonly #joining = new Map<string, JoinAttempt>();
  readonly #transport: MusicTransport;
  readonly #idleMs: number;
  readonly #setTimer: NonNullable<MusicServiceOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<MusicServiceOptions["clearTimer"]>;
  #ready = false;
  #reason: string | undefined;
  #closed = false;

  constructor(
    private readonly client: Client,
    private readonly source: MusicSource,
    private readonly options: MusicServiceOptions,
  ) {
    this.#transport = options.transport ?? new DiscordMusicTransport();
    this.#idleMs = options.idleMs ?? MUSIC_IDLE_MS;
    this.#setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async initialize(): Promise<void> {
    if (!this.options.enabled) {
      this.#ready = false;
      this.#reason = "Music is disabled.";
      return;
    }
    try {
      const readiness = await this.source.inspect();
      this.#ready = readiness.ready;
      this.#reason = readiness.ready ? undefined : (readiness.reason ?? "Music source is unavailable.");
    } catch {
      this.#ready = false;
      this.#reason = "Music source inspection failed.";
    }
  }

  health(): { enabled: boolean; ready: boolean; reason?: string } {
    return {
      enabled: this.options.enabled,
      ready: this.#ready && !this.#closed,
      ...((this.#reason || this.#closed) ? { reason: this.#closed ? "Music service is closed." : this.#reason } : {}),
    };
  }

  async handle(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (!MUSIC_COMMANDS.has(interaction.commandName)) return false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = async (content: string) => interaction.editReply({ content, allowedMentions: { parse: [] } });

    if (!interaction.inGuild() || !interaction.guild) {
      await reply("Music commands can only be used in a server.");
      return true;
    }
    if (this.options.guildId && interaction.guildId !== this.options.guildId) {
      await reply("Music is not enabled in this server.");
      return true;
    }
    if (!this.options.enabled || !this.#ready || this.#closed) {
      await reply(this.#reason ?? "Music is unavailable right now.");
      return true;
    }

    try {
      switch (interaction.commandName) {
        case "play":
          await this.#handlePlay(interaction, reply);
          break;
        case "queue":
          await reply(this.#queueText(this.#sessions.get(interaction.guildId)));
          break;
        case "nowplaying":
          await reply(this.#nowPlayingText(this.#sessions.get(interaction.guildId)));
          break;
        case "pause":
          await this.#handlePause(interaction, reply);
          break;
        case "resume":
          await this.#handleResume(interaction, reply);
          break;
        case "skip":
          await this.#handleSkip(interaction, reply);
          break;
        case "stop":
          await this.#handleStop(interaction, reply);
          break;
      }
    } catch {
      await reply("The music request could not be completed. Please try again.");
    }
    return true;
  }

  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
    const session = this.#sessions.get(oldState.guild.id) ?? this.#sessions.get(newState.guild.id);
    if (!session) return;
    if (oldState.id === this.client.user?.id && oldState.channelId === session.channelId && newState.channelId !== session.channelId) {
      this.#cleanup(session);
      return;
    }
    if (oldState.channelId === session.channelId || newState.channelId === session.channelId) this.#refreshDepartureTimer(session);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const attempt of this.#joining.values()) attempt.controller.abort();
    for (const session of [...this.#sessions.values()]) this.#cleanup(session);
    await Promise.allSettled([...this.#joining.values()].map((attempt) => attempt.promise));
    for (const session of [...this.#sessions.values()]) this.#cleanup(session);
  }

  async #handlePlay(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<void> {
    const guild = interaction.guild;
    if (!guild) {
      await reply("Music commands can only be used in a server.");
      return;
    }
    const query = interaction.options.getString("query", true).trim();
    if (!query) {
      await reply("Enter a song, YouTube URL, or Spotify URL.");
      return;
    }
    const member = this.#guildMember(interaction);
    if (!member) {
      await reply("I could not read your current voice channel. Please rejoin voice and try again.");
      return;
    }
    const channel = member.voice.channel;
    if (!channel) {
      await reply("Join a voice channel first.");
      return;
    }
    if (channel.type === ChannelType.GuildStageVoice) {
      await reply("Music playback is not supported in Stage channels.");
      return;
    }
    if (guild.afkChannelId === channel.id) {
      await reply("Music playback is not available in the server AFK channel.");
      return;
    }
    const botMember = guild.members.me;
    const permissions = botMember?.permissionsIn(channel);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      await reply("I need View Channel, Connect, and Speak permissions in that voice channel.");
      return;
    }

    let session: Session;
    try {
      session = await this.#join(guild, channel.id);
    } catch {
      await reply("I could not connect to that voice channel.");
      return;
    }
    if (session.channelId !== channel.id) {
      await reply("I am already playing in another voice channel in this server.");
      return;
    }
    if (this.#sessions.get(guild.id) !== session) {
      await reply("That music connection was cancelled before the request could start.");
      return;
    }
    if (member.voice.channelId !== channel.id) {
      this.#refreshDepartureTimer(session);
      await reply("You left that voice channel before I connected, so the request was cancelled.");
      return;
    }
    this.#rememberPrivateInteraction(session, interaction);
    this.#clearDepartureTimer(session);

    const result = await this.#admit(session, query, member, interaction);
    if (result.cancelled) {
      await reply("That music request was cancelled.");
      return;
    }
    if (result.error) {
      await reply("I could not find playable music for that request.");
      return;
    }
    if (result.added === 0) {
      const details = this.#selectionDetails(result);
      await reply(`No playable tracks were added.${details}`);
      return;
    }
    const noun = result.added === 1 ? "track" : "tracks";
    await reply(`Added **${result.added}** ${noun} to the music session.${this.#selectionDetails(result)}`);
  }

  async #handlePause(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<void> {
    const session = await this.#controllableSession(interaction, reply);
    if (!session) return;
    if (session.current && !session.currentStream) {
      await reply("That track is still buffering. Try pause again when playback starts.");
      return;
    }
    await reply(session.transport.pause() ? "Music paused." : "Music is not currently playing.");
  }

  async #handleResume(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<void> {
    const session = await this.#controllableSession(interaction, reply);
    if (!session) return;
    if (session.transport.resume()) {
      this.#clearDepartureTimer(session);
      await reply("Music resumed.");
      return;
    }
    this.#refreshDepartureTimer(session);
    await reply("Music is not paused.");
  }

  async #handleSkip(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<void> {
    const session = await this.#controllableSession(interaction, reply);
    if (!session) return;
    if (!session.current) {
      await reply("Nothing is playing.");
      return;
    }
    const skipped = session.current;
    this.#finishCurrent(session, session.playbackToken, false);
    await reply(`Skipped **${this.#trackLabel(skipped)}**.`);
  }

  async #handleStop(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<void> {
    const joining = interaction.guildId ? this.#joining.get(interaction.guildId) : undefined;
    if (joining) {
      const member = this.#guildMember(interaction);
      if (!member || member.voice.channelId !== joining.channelId) {
        await reply("Join the pending music voice channel to cancel that connection.");
        return;
      }
      joining.controller.abort();
      await reply("Cancelled the pending music connection.");
      return;
    }
    const session = await this.#controllableSession(interaction, reply);
    if (!session) return;
    this.#cleanup(session);
    await reply("Music stopped, the queue was cleared, and I left voice.");
  }

  async #controllableSession(interaction: ChatInputCommandInteraction, reply: (content: string) => Promise<unknown>): Promise<Session | undefined> {
    const session = interaction.guildId ? this.#sessions.get(interaction.guildId) : undefined;
    if (!session) {
      await reply("There is no active music session.");
      return undefined;
    }
    const member = this.#guildMember(interaction);
    if (!member) {
      await reply("I could not read your current voice channel. Please rejoin voice and try again.");
      return undefined;
    }
    if (member.voice.channelId !== session.channelId) {
      await reply("Join my current voice channel to control playback.");
      return undefined;
    }
    this.#rememberPrivateInteraction(session, interaction);
    return session;
  }

  async #join(guild: Guild, channelId: string): Promise<Session> {
    const existing = this.#sessions.get(guild.id);
    if (existing) return existing;
    const joining = this.#joining.get(guild.id);
    if (joining) return joining.promise;

    const controller = new AbortController();
    const promise = (async () => {
      let session!: Session;
      const transport = await this.#transport.connect(guild, channelId, {
        onIdle: () => {
          if (!session) return;
          if (session.ignoredIdle > 0) {
            session.ignoredIdle--;
            return;
          }
          this.#finishCurrent(session, session.playbackToken, false);
        },
        onError: () => { if (session) this.#finishCurrent(session, session.playbackToken, true); },
        onDisconnect: () => { if (session) this.#connectionLost(session); },
      }, controller.signal);
      if (this.#closed || controller.signal.aborted) {
        transport.destroy();
        throw new Error("Music connection was cancelled");
      }
      session = {
        guild,
        channelId,
        transport,
        queue: new MusicQueue<QueuedTrack>(MUSIC_QUEUE_LIMIT),
        playbackToken: 0,
        ignoredIdle: 0,
        generation: 0,
        nextAdmission: 0,
        commitAdmission: 0,
        pending: new Map(),
        lastNoticeAt: 0,
      };
      this.#sessions.set(guild.id, session);
      return session;
    })();
    const attempt = { channelId, controller, promise };
    this.#joining.set(guild.id, attempt);
    try {
      return await promise;
    } finally {
      if (this.#joining.get(guild.id) === attempt) this.#joining.delete(guild.id);
    }
  }

  #admit(session: Session, query: string, requester: GuildMember, interaction: ChatInputCommandInteraction): Promise<AdmissionResult> {
    const sequence = session.nextAdmission++;
    const controller = new AbortController();
    let complete!: (result: AdmissionResult) => void;
    const completion = new Promise<AdmissionResult>((resolve) => { complete = resolve; });
    const pending: PendingAdmission = {
      sequence,
      generation: session.generation,
      controller,
      state: "pending",
      requester,
      requesterId: requester.id,
      interaction,
      complete,
    };
    session.pending.set(sequence, pending);
    void Promise.resolve().then(() => this.source.resolve(query, controller.signal, MUSIC_QUEUE_LIMIT))
      .then((selection) => {
        if (!this.#isCurrentAdmission(session, pending)) return;
        pending.selection = selection;
        pending.state = "resolved";
        this.#commitAdmissions(session);
      })
      .catch(() => {
        if (!this.#isCurrentAdmission(session, pending)) return;
        pending.state = "failed";
        this.#commitAdmissions(session);
      });
    return completion;
  }

  #isCurrentAdmission(session: Session, pending: PendingAdmission): boolean {
    return this.#sessions.get(session.guild.id) === session
      && pending.generation === session.generation
      && session.pending.get(pending.sequence) === pending;
  }

  #commitAdmissions(session: Session): void {
    while (true) {
      const pending = session.pending.get(session.commitAdmission);
      if (!pending || pending.state === "pending") break;
      session.pending.delete(pending.sequence);
      session.commitAdmission++;
      if (pending.state === "failed" || !pending.selection) {
        pending.complete({ added: 0, omitted: 0, unavailable: 0, error: true });
        this.#refreshDepartureTimer(session);
        continue;
      }
      if (pending.requester.voice.channelId !== session.channelId) {
        pending.complete({ added: 0, omitted: 0, unavailable: pending.selection.unavailable, cancelled: true });
        this.#refreshDepartureTimer(session);
        continue;
      }
      const requestedBy = pending.requester.displayName || pending.requesterId;
      const requestInteraction = pending.interaction;
      const added = session.queue.add(pending.selection.tracks.map((track) => ({ ...track, requestedBy, requestInteraction })));
      pending.complete({
        added: added.added,
        omitted: pending.selection.omitted + added.omitted,
        unavailable: pending.selection.unavailable,
        truncated: pending.selection.truncated,
      });
      if (!session.current) void this.#playNext(session);
      if (added.added === 0) this.#refreshDepartureTimer(session);
    }
  }

  async #playNext(session: Session): Promise<void> {
    if (this.#sessions.get(session.guild.id) !== session || session.current) return;
    const track = session.queue.shift();
    if (!track) {
      this.#refreshDepartureTimer(session);
      return;
    }
    this.#clearDepartureTimer(session);
    const token = ++session.playbackToken;
    const controller = new AbortController();
    session.current = track;
    session.currentAbort = controller;
    try {
      const prepared = await this.source.prepare(track, controller.signal);
      if (!this.#isCurrentPlayback(session, token)) return;
      const requestedBy = track.requestedBy;
      session.current = { ...prepared, requestedBy, requestInteraction: track.requestInteraction };
      const media = this.source.stream(session.current, controller.signal);
      session.currentStream = media;
      media.done.catch(() => {
        if (this.#isCurrentPlayback(session, token)) this.#finishCurrent(session, token, true);
      });
      session.transport.play(media.stream);
    } catch {
      if (!controller.signal.aborted && this.#isCurrentPlayback(session, token)) this.#finishCurrent(session, token, true);
    }
  }

  #isCurrentPlayback(session: Session, token: number): boolean {
    return this.#sessions.get(session.guild.id) === session && session.playbackToken === token && Boolean(session.current);
  }

  #finishCurrent(session: Session, token: number, failed: boolean): void {
    if (!this.#isCurrentPlayback(session, token)) return;
    const privateInteraction = session.current?.requestInteraction;
    ++session.playbackToken;
    session.currentAbort?.abort();
    session.currentStream?.stop();
    session.currentAbort = undefined;
    session.currentStream = undefined;
    session.current = undefined;
    session.ignoredIdle++;
    if (!session.transport.stop()) session.ignoredIdle--;
    if (failed) this.#notify(session, "That track could not be played, so I skipped it.", privateInteraction);
    void this.#playNext(session);
  }

  #connectionLost(session: Session): void {
    if (this.#sessions.get(session.guild.id) !== session) return;
    this.#notify(session, "The voice connection was lost, so the music session ended.", session.lastPrivateInteraction);
    this.#cleanup(session);
  }

  #cleanup(session: Session): void {
    if (this.#sessions.get(session.guild.id) !== session) return;
    this.#sessions.delete(session.guild.id);
    session.generation++;
    this.#clearDepartureTimer(session);
    for (const pending of session.pending.values()) {
      pending.controller.abort();
      pending.complete({ added: 0, omitted: 0, unavailable: 0, cancelled: true });
    }
    session.pending.clear();
    session.queue.clear();
    ++session.playbackToken;
    session.currentAbort?.abort();
    session.currentStream?.stop();
    session.currentAbort = undefined;
    session.currentStream = undefined;
    session.current = undefined;
    session.transport.destroy();
  }

  #refreshDepartureTimer(session: Session): void {
    const humans = this.#humanCount(session);
    const empty = !session.current && session.queue.length === 0 && session.pending.size === 0;
    if (!empty && humans > 0) {
      this.#clearDepartureTimer(session);
      return;
    }
    if (session.idleTimer) return;
    session.idleTimer = this.#setTimer(() => {
      session.idleTimer = undefined;
      if (this.#sessions.get(session.guild.id) !== session) return;
      const latestHumans = this.#humanCount(session);
      const stillEmpty = !session.current && session.queue.length === 0 && session.pending.size === 0;
      if (stillEmpty || latestHumans === 0) this.#cleanup(session);
    }, this.#idleMs);
  }

  #clearDepartureTimer(session: Session): void {
    if (!session.idleTimer) return;
    this.#clearTimer(session.idleTimer);
    session.idleTimer = undefined;
  }

  #humanCount(session: Session): number {
    const channel = session.guild.channels.cache.get(session.channelId);
    if (!channel?.isVoiceBased()) return 0;
    return channel.members.filter((member) => !member.user.bot).size;
  }

  #guildMember(interaction: ChatInputCommandInteraction): GuildMember | undefined {
    const member = interaction.member;
    if (member && "voice" in member) return member as GuildMember;
    return interaction.guild?.members.cache.get(interaction.user.id);
  }

  #rememberPrivateInteraction(session: Session, interaction: ChatInputCommandInteraction): void {
    session.lastPrivateInteraction = interaction;
  }

  #notify(session: Session, content: string, interaction: ChatInputCommandInteraction | undefined): void {
    const now = Date.now();
    if (!interaction || now - session.lastNoticeAt < NOTICE_COOLDOWN_MS) return;
    session.lastNoticeAt = now;
    void interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } })
      .catch(() => console.warn("Music private notification could not be delivered"));
  }

  #queueText(session: Session | undefined): string {
    if (!session) return "There is no active music session.";
    const waiting = session.queue.snapshot();
    const maximumLength = 1_900;
    let current = session.current ? `Now playing: **${this.#trackLabel(session.current, false)}**` : "Nothing is playing.";
    if (session.current) {
      const source = this.#trackSource(session.current);
      if (source && current.length + source.length + 1 <= maximumLength) current += ` ${source}`;
    }
    if (!waiting.length) return `${current}\nThe queue is empty.`;

    const lines: string[] = [];
    for (let index = 0; index < Math.min(10, waiting.length); index++) {
      const candidate = `${index + 1}. ${this.#trackLabel(waiting[index])}`;
      const remainingAfter = waiting.length - (lines.length + 1);
      const remainder = remainingAfter > 0 ? `\n…and ${remainingAfter} more.` : "";
      const content = `${current}\n${[...lines, candidate].join("\n")}${remainder}`;
      if (content.length > maximumLength) break;
      lines.push(candidate);
    }
    const remaining = waiting.length - lines.length;
    const remainder = remaining > 0 ? `\n…and ${remaining} more.` : "";
    return `${current}${lines.length ? `\n${lines.join("\n")}` : ""}${remainder}`;
  }

  #nowPlayingText(session: Session | undefined): string {
    return session?.current ? `Now playing: **${this.#trackLabel(session.current)}**` : "Nothing is playing.";
  }

  #trackLabel(track: MusicTrack, includeSource = true): string {
    const title = escapeMarkdown(track.title.slice(0, 180));
    const artist = track.artist ? ` — ${escapeMarkdown(track.artist.slice(0, 100))}` : "";
    const source = includeSource ? this.#trackSource(track) : "";
    const requester = track.requestedBy ? ` · requested by ${escapeMarkdown(track.requestedBy.slice(0, 80))}` : "";
    return `${title}${artist}${source ? ` ${source}` : ""}${requester}`;
  }

  #trackSource(track: MusicTrack): string {
    return /^https?:\/\//i.test(track.url) ? `<${track.url}>` : "";
  }

  #selectionDetails(result: Pick<AdmissionResult, "omitted" | "unavailable" | "truncated">): string {
    const details: string[] = [];
    if (result.truncated) details.push(`playlist was limited to its first ${MUSIC_QUEUE_LIMIT} tracks`);
    if (result.omitted) details.push(`${result.omitted} omitted because the queue is full or the playlist exceeded ${MUSIC_QUEUE_LIMIT}`);
    if (result.unavailable) details.push(`${result.unavailable} unavailable`);
    return details.length ? ` ${details.join("; ")}.` : "";
  }
}
