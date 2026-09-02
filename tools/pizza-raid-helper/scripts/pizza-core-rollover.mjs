#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SkillError, resolveLocalDateTime } from "./raid-helper-event.mjs";

const RH = "https://raid-helper.xyz/api/v4";
const DISCORD = "https://discord.com/api/v10";
const ADAPTER_VERSION = "pizza-core-rollover/10";
const DEFAULT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config.pizza-core.local.json");
const ID = /^\d{16,22}$/;
const ENV = /^[A-Z_][A-Z0-9_]*$/;
const SECRETS = new Set();
const REMINDER_MINUTES = 30;
const UNSIGNED_REMINDER_MESSAGE = "Pizza Core: the raid starts in 30 minutes. Please sign up or mark your availability in this post.";
const RATE_STATES = new WeakMap();
const MAX_RATE_WAIT_MS = 30_000;
const RATE_MARGIN_MS = 100;
const ROLE_LIMITS = Object.freeze({ Tanks: 2, Melee: 8, Ranged: 10, Healers: 5 });
const PERMISSIONS = Object.freeze({ administrator: 1n << 3n, view: 1n << 10n, history: 1n << 16n, connect: 1n << 20n, manageEvents: 1n << 33n, manageThreads: 1n << 34n, createEvents: 1n << 44n });
const CALENDAR_NOTICE = '"Interested" follows this Discord event; it does not sign you up or reserve a raid slot. Use the linked Raid-Helper post to choose your class/spec.';

function fail(code, message, details, exitCode = 2) {
  throw new SkillError(code, message, details, exitCode);
}

function string(value, field) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_CONFIG", `${field} must be a nonempty string.`, { field });
  return value.trim();
}

function snowflake(value, field) {
  const result = string(value, field);
  if (!ID.test(result)) fail("INVALID_CONFIG", `${field} must be a Discord ID stored as a string.`, { field });
  return result;
}

function envName(value, field) {
  const result = string(value, field);
  if (!ENV.test(result)) fail("INVALID_CONFIG", `${field} must be an environment-variable name.`, { field });
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function validateConfig(raw) {
  if (!raw || raw.version !== 1) fail("INVALID_CONFIG", "Pizza Core rollover configuration version must be 1.");
  const config = {
    version: 1,
    seriesId: string(raw.seriesId, "seriesId"),
    guildId: snowflake(raw.guildId, "guildId"),
    forum: { id: snowflake(raw.forum?.id, "forum.id"), name: string(raw.forum?.name, "forum.name") },
    managementBotUserId: snowflake(raw.managementBotUserId, "managementBotUserId"),
    raidHelperBotUserId: snowflake(raw.raidHelperBotUserId, "raidHelperBotUserId"),
    coreRole: { id: snowflake(raw.coreRole?.id, "coreRole.id"), name: string(raw.coreRole?.name, "coreRole.name") },
    tags: (raw.tags || []).map((tag, index) => ({ id: snowflake(tag.id, `tags[${index}].id`), name: string(tag.name, `tags[${index}].name`) })),
    event: {
      title: string(raw.event?.title, "event.title"),
      templateId: string(raw.event?.templateId, "event.templateId"),
      leaderId: snowflake(raw.event?.leaderId, "event.leaderId"),
      leaderDisplayName: string(raw.event?.leaderDisplayName, "event.leaderDisplayName"),
      description: typeof raw.event?.description === "string" ? raw.event.description : "",
      timeZone: string(raw.event?.timeZone, "event.timeZone"),
      weekday: raw.event?.weekday,
      time: string(raw.event?.time, "event.time"),
      durationMinutes: raw.event?.durationMinutes,
      roles: (raw.event?.roles || []).map((role) => ({
        name: string(role.name, "event.roles.name"),
        cName: string(role.cName || role.name, "event.roles.cName"),
        limit: role.limit,
        emoteId: snowflake(role.emoteId, "event.roles.emoteId"),
      })),
    },
    nativeCalendar: {
      enabled: raw.nativeCalendar?.enabled === true,
      voiceChannel: { id: snowflake(raw.nativeCalendar?.voiceChannel?.id, "nativeCalendar.voiceChannel.id"), name: string(raw.nativeCalendar?.voiceChannel?.name, "nativeCalendar.voiceChannel.name") },
      startGraceMinutes: raw.nativeCalendar?.startGraceMinutes,
    },
    rollover: {
      timeZone: string(raw.rollover?.timeZone, "rollover.timeZone"),
      weekday: raw.rollover?.weekday,
      time: string(raw.rollover?.time, "rollover.time"),
      maxLateMinutes: raw.rollover?.maxLateMinutes,
    },
    credentials: {
      raidHelperApiKeyEnv: envName(raw.credentials?.raidHelperApiKeyEnv, "credentials.raidHelperApiKeyEnv"),
      discordTokenEnv: envName(raw.credentials?.discordTokenEnv, "credentials.discordTokenEnv"),
    },
    statePath: resolve(string(raw.statePath, "statePath")),
    bootstrap: {
      date: string(raw.bootstrap?.date, "bootstrap.date"),
      eventId: snowflake(raw.bootstrap?.eventId, "bootstrap.eventId"),
      legacyPolicy: raw.bootstrap?.legacyPolicy === true,
    },
    activation: raw.activation && typeof raw.activation === "object" ? structuredClone(raw.activation) : {},
    unsignedAudiencePolicy: structuredClone(raw.unsignedAudiencePolicy ?? { mode: "fresh-dashboard" }),
  };
  const audience = config.unsignedAudiencePolicy;
  if (!audience || !["fresh-dashboard", "standing-core-only"].includes(audience.mode)) fail("INVALID_CONFIG", "Select a supported unsigned-audience policy.");
  if (audience.mode === "standing-core-only" && (audience.approvedBy !== "Neil Mitchell"
    || audience.guildId !== config.guildId || audience.coreRoleId !== config.coreRole.id
    || audience.acceptsUnmonitoredRoleChanges !== true || typeof audience.approvedAt !== "string"
    || !/(Z|[+-]\d\d:\d\d)$/.test(audience.approvedAt) || !Number.isFinite(Date.parse(audience.approvedAt)))) {
    fail("INVALID_CONFIG", "Standing Core-only policy requires Neil's explicit, dated approval for this exact guild and Core role, accepting unmonitored Raider-role changes.");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.seriesId)) fail("INVALID_CONFIG", "seriesId must be a short lowercase slug without spaces or line breaks.");
  if (!config.nativeCalendar.enabled) fail("INVALID_CONFIG", "This Pizza Core profile requires the management-bot native calendar companion.");
  if (config.nativeCalendar.voiceChannel.name !== "Raid Chat (Open Mic)" || config.nativeCalendar.startGraceMinutes !== 30) fail("INVALID_CONFIG", "The native voice event must use Raid Chat (Open Mic) with a 30-minute start recovery window.");
  if (config.event.title.length > 100) fail("INVALID_CONFIG", "The raid title must fit Discord's 100-character native event name limit.");
  if (config.coreRole.name !== "Pizza Core") fail("ROLE_BINDING_CHANGED", "This profile is bound to the current Pizza Core role; no retired-role fallback is allowed.");
  if (config.tags.length !== 2 || new Set(config.tags.map((tag) => tag.id)).size !== 2 || !["PizzaCore", "Event"].every((name) => config.tags.some((tag) => tag.name === name))) {
    fail("INVALID_CONFIG", "Exactly the PizzaCore and Event tag ID/name bindings are required.");
  }
  if (config.event.timeZone !== "America/New_York" || config.event.weekday !== 5 || config.event.time !== "22:00" || config.event.durationMinutes !== 240) {
    fail("SCHEDULE_CHANGED", "The approved Pizza Core event contract is Friday 22:00 America/New_York for 240 minutes.");
  }
  if (config.rollover.timeZone !== "America/Halifax" || config.rollover.weekday !== 6 || config.rollover.time !== "03:00" || !Number.isInteger(config.rollover.maxLateMinutes) || config.rollover.maxLateMinutes < 1 || config.rollover.maxLateMinutes > 1440) {
    fail("SCHEDULE_CHANGED", "Rollover must be Saturday 03:00 America/Halifax with a bounded lateness window of at most 24 hours.");
  }
  if (config.event.roles.length !== 4 || new Set(config.event.roles.map((role) => role.name)).size !== 4 || config.event.roles.some((role) => ROLE_LIMITS[role.name] !== role.limit)) {
    fail("COMPOSITION_CHANGED", "Pizza Core composition must be 2 Tanks, 8 Melee, 10 Ranged, and 5 Healers.");
  }
  resolveLocalDateTime({ date: config.bootstrap.date, time: config.event.time, timeZone: config.event.timeZone });
  if (new Date(`${config.bootstrap.date}T00:00:00Z`).getUTCDay() !== 5) fail("INVALID_CONFIG", "bootstrap.date must be a Friday.");
  return config;
}

export function configHash(configInput) {
  const config = validateConfig(configInput);
  const { activation, statePath, ...policy } = config;
  const contract = { adapterVersion: ADAPTER_VERSION, configuration: policy, payloadContract: buildPayload(config, config.bootstrap.date), nativeCalendarContract: calendarPayload(config, occurrence(config, config.bootstrap.date), "<verified-raid-helper-post-id>") };
  return createHash("sha256").update(JSON.stringify(canonical(contract))).digest("hex");
}

function localDate(epochMs, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDays(date, count) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function occurrence(config, date) {
  const start = resolveLocalDateTime({ date, time: config.event.time, timeZone: config.event.timeZone });
  const endEpoch = start.epochSeconds + config.event.durationMinutes * 60;
  const rolloverDate = addDays(date, 1);
  const boundary = resolveLocalDateTime({ date: rolloverDate, time: config.rollover.time, timeZone: config.rollover.timeZone });
  if (boundary.epochSeconds !== endEpoch) fail("TIMEZONE_ALIGNMENT_CHANGED", "The configured Halifax rollover no longer equals the raid's four-hour end.", { date, eventEnd: endEpoch, rollover: boundary.epochSeconds });
  return { key: `${config.seriesId}/${date}`, date, start, end: { epochSeconds: endEpoch, utc: new Date(endEpoch * 1000).toISOString(), local: `${rolloverDate} ${config.rollover.time}`, timeZone: config.rollover.timeZone } };
}

export function buildPayload(configInput, date) {
  const config = validateConfig(configInput);
  const target = occurrence(config, date);
  return {
    leaderId: config.event.leaderId,
    templateId: config.event.templateId,
    date: String(target.start.epochSeconds),
    time: String(target.start.epochSeconds),
    title: config.event.title,
    description: config.event.description,
    roles: structuredClone(config.event.roles),
    announcement: { channel: "unsignedping", time: REMINDER_MINUTES, message: UNSIGNED_REMINDER_MESSAGE },
    advancedSettings: {
      forum_tags: config.tags.map((tag) => tag.name).join(", "),
      allowed_roles: config.coreRole.name,
      banned_roles: "none",
      bench_overflow: true,
      queue_bench: false,
      lock_at_limit: false,
      duration: config.event.durationMinutes,
      limit: 25,
      deadline: "0",
      deletion: "false",
      delete_thread: false,
      disable_archiving: true,
      opt_out: "none",
      vacuum: false,
      mentions: config.coreRole.name,
      reminder: REMINDER_MINUTES,
      create_discordevent: false,
    },
  };
}

const forumPostUrl = (config, postId) => `https://discord.com/channels/${config.guildId}/${postId}`;
const calendarUrl = (config, id) => `https://discord.com/events/${config.guildId}/${id}`;
const calendarMarker = (target) => `Managed occurrence: ${target.key}`;

function reminderPlan(target, config) {
  const epochSeconds = target.start.epochSeconds - REMINDER_MINUTES * 60;
  return { provider: "Raid-Helper", minutesBeforeStart: REMINDER_MINUTES, epochSeconds, utc: new Date(epochSeconds * 1000).toISOString(), action: "unsignedping", destination: "Raid-Helper event-relative unsigned ping", audience: "Pizza Core members with no response", attendeeReminderEnabled: true, attendeeReminder: { minutesBeforeStart: REMINDER_MINUTES, audience: "Raid-Helper attendees", destination: "event channel", message: "Raid-Helper standard reminder text; no custom wording configured" }, requiredServerRaiderRoles: ["Pizza Core"], serverRaiderRolesRequireDashboardVerification: config.unsignedAudiencePolicy.mode === "fresh-dashboard", audiencePolicy: config.unsignedAudiencePolicy.mode, message: UNSIGNED_REMINDER_MESSAGE };
}

const audienceAuditPath = (config) => `${config.statePath}.audience.json`;

export function validateAudienceAudit(proof, configInput, at) {
  const config = validateConfig(configInput);
  const checkedAt = Date.parse(proof?.verifiedAt || "");
  const age = Date.parse(at) - checkedAt;
  const valid = proof?.version === 1 && proof.verified === true && proof.source === "raid-helper-dashboard"
    && proof.guildId === config.guildId && Array.isArray(proof.roleIds) && Array.isArray(proof.roleNames)
    && sameSet(proof.roleIds, [config.coreRole.id]) && sameSet(proof.roleNames, [config.coreRole.name])
    && typeof proof.verifiedAt === "string" && /(Z|[+-]\d\d:\d\d)$/.test(proof.verifiedAt)
    && Number.isFinite(age) && age >= 0 && age <= 15 * 60 * 1000;
  if (!valid) fail("UNSIGNED_AUDIENCE_NOT_VERIFIED", "A current official-dashboard check must show Pizza Core as the only Raid-Helper Raider role. Do not create a successor or change server settings from stale, missing, or wider-audience evidence.", { auditPath: audienceAuditPath(config), maxAgeMinutes: 15 }, 3);
  return { verified: true, source: proof.source, guildId: proof.guildId, roleIds: [...proof.roleIds], roleNames: [...proof.roleNames], verifiedAt: proof.verifiedAt };
}

async function readAudienceAudit(config, at, injectedProof) {
  if (config.unsignedAudiencePolicy.mode === "standing-core-only") {
    const approval = config.unsignedAudiencePolicy;
    if (Date.parse(approval.approvedAt) > Date.parse(at)) fail("UNSIGNED_AUDIENCE_NOT_VERIFIED", "Standing approval is dated after this run.");
    return { accepted: true, verified: false, source: "standing-administrative-approval", ...approval,
      reminderSender: "Raid-Helper", dashboardObservedThisRun: false };
  }
  let proof = injectedProof;
  if (proof === undefined) {
    try { proof = JSON.parse(await readFile(audienceAuditPath(config), "utf8")); }
    catch { fail("UNSIGNED_AUDIENCE_NOT_VERIFIED", "The current Raider-role dashboard audit is missing or unreadable. Record an actual fresh check; never refresh its timestamp without checking the dashboard.", { auditPath: audienceAuditPath(config) }, 3); }
  }
  return validateAudienceAudit(proof, config, at);
}

function calendarPayload(config, target, postReference) {
  const description = [
    `Raid leader: ${config.event.leaderDisplayName}\nRaid signup / live roster: ${forumPostUrl(config, postReference)}`,
    CALENDAR_NOTICE,
    target.date === config.bootstrap.date && config.bootstrap.legacyPolicy === true
      ? "Roster: 2 tanks, 8 melee, 10 ranged, 5 healers. Use the linked Raid-Helper post for this raid's signups and availability."
      : "Roster: 2 tanks, 8 melee, 10 ranged, 5 healers. Pizza Core members sign up normally; other members go to bench.",
    `${calendarMarker(target)}\nRaid-Helper post: ${postReference}`,
  ].join("\n\n");
  if (description.length > 1000) fail("INVALID_NATIVE_PAYLOAD", "The native calendar description exceeds Discord's 1000-character limit.");
  return {
    name: config.event.title,
    entity_type: 2,
    privacy_level: 2,
    channel_id: config.nativeCalendar.voiceChannel.id,
    scheduled_start_time: target.start.utc,
    scheduled_end_time: target.end.utc,
    entity_metadata: null,
    description,
  };
}

export function buildNativePayload(configInput, date, postId) {
  const config = validateConfig(configInput);
  return calendarPayload(config, occurrence(config, date), snowflake(postId, "nativeCalendar.raidHelperPostId"));
}

export function buildPlan(configInput, at = new Date().toISOString(), { preview = false } = {}) {
  const config = validateConfig(configInput);
  const now = Date.parse(at);
  if (!Number.isFinite(now) || !/(Z|[+-]\d\d:\d\d)$/.test(at)) fail("INVALID_TIME", "--at must be an ISO timestamp with an explicit offset.");
  let date = localDate(now, config.event.timeZone);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  date = addDays(date, -((weekday - config.event.weekday + 7) % 7));
  let previous = occurrence(config, date);
  if (previous.start.epochSeconds * 1000 > now) previous = occurrence(config, addDays(date, -7));
  const latest = previous;
  const isDue = now >= latest.end.epochSeconds * 1000 && now <= (latest.end.epochSeconds + config.rollover.maxLateMinutes * 60) * 1000;
  if (preview && !isDue && now > latest.end.epochSeconds * 1000) previous = occurrence(config, addDays(latest.date, 7));
  const next = occurrence(config, addDays(previous.date, 7));
  return {
    operation: "pizza-core-rollover",
    configHash: configHash(config),
    evaluatedAt: new Date(now).toISOString(),
    due: isDue && previous.date === latest.date,
    previewOnly: preview,
    order: ["verify-raid-helper-successor", "verify-native-calendar-successor", "lock-and-archive-predecessor"],
    previous: { ...previous, ...(previous.date === config.bootstrap.date ? { eventId: config.bootstrap.eventId, legacyPolicy: config.bootstrap.legacyPolicy } : {}) },
    next: { ...next, payload: buildPayload(config, next.date), reminder: { ...reminderPlan(next, config), ...(config.unsignedAudiencePolicy.mode === "fresh-dashboard" ? { audienceAuditPath: audienceAuditPath(config), audienceAuditMaxAgeMinutes: 15 } : {}) }, nativeCalendar: { postIdResolvedAfterCreation: true, payload: calendarPayload(config, next, "<new-raid-helper-post-id>") } },
    schedule: { raid: "Friday 22:00 America/New_York", durationMinutes: 240, reminder: "Friday 21:30 America/New_York / 22:30 America/Halifax", nativeStart: "Friday 23:00 America/Halifax", nativeStartGraceMinutes: config.nativeCalendar.startGraceMinutes, rollover: "Saturday 03:00 America/Halifax", maxLateMinutes: config.rollover.maxLateMinutes },
  };
}

function activationBlockers(config) {
  const a = config.activation;
  const blockers = [];
  if (a.configHash !== configHash(config)) blockers.push("activated configuration fingerprint is missing or stale");
  if (!ID.test(a.rolePolicyCanaryEventId || "")) blockers.push("controlled core/non-core signup canary has not been recorded");
  if (!ID.test(a.lifecycleCanaryThreadId || "")) blockers.push("lock-and-archive canary has not been recorded");
  if (!ID.test(a.nativeCalendarCanaryEventId || "") || a.nativeCalendarVerified !== true || a.nativeCalendarRetryVerified !== true || a.nativeCalendarLifecycleVerified !== true) blockers.push("native voice calendar create/read/adopt/start/end canary has not been verified");
  if (a.coreSignupVerified !== true || a.nonCoreBenchVerified !== true || a.lifecycleVerified !== true) blockers.push("live canary verification is incomplete");
  if (!Number.isFinite(Date.parse(a.verifiedAt || ""))) blockers.push("live canary verification timestamp is missing");
  return blockers;
}

function secret(name, required = true) {
  const value = process.env[name]?.trim();
  if (!value && required) fail("MISSING_CREDENTIAL", `Set ${name} in the private local environment file; do not put it in the skill configuration.`, { environmentVariable: name });
  if (value) SECRETS.add(value);
  return value;
}

function redact(value) {
  if (typeof value === "string") {
    let result = value;
    for (const token of SECRETS) result = result.split(token).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

function uncertainRequestError(url, method) {
  const error = new SkillError("NETWORK_OUTCOME_UNCERTAIN", "A provider request did not return a confirmed result.", { method, endpoint: new URL(url).pathname }, 3);
  error.uncertain = true;
  return error;
}

function rateContext(url, fetchImpl) {
  const parsed = new URL(url);
  if (parsed.origin !== "https://discord.com" || !parsed.pathname.startsWith("/api/v10/")) return null;
  if (!RATE_STATES.has(fetchImpl)) RATE_STATES.set(fetchImpl, { deadlines: new Map(), globalUntil: 0 });
  // The live canary showed the scheduled-event collection/item reads and
  // lifecycle writes sharing a cooldown. Group these conservatively per guild.
  const route = parsed.pathname.replace(/(\/guilds\/\d+\/scheduled-events)(?:\/\d+)?$/, "$1");
  return { state: RATE_STATES.get(fetchImpl), route };
}

function rateSeconds(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function saveRateDeadline(rate, seconds, now, global = false) {
  if (!rate || seconds === null) return;
  const deadline = now() + Math.ceil(seconds * 1000) + RATE_MARGIN_MS;
  rate.state.deadlines.set(rate.route, Math.max(rate.state.deadlines.get(rate.route) || 0, deadline));
  if (global) rate.state.globalUntil = Math.max(rate.state.globalUntil, deadline);
}

async function waitForRate(rate, now, sleep) {
  if (!rate) return;
  const wait = Math.max(rate.state.globalUntil, rate.state.deadlines.get(rate.route) || 0) - now();
  if (wait <= 0) return;
  if (wait > MAX_RATE_WAIT_MS) {
    const error = new SkillError("RATE_LIMIT_WAIT_EXCEEDED", "Discord requested a cooldown longer than this run will wait. Inspect the saved checkpoint before retrying.", { retryAfterSeconds: Math.ceil(wait / 1000), endpoint: rate.route }, 3);
    error.status = 429;
    error.uncertain = false;
    throw error;
  }
  await sleep(wait);
}

export async function providerRequest(url, { method = "GET", headers = {}, body, fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)) } = {}) {
  const rate = rateContext(url, fetchImpl);
  for (let retry = 0; ; retry++) {
    await waitForRate(rate, now, sleep);
    let response;
    try {
      response = await fetchImpl(url, { method, headers: { Accept: "application/json", "User-Agent": "PizzaCoreRollover/1.0", ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch {
      throw uncertainRequestError(url, method);
    }
    const header = (name) => response.headers?.get?.(name);
    if (header("x-ratelimit-remaining") === "0") saveRateDeadline(rate, rateSeconds(header("x-ratelimit-reset-after")), now);
    let text;
    try { text = await response.text(); } catch { throw uncertainRequestError(url, method); }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      const retryAfter = rateSeconds(payload?.retry_after) ?? rateSeconds(header("retry-after"));
      if (rate && response.status === 429) {
        saveRateDeadline(rate, retryAfter, now, payload?.global === true);
        // Only reads may be retried here. Mutation retries must first reconcile
        // their durable intent and the provider's actual event/thread state.
        if (method === "GET" && retry < 2 && retryAfter !== null) continue;
      }
      const reason = typeof payload?.message === "string" ? payload.message : typeof payload?.reason === "string" ? payload.reason : "Request rejected";
      const error = new SkillError("PROVIDER_HTTP_ERROR", `${new URL(url).hostname} returned HTTP ${response.status}: ${redact(reason).slice(0, 200)}`, { status: response.status, endpoint: new URL(url).pathname, ...(response.status === 429 && retryAfter !== null ? { retryAfterSeconds: retryAfter } : {}) }, response.status >= 500 || response.status === 429 ? 3 : 2);
      error.status = response.status;
      error.uncertain = response.status >= 500;
      throw error;
    }
    return payload;
  }
}

const request = providerRequest;

const discordGet = (path, token, fetchImpl) => request(`${DISCORD}${path}`, { headers: { Authorization: `Bot ${token}` }, fetchImpl });
const rhEvent = (id, fetchImpl) => request(`${RH}/events/${id}`, { fetchImpl });
const eventId = (event) => String(event?.id ?? event?.eventId ?? event?.messageId ?? "");
const eventStart = (event) => Number(event?.startTime ?? event?.start_time);
const eventChannel = (event) => String(event?.channelId ?? event?.channel_id ?? "");
const list = (value) => Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
const bool = (value) => value === true || value === "true" || value === 1 || value === "1";
const sameSet = (left, right) => left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length && left.every((item) => right.includes(item));

function guildPermissionBits(guildId, roles, member) {
  const memberRoles = new Set(member.roles || []);
  let bits = BigInt(roles.find((role) => role.id === guildId)?.permissions || 0);
  for (const role of roles) if (memberRoles.has(role.id)) bits |= BigInt(role.permissions || 0);
  return bits;
}

function permissionFlags(bits) {
  return Object.fromEntries(Object.entries(PERMISSIONS).map(([name, mask]) => [name, Boolean(bits & PERMISSIONS.administrator) || Boolean(bits & mask)]));
}

export function guildPermissions(guildId, roles, member) {
  return permissionFlags(guildPermissionBits(guildId, roles, member));
}

export function effectivePermissions(guildId, roles, member, channel) {
  const memberRoles = new Set(member.roles || []);
  let bits = guildPermissionBits(guildId, roles, member);
  if (!(bits & PERMISSIONS.administrator)) {
    const overwrites = channel.permission_overwrites || [];
    const everyone = overwrites.find((overwrite) => overwrite.id === guildId && Number(overwrite.type) === 0);
    if (everyone) bits = (bits & ~BigInt(everyone.deny || 0)) | BigInt(everyone.allow || 0);
    let allow = 0n, deny = 0n;
    for (const overwrite of overwrites) if (Number(overwrite.type) === 0 && memberRoles.has(overwrite.id)) { allow |= BigInt(overwrite.allow || 0); deny |= BigInt(overwrite.deny || 0); }
    bits = (bits & ~deny) | allow;
    const personal = overwrites.find((overwrite) => Number(overwrite.type) === 1 && overwrite.id === member.user?.id);
    if (personal) bits = (bits & ~BigInt(personal.deny || 0)) | BigInt(personal.allow || 0);
  }
  return permissionFlags(bits);
}

async function nativeContext(config, token, fetchImpl) {
  const [me, roles, voice] = await Promise.all([
    discordGet("/users/@me", token, fetchImpl),
    discordGet(`/guilds/${config.guildId}/roles`, token, fetchImpl),
    discordGet(`/channels/${config.nativeCalendar.voiceChannel.id}`, token, fetchImpl),
  ]);
  if (me.id !== config.managementBotUserId) fail("BOT_IDENTITY_CHANGED", "The Discord token does not belong to the configured management bot.");
  if (voice.id !== config.nativeCalendar.voiceChannel.id || String(voice.guild_id) !== config.guildId || voice.type !== 2 || voice.name !== config.nativeCalendar.voiceChannel.name) fail("VOICE_CHANNEL_DRIFT", "The pinned Raid Chat (Open Mic) voice channel is missing, renamed, or changed.", { id: voice.id, name: voice.name, type: voice.type });
  const member = await discordGet(`/guilds/${config.guildId}/members/${me.id}`, token, fetchImpl);
  return { roles, member, voice, voicePermissions: effectivePermissions(config.guildId, roles, member, voice), guildPermissions: guildPermissions(config.guildId, roles, member), bot: { id: me.id, name: me.username } };
}

async function context(config, token, fetchImpl, existingNativeContext) {
  const base = existingNativeContext || await nativeContext(config, token, fetchImpl);
  const { roles, member } = base;
  const forum = await discordGet(`/channels/${config.forum.id}`, token, fetchImpl);
  if (forum.id !== config.forum.id || String(forum.guild_id) !== config.guildId || forum.type !== 15 || forum.name !== config.forum.name) fail("FORUM_DRIFT", "The configured raid-signups forum identity has changed.", { id: forum.id, name: forum.name, type: forum.type });
  const coreRole = roles.find((role) => role.id === config.coreRole.id);
  if (!coreRole || coreRole.name !== config.coreRole.name || roles.filter((role) => role.name === coreRole.name).length !== 1) fail("CORE_ROLE_DRIFT", "The pinned Pizza Core role ID/name is missing, renamed, or ambiguous. No fallback role will be used.");
  for (const expected of config.tags) {
    const tags = forum.available_tags || [];
    const actual = tags.find((tag) => tag.id === expected.id);
    if (!actual || actual.name !== expected.name || tags.filter((tag) => tag.name === expected.name).length !== 1) fail("FORUM_TAG_DRIFT", "A pinned forum tag ID/name is missing, renamed, or ambiguous.", { expected });
  }
  return { ...base, forum, coreRole, permissions: effectivePermissions(config.guildId, roles, member, forum) };
}

function requireVoicePermissions(live, { creation = true } = {}) {
  const canManage = live.voicePermissions.createEvents || (!creation && live.voicePermissions.manageEvents);
  if (!live.voicePermissions.view || !live.voicePermissions.connect || !canManage) fail("MISSING_VOICE_EVENT_PERMISSION", `The management bot needs View Channel, Connect, and ${creation ? "Create Events" : "Create Events or Manage Events"} on Raid Chat (Open Mic).`, { permissions: live.voicePermissions });
}

function arrayFrom(payload, names) {
  if (Array.isArray(payload)) return payload;
  for (const name of names) if (Array.isArray(payload?.[name])) return payload[name];
  fail("UNEXPECTED_PROVIDER_RESPONSE", "Raid-Helper returned an unrecognized event-list shape.");
}

async function candidates(config, target, apiKey, token, fetchImpl) {
  const found = new Map();
  const seenRows = new Set();
  for (let page = 1; page <= 10; page++) {
    // Forum events report their thread ID as channelId. A parent-forum
    // ChannelFilter could hide them, so filter by exact time and verify parent
    // ownership through Discord before adopting any candidate.
    const payload = await request(`${RH}/servers/${config.guildId}/events`, { headers: { Authorization: apiKey, Page: String(page), IncludeSignUps: "false", StartTimeFilter: String(target.start.epochSeconds - 1), EndTimeFilter: String(target.start.epochSeconds + 1) }, fetchImpl });
    const rows = arrayFrom(payload, ["postedEvents", "events"]);
    if (!rows.length) return [...found.values()];
    let freshRows = 0;
    for (const row of rows) {
      const id = eventId(row);
      if (!ID.test(id)) fail("MISSING_EVENT_ID", "Raid-Helper listed an event without a valid ID.");
      if (!seenRows.has(id)) { seenRows.add(id); freshRows++; }
      if (eventStart(row) !== target.start.epochSeconds) continue;
      if (found.has(id)) continue;
      let thread;
      try { thread = await discordGet(`/channels/${id}`, token, fetchImpl); } catch (error) {
        // A normal text-channel event's message ID is not a channel ID.
        if (error.status === 404 && eventChannel(row) !== id && row.channelType !== "post") continue;
        throw error;
      }
      // Retain the completed, explicitly recorded canary as history without
      // treating its placeholder Friday as a production occurrence. A live,
      // renamed, foreign-owned, or unrecorded post remains a conflict.
      const retiredCanary = id === config.activation.rolePolicyCanaryEventId
        && id === config.activation.lifecycleCanaryThreadId
        && row.title === `TEST ONLY - ${config.event.title}`
        && thread.owner_id === config.raidHelperBotUserId
        && thread.name === row.title
        && thread.thread_metadata?.archived === true
        && thread.thread_metadata?.locked === true;
      if (thread.parent_id === config.forum.id && !retiredCanary) found.set(id, row);
    }
    if (page > 1 && !freshRows) fail("EVENT_PAGINATION_UNCERTAIN", "Raid-Helper repeated a nonempty event-list page. Do not treat an incomplete lookup as proof of absence.");
    if (found.size > 1) return [...found.values()];
  }
  fail("EVENT_PAGINATION_LIMIT", "The narrow occurrence lookup exceeded its safety bound.");
}

async function assertNoNativeRecurrence(config, apiKey, fetchImpl) {
  const payload = await request(`${RH}/servers/${config.guildId}/scheduledevents`, { headers: { Authorization: apiKey }, fetchImpl });
  const rows = arrayFrom(payload, ["scheduledEvents", "events"]);
  const conflicting = rows.filter((event) => event.title === config.event.title || (eventChannel(event) === config.forum.id && list(event.advancedSettings?.forum_tags).includes("PizzaCore")));
  if (conflicting.length) fail("COMPETING_RECURRENCE", "A Raid-Helper scheduled event also owns this Pizza Core series. Do not run two creators.", { eventIds: conflicting.map(eventId) });
}

export function eventMismatches(event, configInput, target, { policy = true } = {}) {
  const config = validateConfig(configInput);
  const mismatch = [];
  if (String(event.serverId) !== config.guildId) mismatch.push("serverId");
  if (![config.forum.id, eventId(event)].includes(eventChannel(event))) mismatch.push("channelId");
  if (eventStart(event) !== target.start.epochSeconds) mismatch.push("startTime");
  if (event.title !== config.event.title) mismatch.push("title");
  if (String(event.templateId) !== config.event.templateId) mismatch.push("templateId");
  if (String(event.leaderId) !== config.event.leaderId) mismatch.push("leaderId");
  const roles = event.roles || [];
  // The stock WotLK template adds an unlimited, hidden DPS aggregate while
  // rendering the four requested composition buckets. Its API edits merge
  // role limits rather than replacing the template's role definitions.
  const extraRoles = roles.filter((role) => !config.event.roles.some((expected) => expected.name === role.name));
  const knownDpsAggregate = config.event.templateId === "wowwotlk" && extraRoles.length === 1 && extraRoles[0].name === "Dps" && extraRoles[0].cName === "Dps" && Number(extraRoles[0].limit) === 999 && String(extraRoles[0].emoteId) === "592440132129521664";
  if (roles.length !== config.event.roles.length + (knownDpsAggregate ? 1 : 0)) mismatch.push("roles.count");
  for (const expected of config.event.roles) {
    const actual = roles.filter((role) => role.name === expected.name);
    if (actual.length !== 1 || Number(actual[0].limit) !== expected.limit || String(actual[0].emoteId) !== expected.emoteId) mismatch.push(`roles.${expected.name}`);
  }
  if (policy) {
    const advanced = event.advancedSettings || {};
    const expected = buildPayload(config, target.date).advancedSettings;
    if (!sameSet(list(advanced.forum_tags), config.tags.map((tag) => tag.name))) mismatch.push("advancedSettings.forum_tags");
    if (!sameSet(list(advanced.allowed_roles), [config.coreRole.name])) mismatch.push("advancedSettings.allowed_roles");
    if (!sameSet(list(advanced.banned_roles), ["none"])) mismatch.push("advancedSettings.banned_roles");
    for (const key of ["bench_overflow", "queue_bench", "lock_at_limit", "delete_thread", "disable_archiving", "vacuum", "create_discordevent"]) {
      if (![true, false, "true", "false", 1, 0, "1", "0"].includes(advanced[key]) || bool(advanced[key]) !== expected[key]) mismatch.push(`advancedSettings.${key}`);
    }
    for (const key of ["duration", "limit"]) if (Number(advanced[key]) !== expected[key]) mismatch.push(`advancedSettings.${key}`);
    if (![REMINDER_MINUTES, String(REMINDER_MINUTES)].includes(advanced.reminder)) mismatch.push("advancedSettings.reminder");
    if (!Array.isArray(event.announcements) || event.announcements.length !== 1) mismatch.push("announcements.count");
    else {
      const announcement = event.announcements[0];
      if (announcement?.channel !== "unsignedping") mismatch.push("announcements.channel");
      if (announcement?.time !== REMINDER_MINUTES && announcement?.time !== String(REMINDER_MINUTES)) mismatch.push("announcements.time");
      if (announcement?.message !== UNSIGNED_REMINDER_MESSAGE) mismatch.push("announcements.message");
    }
    if (String(advanced.deadline) !== "0") mismatch.push("advancedSettings.deadline");
    if (![false, "false"].includes(advanced.deletion)) mismatch.push("advancedSettings.deletion");
    if (advanced.opt_out !== "none") mismatch.push("advancedSettings.opt_out");
    if (!sameSet(list(advanced.mentions), [config.coreRole.name])) mismatch.push("advancedSettings.mentions");
    if (event.description !== config.event.description) mismatch.push("description");
    if (Number(event.endTime) !== target.end.epochSeconds) mismatch.push("endTime");
  }
  return mismatch;
}

function discordMismatches(config, id, thread, starter, { openThread = false, policy = false } = {}) {
  const mismatch = [];
  if (thread.id !== id || thread.parent_id !== config.forum.id || thread.owner_id !== config.raidHelperBotUserId) mismatch.push("discord.threadIdentity");
  if (starter.author?.id !== config.raidHelperBotUserId) mismatch.push("discord.starterAuthor");
  if (!config.tags.every((tag) => (thread.applied_tags || []).includes(tag.id))) mismatch.push("discord.appliedTags");
  if (openThread && (thread.thread_metadata?.archived !== false || thread.thread_metadata?.locked !== false)) mismatch.push("discord.successorNotOpen");
  // Raid-Helper replaces the creation ping with the latest signup mention on
  // edits. The canary proves the initial ping; do not resend it or reject an
  // otherwise compliant event solely because the current role list is empty.
  // The persisted advancedSettings.mentions contract remains mandatory.
  const roleMentions = starter.mention_roles;
  if (policy && (starter.mention_everyone !== false || !Array.isArray(roleMentions) || roleMentions.length > 1 || roleMentions.some((roleId) => String(roleId) !== config.coreRole.id))) mismatch.push("discord.coreRolePing");
  return mismatch;
}

async function verify(config, target, id, token, fetchImpl, { policy = true, openThread = false } = {}) {
  const event = await rhEvent(id, fetchImpl);
  const mismatch = eventMismatches(event, config, target, { policy });
  if (eventId(event) !== id) mismatch.push("eventId");
  const [thread, starter] = await Promise.all([
    discordGet(`/channels/${id}`, token, fetchImpl),
    discordGet(`/channels/${id}/messages/${id}`, token, fetchImpl),
  ]);
  mismatch.push(...discordMismatches(config, id, thread, starter, { openThread, policy }));
  if (mismatch.length) fail("EVENT_DRIFT", "The exact occurrence exists but does not match the expected contract. No duplicate or silent repair will be made.", { eventId: id, mismatches: mismatch }, 3);
  return { event, thread, url: `https://discord.com/channels/${config.guildId}/${id}` };
}

async function pollVerify(config, target, id, token, fetchImpl, sleep) {
  let lastError;
  for (const wait of [0, 1000, 2000, 4000]) {
    if (wait) await sleep(wait);
    try { return await verify(config, target, id, token, fetchImpl, { openThread: true }); } catch (error) {
      lastError = error;
      if (error.code !== "EVENT_DRIFT" && error.status !== 404) throw error;
    }
  }
  throw lastError;
}

export function nativeEventMismatches(event, configInput, target, postId, { allowedStatuses = [1] } = {}) {
  const config = validateConfig(configInput);
  const expected = buildNativePayload(config, target.date, postId);
  const mismatch = [];
  if (event.guild_id !== config.guildId) mismatch.push("guild_id");
  if (event.creator_id !== config.managementBotUserId) mismatch.push("creator_id");
  for (const field of ["name", "description", "entity_type", "privacy_level", "channel_id"]) if (event[field] !== expected[field]) mismatch.push(field);
  for (const field of ["scheduled_start_time", "scheduled_end_time"]) if (Date.parse(event[field]) !== Date.parse(expected[field])) mismatch.push(field);
  // Discord's live VOICE readback can normalize a null request to {}.
  // Accept only that empty-object form; populated metadata and arrays drift.
  const metadata = event.entity_metadata;
  if (metadata != null && !(typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length === 0)) mismatch.push("entity_metadata");
  if (event.recurrence_rule != null) mismatch.push("recurrence_rule");
  if (!allowedStatuses.includes(event.status)) mismatch.push("status");
  return mismatch;
}

async function nativeEvents(config, token, fetchImpl) {
  const rows = await discordGet(`/guilds/${config.guildId}/scheduled-events`, token, fetchImpl);
  if (!Array.isArray(rows)) fail("UNEXPECTED_NATIVE_RESPONSE", "Discord did not return a native event list. Absence cannot be inferred.");
  for (const row of rows) {
    const invalidFields = [];
    if (typeof row?.id !== "string" || !ID.test(row.id)) invalidFields.push("id");
    if (row?.guild_id !== config.guildId) invalidFields.push("guild_id");
    if (typeof row?.name !== "string" || !row.name.trim() || row.name.length > 100) invalidFields.push("name");
    if (row?.description != null && typeof row.description !== "string") invalidFields.push("description");
    if (typeof row?.scheduled_start_time !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(Z|[+-]\d{2}:\d{2})$/.test(row.scheduled_start_time) || !Number.isFinite(Date.parse(row.scheduled_start_time))) invalidFields.push("scheduled_start_time");
    if (![1, 2, 3, 4].includes(row?.status)) invalidFields.push("status");
    if (![1, 2, 3].includes(row?.entity_type)) invalidFields.push("entity_type");
    if (invalidFields.length) fail("UNEXPECTED_NATIVE_RESPONSE", "A native list entry is incomplete or malformed. It cannot establish absence or safe capacity.", { eventId: typeof row?.id === "string" ? row.id : undefined, invalidFields }, 3);
  }
  return rows;
}

function nativeMatches(event, config, target, postId, expectedId) {
  const lines = typeof event.description === "string" ? event.description.split(/\r?\n/) : [];
  return event.id === expectedId || lines.includes(calendarMarker(target)) ||
    (postId && lines.includes(`Raid-Helper post: ${postId}`)) ||
    (event.name === config.event.title && Date.parse(event.scheduled_start_time) === target.start.epochSeconds * 1000);
}

async function uniqueNative(config, target, postId, token, fetchImpl, expectedId, { capacity = true } = {}) {
  if (expectedId && !ID.test(expectedId)) fail("NATIVE_CHECKPOINT_INVALID", "The journaled native event ID is invalid.");
  const rows = await nativeEvents(config, token, fetchImpl);
  const matches = rows.filter((event) => nativeMatches(event, config, target, postId, expectedId));
  if (matches.length > 1) fail("DUPLICATE_NATIVE_EVENT", "Multiple native events could own this occurrence. No duplicate, repair, or deletion is allowed.", { occurrence: target.key, eventIds: matches.map((event) => event.id) }, 3);
  const id = matches[0]?.id;
  if (expectedId && id && id !== expectedId) fail("NATIVE_OCCURRENCE_ID_CHANGED", "The native event list conflicts with the saved occurrence ID.", { expectedId, actualId: id }, 3);
  if (id || expectedId) return id || expectedId;
  if (capacity && rows.filter((event) => [1, 2].includes(event.status)).length >= 100) fail("NATIVE_EVENT_CAPACITY", "Discord already has 100 scheduled/active events. No new signup post or ping will be created while native creation is unavailable.");
  return undefined;
}

async function verifyNative(config, target, postId, id, token, fetchImpl, options = {}) {
  let event;
  try { event = await discordGet(`/guilds/${config.guildId}/scheduled-events/${id}`, token, fetchImpl); } catch (error) {
    if (error.status === 404) fail("NATIVE_EVENT_MISSING", "The known native calendar event is missing or inaccessible. It will not be recreated automatically.", { eventId: id, occurrence: target.key }, 3);
    throw error;
  }
  const mismatches = nativeEventMismatches(event, config, target, postId, options);
  if (event.id !== id) mismatches.push("id");
  if (mismatches.length) fail("NATIVE_EVENT_DRIFT", "The native event differs from its bound raid occurrence. It will not be overwritten or duplicated.", { eventId: id, mismatches }, 3);
  return { event, url: calendarUrl(config, id) };
}

async function pollNativeVerify(config, target, postId, id, token, fetchImpl, sleep) {
  let lastError;
  for (const wait of [0, 1000, 2000, 4000]) {
    if (wait) await sleep(wait);
    try { return await verifyNative(config, target, postId, id, token, fetchImpl); } catch (error) {
      lastError = error;
      if (!["NATIVE_EVENT_DRIFT", "NATIVE_EVENT_MISSING"].includes(error.code)) throw error;
    }
  }
  throw lastError;
}

async function nativePreflight(config, target, postId, token, fetchImpl, checkpoint = {}) {
  // This runs before the first Raid-Helper POST as well as before native POST.
  // A marker without a verified signup counterpart is a conflict, not a reason
  // to manufacture a new post and rebind an existing calendar card.
  const id = await uniqueNative(config, target, postId, token, fetchImpl, checkpoint.eventId);
  if (id) {
    if (!postId) fail("ORPHAN_NATIVE_EVENT", "A native event already refers to this occurrence without a verified Raid-Helper successor. Inspect the pair before creating anything.", { eventId: id }, 3);
    await verifyNative(config, target, postId, id, token, fetchImpl);
  } else if (["create-intent", "create-uncertain"].includes(checkpoint.phase)) {
    fail("NATIVE_CREATE_OUTCOME_UNCERTAIN", "A prior native create intent has no reconciled event. Do not repeat POST.", { occurrence: target.key }, 3);
  }
  return id;
}

async function ensureNativeCalendar(config, plan, postId, token, fetchImpl, sleep, checkpoint, state) {
  const payload = buildNativePayload(config, plan.next.date, postId);
  const payloadHash = createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  const native = checkpoint.nativeCalendar ||= { phase: "planned", occurrenceKey: plan.next.key, raidHelperEventId: postId, payloadHash };
  if (native.occurrenceKey !== plan.next.key || native.raidHelperEventId !== postId || native.payloadHash !== payloadHash) fail("NATIVE_CHECKPOINT_CHANGED", "The native creation checkpoint belongs to a different payload or signup post.");
  let id = await nativePreflight(config, plan.next, postId, token, fetchImpl, native);
  let outcome = "adopted-existing";
  if (!id) {
    native.phase = "create-intent";
    native.intentAt = new Date().toISOString();
    await saveState(config, state);
    let created;
    let uncertain = false;
    try {
      created = await request(`${DISCORD}/guilds/${config.guildId}/scheduled-events`, { method: "POST", headers: { Authorization: `Bot ${token}`, "X-Audit-Log-Reason": encodeURIComponent(`Pizza Core calendar ${plan.next.date}; Raid-Helper ${postId}`) }, body: payload, fetchImpl });
    } catch (error) {
      if (!error.uncertain) { native.phase = "create-rejected"; await saveState(config, state); throw error; }
      uncertain = true;
    }
    id = ID.test(created?.id || "") ? created.id : undefined;
    if (!id) {
      for (const wait of [0, 1000, 2000, 4000]) {
        if (wait) await sleep(wait);
        id = await uniqueNative(config, plan.next, postId, token, fetchImpl);
        if (id) break;
      }
    }
    if (!id) {
      native.phase = "create-uncertain";
      await saveState(config, state);
      fail("NATIVE_CREATE_OUTCOME_UNCERTAIN", "Native calendar creation could not be reconciled. The signup successor is retained and the old forum stays open; do not POST again blindly.", { occurrence: plan.next.key }, 3);
    }
    outcome = uncertain ? "reconciled-after-uncertain-create" : "created";
  }
  native.eventId = id;
  await saveState(config, state);
  const verified = await pollNativeVerify(config, plan.next, postId, id, token, fetchImpl, sleep);
  native.phase = "verified";
  native.verifiedAt = new Date().toISOString();
  await saveState(config, state);
  return { id, outcome, verified };
}

function recordedPair(config, state, target, postId) {
  const cycles = Object.values(state.cycles).filter((cycle) => cycle.nextDate === target.date && cycle.nextEventId && cycle.nativeCalendar?.eventId);
  const identities = new Set(cycles.map((cycle) => `${cycle.nextEventId}/${cycle.nativeCalendar.eventId}`));
  if (identities.size > 1) fail("NATIVE_JOURNAL_CONFLICT", "The journal has conflicting signup/calendar pairs for this date.");
  const cycle = cycles[0];
  if (!cycle) return undefined;
  if (cycle.configHash !== configHash(config) || (postId && cycle.nextEventId !== postId) || cycle.nativeCalendar.occurrenceKey !== target.key || cycle.nativeCalendar.raidHelperEventId !== cycle.nextEventId) fail("NATIVE_JOURNAL_CONFLICT", "The recorded calendar pair no longer matches the activated occurrence.");
  return { cycle, postId: cycle.nextEventId, native: cycle.nativeCalendar };
}

async function transitionNative(config, target, pair, status, token, fetchImpl) {
  let patchError;
  try {
    await request(`${DISCORD}/guilds/${config.guildId}/scheduled-events/${pair.native.eventId}`, { method: "PATCH", headers: { Authorization: `Bot ${token}`, "X-Audit-Log-Reason": encodeURIComponent(`Pizza Core ${target.date}; native ${status === 2 ? "start" : "end"}`) }, body: { status }, fetchImpl });
  } catch (error) { patchError = error; }
  const actual = await verifyNative(config, target, pair.postId, pair.native.eventId, token, fetchImpl, { allowedStatuses: [1, 2, 3, 4] });
  if (actual.event.status !== status && ![3, 4].includes(actual.event.status)) {
    if (patchError) throw patchError;
    fail("NATIVE_STATUS_NOT_VERIFIED", "The requested native lifecycle transition was not confirmed. Inspect and retry this recorded event only.", { eventId: pair.native.eventId, expectedStatus: status, actualStatus: actual.event.status }, 3);
  }
  return actual;
}

async function endPredecessorCalendar(config, plan, previousId, state, token, fetchImpl) {
  const pair = recordedPair(config, state, plan.previous, previousId);
  if (!pair) return { outcome: "no-managed-calendar", status: null };
  await uniqueNative(config, plan.previous, previousId, token, fetchImpl, pair.native.eventId, { capacity: false });
  let actual = await verifyNative(config, plan.previous, previousId, pair.native.eventId, token, fetchImpl, { allowedStatuses: [1, 2, 3, 4] });
  let outcome = { 1: "never-started", 3: "already-completed", 4: "canceled-preserved" }[actual.event.status];
  if (actual.event.status === 2) {
    pair.native.lifecycle ||= {};
    pair.native.lifecycle.endIntentAt = new Date().toISOString();
    await saveState(config, state);
    actual = await transitionNative(config, plan.previous, pair, 3, token, fetchImpl);
    outcome = actual.event.status === 3 ? "completed" : "canceled-preserved";
    pair.native.lifecycle[actual.event.status === 3 ? "endVerifiedAt" : "terminalObservedAt"] = new Date().toISOString();
    await saveState(config, state);
  }
  return { eventId: pair.native.eventId, outcome, status: actual.event.status, url: actual.url };
}

export async function startNative(configInput, at, { fetchImpl = fetch } = {}) {
  const config = validateConfig(configInput);
  const now = Date.parse(at);
  if (!Number.isFinite(now) || !/(Z|[+-]\d\d:\d\d)$/.test(at)) fail("INVALID_TIME", "The calendar start clock must include an explicit offset.");
  const date = localDate(now, config.event.timeZone);
  const target = occurrence(config, date);
  const lateSeconds = now / 1000 - target.start.epochSeconds;
  if (new Date(`${date}T12:00:00Z`).getUTCDay() !== 5 || lateSeconds < 0 || lateSeconds > config.nativeCalendar.startGraceMinutes * 60) fail("OUTSIDE_NATIVE_START_WINDOW", "Native start is allowed only at Friday 22:00 Eastern or within its 30-minute recovery window.");
  const blockers = activationBlockers(config);
  if (blockers.length) fail("NOT_ACTIVATED", "The native start trigger remains paused until the live activation checks pass.", { blockers });
  const token = secret(config.credentials.discordTokenEnv);
  return withLock(config, async () => {
    const state = await readState(config);
    const pair = recordedPair(config, state, target);
    if (!pair) return { ok: true, outcome: "no-managed-native-event", date, reason: "No native event was created for this occurrence by this series. No legacy backfill or creation is allowed in start-native." };
    const live = await context(config, token, fetchImpl);
    requireVoicePermissions(live, { creation: false });
    // An explicitly journaled calendar may be paired with the pinned legacy
    // bootstrap post without rewriting its existing signup policy. Every
    // subsequent week's signup must still satisfy the full current policy.
    const legacyBootstrap = config.bootstrap.legacyPolicy === true
      && target.date === config.bootstrap.date && pair.postId === config.bootstrap.eventId;
    await verify(config, target, pair.postId, token, fetchImpl, { openThread: true, policy: !legacyBootstrap });
    await uniqueNative(config, target, pair.postId, token, fetchImpl, pair.native.eventId, { capacity: false });
    let actual = await verifyNative(config, target, pair.postId, pair.native.eventId, token, fetchImpl, { allowedStatuses: [1, 2, 3, 4] });
    if (actual.event.status !== 1) return { ok: true, outcome: actual.event.status === 2 ? "verified-noop" : "terminal-preserved", requiresAttention: actual.event.status !== 2, nativeCalendar: { eventId: pair.native.eventId, status: actual.event.status, url: actual.url }, date };
    pair.native.lifecycle ||= {};
    pair.native.lifecycle.startIntentAt = new Date().toISOString();
    await saveState(config, state);
    actual = await transitionNative(config, target, pair, 2, token, fetchImpl);
    pair.native.lifecycle[actual.event.status === 2 ? "startVerifiedAt" : "terminalObservedAt"] = new Date().toISOString();
    await saveState(config, state);
    return { ok: true, outcome: actual.event.status === 2 ? "native-started" : "terminal-preserved", requiresAttention: actual.event.status !== 2, nativeCalendar: { eventId: pair.native.eventId, status: actual.event.status, url: actual.url }, date };
  });
}

async function readState(config) {
  try {
    const state = JSON.parse(await readFile(config.statePath, "utf8"));
    if (state.version !== 1 || state.seriesId !== config.seriesId || !state.cycles) fail("STATE_MISMATCH", "The local rollover journal does not match this series.");
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, seriesId: config.seriesId, cycles: {} };
  }
}

async function saveState(config, state) {
  await mkdir(dirname(config.statePath), { recursive: true });
  const temp = `${config.statePath}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temp, config.statePath);
}

async function withLock(config, callback) {
  await mkdir(dirname(config.statePath), { recursive: true });
  const path = `${config.statePath}.lock`;
  let handle;
  try { handle = await open(path, "wx", 0o600); } catch (error) {
    if (error.code === "EEXIST") fail("ROLLOVER_LOCKED", "Another run or an interrupted run owns the local lock. Inspect it before any recovery; do not run concurrently.", { lockPath: path });
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), seriesId: config.seriesId }));
    return await callback();
  } finally {
    await handle.close();
    await unlink(path);
  }
}

async function uniqueCandidate(config, target, apiKey, token, fetchImpl, expectedId) {
  const matches = await candidates(config, target, apiKey, token, fetchImpl);
  if (matches.length > 1) fail("DUPLICATE_OCCURRENCE", "Multiple events occupy the exact forum/start instant. No event will be created or closed.", { eventIds: matches.map(eventId), occurrence: target.key }, 3);
  const id = matches.length ? eventId(matches[0]) : undefined;
  if (expectedId && id && id !== expectedId) fail("OCCURRENCE_ID_CHANGED", "The journaled occurrence ID conflicts with Raid-Helper's event list.", { expectedId, actualId: id }, 3);
  return id || expectedId;
}

function knownPredecessor(plan, state) {
  const checkpoint = state.cycles[plan.previous.date];
  const priorIds = [...new Set(Object.values(state.cycles).filter((cycle) => cycle.nextDate === plan.previous.date && cycle.nextEventId).map((cycle) => cycle.nextEventId))];
  const allIds = [...new Set([checkpoint?.previousEventId, plan.previous.eventId, ...priorIds].filter(Boolean))];
  if (allIds.length > 1) fail("JOURNAL_OCCURRENCE_CONFLICT", "The journal contains conflicting IDs for the predecessor occurrence.", { eventIds: allIds });
  return allIds[0];
}

async function createSuccessor(config, plan, apiKey, token, fetchImpl, sleep, checkpoint) {
  const existingId = await uniqueCandidate(config, plan.next, apiKey, token, fetchImpl, checkpoint.nextEventId);
  if (existingId) return { id: existingId, outcome: "adopted-existing", verified: await pollVerify(config, plan.next, existingId, token, fetchImpl, sleep) };
  if (checkpoint.phase === "create-intent" || checkpoint.phase === "create-uncertain") fail("CREATE_OUTCOME_UNCERTAIN", "A prior create intent has no uniquely reconciled event. Do not POST again until the outcome is resolved.", { occurrence: plan.next.key }, 3);
  return null;
}

export async function applyRollover(configInput, at, { fetchImpl = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), audienceAudit } = {}) {
  const config = validateConfig(configInput);
  const plan = buildPlan(config, at);
  if (!plan.due) fail("OUTSIDE_ROLLOVER_WINDOW", "This run is not at the end of the Friday raid or within its bounded recovery window. Use a read-only plan; do not backfill past raids.", { evaluatedAt: plan.evaluatedAt, expectedEnd: plan.previous.end.utc });
  const blockers = activationBlockers(config);
  if (blockers.length) fail("NOT_ACTIVATED", "Production rollover is paused until its live activation checks pass.", { blockers });
  const apiKey = secret(config.credentials.raidHelperApiKeyEnv, false);
  const token = secret(config.credentials.discordTokenEnv);
  return withLock(config, async () => {
    const state = await readState(config);
    const checkpoint = state.cycles[plan.previous.date] || { phase: "planned", configHash: plan.configHash, previousDate: plan.previous.date, nextDate: plan.next.date };
    if (checkpoint.configHash !== plan.configHash) fail("CHECKPOINT_CONFIG_CHANGED", "This cycle began under a different configuration. Review the partial result before continuing.");
    const knownPreviousId = knownPredecessor(plan, state);
    const priorPair = recordedPair(config, state, plan.previous, knownPreviousId);
    if (!priorPair && !apiKey) secret(config.credentials.raidHelperApiKeyEnv);
    state.cycles[plan.previous.date] = checkpoint;
    let previousCalendar = { outcome: "no-managed-calendar", status: null };
    let nativeEndError;
    let nativeLive;
    if (priorPair) {
      // Native ending is a timed action on an already-recorded pair. RH key,
      // service availability, and forum permissions must not keep it active.
      try {
        nativeLive = await nativeContext(config, token, fetchImpl);
        requireVoicePermissions(nativeLive, { creation: false });
        previousCalendar = await endPredecessorCalendar(config, plan, knownPreviousId, state, token, fetchImpl);
      } catch (error) {
        nativeEndError = { code: error.code || "NATIVE_END_FAILED", message: error instanceof SkillError ? error.message : "The prior native event could not be ended and verified." };
        previousCalendar = { outcome: "end-pending", error: nativeEndError };
      }
    }
    checkpoint.previousCalendar = previousCalendar;
    await saveState(config, state);
    let previousId;
    try {
      if (!apiKey) secret(config.credentials.raidHelperApiKeyEnv);
      const live = await context(config, token, fetchImpl, nativeLive);
      if (!live.permissions.view || !live.permissions.history || !live.permissions.manageThreads) fail("MISSING_THREAD_PERMISSION", "The management bot needs View Channel, Read Message History, and Manage Threads on raid-signups before signup creation or forum closure.", { permissions: live.permissions });
      requireVoicePermissions(live);
      // An unavailable/wider RH dashboard audience must block creation, but
      // never strand the independently journaled native ending above.
      checkpoint.unsignedAudienceAudit = await readAudienceAudit(config, plan.evaluatedAt, audienceAudit);
      await assertNoNativeRecurrence(config, apiKey, fetchImpl);
      previousId = await uniqueCandidate(config, plan.previous, apiKey, token, fetchImpl, knownPreviousId);
      if (!previousId) fail("PREDECESSOR_NOT_FOUND", "No exact just-finished Pizza Core signup occurrence was found. No post will be created or closed.", { occurrence: plan.previous.key });
      await verify(config, plan.previous, previousId, token, fetchImpl, { policy: false });
    } catch (error) {
      error.details = { ...error.details, previousNativeCalendar: previousCalendar, forumUnchanged: true };
      throw error;
    }
    checkpoint.previousEventId = previousId;
    let successor = await createSuccessor(config, plan, apiKey, token, fetchImpl, sleep, checkpoint);
    await nativePreflight(config, plan.next, successor?.id, token, fetchImpl, checkpoint.nativeCalendar);
    if (!successor) {
      checkpoint.phase = "create-intent";
      checkpoint.updatedAt = new Date().toISOString();
      await saveState(config, state);
      let created;
      let uncertain = false;
      try {
        created = await request(`${RH}/servers/${config.guildId}/channels/${config.forum.id}/event`, { method: "POST", headers: { Authorization: apiKey }, body: plan.next.payload, fetchImpl });
      } catch (error) {
        if (!error.uncertain) { checkpoint.phase = "create-rejected"; await saveState(config, state); throw error; }
        uncertain = true;
      }
      let nextId = eventId(created?.event || created);
      if (!ID.test(nextId)) {
        for (const wait of [0, 1000, 2000, 4000]) {
          if (wait) await sleep(wait);
          nextId = await uniqueCandidate(config, plan.next, apiKey, token, fetchImpl);
          if (nextId) break;
        }
      }
      if (!nextId) {
        checkpoint.phase = "create-uncertain";
        await saveState(config, state);
        fail("CREATE_OUTCOME_UNCERTAIN", "Raid-Helper creation could not be reconciled. The predecessor remains untouched; do not retry POST blindly.", { occurrence: plan.next.key }, 3);
      }
      checkpoint.nextEventId = nextId;
      await saveState(config, state);
      successor = { id: nextId, outcome: uncertain ? "reconciled-after-uncertain-create" : "created", verified: await pollVerify(config, plan.next, nextId, token, fetchImpl, sleep) };
    }
    checkpoint.nextEventId = successor.id;
    checkpoint.phase = "successor-verified";
    checkpoint.updatedAt = new Date().toISOString();
    await saveState(config, state);
    await uniqueCandidate(config, plan.next, apiKey, token, fetchImpl, successor.id);
    const nativeSuccessor = await ensureNativeCalendar(config, plan, successor.id, token, fetchImpl, sleep, checkpoint, state);
    await uniqueCandidate(config, plan.next, apiKey, token, fetchImpl, successor.id);
    await verify(config, plan.next, successor.id, token, fetchImpl, { openThread: true });
    await uniqueNative(config, plan.next, successor.id, token, fetchImpl, nativeSuccessor.id);
    await verifyNative(config, plan.next, successor.id, nativeSuccessor.id, token, fetchImpl);
    const previous = await verify(config, plan.previous, previousId, token, fetchImpl, { policy: false });
    const alreadyClosed = previous.thread.thread_metadata?.archived === true && previous.thread.thread_metadata?.locked === true;
    if (!alreadyClosed) {
      checkpoint.phase = "close-pending";
      await saveState(config, state);
      try {
        await request(`${DISCORD}/channels/${previousId}`, { method: "PATCH", headers: { Authorization: `Bot ${token}`, "X-Audit-Log-Reason": encodeURIComponent(`Pizza Core rollover ${plan.previous.date}; successor ${successor.id} verified`) }, body: { archived: true, locked: true }, fetchImpl });
      } catch (error) {
        if (!error.uncertain) {
          error.details = { ...error.details, phase: "close-pending", previousId, nextId: successor.id };
          throw error;
        }
      }
    }
    const closed = await discordGet(`/channels/${previousId}`, token, fetchImpl);
    if (closed.thread_metadata?.archived !== true || closed.thread_metadata?.locked !== true) fail("CLOSE_NOT_VERIFIED", "The successor is available, but the predecessor lock/archive was not verified. Retry only after inspecting this partial cycle.", { previousId, nextId: successor.id }, 3);
    checkpoint.phase = nativeEndError ? "native-end-pending" : "complete";
    checkpoint.updatedAt = new Date().toISOString();
    await saveState(config, state);
    const warnings = [];
    if (["never-started", "canceled-preserved"].includes(previousCalendar.outcome)) warnings.push(`Previous native calendar: ${previousCalendar.outcome}; it was preserved, not restarted or recreated.`);
    if (nativeEndError) warnings.push("The successor pair and old forum closure are verified, but the prior native end still needs recovery.");
    const noChange = alreadyClosed && successor.outcome === "adopted-existing" && nativeSuccessor.outcome === "adopted-existing" && previousCalendar.outcome !== "completed";
    return { ok: !nativeEndError, outcome: nativeEndError ? "rolled-over-native-end-pending" : noChange ? "verified-noop" : "rolled-over", successorOutcome: successor.outcome, nativeSuccessorOutcome: nativeSuccessor.outcome, previous: { eventId: previousId, date: plan.previous.date, archived: true, locked: true, url: previous.url, nativeCalendar: previousCalendar }, next: { eventId: successor.id, date: plan.next.date, start: plan.next.start, end: plan.next.end, url: successor.verified.url, nativeCalendar: { eventId: nativeSuccessor.id, url: nativeSuccessor.verified.url, voiceChannel: config.nativeCalendar.voiceChannel } }, verification: { raidHelper: "passed", discord: "passed", nativeCalendar: "passed", journal: checkpoint.phase }, warnings };
  });
}

export async function audit(configInput, at, { fetchImpl = fetch, audienceAudit } = {}) {
  const config = validateConfig(configInput);
  const token = secret(config.credentials.discordTokenEnv);
  const apiKey = secret(config.credentials.raidHelperApiKeyEnv, false);
  const live = await context(config, token, fetchImpl);
  const plan = buildPlan(config, at, { preview: true });
  const state = await readState(config);
  const calendarEvents = await nativeEvents(config, token, fetchImpl);
  let unsignedAudience;
  try { unsignedAudience = { ...(await readAudienceAudit(config, plan.evaluatedAt, audienceAudit)), auditPath: audienceAuditPath(config) }; }
  catch (error) { unsignedAudience = { verified: false, code: error.code, message: error.message, auditPath: audienceAuditPath(config) }; }
  let currentId = knownPredecessor(plan, state);
  let nativeRecurrence = "not-checked-missing-api-key";
  if (apiKey) {
    await assertNoNativeRecurrence(config, apiKey, fetchImpl);
    nativeRecurrence = "no-competing-schedule-found";
    currentId = await uniqueCandidate(config, plan.previous, apiKey, token, fetchImpl, currentId);
  }
  let currentEvent = { date: plan.previous.date, status: "not-located", reason: apiKey ? "No exact occurrence was found." : "No journaled occurrence ID is available and the Raid-Helper API key is missing." };
  if (currentId) {
    const current = await rhEvent(currentId, fetchImpl);
    const [currentThread, starter] = await Promise.all([
      discordGet(`/channels/${currentId}`, token, fetchImpl),
      discordGet(`/channels/${currentId}/messages/${currentId}`, token, fetchImpl),
    ]);
    const identityMismatches = [...eventMismatches(current, config, plan.previous, { policy: false }), ...discordMismatches(config, currentId, currentThread, starter)];
    if (eventId(current) !== currentId) identityMismatches.push("eventId");
    const policyMismatches = eventMismatches(current, config, plan.previous);
    currentEvent = { eventId: currentId, date: plan.previous.date, status: "located", identityMismatches, policyMismatches, mismatches: [...new Set([...identityMismatches, ...policyMismatches])], signUpCount: (current.signUps || []).length, reminder: { ...reminderPlan(plan.previous, config), configuredAttendeeReminder: current.advancedSettings?.reminder ?? null, attendeeReminderDisabled: [false, "false"].includes(current.advancedSettings?.reminder), explicitThirtyMinuteAttendee: [REMINDER_MINUTES, String(REMINDER_MINUTES)].includes(current.advancedSettings?.reminder), configuredAnnouncements: current.announcements ?? [], explicitThirtyMinuteUnsigned: current.announcements?.length === 1 && current.announcements[0]?.channel === "unsignedping" && [REMINDER_MINUTES, String(REMINDER_MINUTES)].includes(current.announcements[0]?.time), dispatchVerified: false }, discordRequiredTagsPresent: config.tags.every((tag) => (currentThread.applied_tags || []).includes(tag.id)), archived: currentThread.thread_metadata?.archived, locked: currentThread.thread_metadata?.locked };
  }
  return {
    ok: true,
    outcome: "read-only-audit",
    plan,
    forum: { id: live.forum.id, name: live.forum.name },
    coreRole: { id: live.coreRole.id, name: live.coreRole.name },
    managementBot: live.bot,
    permissions: live.permissions,
    guildPermissions: live.guildPermissions,
    nativeCalendar: {
      voiceChannel: config.nativeCalendar.voiceChannel,
      voicePermissions: live.voicePermissions,
      scheduledOrActiveCount: calendarEvents.filter((event) => [1, 2].includes(event.status)).length,
      nextCandidates: calendarEvents.filter((event) => nativeMatches(event, config, plan.next, state.cycles[plan.previous.date]?.nextEventId)).map((event) => ({ id: event.id, name: event.name, status: event.status, creatorId: event.creator_id })),
      attendeeSync: "unsupported-by-documented-bot-api; Raid-Helper roster linked directly",
    },
    raidHelperApiKeyPresent: Boolean(apiKey),
    nativeRecurrence,
    unsignedAudience,
    activationBlockers: activationBlockers(config),
    currentEvent,
  };
}

async function load(path) {
  const selected = resolve(path || DEFAULT_CONFIG);
  return { config: validateConfig(JSON.parse(await readFile(selected, "utf8"))), path: selected };
}

export async function runCli(argv, dependencies = {}) {
  const command = argv[0] || "plan";
  if (command === "help" || argv.includes("--help")) return { help: "Pizza Core: plan | audit | apply | start-native [--config PATH] [--at ISO_TIMESTAMP]\nplan is offline/read-only; audit is live/read-only. apply rolls over the pair; start-native only starts an existing recorded calendar event. Both mutations require live activation checks and must omit --at." };
  if (!["plan", "audit", "apply", "start-native"].includes(command)) fail("UNKNOWN_COMMAND", "Use plan, audit, apply, or start-native.");
  const options = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!["--config", "--at"].includes(argv[i]) || !argv[i + 1]) fail("INVALID_ARGUMENT", `Unsupported or incomplete option: ${argv[i]}.`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const { config, path } = await load(options.config);
  const at = options.at || new Date().toISOString();
  if (command === "plan") return { ok: true, outcome: "preview", mutationAuthorized: false, ...buildPlan(config, at, { preview: true }), activationBlockers: activationBlockers(config), configPath: path };
  if (command === "audit") return { ...(await audit(config, at, dependencies)), configPath: path };
  if (options.at && !dependencies.allowSimulatedApply) fail("SIMULATED_APPLY_FORBIDDEN", "Production mutation uses the real clock. --at is allowed only for read-only plans/audits and injected local tests.");
  if (command === "start-native") return { ...(await startNative(config, at, dependencies)), configPath: path };
  return { ...(await applyRollover(config, at, dependencies)), configPath: path };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(result.help ? `${result.help}\n` : `${JSON.stringify(redact(result), null, 2)}\n`);
    if (result.ok === false) process.exitCode = 3;
  } catch (error) {
    const payload = error instanceof SkillError ? { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } : { ok: false, code: "UNEXPECTED_ERROR", message: "Pizza Core rollover failed before a confirmed result. Inspect the local journal; do not retry a create blindly." };
    process.stderr.write(`${JSON.stringify(redact(payload), null, 2)}\n`);
    process.exitCode = error instanceof SkillError ? error.exitCode : 1;
  }
}
