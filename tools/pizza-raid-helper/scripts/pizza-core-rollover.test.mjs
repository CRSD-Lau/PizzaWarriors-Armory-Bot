import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { applyRollover, audit, buildNativePayload, buildPayload, buildPlan, configHash, effectivePermissions, eventMismatches, guildPermissions, nativeEventMismatches, providerRequest, runCli, startNative, validateAudienceAudit, validateConfig } from "./pizza-core-rollover.mjs";

const AT = "2026-09-05T06:00:00Z";

function standing(config) {
  config.unsignedAudiencePolicy = { mode: "standing-core-only", approvedBy: "Neil Mitchell", approvedAt: "2026-09-02T05:21:00Z",
    guildId: config.guildId, coreRoleId: config.coreRole.id, acceptsUnmonitoredRoleChanges: true };
  config.activation.configHash = configHash(config);
  return config;
}

test("standing audience approval allows a normal rollover without a dashboard file, and records acceptance not observation", async () => isolated(async (raw) => {
  const config = standing(raw);
  const api = mock(config);
  const result = await applyRollover(config, AT, { fetchImpl: api.fetchImpl, sleep: async () => {} });
  assert.equal(result.ok, true);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  const receipt = state.cycles["2026-09-04"].unsignedAudienceAudit;
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.verified, false);
  assert.equal(receipt.dashboardObservedThisRun, false);
  assert.equal(receipt.source, "standing-administrative-approval");
  assert.equal(buildPlan(config, AT).next.reminder.serverRaiderRolesRequireDashboardVerification, false);
  const repeated = await applyRollover(config, AT, { fetchImpl: api.fetchImpl, sleep: async () => {} });
  assert.equal(repeated.outcome, "verified-noop");
  assert.equal(rhPosts(api).length, 1);
  assert.equal(nativePosts(api).length, 1);
}));

test("standing approval requires exact identities and affirmative acceptance and changes the fingerprint", () => {
  const raw = fixture();
  const original = configHash(raw);
  const config = standing(raw);
  assert.notEqual(configHash(config), original);
  for (const patch of [{ guildId: "123456789012345678" }, { coreRoleId: "123456789012345678" }, { approvedBy: "someone" }, { approvedAt: "invalid" }, { approvedAt: "2026-09-02T05:21:00" }, { acceptsUnmonitoredRoleChanges: false }]) {
    const bad = structuredClone(config);
    Object.assign(bad.unsignedAudiencePolicy, patch);
    assert.throws(() => validateConfig(bad), { code: "INVALID_CONFIG" });
  }
});

test("standing policy still rejects future-dated approval without a successor", async () => isolated(async (raw) => {
  const config = standing(raw);
  config.unsignedAudiencePolicy.approvedAt = "2026-09-06T00:00:00Z";
  config.activation.configHash = configHash(config);
  const api = mock(config);
  await assert.rejects(applyRollover(config, AT, { fetchImpl: api.fetchImpl }), { code: "UNSIGNED_AUDIENCE_NOT_VERIFIED" });
  assert.equal(rhPosts(api).length, 0);
}));
const ids = { guild: "111111111111111111", forum: "222222222222222222", voice: "222222222222222223", bot: "333333333333333333", raidHelper: "444444444444444444", core: "555555555555555555", leader: "666666666666666666", pizzaTag: "777777777777777771", eventTag: "777777777777777772", previous: "888888888888888881", next: "888888888888888882", duplicate: "888888888888888883", botRole: "999999999999999999", nativePrevious: "777777777777777773", nativeNext: "777777777777777774", nativeDuplicate: "777777777777777775" };
const emotes = ["598989638098747403", "734439523328720913", "592446395596931072", "592438128057253898"];

function fixture(statePath = join(tmpdir(), "unused-pizza-core-state.json"), activated = true) {
  const config = {
    version: 1, seriesId: "pizza-core-icc25", guildId: ids.guild,
    forum: { id: ids.forum, name: "raid-signups" }, managementBotUserId: ids.bot, raidHelperBotUserId: ids.raidHelper,
    coreRole: { id: ids.core, name: "Pizza Core" }, tags: [{ id: ids.pizzaTag, name: "PizzaCore" }, { id: ids.eventTag, name: "Event" }],
    event: {
      title: "Pizza Core ICC25", templateId: "wowwotlk", leaderId: ids.leader, leaderDisplayName: "Raid Leader", description: "Bring consumes.",
      timeZone: "America/New_York", weekday: 5, time: "22:00", durationMinutes: 240,
      roles: Object.entries({ Tanks: 2, Melee: 8, Ranged: 10, Healers: 5 }).map(([name, limit], index) => ({ name, cName: name, limit, emoteId: emotes[index] })),
    },
    nativeCalendar: { enabled: true, voiceChannel: { id: ids.voice, name: "Raid Chat (Open Mic)" }, startGraceMinutes: 30 },
    rollover: { timeZone: "America/Halifax", weekday: 6, time: "03:00", maxLateMinutes: 720 },
    credentials: { raidHelperApiKeyEnv: "TEST_PIZZA_API_KEY", discordTokenEnv: "TEST_PIZZA_DISCORD_TOKEN" },
    statePath, bootstrap: { date: "2026-09-04", eventId: ids.previous, legacyPolicy: true }, activation: {},
  };
  if (activated) config.activation = { configHash: configHash(config), rolePolicyCanaryEventId: ids.duplicate, lifecycleCanaryThreadId: ids.duplicate, nativeCalendarCanaryEventId: ids.nativeDuplicate, coreSignupVerified: true, nonCoreBenchVerified: true, lifecycleVerified: true, nativeCalendarVerified: true, nativeCalendarRetryVerified: true, nativeCalendarLifecycleVerified: true, verifiedAt: "2026-09-01T00:00:00Z" };
  return config;
}

async function isolated(callback, activated = true) {
  const directory = await mkdtemp(join(tmpdir(), "pizza-core-rollover-test-"));
  const previousApi = process.env.TEST_PIZZA_API_KEY;
  const previousDiscord = process.env.TEST_PIZZA_DISCORD_TOKEN;
  process.env.TEST_PIZZA_API_KEY = "test-rh-key-not-real";
  process.env.TEST_PIZZA_DISCORD_TOKEN = "test-discord-token-not-real";
  try { return await callback(fixture(join(directory, "state.json"), activated), directory); }
  finally {
    if (previousApi === undefined) delete process.env.TEST_PIZZA_API_KEY; else process.env.TEST_PIZZA_API_KEY = previousApi;
    if (previousDiscord === undefined) delete process.env.TEST_PIZZA_DISCORD_TOKEN; else process.env.TEST_PIZZA_DISCORD_TOKEN = previousDiscord;
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith("pizza-core-rollover-test-"));
    await rm(absolute, { recursive: true, force: true });
  }
}

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function eventFor(config, target, id) {
  const payload = buildPayload(config, target.date);
  return { id, serverId: ids.guild, channelId: id, channelType: "post", title: payload.title, templateId: payload.templateId, leaderId: payload.leaderId, description: payload.description, startTime: target.start.epochSeconds, endTime: target.end.epochSeconds, roles: payload.roles, advancedSettings: payload.advancedSettings, announcements: [payload.announcement], signUps: [] };
}

function nativeFor(config, target, postId, id, status = 1) {
  return { ...buildNativePayload(config, target.date, postId), id, guild_id: config.guildId, creator_id: config.managementBotUserId, status, recurrence_rule: null, user_count: 0 };
}

const rhPosts = (api) => api.writes.filter((call) => call.method === "POST" && call.target.startsWith("https://raid-helper.xyz/"));
const nativePosts = (api) => api.writes.filter((call) => call.method === "POST" && call.target.includes("/scheduled-events"));
const audienceProof = (at = AT) => ({ version: 1, verified: true, source: "raid-helper-dashboard", guildId: ids.guild, roleIds: [ids.core], roleNames: ["Pizza Core"], verifiedAt: at });

function mock(config, options = {}) {
  const plan = buildPlan(config, options.at || AT);
  const events = new Map([[ids.previous, eventFor(config, plan.previous, ids.previous)]]);
  events.get(ids.previous).advancedSettings.duration = 0;
  events.get(ids.previous).advancedSettings.allowed_roles = "none";
  const threads = new Map([[ids.previous, thread(ids.previous)]]);
  const nativeEvents = new Map();
  const calls = [];
  const writes = [];
  let closeError = options.closeError;
  let nativeCreateError = options.nativeCreateError;
  let nativeStatusError = options.nativeStatusError;
  const roles = [
    { id: ids.guild, name: "@everyone", permissions: String((1n << 10n) | (1n << 16n) | (1n << 20n)) },
    { id: ids.core, name: "Pizza Core", permissions: "0" },
    { id: ids.botRole, name: "Management", permissions: String((options.noManageThreads ? 0n : 1n << 34n) | (options.noCreateEvents ? 0n : 1n << 44n)) },
  ];
  const forum = { id: ids.forum, guild_id: ids.guild, name: "raid-signups", type: 15, permission_overwrites: [], available_tags: config.tags };
  const voice = { id: ids.voice, guild_id: ids.guild, name: "Raid Chat (Open Mic)", type: 2, permission_overwrites: [] };
  function thread(id) { return { id, parent_id: ids.forum, owner_id: ids.raidHelper, type: 11, applied_tags: [ids.eventTag, ids.pizzaTag], thread_metadata: { archived: false, locked: false } }; }
  function addNext(id = ids.next) { events.set(id, eventFor(config, plan.next, id)); threads.set(id, thread(id)); }
  function addNative(id = ids.nativeNext) { nativeEvents.set(id, nativeFor(config, plan.next, ids.next, id)); }
  if (options.nextExists) addNext();
  if (options.duplicate) { addNext(); addNext(ids.duplicate); }
  if (options.drift) { addNext(); events.get(ids.next).advancedSettings.allowed_roles = "none"; }
  if (options.nativeExists) addNative();
  if (options.nativeDuplicate) { addNative(); addNative(ids.nativeDuplicate); }
  const fetchImpl = async (url, request = {}) => {
    const target = String(url);
    const method = request.method || "GET";
    calls.push({ target, method });
    if (method !== "GET") writes.push({ target, method, body: request.body ? JSON.parse(request.body) : undefined });
    if (target === "https://discord.com/api/v10/users/@me") return response({ id: ids.bot, username: "Management" });
    if (target === `https://discord.com/api/v10/guilds/${ids.guild}/roles`) return response(roles);
    if (target === `https://discord.com/api/v10/guilds/${ids.guild}/members/${ids.bot}`) return response({ user: { id: ids.bot }, roles: [ids.botRole] });
    if (target === `https://discord.com/api/v10/channels/${ids.forum}`) return response(forum);
    if (target === `https://discord.com/api/v10/channels/${ids.voice}`) return response(voice);
    if (target === `https://discord.com/api/v10/guilds/${ids.guild}/scheduled-events`) {
      if (method === "POST") {
        if (nativeCreateError) return response({ message: "Native creation denied" }, nativeCreateError);
        if (!options.uncertainNativeAbsent) {
          addNative();
          if (options.nativeConcurrentDuplicate) addNative(ids.nativeDuplicate);
          if (options.createdNativeDrift) nativeEvents.get(ids.nativeNext).description = "Changed description";
          if (options.createdNativeEmptyMetadata) nativeEvents.get(ids.nativeNext).entity_metadata = {};
        }
        if (options.uncertainNativeCreate || options.uncertainNativeAbsent) throw new TypeError("Lost native create response");
        if (options.nativeBodyReadFailure) return { ok: true, status: 200, text: async () => { throw new TypeError("Lost native response body"); } };
        return response(options.nativeMalformedCreateResponse ? {} : { id: ids.nativeNext });
      }
      if (options.nativeListMalformed) return response({ unexpected: [] });
      return response([...nativeEvents.values()].filter((event) => !(options.hideNativeFromList && event.id === ids.nativeNext)));
    }
    const native = target.match(/discord\.com\/api\/v10\/guilds\/\d+\/scheduled-events\/(\d+)$/);
    if (native) {
      const value = nativeEvents.get(native[1]);
      if (!value) return response({ message: "Not found" }, 404);
      if (method === "PATCH") {
        if (nativeStatusError) return response({ message: "Native lifecycle denied" }, nativeStatusError);
        const status = JSON.parse(request.body).status;
        if (!options.nativeStatusNoEffect) value.status = options.autoCompleteOnStart && status === 2 ? 3 : status;
        if (options.uncertainNativeStatus) throw new TypeError("Lost native lifecycle response");
      }
      return response(value);
    }
    if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/scheduledevents`) return response({ scheduledEvents: options.nativeRecurrence ? [{ id: ids.duplicate, channelId: ids.forum, title: config.event.title }] : [] });
    if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/events`) {
      assert.equal(request.headers.ChannelFilter, undefined, "A parent-forum filter must not hide post-ID channel records");
      if (request.headers.Page !== "1") return response({ postedEvents: [] });
      const start = Number(request.headers.StartTimeFilter) + 1;
      return response({ postedEvents: [...events.values()].filter((event) => event.startTime === start && !(options.hideNextFromList && event.id === ids.next) && !(options.hidePreviousFromList && event.id === ids.previous)) });
    }
    if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/channels/${ids.forum}/event` && method === "POST") {
      if (options.createRejected) return response({ message: "Denied" }, 403);
      if (!options.uncertainAbsent) {
        addNext();
        if (options.concurrentDuplicate) addNext(ids.duplicate);
        if (options.createdDrift) events.get(ids.next).advancedSettings.allowed_roles = "none";
      }
      if (options.uncertainCreate || options.uncertainAbsent) throw new TypeError("Lost response after POST");
      if (options.bodyReadFailure) return { ok: true, status: 200, text: async () => { throw new TypeError("Response body connection lost"); } };
      return response({ event: { id: ids.next } });
    }
    const rh = target.match(/raid-helper\.xyz\/api\/v4\/events\/(\d+)$/);
    if (rh) return events.has(rh[1]) ? response(events.get(rh[1])) : response({ message: "Not found" }, 404);
    const starter = target.match(/discord\.com\/api\/v10\/channels\/(\d+)\/messages\/\d+$/);
    if (starter) return response({ id: starter[1], author: { id: options.wrongStarter ? ids.duplicate : ids.raidHelper }, mention_everyone: options.everyonePing === true, mention_roles: options.missingCorePing ? [] : options.extraRolePing ? [ids.core, ids.duplicate] : [ids.core] });
    const channel = target.match(/discord\.com\/api\/v10\/channels\/(\d+)$/);
    if (channel) {
      const value = threads.get(channel[1]);
      if (!value) return response({ message: "Not found" }, 404);
      if (method === "PATCH") {
        if (closeError) return response({ message: "Missing Permissions" }, closeError);
        value.thread_metadata = { archived: true, locked: true };
        if (options.uncertainClose) throw new TypeError("Lost close response");
      }
      return response(value);
    }
    throw new Error(`Unexpected mock request ${method} ${target}`);
  };
  return { plan, events, nativeEvents, threads, roles, forum, voice, calls, writes, fetchImpl, sleep: async () => {}, audienceAudit: audienceProof(options.at || AT), clearCloseError: () => { closeError = undefined; }, clearNativeCreateError: () => { nativeCreateError = undefined; }, clearNativeStatusError: () => { nativeStatusError = undefined; }, revealNext: () => { options.hideNextFromList = false; }, revealNative: () => { options.hideNativeFromList = false; } };
}

test("first rollover is Saturday 3 AM Halifax and creates the next Friday 10 PM Eastern", () => {
  const plan = buildPlan(fixture(), AT);
  assert.equal(plan.due, true);
  assert.equal(plan.previous.date, "2026-09-04");
  assert.equal(plan.previous.start.utc, "2026-09-05T02:00:00.000Z");
  assert.equal(plan.previous.end.utc, "2026-09-05T06:00:00.000Z");
  assert.equal(plan.previous.eventId, ids.previous);
  assert.equal(plan.next.start.utc, "2026-09-12T02:00:00.000Z");
});

test("offline preview on Tuesday chooses the upcoming rollover, not last week's raid", () => {
  const plan = buildPlan(fixture(), "2026-09-01T18:00:00Z", { preview: true });
  assert.equal(plan.due, false);
  assert.equal(plan.previous.date, "2026-09-04");
  assert.equal(plan.next.date, "2026-09-11");
});

test("calendar recurrence preserves Friday 22:00 across fall and spring DST", () => {
  const fall = buildPlan(fixture(), "2026-10-31T06:00:00Z");
  assert.equal(fall.next.start.utc, "2026-11-07T03:00:00.000Z");
  assert.equal((fall.next.start.epochSeconds - fall.previous.start.epochSeconds) / 3600, 169);
  const spring = buildPlan(fixture(), "2027-03-13T07:00:00Z");
  assert.equal(spring.next.start.utc, "2027-03-20T02:00:00.000Z");
  assert.equal((spring.next.start.epochSeconds - spring.previous.start.epochSeconds) / 3600, 167);
});

test("payload enforces role bench policy, exact composition, 4h duration, and one creation-time Core role ping", () => {
  const payload = buildPayload(fixture(), "2026-09-11");
  assert.equal(payload.advancedSettings.allowed_roles, "Pizza Core");
  assert.equal(payload.advancedSettings.bench_overflow, true);
  assert.equal(payload.advancedSettings.queue_bench, false);
  assert.equal(payload.advancedSettings.lock_at_limit, false);
  assert.equal(payload.advancedSettings.duration, 240);
  assert.equal(payload.advancedSettings.opt_out, "none");
  assert.equal(payload.advancedSettings.mentions, "Pizza Core");
  assert.equal(payload.advancedSettings.reminder, 30);
  assert.deepEqual(payload.announcement, { channel: "unsignedping", time: 30, message: "Pizza Core: the raid starts in 30 minutes. Please sign up or mark your availability in this post." });
  assert.deepEqual(payload.roles.map(({ name, limit }) => ({ name, limit })), [{ name: "Tanks", limit: 2 }, { name: "Melee", limit: 8 }, { name: "Ranged", limit: 10 }, { name: "Healers", limit: 5 }]);
  assert.equal(JSON.stringify(payload).includes("Well Timed Pizza"), false);
});

test("reminder preview is exactly 30 minutes before start across Eastern DST", () => {
  for (const at of [AT, "2026-10-31T06:00:00Z", "2027-03-13T07:00:00Z"]) {
    const plan = buildPlan(fixture(), at);
    assert.equal(plan.next.reminder.epochSeconds, plan.next.start.epochSeconds - 1800);
    assert.equal(Date.parse(plan.next.reminder.utc), plan.next.reminder.epochSeconds * 1000);
    assert.equal(plan.next.reminder.audience, "Pizza Core members with no response");
    assert.equal(plan.next.reminder.attendeeReminderEnabled, true);
    assert.equal(plan.next.reminder.attendeeReminder.minutesBeforeStart, 30);
    assert.equal(plan.next.payload.advancedSettings.reminder, 30);
    assert.match(plan.next.reminder.attendeeReminder.message, /standard reminder text/);
    assert.equal(plan.next.reminder.serverRaiderRolesRequireDashboardVerification, true);
    assert.equal(plan.next.payload.announcements, undefined, "v4 uses the singular announcement request object");
    assert.equal(plan.next.payload.announcement.channel, "unsignedping");
  }
});

test("both unsigned and attendee reminders require exactly 30 minutes on readback", () => {
  const config = fixture();
  const target = buildPlan(config, AT).next;
  const event = eventFor(config, target, ids.next);
  for (const value of [30, "30"]) {
    event.announcements[0].time = value;
    assert.equal(eventMismatches(event, config, target).includes("announcements.time"), false);
  }
  for (const value of [undefined, null, true, "true", false, "false", 0, 1, 15, "30m", "030", " 30 ", [30], { value: 30 }]) {
    event.announcements[0].time = value;
    assert.equal(eventMismatches(event, config, target).includes("announcements.time"), true, `Must reject ${JSON.stringify(value)}`);
  }
  event.announcements[0].time = "30";
  for (const value of [30, "30"]) {
    event.advancedSettings.reminder = value;
    assert.equal(eventMismatches(event, config, target).includes("advancedSettings.reminder"), false);
  }
  for (const value of [undefined, null, true, "true", false, "false", 0, 1, 15, "30m", "030", " 30 ", [30], { value: 30 }]) {
    event.advancedSettings.reminder = value;
    assert.equal(eventMismatches(event, config, target).includes("advancedSettings.reminder"), true);
  }
});

test("unsigned reminder rejects duplicate announcements, signed targets, raw channel IDs, and wrong text", () => {
  const config = fixture();
  const target = buildPlan(config, AT).next;
  const event = eventFor(config, target, ids.next);
  const expected = structuredClone(event.announcements[0]);
  for (const value of [undefined, [], [expected, expected]]) {
    event.announcements = value;
    assert.ok(eventMismatches(event, config, target).includes("announcements.count"));
  }
  for (const channel of [ids.next, ids.forum, "signedping", "unsigneddm", "Pizza Core"]) {
    event.announcements = [{ ...expected, channel }];
    assert.ok(eventMismatches(event, config, target).includes("announcements.channel"));
  }
  event.announcements = [{ ...expected, message: "unsignedping" }];
  assert.ok(eventMismatches(event, config, target).includes("announcements.message"), "The unsigned action is the channel keyword, not the message text");
});

test("unsigned audience proof requires fresh verified dashboard evidence for the exact Core-only pool", () => {
  const config = fixture();
  assert.equal(validateAudienceAudit(audienceProof(), config, AT).verified, true);
  assert.equal(validateAudienceAudit(audienceProof("2026-09-05T05:45:00Z"), config, AT).verified, true);
  for (const proof of [
    null, {}, { ...audienceProof(), verified: false }, { ...audienceProof(), verified: "true" }, { ...audienceProof(), source: "assumed-from-config" },
    { ...audienceProof(), guildId: ids.duplicate }, { ...audienceProof(), roleIds: [ids.core, ids.duplicate], roleNames: ["Pizza Core", "Trial"] },
    { ...audienceProof(), roleIds: [ids.duplicate] }, { ...audienceProof(), roleNames: ["Well Timed Pizza"] },
    { ...audienceProof(), roleIds: [ids.core, ids.core] }, audienceProof("2026-09-05T05:44:59Z"), audienceProof("2026-09-05T06:00:01Z"), audienceProof("2026-09-05T06:00:00"), audienceProof("invalid"),
  ]) assert.throws(() => validateAudienceAudit(proof, config, AT), { code: "UNSIGNED_AUDIENCE_NOT_VERIFIED" });
});

test("missing or invalid unsigned-audience evidence blocks both creates and forum closure", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await assert.rejects(() => applyRollover(config, AT, { ...api, audienceAudit: null }), { code: "UNSIGNED_AUDIENCE_NOT_VERIFIED" });
    await assert.rejects(() => applyRollover(config, AT, { ...api, audienceAudit: undefined }), { code: "UNSIGNED_AUDIENCE_NOT_VERIFIED" });
    assert.equal(api.writes.length, 0);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("the runner loads actual audience proof from its sibling JSON when no test injection is supplied", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await writeFile(`${config.statePath}.audience.json`, JSON.stringify(audienceProof()));
    const result = await applyRollover(config, AT, { ...api, audienceAudit: undefined });
    assert.equal(result.ok, true);
    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    assert.deepEqual(state.cycles["2026-09-04"].unsignedAudienceAudit.roleIds, [ids.core]);
  });
});

function rateFixture(responses) {
  let instant = 1_000_000;
  const calls = [], waits = [];
  return {
    calls, waits,
    now: () => instant,
    sleep: async (ms) => { waits.push(ms); instant += ms; },
    fetchImpl: async (url, request) => {
      calls.push({ url, method: request.method, at: instant });
      assert.ok(responses.length, "Unexpected extra provider request");
      return responses.shift();
    },
  };
}

const nativeRateUrl = `https://discord.com/api/v10/guilds/${ids.guild}/scheduled-events`;
const rateResponse = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

test("native collection/item reads and writes honor an exhausted success-response cooldown", async () => {
  const transport = rateFixture([
    rateResponse([], 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5.000" }),
    rateResponse({ status: 2 }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.250" }),
    rateResponse({ status: 2 }),
  ]);
  await providerRequest(nativeRateUrl, transport);
  await providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, { ...transport, method: "PATCH", body: { status: 2 } });
  await providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, transport);
  assert.deepEqual(transport.waits, [5100, 350]);
  assert.deepEqual(transport.calls.map((call) => call.method), ["GET", "PATCH", "GET"]);
});

test("a Discord 429 GET retries at retry_after without repeating the preceding mutation", async () => {
  const transport = rateFixture([
    rateResponse({ status: 2 }),
    rateResponse({ message: "Rate limited", retry_after: 1.25 }, 429),
    rateResponse({ status: 2 }),
  ]);
  await providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, { ...transport, method: "PATCH", body: { status: 2 } });
  assert.deepEqual(await providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, transport), { status: 2 });
  assert.deepEqual(transport.waits, [1350]);
  assert.deepEqual(transport.calls.map((call) => call.method), ["PATCH", "GET", "GET"]);
});

test("a global Discord cooldown also gates another route and uses the Retry-After fallback", async () => {
  const transport = rateFixture([
    rateResponse({ message: "Global rate limit", global: true }, 429, { "retry-after": "2" }),
    rateResponse({ id: ids.forum }),
  ]);
  await assert.rejects(() => providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, { ...transport, method: "PATCH", body: { status: 2 } }), { code: "PROVIDER_HTTP_ERROR", status: 429, uncertain: false });
  await providerRequest(`https://discord.com/api/v10/channels/${ids.forum}`, transport);
  assert.deepEqual(transport.waits, [2100]);
  assert.equal(transport.calls.length, 2);
});

test("provider transport never automatically retries rejected POST/PATCH/DELETE writes", async () => {
  for (const method of ["POST", "PATCH", "DELETE"]) {
    const transport = rateFixture([rateResponse({ message: "Rate limited", retry_after: 1 }, 429)]);
    await assert.rejects(() => providerRequest(nativeRateUrl, { ...transport, method, body: {} }), { code: "PROVIDER_HTTP_ERROR", status: 429, uncertain: false });
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(transport.waits, []);
  }
});

test("read retries are bounded and malformed or excessive cooldowns stop safely", async () => {
  const repeated = rateFixture(Array.from({ length: 3 }, () => rateResponse({ retry_after: 0.25 }, 429)));
  await assert.rejects(() => providerRequest(nativeRateUrl, repeated), { code: "PROVIDER_HTTP_ERROR", status: 429 });
  assert.equal(repeated.calls.length, 3);
  assert.deepEqual(repeated.waits, [350, 350]);
  for (const retryAfter of [undefined, null, "unknown", false, -1, []]) {
    const invalid = rateFixture([rateResponse({ retry_after: retryAfter }, 429)]);
    await assert.rejects(() => providerRequest(nativeRateUrl, invalid), { code: "PROVIDER_HTTP_ERROR", status: 429 });
    assert.equal(invalid.calls.length, 1);
    assert.deepEqual(invalid.waits, []);
  }
  const excessive = rateFixture([rateResponse({ retry_after: 60 }, 429)]);
  await assert.rejects(() => providerRequest(nativeRateUrl, excessive), { code: "RATE_LIMIT_WAIT_EXCEEDED", status: 429, uncertain: false });
  assert.equal(excessive.calls.length, 1);
  assert.deepEqual(excessive.waits, []);
});

test("a learned cooldown over the run limit prevents the next mutation before fetch", async () => {
  const transport = rateFixture([rateResponse([], 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "60" })]);
  await providerRequest(nativeRateUrl, transport);
  await assert.rejects(() => providerRequest(`${nativeRateUrl}/${ids.nativeNext}`, { ...transport, method: "PATCH", body: { status: 2 } }), { code: "RATE_LIMIT_WAIT_EXCEEDED", status: 429 });
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.waits, []);
});

test("Discord cooldowns do not throttle a different guild or Raid-Helper", async () => {
  const transport = rateFixture([
    rateResponse([], 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "5" }),
    rateResponse([]), rateResponse({ id: ids.next }),
  ]);
  await providerRequest(nativeRateUrl, transport);
  await providerRequest(nativeRateUrl.replace(ids.guild, ids.duplicate), transport);
  await providerRequest(`https://raid-helper.xyz/api/v4/events/${ids.next}`, transport);
  assert.deepEqual(transport.waits, []);
});

test("configuration rejects wrong composition, retired role, and changed schedule", () => {
  for (const change of [(c) => { c.event.durationMinutes = 4; }, (c) => { c.coreRole.name = "Well Timed Pizza"; }, (c) => { c.event.roles[0].limit = 3; }]) {
    const config = fixture(); change(config); assert.throws(() => validateConfig(config));
  }
});

test("activation fingerprint ignores its own receipt but detects policy changes", () => {
  const config = fixture();
  assert.equal(config.activation.configHash, configHash(config));
  config.activation.verifiedAt = "2026-09-02T00:00:00Z";
  assert.equal(config.activation.configHash, configHash(config));
  config.event.description = "Changed policy copy";
  assert.notEqual(config.activation.configHash, configHash(config));
});

test("channel permission evaluation applies role and member overwrites correctly", () => {
  const roles = [{ id: ids.guild, permissions: "0" }, { id: ids.botRole, permissions: String(1n << 34n) }];
  const member = { user: { id: ids.bot }, roles: [ids.botRole] };
  const denied = { permission_overwrites: [{ id: ids.guild, type: 0, deny: String(1n << 34n), allow: "0" }] };
  assert.equal(effectivePermissions(ids.guild, roles, member, denied).manageThreads, false);
  denied.permission_overwrites.push({ id: ids.botRole, type: 0, allow: String(1n << 34n), deny: "0" });
  assert.equal(effectivePermissions(ids.guild, roles, member, denied).manageThreads, true);
  denied.permission_overwrites.push({ id: ids.bot, type: 1, allow: "0", deny: String(1n << 34n) });
  assert.equal(effectivePermissions(ids.guild, roles, member, denied).manageThreads, false);
});

test("unactivated or stale configuration fails before any network action", async () => {
  await isolated(async (config) => {
    let calls = 0;
    await assert.rejects(() => applyRollover(config, AT, { fetchImpl: async () => { calls++; } }), { code: "NOT_ACTIVATED" });
    assert.equal(calls, 0);
  }, false);
});

test("missing credential fails before any network action", async () => {
  await isolated(async (config) => {
    delete process.env.TEST_PIZZA_API_KEY;
    await assert.rejects(() => applyRollover(config, AT, { fetchImpl: async () => { throw new Error("No network expected"); } }), { code: "MISSING_CREDENTIAL" });
  });
});

test("missing Manage Threads stops before creation", async () => {
  await isolated(async (config) => {
    const api = mock(config, { noManageThreads: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "MISSING_THREAD_PERMISSION" });
    assert.equal(api.writes.length, 0);
  });
});

test("rollover verifies both successors before locking the legacy predecessor and reruns as a no-op", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    const result = await applyRollover(config, AT, api);
    assert.equal(result.outcome, "rolled-over");
    assert.deepEqual(api.writes.map((call) => call.method), ["POST", "POST", "PATCH"]);
    assert.deepEqual(api.writes[2].body, { archived: true, locked: true });
    const postIndex = api.calls.findIndex((call) => call.method === "POST");
    const closeIndex = api.calls.findIndex((call) => call.method === "PATCH");
    assert.ok(api.calls.slice(postIndex + 1, closeIndex).some((call) => call.target.endsWith(`/events/${ids.next}`)));
    assert.ok(api.calls.slice(postIndex + 1, closeIndex).some((call) => call.target.endsWith(`/messages/${ids.next}`)));
    assert.ok(api.calls.slice(postIndex + 1, closeIndex).some((call) => call.target.endsWith(`/scheduled-events/${ids.nativeNext}`)));
    assert.equal(result.next.nativeCalendar.eventId, ids.nativeNext);
    assert.equal(JSON.parse(await readFile(config.statePath, "utf8")).cycles["2026-09-04"].phase, "complete");
    const writes = api.writes.length;
    const rerun = await applyRollover(config, AT, api);
    assert.equal(rerun.outcome, "verified-noop");
    assert.equal(api.writes.length, writes);
    assert.equal(JSON.stringify(result).includes(process.env.TEST_PIZZA_API_KEY), false);
    assert.equal(JSON.stringify(result).includes(process.env.TEST_PIZZA_DISCORD_TOKEN), false);
  });
});

test("one existing compliant signup successor is adopted without another Raid-Helper POST", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nextExists: true });
    const result = await applyRollover(config, AT, api);
    assert.equal(result.successorOutcome, "adopted-existing");
    assert.deepEqual(api.writes.map((call) => call.method), ["POST", "PATCH"]);
    assert.equal(rhPosts(api).length, 0);
    assert.equal(nativePosts(api).length, 1);
  });
});

test("uncertain create response is reconciled without a second POST", async () => {
  await isolated(async (config) => {
    const api = mock(config, { uncertainCreate: true });
    const result = await applyRollover(config, AT, api);
    assert.equal(result.successorOutcome, "reconciled-after-uncertain-create");
    assert.equal(rhPosts(api).length, 1);
  });
});

test("unresolved create intent blocks a second POST across invocations", async () => {
  await isolated(async (config) => {
    const api = mock(config, { uncertainAbsent: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "CREATE_OUTCOME_UNCERTAIN" });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "CREATE_OUTCOME_UNCERTAIN" });
    assert.equal(rhPosts(api).length, 1);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("a lost successful response body is uncertain, not a safe create rejection", async () => {
  await isolated(async (config) => {
    const api = mock(config, { bodyReadFailure: true, hideNextFromList: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "CREATE_OUTCOME_UNCERTAIN" });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "CREATE_OUTCOME_UNCERTAIN" });
    assert.equal(rhPosts(api).length, 1);
    api.revealNext();
    const recovered = await applyRollover(config, AT, api);
    assert.equal(recovered.successorOutcome, "adopted-existing");
    assert.equal(rhPosts(api).length, 1);
  });
});

test("a previous cycle's successor ID remains authoritative if completed events leave the list", async () => {
  await isolated(async (config) => {
    config.bootstrap = { date: "2026-08-28", eventId: ids.duplicate, legacyPolicy: true };
    config.activation.configHash = configHash(config);
    await writeFile(config.statePath, JSON.stringify({ version: 1, seriesId: config.seriesId, cycles: { "2026-08-28": { phase: "complete", nextDate: "2026-09-04", nextEventId: ids.previous } } }));
    const api = mock(config, { hidePreviousFromList: true });
    const result = await applyRollover(config, AT, api);
    assert.equal(result.previous.eventId, ids.previous);
    assert.equal(result.verification.journal, "complete");
  });
});

test("duplicate exact-time successors cause zero mutations", async () => {
  await isolated(async (config) => {
    const api = mock(config, { duplicate: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "DUPLICATE_OCCURRENCE" });
    assert.equal(api.writes.length, 0);
  });
});

test("a duplicate appearing during successful creation prevents predecessor closure", async () => {
  await isolated(async (config) => {
    const api = mock(config, { concurrentDuplicate: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "DUPLICATE_OCCURRENCE" });
    assert.deepEqual(api.writes.map((call) => call.method), ["POST"]);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("a drifted existing successor is not silently repaired or duplicated", async () => {
  await isolated(async (config) => {
    const api = mock(config, { drift: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "EVENT_DRIFT" });
    assert.equal(api.writes.length, 0);
  });
});

test("title drift at the same start is a conflict, not permission to create another event", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nextExists: true });
    api.events.get(ids.next).title = "Officer edited title";
    await assert.rejects(() => applyRollover(config, AT, api), { code: "EVENT_DRIFT" });
    assert.equal(api.writes.length, 0);
  });
});

test("create rejection leaves predecessor open", async () => {
  await isolated(async (config) => {
    const api = mock(config, { createRejected: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "PROVIDER_HTTP_ERROR" });
    assert.equal(api.writes.filter((call) => call.method === "PATCH").length, 0);
    assert.equal(api.threads.get(ids.previous).thread_metadata.archived, false);
  });
});

test("post-create verification failure preserves both posts and never duplicates on retry", async () => {
  await isolated(async (config) => {
    const api = mock(config, { createdDrift: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "EVENT_DRIFT" });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "EVENT_DRIFT" });
    assert.equal(rhPosts(api).length, 1);
    assert.equal(api.writes.filter((call) => call.method === "PATCH").length, 0);
  });
});

test("archive failure leaves a recoverable successor and retry performs only close", async () => {
  await isolated(async (config) => {
    const api = mock(config, { closeError: 403 });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "PROVIDER_HTTP_ERROR" });
    assert.equal(JSON.parse(await readFile(config.statePath, "utf8")).cycles["2026-09-04"].phase, "close-pending");
    assert.equal(api.events.has(ids.next), true);
    api.clearCloseError();
    const result = await applyRollover(config, AT, api);
    assert.equal(result.verification.journal, "complete");
    assert.equal(rhPosts(api).length, 1);
  });
});

test("lost archive response is reconciled by reading actual thread state", async () => {
  await isolated(async (config) => {
    const api = mock(config, { uncertainClose: true });
    const result = await applyRollover(config, AT, api);
    assert.equal(result.previous.locked, true);
    assert.equal(api.writes.filter((call) => call.method === "PATCH").length, 1);
  });
});

test("wrong predecessor parent cannot be locked", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    api.threads.get(ids.previous).parent_id = ids.duplicate;
    await assert.rejects(() => applyRollover(config, AT, api), { code: "EVENT_DRIFT" });
    assert.equal(api.writes.length, 0);
  });
});

test("early and stale invocations never mutate", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    for (const at of ["2026-09-05T05:59:59Z", "2026-09-06T06:00:00Z"]) await assert.rejects(() => applyRollover(config, at, api), { code: "OUTSIDE_ROLLOVER_WINDOW" });
    assert.equal(api.calls.length, 0);
  });
});

test("role deletion, rename, or duplicate name fails closed", async () => {
  await isolated(async (config) => {
    for (const change of [(roles) => roles.splice(1, 1), (roles) => { roles[1].name = "Renamed"; }, (roles) => roles.push({ id: ids.duplicate, name: "Pizza Core", permissions: "0" })]) {
      const api = mock(config); change(api.roles);
      await assert.rejects(() => applyRollover(config, AT, api), { code: "CORE_ROLE_DRIFT" });
      assert.equal(api.writes.length, 0);
    }
  });
});

test("tag ID or name drift fails closed", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    api.forum.available_tags = [{ id: ids.duplicate, name: "PizzaCore" }, config.tags[1]];
    await assert.rejects(() => applyRollover(config, AT, api), { code: "FORUM_TAG_DRIFT" });
    assert.equal(api.writes.length, 0);
  });
});

test("competing Raid-Helper native recurrence blocks local creation", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeRecurrence: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "COMPETING_RECURRENCE" });
    assert.equal(api.writes.length, 0);
  });
});

test("local mutex blocks overlapping or unreconciled crashed run", async () => {
  await isolated(async (config) => {
    await writeFile(`${config.statePath}.lock`, JSON.stringify({ pid: 123 }));
    const api = mock(config);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "ROLLOVER_LOCKED" });
    assert.equal(api.calls.length, 0);
  });
});

test("read-only audit distinguishes configured attendee reminder from intended policy without sending anything", async () => isolated(async (config) => {
  const api = mock(config);
  let result = await audit(config, "2026-09-01T18:00:00Z", api);
  assert.equal(result.currentEvent.reminder.explicitThirtyMinuteAttendee, true);
  assert.equal(result.currentEvent.reminder.explicitThirtyMinuteUnsigned, true);
  assert.equal(result.currentEvent.reminder.dispatchVerified, false);
  api.events.get(ids.previous).advancedSettings.reminder = "false";
  result = await audit(config, "2026-09-01T18:00:00Z", api);
  assert.equal(result.currentEvent.reminder.explicitThirtyMinuteAttendee, false);
  assert.equal(result.currentEvent.reminder.attendeeReminderDisabled, true);
  assert.ok(result.currentEvent.policyMismatches.includes("advancedSettings.reminder"));
  assert.equal(api.writes.length, 0);
}));

test("a successor with the old disabled-attendee contract blocks adoption and forum closure", async () => isolated(async (config) => {
  const api = mock(config, { nextExists: true });
  api.events.get(ids.next).advancedSettings.reminder = false;
  await assert.rejects(applyRollover(config, AT, api), (error) => error.details?.mismatches?.includes("advancedSettings.reminder"));
  assert.equal(api.writes.length, 0);
  assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
}));

test("read-only audit reports missing API key, permission, and current legacy drift", async () => {
  await isolated(async (config) => {
    delete process.env.TEST_PIZZA_API_KEY;
    const api = mock(config, { noManageThreads: true });
    const result = await audit(config, "2026-09-01T18:00:00Z", api);
    assert.equal(result.raidHelperApiKeyPresent, false);
    assert.equal(result.permissions.manageThreads, false);
    assert.ok(result.currentEvent.policyMismatches.includes("advancedSettings.allowed_roles"));
    assert.equal(result.currentEvent.discordRequiredTagsPresent, true);
    assert.equal(api.writes.length, 0);
  });
});

test("audit exposes wrong Discord parent, owner, and starter author", async () => {
  await isolated(async (config) => {
    delete process.env.TEST_PIZZA_API_KEY;
    const api = mock(config, { wrongStarter: true });
    api.threads.get(ids.previous).parent_id = ids.duplicate;
    api.threads.get(ids.previous).owner_id = ids.duplicate;
    const result = await audit(config, "2026-09-01T18:00:00Z", api);
    assert.ok(result.currentEvent.identityMismatches.includes("discord.threadIdentity"));
    assert.ok(result.currentEvent.identityMismatches.includes("discord.starterAuthor"));
    assert.equal(api.writes.length, 0);
  });
});

test("audit follows the current planned occurrence from the journal after the first week", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await applyRollover(config, AT, api);
    const writes = api.writes.length;
    const result = await audit(config, "2026-09-12T06:00:00Z", api);
    assert.equal(result.currentEvent.date, "2026-09-11");
    assert.equal(result.currentEvent.eventId, ids.next);
    assert.deepEqual(result.currentEvent.mismatches, []);
    assert.equal(api.writes.length, writes);
  });
});

test("audit does not fall back to an old bootstrap event when the new occurrence is unknown", async () => {
  await isolated(async (config) => {
    delete process.env.TEST_PIZZA_API_KEY;
    const api = mock(config);
    const result = await audit(config, "2026-09-12T06:00:00Z", api);
    assert.equal(result.currentEvent.date, "2026-09-11");
    assert.equal(result.currentEvent.status, "not-located");
    assert.equal(api.calls.some((call) => call.target.endsWith(`/events/${ids.previous}`)), false);
  });
});

test("verification checks duration/end, composition, and unordered required tags", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  const event = eventFor(config, plan.next, ids.next);
  event.advancedSettings.forum_tags = "Event, PizzaCore";
  assert.deepEqual(eventMismatches(event, config, plan.next), []);
  event.endTime = event.startTime;
  event.roles[0].limit = 1;
  assert.ok(eventMismatches(event, config, plan.next).includes("endTime"));
  assert.ok(eventMismatches(event, config, plan.next).includes("roles.Tanks"));
  event.roles.push({ name: "Extra", limit: 1, emoteId: ids.duplicate });
  assert.ok(eventMismatches(event, config, plan.next).includes("roles.count"));
});

test("only the stock hidden unlimited WotLK DPS aggregate is accepted in addition to the four slots", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  const event = eventFor(config, plan.next, ids.next);
  event.roles.push({ name: "Dps", cName: "Dps", limit: 999, emoteId: "592440132129521664" });
  assert.deepEqual(eventMismatches(event, config, plan.next), []);
  event.roles.at(-1).limit = 18;
  assert.ok(eventMismatches(event, config, plan.next).includes("roles.count"));
  event.roles.at(-1).limit = 999;
  event.roles.at(-1).emoteId = ids.duplicate;
  assert.ok(eventMismatches(event, config, plan.next).includes("roles.count"));
  event.roles.at(-1).emoteId = "592440132129521664";
  event.roles.push(structuredClone(event.roles.at(-1)));
  assert.ok(eventMismatches(event, config, plan.next).includes("roles.count"));
});

test("duplicate provider tags cannot impersonate the required tag set and mass mentions are drift", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  const event = eventFor(config, plan.next, ids.next);
  event.advancedSettings.forum_tags = "PizzaCore, PizzaCore";
  event.advancedSettings.mentions = "everyone";
  const mismatches = eventMismatches(event, config, plan.next);
  assert.ok(mismatches.includes("advancedSettings.forum_tags"));
  assert.ok(mismatches.includes("advancedSettings.mentions"));
});

for (const option of ["extraRolePing", "everyonePing"]) {
  test(`successor starter rejects ${option} without creating or closing anything`, async () => {
    await isolated(async (config) => {
      const api = mock(config, { nextExists: true, [option]: true });
      await assert.rejects(() => applyRollover(config, AT, api), (error) => error.code === "EVENT_DRIFT" && error.details.mismatches.includes("discord.coreRolePing"));
      assert.equal(api.writes.length, 0);
    });
  });
}

test("Raid-Helper clearing the creation-time role mention on signup refresh never causes a second ping", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nextExists: true, missingCorePing: true });
    api.events.get(ids.next).signUps = [{ userId: ids.leader, className: "Tank", status: "primary" }];
    const first = await applyRollover(config, AT, api);
    assert.equal(first.successorOutcome, "adopted-existing");
    const second = await applyRollover(config, AT, api);
    assert.equal(second.outcome, "verified-noop");
    assert.equal(rhPosts(api).length, 0);
    assert.equal(nativePosts(api).length, 1);
    assert.equal(api.writes.length, 2);
  });
});

test("successor signup-request text must survive readback", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  const event = eventFor(config, plan.next, ids.next);
  event.description = "";
  assert.ok(eventMismatches(event, config, plan.next).includes("description"));
  assert.equal(eventMismatches(event, config, plan.next, { policy: false }).includes("description"), false);
});

test("CLI plans are offline and simulated production apply is forbidden", async () => {
  await isolated(async (config, directory) => {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config));
    const noNetwork = { fetchImpl: async () => { throw new Error("No network expected"); } };
    const result = await runCli(["plan", "--config", path, "--at", AT], noNetwork);
    assert.equal(result.mutationAuthorized, false);
    await assert.rejects(() => runCli(["apply", "--config", path, "--at", AT], noNetwork), { code: "SIMULATED_APPLY_FORBIDDEN" });
    await assert.rejects(() => runCli(["start-native", "--config", path, "--at", AT], noNetwork), { code: "SIMULATED_APPLY_FORBIDDEN" });
    await assert.rejects(() => runCli(["plan", "--config", path, "--typo", "x"], noNetwork), { code: "INVALID_ARGUMENT" });
  });
});

test("native VOICE readback accepts null, missing, or exactly empty metadata", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  for (const metadata of [null, undefined, {}]) {
    const native = nativeFor(config, plan.next, ids.next, ids.nativeNext);
    native.entity_metadata = metadata;
    assert.deepEqual(nativeEventMismatches(native, config, plan.next, ids.next), []);
  }
});

test("native VOICE metadata compatibility does not accept populated or malformed data", () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  for (const metadata of [{ location: "Elsewhere" }, { location: null }, [], [null], "", false, 0]) {
    const native = nativeFor(config, plan.next, ids.next, ids.nativeNext);
    native.entity_metadata = metadata;
    assert.ok(nativeEventMismatches(native, config, plan.next, ids.next).includes("entity_metadata"));
  }
});

test("live empty VOICE metadata verifies creation and retry without duplicate posts", async () => {
  await isolated(async (config) => {
    const api = mock(config, { createdNativeEmptyMetadata: true });
    await applyRollover(config, AT, { ...api, sleep: async () => {} });
    assert.equal(rhPosts(api).length, 1);
    assert.equal(nativePosts(api).length, 1);
    const beforeRetry = api.writes.length;
    const retried = await applyRollover(config, AT, { ...api, sleep: async () => {} });
    assert.equal(retried.outcome, "verified-noop");
    assert.equal(api.writes.length, beforeRetry);
    assert.deepEqual(api.nativeEvents.get(ids.nativeNext).entity_metadata, {});
  });
});

test("native voice payload uses the same occurrence, leader, signup link, and no competing creator", () => {
  const config = fixture();
  const originalHash = configHash(config);
  for (const at of [AT, "2026-10-31T06:00:00Z", "2027-03-13T07:00:00Z"]) {
    const plan = buildPlan(config, at);
    const payload = buildNativePayload(config, plan.next.date, ids.next);
    assert.equal(payload.entity_type, 2);
    assert.equal(payload.channel_id, ids.voice);
    assert.equal(payload.privacy_level, 2);
    assert.equal(payload.entity_metadata, null);
    assert.equal(payload.recurrence_rule, undefined);
    assert.equal(payload.scheduled_start_time, plan.next.start.utc);
    assert.equal(payload.scheduled_end_time, plan.next.end.utc);
    assert.equal((Date.parse(payload.scheduled_end_time) - Date.parse(payload.scheduled_start_time)) / 60000, 240);
    assert.ok(payload.description.includes(`https://discord.com/channels/${ids.guild}/${ids.next}`));
    assert.ok(payload.description.includes("Raid leader: Raid Leader"));
    assert.ok(payload.description.includes("does not sign you up"));
    assert.ok(payload.description.length <= 1000);
    assert.equal(plan.next.payload.advancedSettings.create_discordevent, false);
  }
  buildNativePayload(config, "2026-09-11", ids.duplicate);
  assert.equal(configHash(config), originalHash, "Dynamic post IDs must not invalidate activation");
});

test("invalid native description/name and missing voice policy fail before mutation", () => {
  const config = fixture();
  config.event.title = "x".repeat(101);
  assert.throws(() => validateConfig(config), { code: "INVALID_CONFIG" });
  config.event.title = "Pizza Core ICC25";
  config.event.leaderDisplayName = "x".repeat(1000);
  assert.throws(() => buildNativePayload(config, "2026-09-11", ids.next), { code: "INVALID_NATIVE_PAYLOAD" });
  config.event.leaderDisplayName = "Raid Leader";
  delete config.nativeCalendar;
  assert.throws(() => validateConfig(config), { code: "INVALID_CONFIG" });
});

test("native permission comes from the voice channel, not the forum or only guild defaults", async () => {
  await isolated(async (config) => {
    const denied = mock(config, { noCreateEvents: true });
    denied.forum.permission_overwrites.push({ id: ids.botRole, type: 0, allow: String(1n << 44n), deny: "0" });
    await assert.rejects(() => applyRollover(config, AT, denied), { code: "MISSING_VOICE_EVENT_PERMISSION" });
    assert.equal(denied.writes.length, 0);
    const allowed = mock(config, { noCreateEvents: true });
    allowed.voice.permission_overwrites.push({ id: ids.botRole, type: 0, allow: String(1n << 44n), deny: "0" });
    assert.equal(guildPermissions(ids.guild, allowed.roles, { roles: [ids.botRole] }).createEvents, false);
    assert.equal((await applyRollover(config, AT, allowed)).ok, true);
  });
});

for (const permission of [10n, 20n, 44n]) {
  test(`voice denial of bit ${permission} blocks before either create`, async () => {
    await isolated(async (config) => {
      const api = mock(config);
      api.voice.permission_overwrites.push({ id: ids.bot, type: 1, allow: "0", deny: String(1n << permission) });
      await assert.rejects(() => applyRollover(config, AT, api), { code: "MISSING_VOICE_EVENT_PERMISSION" });
      assert.equal(api.writes.length, 0);
    });
  });
}

test("renamed or replaced voice binding cannot be silently substituted", async () => {
  await isolated(async (config) => {
    for (const change of [(voice) => { voice.name = "Different voice"; }, (voice) => { voice.type = 13; }, (voice) => { voice.guild_id = ids.duplicate; }]) {
      const api = mock(config); change(api.voice);
      await assert.rejects(() => applyRollover(config, AT, api), { code: "VOICE_CHANNEL_DRIFT" });
      assert.equal(api.writes.length, 0);
    }
  });
});

test("both existing successors are adopted without a create or repeated ping", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nextExists: true, nativeExists: true });
    const result = await applyRollover(config, AT, api);
    assert.equal(result.nativeSuccessorOutcome, "adopted-existing");
    assert.deepEqual(api.writes.map((call) => call.method), ["PATCH"]);
  });
});

test("orphan native event blocks a new signup post and its ping", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeExists: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "ORPHAN_NATIVE_EVENT" });
    assert.equal(api.writes.length, 0);
  });
});

test("native capacity is checked before Raid-Helper creation", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    for (let i = 0; i < 100; i++) {
      const id = String(900000000000000000n + BigInt(i));
      api.nativeEvents.set(id, { ...nativeFor(config, api.plan.next, ids.duplicate, id), name: `Other raid ${i}`, description: "Unrelated event" });
    }
    await assert.rejects(() => applyRollover(config, AT, api), { code: "NATIVE_EVENT_CAPACITY" });
    assert.equal(api.writes.length, 0);
  });
});

test("unrelated native raid at the same time remains untouched", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    api.nativeEvents.set(ids.nativeDuplicate, { ...nativeFor(config, api.plan.next, ids.duplicate, ids.nativeDuplicate), name: "Brother Raid", description: "Unrelated event" });
    await applyRollover(config, AT, api);
    assert.equal(api.writes.some((call) => call.target.endsWith(`/${ids.nativeDuplicate}`)), false);
    assert.equal(api.nativeEvents.get(ids.nativeDuplicate).name, "Brother Raid");
  });
});

test("malformed native list cannot masquerade as absence", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeListMalformed: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "UNEXPECTED_NATIVE_RESPONSE" });
    assert.equal(api.writes.length, 0);
  });
});

for (const [field, replacement] of [
  ["creator_id", ids.leader], ["guild_id", ids.duplicate], ["channel_id", ids.forum], ["entity_type", 3],
  ["privacy_level", 1], ["description", "Manual event without ownership marker"], ["name", "Renamed raid"],
  ["scheduled_start_time", "2026-09-13T02:00:00Z"], ["scheduled_end_time", "2026-09-12T07:00:00Z"],
  ["status", 4], ["recurrence_rule", { frequency: 2, interval: 1 }],
]) {
  test(`native ${field} drift is not duplicated, adopted, or repaired`, async () => {
    await isolated(async (config) => {
      const api = mock(config, { nextExists: true, nativeExists: true });
      api.nativeEvents.get(ids.nativeNext)[field] = replacement;
      await assert.rejects(() => applyRollover(config, AT, api), (error) => (error.code === "NATIVE_EVENT_DRIFT" && error.details.mismatches.includes(field)) || (error.code === "UNEXPECTED_NATIVE_RESPONSE" && error.details.invalidFields.includes(field)));
      assert.equal(api.writes.length, 0);
    });
  });
}

test("native duplicates block before either creation", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nextExists: true, nativeDuplicate: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "DUPLICATE_NATIVE_EVENT" });
    assert.equal(api.writes.length, 0);
  });
});

test("native rejection preserves signup successor and retries only the rejected calendar create", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeCreateError: 403 });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "PROVIDER_HTTP_ERROR" });
    assert.equal(api.events.has(ids.next), true);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
    assert.equal(JSON.parse(await readFile(config.statePath, "utf8")).cycles["2026-09-04"].nativeCalendar.phase, "create-rejected");
    api.clearNativeCreateError();
    await applyRollover(config, AT, api);
    assert.equal(rhPosts(api).length, 1);
    assert.equal(nativePosts(api).length, 2, "Only the explicitly rejected native request may be retried");
  });
});

for (const option of ["uncertainNativeCreate", "nativeMalformedCreateResponse"]) {
  test(`${option} reconciles the native card without a second create`, async () => {
    await isolated(async (config) => {
      const api = mock(config, { [option]: true });
      const result = await applyRollover(config, AT, api);
      assert.equal(result.next.nativeCalendar.eventId, ids.nativeNext);
      assert.equal(nativePosts(api).length, 1);
      assert.equal(rhPosts(api).length, 1);
    });
  });
}

test("unresolved native intent survives top-level successor re-verification across invocations", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeBodyReadFailure: true, hideNativeFromList: true });
    for (let i = 0; i < 2; i++) await assert.rejects(() => applyRollover(config, AT, api), { code: "NATIVE_CREATE_OUTCOME_UNCERTAIN" });
    assert.equal(nativePosts(api).length, 1);
    assert.equal(rhPosts(api).length, 1);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
    const checkpoint = JSON.parse(await readFile(config.statePath, "utf8")).cycles["2026-09-04"];
    assert.equal(checkpoint.nativeCalendar.phase, "create-uncertain");
    api.revealNative();
    assert.equal((await applyRollover(config, AT, api)).ok, true);
    assert.equal(nativePosts(api).length, 1);
    assert.equal(rhPosts(api).length, 1);
  });
});

test("a native create with no reconciled outcome never gets a blind second POST", async () => {
  await isolated(async (config) => {
    const api = mock(config, { uncertainNativeAbsent: true });
    for (let i = 0; i < 2; i++) await assert.rejects(() => applyRollover(config, AT, api), { code: "NATIVE_CREATE_OUTCOME_UNCERTAIN" });
    assert.equal(nativePosts(api).length, 1);
    assert.equal(api.threads.get(ids.previous).thread_metadata.archived, false);
  });
});

test("native post-create drift retains both posts and never repeats either create", async () => {
  await isolated(async (config) => {
    const api = mock(config, { createdNativeDrift: true });
    for (let i = 0; i < 2; i++) await assert.rejects(() => applyRollover(config, AT, api), { code: "NATIVE_EVENT_DRIFT" });
    assert.equal(nativePosts(api).length, 1);
    assert.equal(rhPosts(api).length, 1);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("a native duplicate appearing after POST prevents forum closure", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeConcurrentDuplicate: true });
    await assert.rejects(() => applyRollover(config, AT, api), { code: "DUPLICATE_NATIVE_EVENT" });
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
    assert.equal(nativePosts(api).length, 1);
  });
});

test("a deleted journaled native event is not recreated on retry", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await applyRollover(config, AT, api);
    const count = api.writes.length;
    api.nativeEvents.delete(ids.nativeNext);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "NATIVE_EVENT_MISSING" });
    assert.equal(api.writes.length, count);
  });
});

test("native timestamp normalization and Interested counts do not change ownership or roster", async () => {
  const config = fixture();
  const plan = buildPlan(config, AT);
  const native = nativeFor(config, plan.next, ids.next, ids.nativeNext);
  native.scheduled_start_time = "2026-09-11T22:00:00-04:00";
  native.user_count = 99;
  assert.deepEqual(nativeEventMismatches(native, config, plan.next, ids.next), []);
  native.status = 3;
  assert.deepEqual(nativeEventMismatches(native, config, plan.next, ids.next, { allowedStatuses: [3, 4] }), []);
  assert.ok(nativeEventMismatches(native, config, plan.next, ids.next).includes("status"));
});

const NEXT_START = "2026-09-12T02:00:00Z";

test("start-only invocation never creates or backfills a legacy event", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    const result = await startNative(config, "2026-09-05T02:00:00Z", api);
    assert.equal(result.outcome, "no-managed-native-event");
    assert.equal(api.calls.length, 0);
  });
});

test("start-only path is activation-gated and rejects early or late clocks before network", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await assert.rejects(() => startNative(config, NEXT_START, api), { code: "NOT_ACTIVATED" });
    assert.equal(api.calls.length, 0);
  }, false);
  await isolated(async (config) => {
    const api = mock(config);
    for (const at of ["2026-09-12T01:59:59Z", "2026-09-12T02:30:01Z", "2026-09-13T02:00:00Z"]) await assert.rejects(() => startNative(config, at, api), { code: "OUTSIDE_NATIVE_START_WINDOW" });
    assert.equal(api.calls.length, 0);
  });
});

test("start-only phase activates one recorded voice event and repeats as a no-op without a ping", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await applyRollover(config, AT, api);
    const count = api.writes.length;
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "native-started");
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "verified-noop");
    assert.equal(api.writes.length, count + 1);
    assert.deepEqual(api.writes.at(-1).body, { status: 2 });
    assert.equal(rhPosts(api).length, 1);
    assert.equal(nativePosts(api).length, 1);
    assert.equal(api.calls.some((call) => /scheduled-events\/\d+\/users/.test(call.target)), false);
    assert.equal(api.writes.some((call) => call.method === "DELETE" || /sign.?up|voice-states/.test(call.target)), false);
  });
});

for (const status of [3, 4]) {
  test(`start-only phase preserves terminal native status ${status}`, async () => {
    await isolated(async (config) => {
      const api = mock(config);
      await applyRollover(config, AT, api);
      const count = api.writes.length;
      api.nativeEvents.get(ids.nativeNext).status = status;
      const result = await startNative(config, NEXT_START, api);
      assert.equal(result.outcome, "terminal-preserved");
      assert.equal(result.requiresAttention, true);
      assert.equal(api.writes.length, count);
    });
  });
}

test("lost native start response is read back without a second start or create", async () => {
  await isolated(async (config) => {
    const api = mock(config, { uncertainNativeStatus: true });
    await applyRollover(config, AT, api);
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "native-started");
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "verified-noop");
    assert.equal(api.writes.filter((call) => call.body?.status === 2).length, 1);
  });
});

test("native start failure is retryable only on the existing pair", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeStatusError: 403 });
    await applyRollover(config, AT, api);
    await assert.rejects(() => startNative(config, NEXT_START, api), { code: "PROVIDER_HTTP_ERROR" });
    assert.equal(api.nativeEvents.get(ids.nativeNext).status, 1);
    api.clearNativeStatusError();
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "native-started");
    assert.equal(nativePosts(api).length, 1);
    assert.equal(rhPosts(api).length, 1);
  });
});

test("provider auto-completion is preserved instead of restarting or parking a bot in voice", async () => {
  await isolated(async (config) => {
    const api = mock(config, { autoCompleteOnStart: true });
    await applyRollover(config, AT, api);
    const first = await startNative(config, NEXT_START, api);
    assert.equal(first.outcome, "terminal-preserved");
    assert.equal(first.nativeCalendar.status, 3);
    const count = api.writes.length;
    await startNative(config, NEXT_START, api);
    assert.equal(api.writes.length, count);
  });
});

async function seedPriorCalendar(config, api, status) {
  api.nativeEvents.set(ids.nativePrevious, nativeFor(config, api.plan.previous, ids.previous, ids.nativePrevious, status));
  const cycle = { phase: "complete", configHash: configHash(config), previousDate: "2026-08-28", nextDate: api.plan.previous.date, nextEventId: ids.previous, nativeCalendar: { phase: "verified", occurrenceKey: api.plan.previous.key, raidHelperEventId: ids.previous, eventId: ids.nativePrevious } };
  await writeFile(config.statePath, JSON.stringify({ version: 1, seriesId: config.seriesId, cycles: { "2026-08-28": cycle } }));
}

test("active predecessor calendar ends even when the subsequent signup create fails", async () => {
  await isolated(async (config) => {
    const api = mock(config, { createRejected: true });
    await seedPriorCalendar(config, api, 2);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "PROVIDER_HTTP_ERROR" });
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
    assert.deepEqual(api.writes.map((call) => call.method), ["PATCH", "POST"]);
  });
});

for (const [status, outcome] of [[1, "never-started"], [3, "already-completed"], [4, "canceled-preserved"]]) {
  test(`prior native status ${status} is preserved and does not strand the old forum`, async () => {
    await isolated(async (config) => {
      const api = mock(config);
      await seedPriorCalendar(config, api, status);
      const result = await applyRollover(config, AT, api);
      assert.equal(result.previous.nativeCalendar.outcome, outcome);
      assert.equal(api.nativeEvents.get(ids.nativePrevious).status, status);
      assert.equal(api.threads.get(ids.previous).thread_metadata.locked, true);
      assert.equal(api.writes.some((call) => call.target.endsWith(`/${ids.nativePrevious}`)), false);
      assert.equal(result.warnings.length, status === 3 ? 0 : 1);
    });
  });
}

test("failed prior native end stays a partial result while verified successors and forum closure survive", async () => {
  await isolated(async (config) => {
    const api = mock(config, { nativeStatusError: 403 });
    await seedPriorCalendar(config, api, 2);
    const first = await applyRollover(config, AT, api);
    assert.equal(first.ok, false);
    assert.equal(first.outcome, "rolled-over-native-end-pending");
    assert.equal(first.verification.journal, "native-end-pending");
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, true);
    api.clearNativeStatusError();
    const second = await applyRollover(config, AT, api);
    assert.equal(second.ok, true);
    assert.equal(second.verification.journal, "complete");
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.equal(nativePosts(api).length, 1);
    assert.equal(rhPosts(api).length, 1);
  });
});

test("missing native canary proof prevents production network work even with other gates populated", async () => {
  await isolated(async (config) => {
    config.activation.nativeCalendarLifecycleVerified = false;
    const api = mock(config);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "NOT_ACTIVATED" });
    await assert.rejects(() => startNative(config, NEXT_START, api), { code: "NOT_ACTIVATED" });
    assert.equal(api.calls.length, 0);
  });
});

for (const [label, change] of [
  ["valid ID only", (event) => ({ id: event.id })],
  ["invalid start time", (event) => ({ ...event, scheduled_start_time: "not-a-timestamp" })],
  ["missing status", (event) => { const copy = { ...event }; delete copy.status; return copy; }],
]) {
  test(`native list row with ${label} never authorizes either create`, async () => {
    await isolated(async (config) => {
      const api = mock(config, { nativeExists: true });
      const malformed = change(api.nativeEvents.get(ids.nativeNext));
      const fetchImpl = async (url, request = {}) => String(url).endsWith(`/guilds/${ids.guild}/scheduled-events`) && (request.method || "GET") === "GET" ? response([malformed]) : api.fetchImpl(url, request);
      await assert.rejects(() => applyRollover(config, AT, { ...api, fetchImpl }), { code: "UNEXPECTED_NATIVE_RESPONSE" });
      assert.equal(api.writes.length, 0);
      assert.equal(api.nativeEvents.size, 1);
    });
  });
}

test("legitimate null descriptions on unrelated native events remain supported", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    api.nativeEvents.set(ids.nativeDuplicate, { ...nativeFor(config, api.plan.next, ids.duplicate, ids.nativeDuplicate), name: "Other guild event", description: null });
    assert.equal((await applyRollover(config, AT, api)).ok, true);
    assert.equal(api.nativeEvents.get(ids.nativeDuplicate).description, null);
  });
});

test("a Raid-Helper read outage cannot keep a journaled prior native card active", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await seedPriorCalendar(config, api, 2);
    const fetchImpl = async (url, request) => String(url).startsWith("https://raid-helper.xyz/") ? response({ message: "RH unavailable" }, 503) : api.fetchImpl(url, request);
    await assert.rejects(() => applyRollover(config, AT, { ...api, fetchImpl }), (error) => error.code === "PROVIDER_HTTP_ERROR" && error.details.previousNativeCalendar.outcome === "completed" && error.details.forumUnchanged);
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.deepEqual(api.writes.map((call) => ({ method: call.method, body: call.body })), [{ method: "PATCH", body: { status: 3 } }]);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("missing RH key permits only the due, recorded native end and blocks forum work", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await seedPriorCalendar(config, api, 2);
    delete process.env.TEST_PIZZA_API_KEY;
    await assert.rejects(() => applyRollover(config, AT, api), { code: "MISSING_CREDENTIAL" });
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.equal(api.calls.some((call) => call.target.startsWith("https://raid-helper.xyz/")), false);
    assert.deepEqual(api.writes.map((call) => call.body), [{ status: 3 }]);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
  });
});

test("an unavailable or widened dashboard audience does not strand the journaled native end", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await seedPriorCalendar(config, api, 2);
    const invalid = { ...audienceProof(), verified: false, roleNames: ["Pizza Core", "Trial"], roleIds: [ids.core, ids.duplicate] };
    await assert.rejects(() => applyRollover(config, AT, { ...api, audienceAudit: invalid }), (error) => error.code === "UNSIGNED_AUDIENCE_NOT_VERIFIED" && error.details.previousNativeCalendar.outcome === "completed" && error.details.forumUnchanged);
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.deepEqual(api.writes.map((call) => call.body), [{ status: 3 }]);
    assert.equal(api.threads.get(ids.previous).thread_metadata.locked, false);
    assert.equal(rhPosts(api).length, 0);
    assert.equal(nativePosts(api).length, 0);
  });
});

test("missing forum Manage Threads does not prevent an independently authorized native end", async () => {
  await isolated(async (config) => {
    const api = mock(config, { noManageThreads: true });
    await seedPriorCalendar(config, api, 2);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "MISSING_THREAD_PERMISSION" });
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.deepEqual(api.writes.map((call) => call.body), [{ status: 3 }]);
    assert.equal(api.threads.get(ids.previous).thread_metadata.archived, false);
  });
});

test("Manage Events alone may end an owned native card but cannot create its successor", async () => {
  await isolated(async (config) => {
    const api = mock(config, { noCreateEvents: true });
    api.roles.find((role) => role.id === ids.botRole).permissions = String((1n << 34n) | (1n << 33n));
    await seedPriorCalendar(config, api, 2);
    await assert.rejects(() => applyRollover(config, AT, api), { code: "MISSING_VOICE_EVENT_PERMISSION" });
    assert.equal(api.nativeEvents.get(ids.nativePrevious).status, 3);
    assert.deepEqual(api.writes.map((call) => call.body), [{ status: 3 }]);
  });
});

test("Manage Events can start the already-owned native card without granting creation", async () => {
  await isolated(async (config) => {
    const api = mock(config);
    await applyRollover(config, AT, api);
    api.roles.find((role) => role.id === ids.botRole).permissions = String((1n << 34n) | (1n << 33n));
    assert.equal((await startNative(config, NEXT_START, api)).outcome, "native-started");
    assert.equal(nativePosts(api).length, 1);
  });
});
