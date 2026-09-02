import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SkillError,
  buildEventPlan,
  normalizeRaidType,
  resolveLocalDateTime,
  runCli,
  validateConfig,
} from "./raid-helper-event.mjs";

const ids = Object.freeze({
  guild: "111111111111111111",
  forum: "222222222222222222",
  raidHelper: "333333333333333333",
  leader: "444444444444444444",
  coreRole: "555555555555555555",
  event: "666666666666666666",
  brotherTag: "777777777777777771",
  pizzaTag: "777777777777777772",
  casualTag: "777777777777777773",
});

function fixtureConfig(overrides = {}) {
  return {
    guildId: ids.guild,
    forumChannelId: ids.forum,
    raidHelperBotUserId: ids.raidHelper,
    timeZone: "America/Halifax",
    credentials: {
      raidHelperApiKeyEnv: "TEST_RAID_HELPER_API_KEY",
      discordTokenEnv: "TEST_DISCORD_TOKEN",
    },
    defaults: {
      leaderId: ids.leader,
      description: "Bring consumes.",
    },
    pizzaCoreRole: {
      id: ids.coreRole,
      name: "Well Timed Pizza",
      confirmed: true,
    },
    raidTypes: {
      BrotherRaid: { templateId: "1", advancedSettings: { attendance: "brother" } },
      PizzaRaid: {
        templateId: "2",
        advancedSettings: {
          forum_tags: "WrongTag",
          allowed_roles: "Wrong Role",
          banned_roles: "Trial",
          bench_overflow: false,
          queue_bench: true,
          lock_at_limit: true,
          limit: 25,
          attendance: "pizza",
        },
      },
      CasualRaid: { templateId: "3", advancedSettings: { attendance: "casual" } },
    },
    ...overrides,
  };
}

function weeklyOptions(type = "PizzaRaid") {
  return {
    type,
    date: "2026-09-05",
    time: "20:00",
    title: "ICC 25 Heroic",
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withConfigFile(config, callback) {
  const directory = await mkdtemp(join(tmpdir(), "pizza-raid-helper-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(config), "utf8");
  try {
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function fullRaidHelperEvent(plan) {
  return {
    id: ids.event,
    serverId: ids.guild,
    channelId: ids.forum,
    leaderId: ids.leader,
    templateId: "2",
    title: plan.payload.title,
    description: plan.payload.description,
    startTime: plan.start.epochSeconds,
    advancedSettings: {
      ...plan.payload.advancedSettings,
    },
  };
}

function forumPayload() {
  return {
    id: ids.forum,
    type: 15,
    name: "pizza-raids",
    available_tags: [
      { id: ids.brotherTag, name: "BrotherRaid" },
      { id: ids.pizzaTag, name: "PizzaRaid" },
      { id: ids.casualTag, name: "CasualRaid" },
    ],
  };
}

test("normalizes the three supported raid type spellings", () => {
  assert.equal(normalizeRaidType("pizza-raid"), "PizzaRaid");
  assert.equal(normalizeRaidType("BROTHER RAID"), "BrotherRaid");
  assert.equal(normalizeRaidType("casualraid"), "CasualRaid");
  assert.throws(() => normalizeRaidType("OfficerRaid"), (error) => error instanceof SkillError && error.code === "UNKNOWN_RAID_TYPE");
});

test("locks PizzaRaid tag and signup policy after configured defaults", () => {
  const plan = buildEventPlan(fixtureConfig(), weeklyOptions());
  assert.equal(plan.raidType, "PizzaRaid");
  assert.equal(plan.payload.advancedSettings.forum_tags, "PizzaRaid");
  assert.equal(plan.payload.advancedSettings.allowed_roles, "Well Timed Pizza");
  assert.equal(plan.payload.advancedSettings.banned_roles, "none");
  assert.equal(plan.payload.advancedSettings.bench_overflow, true);
  assert.equal(plan.payload.advancedSettings.queue_bench, false);
  assert.equal(plan.payload.advancedSettings.lock_at_limit, false);
  assert.equal(plan.payload.advancedSettings.limit, 25);
  assert.equal(plan.payload.advancedSettings.attendance, "pizza");
  assert.equal(plan.policy.pizzaCoreMappingConfirmed, true);
});

test("does not leak PizzaRaid role restrictions into other raid types", () => {
  for (const type of ["BrotherRaid", "CasualRaid"]) {
    const plan = buildEventPlan(fixtureConfig(), weeklyOptions(type));
    assert.equal(plan.payload.advancedSettings.forum_tags, type);
    assert.equal("allowed_roles" in plan.payload.advancedSettings, false);
    assert.equal("bench_overflow" in plan.payload.advancedSettings, false);
    assert.equal("queue_bench" in plan.payload.advancedSettings, false);
  }
});

test("marks an unconfirmed Pizza Core mapping as preview-only", () => {
  const config = fixtureConfig({
    pizzaCoreRole: { id: ids.coreRole, name: "Well Timed Pizza", confirmed: false },
  });
  const plan = buildEventPlan(config, weeklyOptions());
  assert.equal(plan.policy.pizzaCoreMappingConfirmed, false);
});

test("resolves an ordinary Halifax local time to one exact instant", () => {
  const resolved = resolveLocalDateTime({
    date: "2026-09-05",
    time: "20:00",
    timeZone: "America/Halifax",
  });
  assert.equal(resolved.offset, "-03:00");
  assert.equal(resolved.utc, "2026-09-05T23:00:00.000Z");
  assert.equal(resolved.epochSeconds, Date.parse("2026-09-05T23:00:00.000Z") / 1000);
});

test("rejects a nonexistent spring DST wall-clock time", () => {
  assert.throws(
    () => resolveLocalDateTime({ date: "2026-03-08", time: "02:30", timeZone: "America/Halifax" }),
    (error) => error instanceof SkillError && error.code === "NONEXISTENT_LOCAL_TIME",
  );
});

test("requires an offset for a repeated fall DST wall-clock time", () => {
  assert.throws(
    () => resolveLocalDateTime({ date: "2026-11-01", time: "01:30", timeZone: "America/Halifax" }),
    (error) => error instanceof SkillError && error.code === "AMBIGUOUS_LOCAL_TIME" && error.details.candidates.includes("-03:00") && error.details.candidates.includes("-04:00"),
  );
  const daylight = resolveLocalDateTime({
    date: "2026-11-01",
    time: "01:30",
    timeZone: "America/Halifax",
    offset: "-03:00",
  });
  const standard = resolveLocalDateTime({
    date: "2026-11-01",
    time: "01:30",
    timeZone: "America/Halifax",
    offset: "-04:00",
  });
  assert.equal(standard.epochSeconds - daylight.epochSeconds, 3600);
});

test("validates every required stable configuration field", () => {
  assert.equal(validateConfig(fixtureConfig()).raidTypes.PizzaRaid.templateId, "2");
  assert.throws(
    () => validateConfig({ ...fixtureConfig(), forumChannelId: "not-an-id" }),
    (error) => error instanceof SkillError && error.code === "INVALID_CONFIGURATION",
  );
});

test("plan is read-only and does not require credentials", async () => {
  await withConfigFile(fixtureConfig(), async (configPath) => {
    const result = await runCli([
      "plan",
      "--config",
      configPath,
      "--type",
      "PizzaRaid",
      "--date",
      "2026-09-05",
      "--time",
      "20:00",
      "--title",
      "ICC 25 Heroic",
    ], {
      fetchImpl: async () => {
        throw new Error("Plan must not make a network request");
      },
    });
    assert.equal(result.outcome, "preview");
    assert.equal(result.mutationAuthorized, false);
    assert.equal(result.validation.pizzaCoreMapping, "confirmed-config");
    assert.equal(result.validation.liveRole, "not-run-preview");
    assert.equal(result.validation.forumTags, "not-run-preview");
  });
});

test("rejects unknown options instead of ignoring operator typos", async () => {
  await assert.rejects(
    () => runCli([
      "plan",
      "--config",
      "unused.json",
      "--type",
      "PizzaRaid",
      "--date",
      "2026-09-05",
      "--time",
      "20:00",
      "--title",
      "ICC 25 Heroic",
      "--descrption",
      "typo",
    ]),
    (error) => error instanceof SkillError && error.code === "UNKNOWN_OPTION" && error.details.unknown.includes("--descrption"),
  );
});

test("apply creates one Raid-Helper event and verifies its Discord forum post", async () => {
  process.env.TEST_RAID_HELPER_API_KEY = "raid-helper-secret-for-test";
  process.env.TEST_DISCORD_TOKEN = "discord-secret-for-test";
  let postedPayload;
  const calls = [];

  try {
    await withConfigFile(fixtureConfig(), async (configPath) => {
      const expectedPlan = buildEventPlan(fixtureConfig(), weeklyOptions());
      const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        const method = options.method || "GET";
        calls.push({ target, method, authorization: options.headers?.Authorization });
        if (target === `https://discord.com/api/v10/guilds/${ids.guild}/roles`) {
          return jsonResponse([
            { id: ids.coreRole, name: "Well Timed Pizza" },
            { id: "888888888888888888", name: "Member" },
          ]);
        }
        if (target === `https://discord.com/api/v10/channels/${ids.forum}`) return jsonResponse(forumPayload());
        if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/events`) return jsonResponse({ postedEvents: [] });
        if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/channels/${ids.forum}/event` && method === "POST") {
          postedPayload = JSON.parse(options.body);
          return jsonResponse({ status: "success", event: { id: ids.event } });
        }
        if (target === `https://raid-helper.xyz/api/v4/events/${ids.event}`) return jsonResponse(fullRaidHelperEvent(expectedPlan));
        if (target === `https://discord.com/api/v10/channels/${ids.event}`) {
          return jsonResponse({ id: ids.event, parent_id: ids.forum, owner_id: ids.raidHelper, applied_tags: [ids.pizzaTag] });
        }
        if (target === `https://discord.com/api/v10/channels/${ids.event}/messages/${ids.event}`) {
          return jsonResponse({ id: ids.event, author: { id: ids.raidHelper } });
        }
        throw new Error(`Unexpected mock request: ${method} ${target}`);
      };

      const result = await runCli([
        "apply",
        "--config",
        configPath,
        "--type",
        "PizzaRaid",
        "--date",
        "2026-09-05",
        "--time",
        "20:00",
        "--title",
        "ICC 25 Heroic",
      ], { fetchImpl });

      assert.equal(result.outcome, "created");
      assert.equal(result.eventId, ids.event);
      assert.equal(result.verification.raidHelper, "passed");
      assert.equal(result.verification.discord, "passed");
      assert.equal(postedPayload.advancedSettings.forum_tags, "PizzaRaid");
      assert.equal(postedPayload.advancedSettings.allowed_roles, "Well Timed Pizza");
      assert.equal(postedPayload.advancedSettings.banned_roles, "none");
      assert.equal(postedPayload.advancedSettings.bench_overflow, true);
      assert.equal(postedPayload.advancedSettings.queue_bench, false);
      assert.equal(postedPayload.advancedSettings.lock_at_limit, false);
      assert.equal(JSON.stringify(result).includes(process.env.TEST_RAID_HELPER_API_KEY), false);
      assert.equal(JSON.stringify(result).includes(process.env.TEST_DISCORD_TOKEN), false);
      assert.equal(calls.filter((call) => call.method === "POST").length, 1);
      assert.ok(calls.some((call) => call.authorization === process.env.TEST_RAID_HELPER_API_KEY));
      assert.ok(calls.some((call) => call.authorization === `Bot ${process.env.TEST_DISCORD_TOKEN}`));
    });
  } finally {
    delete process.env.TEST_RAID_HELPER_API_KEY;
    delete process.env.TEST_DISCORD_TOKEN;
  }
});

test("an uncertain create response reconciles instead of posting twice", async () => {
  process.env.TEST_RAID_HELPER_API_KEY = "raid-helper-secret-for-reconcile";
  process.env.TEST_DISCORD_TOKEN = "discord-secret-for-reconcile";
  let listCount = 0;
  let postCount = 0;

  try {
    await withConfigFile(fixtureConfig(), async (configPath) => {
      const expectedPlan = buildEventPlan(fixtureConfig(), weeklyOptions());
      const existing = fullRaidHelperEvent(expectedPlan);
      const fetchImpl = async (url, options = {}) => {
        const target = String(url);
        const method = options.method || "GET";
        if (target === `https://discord.com/api/v10/guilds/${ids.guild}/roles`) {
          return jsonResponse([{ id: ids.coreRole, name: "Well Timed Pizza" }]);
        }
        if (target === `https://discord.com/api/v10/channels/${ids.forum}`) return jsonResponse(forumPayload());
        if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/events`) {
          listCount += 1;
          return jsonResponse({ postedEvents: listCount === 1 ? [] : [existing] });
        }
        if (target === `https://raid-helper.xyz/api/v4/servers/${ids.guild}/channels/${ids.forum}/event` && method === "POST") {
          postCount += 1;
          throw new TypeError("simulated connection loss after transmission");
        }
        if (target === `https://raid-helper.xyz/api/v4/events/${ids.event}`) return jsonResponse(existing);
        if (target === `https://discord.com/api/v10/channels/${ids.event}`) {
          return jsonResponse({ id: ids.event, parent_id: ids.forum, owner_id: ids.raidHelper, applied_tags: [ids.pizzaTag] });
        }
        if (target === `https://discord.com/api/v10/channels/${ids.event}/messages/${ids.event}`) {
          return jsonResponse({ id: ids.event, author: { id: ids.raidHelper } });
        }
        throw new Error(`Unexpected mock request: ${method} ${target}`);
      };

      const result = await runCli([
        "apply",
        "--config",
        configPath,
        "--type",
        "PizzaRaid",
        "--date",
        "2026-09-05",
        "--time",
        "20:00",
        "--title",
        "ICC 25 Heroic",
      ], { fetchImpl });

      assert.equal(result.outcome, "reconciled-after-uncertain-response");
      assert.equal(postCount, 1);
      assert.equal(listCount, 2);
    });
  } finally {
    delete process.env.TEST_RAID_HELPER_API_KEY;
    delete process.env.TEST_DISCORD_TOKEN;
  }
});
