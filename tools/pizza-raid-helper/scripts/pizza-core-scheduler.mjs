#!/usr/bin/env node
// Author and last modified by: Neil Mitchell.
// Windows owns the timer. This dispatcher never creates its own provider objects.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPlan, runCli, validateConfig } from "./pizza-core-rollover.mjs";

const DEFAULT_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config.pizza-core.local.json");

export function selectPhase(config, at) {
  const plan = buildPlan(config, at);
  const late = Date.parse(at) / 1000 - plan.previous.start.epochSeconds;
  if (plan.previous.date < config.bootstrap.date) return { command: null, reason: "before-first-managed-raid" };
  if (late >= 0 && late <= config.nativeCalendar.startGraceMinutes * 60) return { command: "start-native", date: plan.previous.date };
  if (plan.due) return { command: "apply", date: plan.previous.date };
  return { command: null, reason: "outside-recovery-windows", date: plan.previous.date,
    lastEnd: plan.previous.end.utc, pastEndWindow: Date.parse(at) > (plan.previous.end.epochSeconds + config.rollover.maxLateMinutes * 60) * 1000 };
}

export function retryable(error) {
  // A failed read has no uncertain mutation to repeat. Mutations and errors
  // without an identified HTTP method must remain subject to reconciliation.
  if (error?.details?.method !== "GET") return false;
  if (error?.code === "NETWORK_OUTCOME_UNCERTAIN") return true;
  return error?.code === "PROVIDER_HTTP_ERROR" && (error.details?.status === 429 || error.details?.status >= 500);
}

export async function dispatch(config, configPath, { clock = () => new Date().toISOString(), invoke = runCli,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), readJournal = async () => JSON.parse(await readFile(config.statePath, "utf8")) } = {}) {
  const initial = selectPhase(config, clock());
  if (!initial.command) {
    let missed = false;
    if (initial.pastEndWindow) {
      const state = await readJournal();
      missed = state.cycles?.[initial.date]?.phase !== "complete";
    }
    return { ok: !missed, outcome: missed ? "missed-window-needs-review" : "scheduled-noop", ...initial, attempts: 0 };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const phase = selectPhase(config, clock());
    if (phase.command !== initial.command || phase.date !== initial.date) return { ok: false, outcome: "recovery-window-expired", command: initial.command, attempts: attempt - 1 };
    try {
      // No --at is ever passed. The runner independently checks the actual clock,
      // activation, mutex and durable provider-specific create intents.
      const result = await invoke([phase.command, "--config", configPath]);
      return { ok: result.ok !== false && !result.requiresAttention && result.outcome !== "no-managed-native-event",
        outcome: result.outcome, command: phase.command, date: phase.date, attempts: attempt,
        previousEventId: result.previous?.eventId, nextEventId: result.next?.eventId,
        nativeEventId: result.nativeCalendar?.eventId ?? result.next?.nativeCalendar?.eventId,
        journalPhase: result.verification?.journal };
    } catch (error) {
      if (!retryable(error) || attempt === 3) return { ok: false, outcome: "failed-needs-review", command: phase.command, date: phase.date,
        attempts: attempt, code: /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : "UNEXPECTED_ERROR",
        previousNativeOutcome: error.details?.previousNativeCalendar?.outcome };
      const waitMs = Math.max(attempt * 30_000, Number(error.details?.retryAfterSeconds ?? 0) * 1000 + 1000);
      if (!Number.isFinite(waitMs) || waitMs > 60_000) return { ok: false, outcome: "cooldown-needs-review", code: "LONG_PROVIDER_COOLDOWN", attempts: attempt };
      await sleep(waitMs);
    }
  }
}

export function remindersConfigured(audit) {
  return audit.currentEvent?.reminder?.explicitThirtyMinuteUnsigned === true
    && audit.currentEvent.reminder.explicitThirtyMinuteAttendee === true;
}

async function saveStatus(config, result) {
  const record = { author: "Neil Mitchell", lastModifiedBy: "Neil Mitchell", recordedAt: new Date().toISOString(), ...result };
  const target = `${config.statePath}.scheduler-status.json`;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, target);
  await appendFile(`${config.statePath}.scheduler.log`, JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

export async function schedulerCli(args) {
  let configPath = DEFAULT_CONFIG;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) configPath = resolve(args[++i]);
    else if (args[i] === "--check") check = true;
    else throw new Error("Unsupported scheduler option. Simulated clocks are never accepted.");
  }
  const config = validateConfig(JSON.parse(await readFile(configPath, "utf8")));
  let result;
  if (check) {
    const audit = await runCli(["audit", "--config", configPath]);
    const allowedLegacyDrift = config.bootstrap.legacyPolicy && audit.currentEvent.eventId === config.bootstrap.eventId;
    const ok = audit.activationBlockers.length === 0 && audit.permissions.manageThreads && audit.permissions.view && audit.permissions.history
      && audit.nativeCalendar.voicePermissions.view && audit.nativeCalendar.voicePermissions.connect && audit.nativeCalendar.voicePermissions.createEvents
      && audit.raidHelperApiKeyPresent && audit.nativeRecurrence === "no-competing-schedule-found"
      && (audit.unsignedAudience.accepted === true || audit.unsignedAudience.verified === true)
      && audit.currentEvent.identityMismatches?.length === 0 && (allowedLegacyDrift || audit.currentEvent.policyMismatches?.length === 0);
    result = { ok: Boolean(ok), outcome: "read-only-scheduled-credential-check", mutations: 0,
      activationBlockers: audit.activationBlockers, audiencePolicy: config.unsignedAudiencePolicy.mode,
      currentEventId: audit.currentEvent.eventId, legacyPolicyPreserved: allowedLegacyDrift,
      reminderConfigured: remindersConfigured(audit) };
  } else result = await dispatch(config, configPath);
  return saveStatus(config, result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await schedulerCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 3;
  } catch {
    // Never echo provider exceptions, credential values or raw rosters.
    process.stderr.write('Pizza Core scheduler failed before a safe receipt; inspect task history and journal.\n');
    process.exitCode = 1;
  }
}
