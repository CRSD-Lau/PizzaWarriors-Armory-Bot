#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAID_HELPER_API = "https://raid-helper.xyz/api/v4";
const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS = 15_000;
const DISCORD_FORUM_TYPE = 15;
const REQUIRED_TAGS = Object.freeze(["BrotherRaid", "PizzaRaid", "CasualRaid"]);
const SNOWFLAKE = /^\d{16,22}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_VALUES = new Set();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(SCRIPT_DIR, "..", "config.local.json");
const WEEKLY_OPTIONS = new Set([
  "config",
  "type",
  "date",
  "time",
  "title",
  "description",
  "leader-id",
  "template-id",
  "time-zone",
  "offset",
  "duration",
  "deadline",
  "limit",
  "voice-channel",
  "event-key",
  "help",
]);
const VERIFY_OPTIONS = new Set(["config", "type", "event-id", "help"]);

export class SkillError extends Error {
  constructor(code, message, details = undefined, exitCode = 1) {
    super(message);
    this.name = "SkillError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

class HttpError extends SkillError {
  constructor(service, status, reason) {
    super(
      `${service.toUpperCase()}_HTTP_${status}`,
      `${service} returned HTTP ${status}${reason ? `: ${reason}` : "."}`,
      { service, status, ...(reason ? { reason } : {}) },
      status === 401 || status === 403 ? 2 : 1,
    );
    this.status = status;
    this.uncertain = status >= 500;
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillError("INVALID_CONFIGURATION", `Missing or invalid configuration field: ${field}.`, { field }, 2);
  }
  return value.trim();
}

function requireSnowflake(value, field) {
  const normalized = requireString(value, field);
  if (!SNOWFLAKE.test(normalized)) {
    throw new SkillError("INVALID_CONFIGURATION", `Configuration field ${field} is not a Discord snowflake.`, { field }, 2);
  }
  return normalized;
}

function requireEnvName(value, field) {
  const normalized = requireString(value, field);
  if (!ENV_NAME.test(normalized)) {
    throw new SkillError("INVALID_CONFIGURATION", `Configuration field ${field} is not a valid environment-variable name.`, { field }, 2);
  }
  return normalized;
}

function assertTimeZone(timeZone) {
  const normalized = requireString(timeZone, "timeZone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    throw new SkillError("INVALID_TIME_ZONE", `Unknown IANA timezone: ${normalized}.`, { timeZone: normalized }, 2);
  }
  return normalized;
}

export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new SkillError("INVALID_CONFIGURATION", "Configuration must be a JSON object.", undefined, 2);
  }
  const credentials = isPlainObject(raw.credentials) ? raw.credentials : {};
  const defaults = isPlainObject(raw.defaults) ? raw.defaults : {};
  const raidTypes = isPlainObject(raw.raidTypes) ? raw.raidTypes : {};

  const config = {
    guildId: requireSnowflake(raw.guildId, "guildId"),
    forumChannelId: requireSnowflake(raw.forumChannelId, "forumChannelId"),
    raidHelperBotUserId: requireSnowflake(raw.raidHelperBotUserId, "raidHelperBotUserId"),
    timeZone: assertTimeZone(raw.timeZone),
    credentials: {
      raidHelperApiKeyEnv: requireEnvName(credentials.raidHelperApiKeyEnv, "credentials.raidHelperApiKeyEnv"),
      discordTokenEnv: requireEnvName(credentials.discordTokenEnv, "credentials.discordTokenEnv"),
    },
    defaults: {
      leaderId: requireSnowflake(defaults.leaderId, "defaults.leaderId"),
      description: typeof defaults.description === "string" ? defaults.description : "",
    },
    raidTypes: {},
  };

  for (const raidType of REQUIRED_TAGS) {
    const profile = raidTypes[raidType];
    if (!isPlainObject(profile)) {
      throw new SkillError("INVALID_CONFIGURATION", `Missing raidTypes.${raidType} configuration.`, { field: `raidTypes.${raidType}` }, 2);
    }
    const advancedSettings = profile.advancedSettings === undefined ? {} : profile.advancedSettings;
    if (!isPlainObject(advancedSettings)) {
      throw new SkillError("INVALID_CONFIGURATION", `raidTypes.${raidType}.advancedSettings must be an object.`, undefined, 2);
    }
    config.raidTypes[raidType] = {
      templateId: requireString(profile.templateId, `raidTypes.${raidType}.templateId`),
      advancedSettings: structuredClone(advancedSettings),
    };
  }

  if (raw.pizzaCoreRole !== undefined) {
    if (!isPlainObject(raw.pizzaCoreRole)) {
      throw new SkillError("INVALID_CONFIGURATION", "pizzaCoreRole must be an object when provided.", undefined, 2);
    }
    config.pizzaCoreRole = {
      id: requireSnowflake(raw.pizzaCoreRole.id, "pizzaCoreRole.id"),
      name: requireString(raw.pizzaCoreRole.name, "pizzaCoreRole.name"),
      confirmed: raw.pizzaCoreRole.confirmed === true,
    };
  }

  return config;
}

export async function loadConfig(path = undefined) {
  const selectedPath = resolve(path || process.env.PIZZA_RAIDS_CONFIG || DEFAULT_CONFIG_PATH);
  let raw;
  try {
    raw = JSON.parse(await readFile(selectedPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SkillError(
        "CONFIG_NOT_FOUND",
        `Pizza Raid Helper configuration was not found at ${selectedPath}.`,
        { path: selectedPath },
        2,
      );
    }
    if (error instanceof SyntaxError) {
      throw new SkillError("INVALID_CONFIGURATION_JSON", `Configuration is not valid JSON: ${selectedPath}.`, { path: selectedPath }, 2);
    }
    throw error;
  }
  return { config: validateConfig(raw), path: selectedPath };
}

export function normalizeRaidType(value) {
  const input = requireString(value, "--type").replace(/[\s_-]/g, "").toLowerCase();
  const match = REQUIRED_TAGS.find((raidType) => raidType.toLowerCase() === input);
  if (!match) {
    throw new SkillError("UNKNOWN_RAID_TYPE", `Unknown raid type: ${value}. Use BrotherRaid, PizzaRaid, or CasualRaid.`, { value }, 2);
  }
  return match;
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(requireString(value, "--date"));
  if (!match) throw new SkillError("INVALID_DATE", "Date must use YYYY-MM-DD.", { value }, 2);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new SkillError("INVALID_DATE", `Invalid calendar date: ${value}.`, { value }, 2);
  }
  return { year, month, day };
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(requireString(value, "--time"));
  if (!match) throw new SkillError("INVALID_TIME", "Time must use 24-hour HH:mm.", { value }, 2);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new SkillError("INVALID_TIME", `Invalid local time: ${value}.`, { value }, 2);
  return { hour, minute };
}

function localFormatter(timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function localPartsAt(epochMs, timeZone, formatter = localFormatter(timeZone)) {
  const values = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function offsetAt(epochMs, timeZone, formatter = localFormatter(timeZone)) {
  const local = localPartsAt(epochMs, timeZone, formatter);
  const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return Math.round((localAsUtc - epochMs) / 60_000);
}

function formatOffset(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function normalizeOffset(value) {
  if (value === undefined) return undefined;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(value));
  if (!match || Number(match[2]) > 14 || Number(match[3]) > 59) {
    throw new SkillError("INVALID_OFFSET", "Offset must look like -03:00 or +01:00.", { value }, 2);
  }
  return `${match[1]}${match[2]}:${match[3]}`;
}

export function resolveLocalDateTime({ date, time, timeZone, offset = undefined }) {
  const wantedDate = parseDate(date);
  const wantedTime = parseTime(time);
  const zone = assertTimeZone(timeZone);
  const requestedOffset = normalizeOffset(offset);
  const naiveUtc = Date.UTC(wantedDate.year, wantedDate.month - 1, wantedDate.day, wantedTime.hour, wantedTime.minute);
  const candidates = [];
  const formatter = localFormatter(zone);

  for (let epochMs = naiveUtc - 18 * 3_600_000; epochMs <= naiveUtc + 18 * 3_600_000; epochMs += 60_000) {
    const local = localPartsAt(epochMs, zone, formatter);
    if (
      local.year === wantedDate.year &&
      local.month === wantedDate.month &&
      local.day === wantedDate.day &&
      local.hour === wantedTime.hour &&
      local.minute === wantedTime.minute
    ) {
      const candidateOffset = formatOffset(offsetAt(epochMs, zone, formatter));
      if (!requestedOffset || candidateOffset === requestedOffset) {
        candidates.push({ epochMs, offset: candidateOffset });
      }
    }
  }

  if (!candidates.length) {
    throw new SkillError(
      "NONEXISTENT_LOCAL_TIME",
      `${date} ${time} does not exist in ${zone}, or does not use the requested offset.`,
      { date, time, timeZone: zone, ...(requestedOffset ? { offset: requestedOffset } : {}) },
      2,
    );
  }
  if (candidates.length > 1) {
    throw new SkillError(
      "AMBIGUOUS_LOCAL_TIME",
      `${date} ${time} occurs more than once in ${zone}; pass --offset with one of the reported offsets.`,
      { candidates: candidates.map((candidate) => candidate.offset) },
      2,
    );
  }

  const [{ epochMs, offset: resolvedOffset }] = candidates;
  const epochSeconds = Math.floor(epochMs / 1000);
  return {
    date,
    time,
    timeZone: zone,
    offset: resolvedOffset,
    epochSeconds,
    utc: new Date(epochMs).toISOString(),
    local: `${date} ${time} ${zone} (${resolvedOffset})`,
    discordTimestamp: `<t:${epochSeconds}:F>`,
  };
}

function integerOption(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new SkillError("INVALID_OPTION", `${name} must be an integer from ${min} through ${max}.`, { name, value }, 2);
  }
  return parsed;
}

function policyFor(type, coreRoleName) {
  const policy = { forum_tags: type };
  if (type === "PizzaRaid") {
    policy.allowed_roles = requireString(coreRoleName, "pizzaCoreRole.name");
    policy.banned_roles = "none";
    policy.bench_overflow = true;
    policy.queue_bench = false;
    policy.lock_at_limit = false;
  }
  return policy;
}

function buildAdvancedSettings(config, type, options, coreRoleName) {
  const advanced = structuredClone(config.raidTypes[type].advancedSettings);
  const duration = integerOption(options.duration, "--duration", { min: 1, max: 10080 });
  const limit = integerOption(options.limit, "--limit", { min: 1, max: 1000 });
  if (duration !== undefined) advanced.duration = duration;
  if (limit !== undefined) advanced.limit = limit;
  if (options.deadline !== undefined) advanced.deadline = requireString(options.deadline, "--deadline");
  if (options["voice-channel"] !== undefined) advanced.voice_channel = requireString(options["voice-channel"], "--voice-channel");

  Object.assign(advanced, policyFor(type, coreRoleName));
  return advanced;
}

export function buildEventPlan(configInput, options, overrides = {}) {
  const config = validateConfig(configInput);
  const raidType = normalizeRaidType(options.type);
  const start = resolveLocalDateTime({
    date: options.date,
    time: options.time,
    timeZone: options["time-zone"] || config.timeZone,
    offset: options.offset,
  });
  const profile = config.raidTypes[raidType];
  const title = requireString(options.title, "--title");
  const leaderId = requireSnowflake(options["leader-id"] || config.defaults.leaderId, "leaderId");
  const templateId = requireString(options["template-id"] || profile.templateId, "templateId");
  const description = options.description === undefined ? config.defaults.description : String(options.description);

  let coreRoleName;
  let coreRoleResolved = true;
  if (raidType === "PizzaRaid") {
    const configured = config.pizzaCoreRole;
    coreRoleName = overrides.coreRoleName || configured?.name;
    coreRoleResolved = configured?.confirmed === true && Boolean(coreRoleName);
    if (!coreRoleName) coreRoleName = "UNRESOLVED_PIZZA_CORE_ROLE";
  }

  const payload = {
    leaderId,
    templateId,
    date: String(start.epochSeconds),
    time: String(start.epochSeconds),
    title,
    description,
    advancedSettings: buildAdvancedSettings(config, raidType, options, coreRoleName),
  };
  const occurrenceSource = [config.guildId, config.forumChannelId, raidType, String(start.epochSeconds), options["event-key"] || ""].join(":");
  const occurrenceKey = createHash("sha256").update(occurrenceSource).digest("hex").slice(0, 20);

  return {
    version: 1,
    operation: "weekly-event",
    raidType,
    target: {
      guildId: config.guildId,
      forumChannelId: config.forumChannelId,
    },
    start,
    occurrenceKey,
    payload,
    policy: {
      forumTag: raidType,
      ...(raidType === "PizzaRaid"
        ? {
            pizzaCoreRole: coreRoleName,
            pizzaCoreMappingConfirmed: coreRoleResolved,
            bannedRoles: "none",
            benchOverflow: true,
            queueBench: false,
            lockAtLimit: false,
          }
        : {}),
    },
  };
}

function parseArgs(argv) {
  let command = "plan";
  let index = 0;
  if (argv[0] && !argv[0].startsWith("--")) {
    command = argv[0];
    index = 1;
  }
  const options = {};
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new SkillError("INVALID_ARGUMENT", `Unexpected positional argument: ${token}.`, { token }, 2);
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals === -1 ? undefined : equals);
    if (!key) throw new SkillError("INVALID_ARGUMENT", "Empty option name.", undefined, 2);
    if (equals !== -1) {
      options[key] = token.slice(equals + 1);
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[key] = argv[++index];
    } else {
      options[key] = true;
    }
  }
  return { command, options };
}

function validateCliOptions(command, options) {
  const allowed = command === "verify" ? VERIFY_OPTIONS : WEEKLY_OPTIONS;
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new SkillError(
      "UNKNOWN_OPTION",
      `Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}.`,
      { unknown: unknown.map((key) => `--${key}`) },
      2,
    );
  }
}

function safeReason(payload, fallback = "") {
  const candidate = isPlainObject(payload) ? payload.reason ?? payload.message ?? payload.error : undefined;
  const text = typeof candidate === "string" ? candidate : fallback;
  return text.replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function requestJson(url, { service, method = "GET", headers = {}, body = undefined, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const wrapped = new SkillError(
      timeout ? `${service.toUpperCase()}_TIMEOUT` : `${service.toUpperCase()}_NETWORK_ERROR`,
      timeout ? `${service} request timed out.` : `${service} request failed before a confirmed response.`,
      { service },
      3,
    );
    wrapped.uncertain = true;
    throw wrapped;
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (!response.ok) throw new HttpError(service, response.status, "Non-JSON error response");
      throw new SkillError(`${service.toUpperCase()}_INVALID_JSON`, `${service} returned an unexpected non-JSON response.`);
    }
  }
  if (!response.ok) throw new HttpError(service, response.status, safeReason(payload, response.statusText));
  return payload;
}

function envSecret(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new SkillError("MISSING_CREDENTIAL", `Required credential environment variable is not set: ${name}.`, { environmentVariable: name }, 2);
  }
  SECRET_VALUES.add(value);
  return value;
}

async function discordGet(path, token, fetchImpl = fetch) {
  return requestJson(`${DISCORD_API}${path}`, {
    service: "Discord",
    headers: { Authorization: `Bot ${token}`, Accept: "application/json", "User-Agent": "PizzaRaidHelper/1.0" },
    fetchImpl,
  });
}

async function resolveLiveCoreRole(config, token, fetchImpl = fetch) {
  if (!config.pizzaCoreRole?.confirmed) {
    throw new SkillError(
      "UNCONFIRMED_PIZZA_CORE_ROLE",
      "PizzaRaid creation is disabled until pizzaCoreRole is explicitly confirmed in configuration.",
      { configuredName: config.pizzaCoreRole?.name || null },
      2,
    );
  }
  const roles = await discordGet(`/guilds/${config.guildId}/roles`, token, fetchImpl);
  if (!Array.isArray(roles)) throw new SkillError("DISCORD_INVALID_ROLES", "Discord returned an unexpected guild-role response.");
  const role = roles.find((candidate) => String(candidate?.id) === config.pizzaCoreRole.id);
  if (!role || typeof role.name !== "string" || !role.name.trim()) {
    throw new SkillError("PIZZA_CORE_ROLE_NOT_FOUND", "The confirmed Pizza Core role ID no longer exists in the configured guild.", { roleId: config.pizzaCoreRole.id });
  }
  if (role.name !== config.pizzaCoreRole.name) {
    throw new SkillError(
      "PIZZA_CORE_ROLE_RENAMED",
      `The confirmed Pizza Core role is now named ${role.name}; update and reconfirm the mapping before creating a PizzaRaid.`,
      { roleId: role.id, expectedName: config.pizzaCoreRole.name, actualName: role.name },
    );
  }
  const sameName = roles.filter((candidate) => candidate?.name === role.name);
  if (sameName.length !== 1) {
    throw new SkillError(
      "AMBIGUOUS_PIZZA_CORE_ROLE_NAME",
      `Raid-Helper uses role names, and ${role.name} is not unique in the guild.`,
      { roleName: role.name, matchingRoleIds: sameName.map((candidate) => String(candidate.id)) },
    );
  }
  return role.name;
}

async function preflightForum(config, raidType, token, fetchImpl = fetch) {
  const forum = await discordGet(`/channels/${config.forumChannelId}`, token, fetchImpl);
  if (Number(forum?.type) !== DISCORD_FORUM_TYPE) {
    throw new SkillError("TARGET_NOT_FORUM", "The configured weekly target is not a Discord forum channel.", { channelId: config.forumChannelId, type: forum?.type });
  }
  if (forum.name !== "pizza-raids") {
    throw new SkillError("FORUM_NAME_DRIFT", `The configured forum is named ${forum.name}, not pizza-raids.`, { channelId: config.forumChannelId, actualName: forum.name });
  }
  const tags = Array.isArray(forum.available_tags) ? forum.available_tags : [];
  const names = tags.map((tag) => tag?.name).filter((name) => typeof name === "string");
  const missing = REQUIRED_TAGS.filter((tag) => !names.includes(tag));
  if (missing.length) {
    throw new SkillError("MISSING_FORUM_TAGS", "The one-time forum setup is missing required raid tags.", { missing });
  }
  if (names.filter((name) => name === raidType).length !== 1) {
    throw new SkillError("AMBIGUOUS_FORUM_TAG", `The forum tag ${raidType} is missing or duplicated.`, { raidType });
  }
  return forum;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry : entry?.name))
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function booleanValue(value) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

function eventAdvanced(event) {
  return isPlainObject(event?.advancedSettings)
    ? event.advancedSettings
    : isPlainObject(event?.advanced_settings)
      ? event.advanced_settings
      : {};
}

function eventId(event) {
  const value = event?.id ?? event?.eventId ?? event?.event_id ?? event?.messageId ?? event?.message_id;
  return value === undefined ? undefined : String(value);
}

function eventStart(event) {
  const value = event?.startTime ?? event?.start_time ?? event?.start;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function eventChannel(event) {
  const value = event?.channelId ?? event?.channel_id;
  return value === undefined ? undefined : String(value);
}

function eventsFromList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.postedEvents)) return payload.postedEvents;
  if (Array.isArray(payload?.events)) return payload.events;
  throw new SkillError("RAID_HELPER_INVALID_EVENT_LIST", "Raid-Helper returned an unexpected server-event list.");
}

function matchingEvents(events, plan) {
  return events.filter((event) => {
    if (eventChannel(event) !== plan.target.forumChannelId || eventStart(event) !== plan.start.epochSeconds) return false;
    const tags = normalizeList(eventAdvanced(event).forum_tags);
    const sameTag = tags.includes(plan.raidType);
    const sameTitle = typeof event?.title === "string" && event.title.trim().toLowerCase() === plan.payload.title.trim().toLowerCase();
    return sameTag || sameTitle;
  });
}

async function listNearbyEvents(config, plan, apiKey, fetchImpl = fetch) {
  const payload = await requestJson(`${RAID_HELPER_API}/servers/${config.guildId}/events`, {
    service: "Raid-Helper",
    headers: {
      Authorization: apiKey,
      Accept: "application/json",
      Page: "1",
      IncludeSignUps: "false",
      ChannelFilter: config.forumChannelId,
      StartTimeFilter: String(plan.start.epochSeconds - 60),
      EndTimeFilter: String(plan.start.epochSeconds + 60),
      "User-Agent": "PizzaRaidHelper/1.0",
    },
    fetchImpl,
  });
  return matchingEvents(eventsFromList(payload), plan);
}

function compareEvent(event, config, raidType, expectedPlan = undefined, coreRoleName = undefined) {
  const mismatches = [];
  const advanced = eventAdvanced(event);
  const tags = normalizeList(advanced.forum_tags);
  if (String(event?.serverId ?? event?.server_id) !== config.guildId) mismatches.push("serverId");
  if (eventChannel(event) !== config.forumChannelId) mismatches.push("channelId");
  if (tags.length !== 1 || tags[0] !== raidType) mismatches.push("advancedSettings.forum_tags");

  if (raidType === "PizzaRaid") {
    const allowed = normalizeList(advanced.allowed_roles);
    if (allowed.length !== 1 || allowed[0] !== coreRoleName) mismatches.push("advancedSettings.allowed_roles");
    const banned = normalizeList(advanced.banned_roles);
    if (banned.length !== 1 || banned[0] !== "none") mismatches.push("advancedSettings.banned_roles");
    if (booleanValue(advanced.bench_overflow) !== true) mismatches.push("advancedSettings.bench_overflow");
    if (booleanValue(advanced.queue_bench) !== false) mismatches.push("advancedSettings.queue_bench");
    if (booleanValue(advanced.lock_at_limit) !== false) mismatches.push("advancedSettings.lock_at_limit");
  }

  if (expectedPlan) {
    if (String(event?.leaderId ?? event?.leader_id) !== expectedPlan.payload.leaderId) mismatches.push("leaderId");
    if (String(event?.templateId ?? event?.template_id) !== expectedPlan.payload.templateId) mismatches.push("templateId");
    if (event?.title !== expectedPlan.payload.title) mismatches.push("title");
    if (eventStart(event) !== expectedPlan.start.epochSeconds) mismatches.push("startTime");
  }
  return mismatches;
}

async function readRaidHelperEvent(id, fetchImpl = fetch) {
  return requestJson(`${RAID_HELPER_API}/events/${id}`, {
    service: "Raid-Helper",
    headers: { Accept: "application/json", "User-Agent": "PizzaRaidHelper/1.0" },
    fetchImpl,
  });
}

async function verifyDiscordEvent(event, config, raidType, discordToken, forum, fetchImpl = fetch) {
  const id = eventId(event);
  if (!id || !SNOWFLAKE.test(id)) throw new SkillError("MISSING_EVENT_ID", "Raid-Helper did not provide a valid Discord event ID.");
  const thread = await discordGet(`/channels/${id}`, discordToken, fetchImpl);
  const starter = await discordGet(`/channels/${id}/messages/${id}`, discordToken, fetchImpl);
  const tagById = new Map((forum.available_tags || []).map((tag) => [String(tag.id), tag.name]));
  const appliedNames = (thread.applied_tags || []).map((tagId) => tagById.get(String(tagId))).filter(Boolean);
  const mismatches = [];
  if (String(thread.parent_id) !== config.forumChannelId) mismatches.push("discord.parent_id");
  if (String(thread.owner_id) !== config.raidHelperBotUserId) mismatches.push("discord.thread.owner_id");
  if (String(starter?.author?.id) !== config.raidHelperBotUserId) mismatches.push("discord.starter.author.id");
  if (appliedNames.length !== 1 || appliedNames[0] !== raidType) mismatches.push("discord.applied_tags");
  if (mismatches.length) {
    throw new SkillError("DISCORD_POST_VERIFICATION_FAILED", "The Raid-Helper event exists but its Discord forum post does not match the required state.", { eventId: id, mismatches });
  }
  return {
    threadId: id,
    parentChannelId: config.forumChannelId,
    authorId: config.raidHelperBotUserId,
    appliedTag: raidType,
    url: `https://discord.com/channels/${config.guildId}/${id}`,
  };
}

async function verifyEvent({ id, config, raidType, expectedPlan, coreRoleName, discordToken, forum, fetchImpl = fetch }) {
  const event = await readRaidHelperEvent(id, fetchImpl);
  const mismatches = compareEvent(event, config, raidType, expectedPlan, coreRoleName);
  if (mismatches.length) {
    throw new SkillError("RAID_HELPER_EVENT_VERIFICATION_FAILED", "The Raid-Helper event does not match the locked weekly policy.", { eventId: id, mismatches });
  }
  const discord = await verifyDiscordEvent(event, config, raidType, discordToken, forum, fetchImpl);
  return { event, discord };
}

async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function verifyWithPolling(input) {
  let lastError;
  for (const waitMs of [0, 1_000, 2_000, 4_000]) {
    if (waitMs) await delay(waitMs);
    try {
      return await verifyEvent(input);
    } catch (error) {
      lastError = error;
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
    }
  }
  throw lastError;
}

async function reconcileAfterUncertain({ config, plan, apiKey, coreRoleName, discordToken, forum, fetchImpl }) {
  for (const waitMs of [0, 1_000, 2_000, 4_000]) {
    if (waitMs) await delay(waitMs);
    const matches = await listNearbyEvents(config, plan, apiKey, fetchImpl);
    if (matches.length > 1) {
      throw new SkillError("DUPLICATE_EVENT_CONFLICT", "Multiple Raid-Helper events match the same weekly occurrence after an uncertain response.", { eventIds: matches.map(eventId).filter(Boolean) }, 3);
    }
    if (matches.length === 1) {
      const id = eventId(matches[0]);
      const verified = await verifyWithPolling({ id, config, raidType: plan.raidType, expectedPlan: plan, coreRoleName, discordToken, forum, fetchImpl });
      return { outcome: "reconciled-after-uncertain-response", id, verified };
    }
  }
  throw new SkillError(
    "OUTCOME_UNCERTAIN",
    "Raid-Helper did not return a confirmed result, and reconciliation found no unique matching event. Do not retry blindly.",
    { occurrenceKey: plan.occurrenceKey },
    3,
  );
}

async function applyPlan(config, options, fetchImpl = fetch) {
  const apiKey = envSecret(config.credentials.raidHelperApiKeyEnv);
  const discordToken = envSecret(config.credentials.discordTokenEnv);
  const raidType = normalizeRaidType(options.type);
  const coreRoleName = raidType === "PizzaRaid" ? await resolveLiveCoreRole(config, discordToken, fetchImpl) : undefined;
  const plan = buildEventPlan(config, options, { coreRoleName });
  if (raidType === "PizzaRaid" && !plan.policy.pizzaCoreMappingConfirmed) {
    throw new SkillError("UNCONFIRMED_PIZZA_CORE_ROLE", "PizzaRaid creation is disabled until the Pizza Core mapping is confirmed.", undefined, 2);
  }
  const forum = await preflightForum(config, raidType, discordToken, fetchImpl);
  const existing = await listNearbyEvents(config, plan, apiKey, fetchImpl);
  if (existing.length > 1) {
    throw new SkillError("DUPLICATE_EVENT_CONFLICT", "Multiple Raid-Helper events already match this weekly occurrence.", { eventIds: existing.map(eventId).filter(Boolean) });
  }
  if (existing.length === 1) {
    const id = eventId(existing[0]);
    const verified = await verifyWithPolling({ id, config, raidType, expectedPlan: plan, coreRoleName, discordToken, forum, fetchImpl });
    return createResult("existing-noop", plan, id, verified);
  }

  let created;
  try {
    created = await requestJson(`${RAID_HELPER_API}/servers/${config.guildId}/channels/${config.forumChannelId}/event`, {
      service: "Raid-Helper",
      method: "POST",
      headers: {
        Authorization: apiKey,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "PizzaRaidHelper/1.0",
      },
      body: plan.payload,
      fetchImpl,
    });
  } catch (error) {
    if (!error?.uncertain) throw error;
    const reconciled = await reconcileAfterUncertain({ config, plan, apiKey, coreRoleName, discordToken, forum, fetchImpl });
    return createResult(reconciled.outcome, plan, reconciled.id, reconciled.verified);
  }

  const responseEvent = isPlainObject(created?.event) ? created.event : created;
  let id = eventId(responseEvent);
  if (!id) {
    const reconciled = await reconcileAfterUncertain({ config, plan, apiKey, coreRoleName, discordToken, forum, fetchImpl });
    return createResult(reconciled.outcome, plan, reconciled.id, reconciled.verified);
  }
  const verified = await verifyWithPolling({ id, config, raidType, expectedPlan: plan, coreRoleName, discordToken, forum, fetchImpl });
  return createResult("created", plan, id, verified);
}

function createResult(outcome, plan, id, verified) {
  return {
    ok: true,
    outcome,
    eventId: id,
    occurrenceKey: plan.occurrenceKey,
    raidType: plan.raidType,
    start: plan.start,
    policy: plan.policy,
    discord: verified.discord,
    verification: {
      raidHelper: "passed",
      discord: "passed",
    },
  };
}

async function verifyExisting(config, options, fetchImpl = fetch) {
  const raidType = normalizeRaidType(options.type);
  const id = requireSnowflake(options["event-id"], "--event-id");
  const discordToken = envSecret(config.credentials.discordTokenEnv);
  const coreRoleName = raidType === "PizzaRaid" ? await resolveLiveCoreRole(config, discordToken, fetchImpl) : undefined;
  const forum = await preflightForum(config, raidType, discordToken, fetchImpl);
  const verified = await verifyWithPolling({ id, config, raidType, expectedPlan: undefined, coreRoleName, discordToken, forum, fetchImpl });
  return {
    ok: true,
    outcome: "verified",
    eventId: id,
    raidType,
    discord: verified.discord,
    verification: { raidHelper: "passed", discord: "passed" },
  };
}

function publicPlan(plan) {
  return {
    ok: true,
    outcome: "preview",
    ...plan,
    mutationAuthorized: false,
    validation: {
      pizzaCoreMapping:
        plan.raidType === "PizzaRaid"
          ? plan.policy.pizzaCoreMappingConfirmed
            ? "confirmed-config"
            : "unresolved"
          : "not-applicable",
      liveRole: "not-run-preview",
      forumTags: "not-run-preview",
      raidHelper: "not-run-preview",
      discordPost: "not-run-preview",
    },
    notes:
      plan.raidType === "PizzaRaid" && !plan.policy.pizzaCoreMappingConfirmed
        ? ["PizzaRaid apply is blocked until the Pizza Core role mapping is explicitly confirmed."]
        : [],
  };
}

function redactSecrets(value) {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of SECRET_VALUES) {
      if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
    return redacted;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecrets(item)]));
  return value;
}

function printJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(redactSecrets(value), null, 2)}\n`);
}

function usage() {
  return [
    "Pizza Raid Helper",
    "",
    "plan  --config PATH --type TYPE --date YYYY-MM-DD --time HH:mm --title TITLE [options]",
    "apply --config PATH --type TYPE --date YYYY-MM-DD --time HH:mm --title TITLE [options]",
    "verify --config PATH --type TYPE --event-id DISCORD_ID",
    "",
    "Options: --description, --leader-id, --template-id, --time-zone, --offset, --duration, --deadline, --limit, --voice-channel, --event-key",
  ].join("\n");
}

export async function runCli(argv, { fetchImpl = fetch } = {}) {
  const { command, options } = parseArgs(argv);
  if (command === "help" || options.help === true) return { help: usage() };
  if (!new Set(["plan", "apply", "verify"]).has(command)) {
    throw new SkillError("UNKNOWN_COMMAND", `Unknown command: ${command}. Use plan, apply, or verify.`, { command }, 2);
  }
  validateCliOptions(command, options);
  const { config, path } = await loadConfig(options.config);
  if (command === "verify") return { ...(await verifyExisting(config, options, fetchImpl)), configPath: path };
  const plan = buildEventPlan(config, options);
  if (command === "plan") return { ...publicPlan(plan), configPath: path };
  return { ...(await applyPlan(config, options, fetchImpl)), configPath: path };
}

async function main() {
  try {
    const result = await runCli(process.argv.slice(2));
    if (result.help) {
      process.stdout.write(`${result.help}\n`);
      return;
    }
    printJson(result);
  } catch (error) {
    const safe = error instanceof SkillError
      ? { ok: false, code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
      : { ok: false, code: "UNEXPECTED_ERROR", message: "Pizza Raid Helper failed unexpectedly." };
    printJson(safe, process.stderr);
    process.exitCode = error instanceof SkillError ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
