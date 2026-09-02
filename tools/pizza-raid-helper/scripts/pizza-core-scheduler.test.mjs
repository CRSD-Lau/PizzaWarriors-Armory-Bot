// Author and last modified by: Neil Mitchell.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dispatch, retryable, selectPhase, schedulerCli, remindersConfigured } from "./pizza-core-scheduler.mjs";

for (const [unsigned, attendee, expected] of [[true, true, true], [true, false, false], [false, true, false]]) {
  test(`read-only reminder status requires both 30-minute settings: ${unsigned}/${attendee}`, () => {
    assert.equal(remindersConfigured({ currentEvent: { reminder: { explicitThirtyMinuteUnsigned: unsigned, explicitThirtyMinuteAttendee: attendee } } }), expected);
    assert.equal(remindersConfigured({}), false);
  });
}

// This file contains only inert synthetic bindings; no local production config or credentials.
const raw = JSON.parse(await readFile(new URL("../config.pizza-core.example.json", import.meta.url), "utf8"));
const dates = [
  ["2026-09-05T02:00:00Z", "start-native"], ["2026-09-05T02:30:00Z", "start-native"],
  ["2026-09-05T02:30:01Z", null], ["2026-09-05T06:00:00Z", "apply"],
  ["2026-09-05T18:00:00Z", "apply"], ["2026-09-05T18:00:01Z", null],
  ["2026-11-07T03:00:00Z", "start-native"], ["2026-11-07T07:00:00Z", "apply"],
  ["2027-03-20T02:00:00Z", "start-native"], ["2027-03-20T06:00:00Z", "apply"],
  ["2026-09-02T06:00:00Z", null], ["2026-09-04T02:00:00Z", null]
];
for (const [at, command] of dates) test(`dispatch real calendar ${at} => ${command}`, () => assert.equal(selectPhase(raw, at).command, command));

test("off-window boot before first raid never invokes provider code", async () => {
  const result = await dispatch(raw, "unused.json", { clock: () => "2026-09-02T06:00:00Z", invoke: () => assert.fail("unexpected invocation") });
  assert.equal(result.outcome, "scheduled-noop");
});
test("late boot reports incomplete cycle, but does not backfill", async () => {
  const result = await dispatch(raw, "unused.json", { clock: () => "2026-09-06T06:00:00Z", readJournal: async () => ({ cycles: {} }), invoke: () => assert.fail("unexpected invocation") });
  assert.equal(result.outcome, "missed-window-needs-review");
  assert.equal(result.ok, false);
});
test("completed prior occurrence is a no-op after recovery window", async () => {
  const result = await dispatch(raw, "unused.json", { clock: () => "2026-09-06T06:00:00Z", readJournal: async () => ({ cycles: { "2026-09-04": { phase: "complete" } } }) });
  assert.equal(result.outcome, "scheduled-noop");
});
test("transient failure is bounded and retried via runner without simulated clock", async () => {
  let calls = 0;
  const result = await dispatch(raw, "profile.json", { clock: () => "2026-09-05T06:00:00Z", sleep: async () => {}, invoke: async (args) => {
    assert.deepEqual(args, ["apply", "--config", "profile.json"]);
    calls++;
    throw Object.assign(new Error("withheld"), { code: "PROVIDER_HTTP_ERROR", details: { status: 503 } });
  } });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
});
test("uncertain create and permanent drift never retry", async () => {
  for (const error of [{ code: "CREATE_OUTCOME_UNCERTAIN" }, { code: "EVENT_DRIFT" }, { code: "PROVIDER_HTTP_ERROR", uncertain: true, details: { status: 503 } }, { code: "ROLLOVER_LOCKED" }]) {
    let calls = 0;
    const result = await dispatch(raw, "profile.json", { clock: () => "2026-09-05T06:00:00Z", invoke: async () => { calls++; throw error; } });
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.equal(retryable(error), false);
  }
});
test("partial native end remains partial, never reported complete", async () => {
  const result = await dispatch(raw, "profile.json", { clock: () => "2026-09-05T06:00:00Z", invoke: async () => ({ ok: false, outcome: "rolled-over-native-end-pending" }) });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "rolled-over-native-end-pending");
});
test("a retry cannot cross a recovery window or change occurrence", async () => {
  const times = ["2026-09-05T02:29:59Z", "2026-09-05T02:29:59Z", "2026-09-05T02:30:01Z"];
  let calls = 0;
  const result = await dispatch(raw, "profile.json", { clock: () => times.shift(), sleep: async () => {}, invoke: async () => { calls++; throw { code: "PROVIDER_HTTP_ERROR", details: { status: 429 } }; } });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "recovery-window-expired");
});
test("scheduler CLI rejects --at before reading or writing anything", async () => {
  await assert.rejects(schedulerCli(["--at", "2026-09-05T06:00:00Z"]), /Unsupported scheduler option/);
});
