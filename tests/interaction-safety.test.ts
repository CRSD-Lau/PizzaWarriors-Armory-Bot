import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MessageFlags, type ButtonInteraction, type Interaction } from "discord.js";
import { collectSuccessful, handleInteractionSafely, OperationAdmission, updateAfterAcknowledgement } from "../src/interaction-safety.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function verifyErrorContainment(): Promise<void> {
  const expectedError = new Error("simulated request failure");
  for (const [state, expectedMethod] of [
    [{}, "reply"],
    [{ deferred: true, ephemeral: true }, "editReply"],
    [{ replied: true }, "followUp"],
    [{ deferred: true }, "followUp"],
    [{ autocomplete: true }, "respond"],
    [{ autocomplete: true, responded: true }, undefined],
  ] as const) {
    const calls: Array<{ method: string; message: unknown }> = [];
    const logs: unknown[] = [];
    const capture = (method: string) => async (message: unknown) => { calls.push({ method, message }); };
    const interaction = {
      deferred: false, replied: false, ephemeral: false, responded: false,
      ...state,
      isAutocomplete: () => "autocomplete" in state,
      isRepliable: () => !("autocomplete" in state),
      reply: capture("reply"), editReply: capture("editReply"),
      followUp: capture("followUp"), respond: capture("respond"),
    } as unknown as Interaction;
    await handleInteractionSafely(interaction, async () => { throw expectedError; }, (_message, error) => logs.push(error));
    assert.deepEqual(logs, [expectedError]);
    assert.equal(calls.length, expectedMethod ? 1 : 0);
    if (!expectedMethod) continue;
    assert.equal(calls[0].method, expectedMethod);
    if (expectedMethod === "respond") assert.deepEqual(calls[0].message, []);
    else {
      const message = calls[0].message as { content: string; flags?: number; allowedMentions: unknown };
      assert.ok(!message.content.includes(expectedError.message), "internal error details must not reach Discord");
      assert.deepEqual(message.allowedMentions, { parse: [] });
      if (expectedMethod !== "editReply") assert.equal(message.flags, MessageFlags.Ephemeral);
    }
  }

  const logs: unknown[] = [];
  const responseError = new Error("Unknown interaction");
  let attempts = 0;
  const expired = {
    isAutocomplete: () => false, isRepliable: () => true,
    deferred: false, replied: false,
    reply: async () => { attempts++; throw responseError; },
  } as unknown as Interaction;
  await handleInteractionSafely(expired, async (interaction) => {
    if (interaction.isRepliable()) await interaction.reply("Initial acknowledgement");
  }, (_message, error) => logs.push(error));
  assert.equal(attempts, 2, "failed initial and fallback replies must stop after one fallback");
  assert.deepEqual(logs, [responseError, responseError]);
  await handleInteractionSafely(expired, async () => { throw expectedError; }, () => { throw new Error("logger unavailable"); });
}

async function verifyEarlyAcknowledgement(): Promise<void> {
  const acknowledgement = deferred<void>();
  const order: string[] = [];
  const interaction = {
    deferUpdate: async () => { order.push("acknowledge"); await acknowledgement.promise; },
    editReply: async (message: unknown) => { assert.deepEqual(message, { content: "next page" }); order.push("update"); },
  } as unknown as Pick<ButtonInteraction, "deferUpdate" | "editReply">;
  const request = updateAfterAcknowledgement(interaction, async () => {
    order.push("fetch and render");
    return { content: "next page" };
  });
  assert.deepEqual(order, ["acknowledge"]);
  acknowledgement.resolve();
  await request;
  assert.deepEqual(order, ["acknowledge", "fetch and render", "update"]);

  let workStarted = false;
  await assert.rejects(updateAfterAcknowledgement({
    deferUpdate: async () => { throw new Error("acknowledgement failed"); },
    editReply: async () => { throw new Error("must not update"); },
  } as unknown as Pick<ButtonInteraction, "deferUpdate" | "editReply">, async () => {
    workStarted = true;
    return {};
  }), /acknowledgement failed/);
  assert.equal(workStarted, false, "failed acknowledgement must not start expensive work");
}

async function verifyAdmission(): Promise<void> {
  const admission = new OperationAdmission(4);
  const work = Array.from({ length: 4 }, () => deferred<void>());
  let started = 0;
  let busy = 0;
  const requests = work.map((pending, index) => admission.run(`user-${index}`, async () => {
    started++;
    await pending.promise;
  }, async () => { busy++; }));
  await admission.run("user-0", async () => { started++; }, async () => { busy++; });
  await admission.run("user-4", async () => { started++; }, async () => { busy++; });
  assert.equal(started, 4);
  assert.equal(busy, 2, "duplicate users and a fifth active operation must be rejected promptly");
  work[0].reject(new Error("browser failed"));
  await assert.rejects(requests[0], /browser failed/);
  await admission.run("user-0", async () => { started++; }, async () => { busy++; });
  assert.equal(started, 5, "failed work must release its user and capacity");
  work.slice(1).forEach((pending) => pending.resolve());
  await Promise.all(requests.slice(1));
}

async function verifyBoundedDiscovery(): Promise<void> {
  let active = 0;
  let maximum = 0;
  const values = await collectSuccessful(Array.from({ length: 12 }, (_, index) => index), async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await setImmediate();
      if (value === 1 || value === 8) throw new Error("unavailable candidate");
      return value;
    } finally { active--; }
  }, 3);
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.deepEqual(values, [0, 2, 3, 4, 5, 6, 7, 9, 10, 11]);
}

await verifyErrorContainment();
await verifyEarlyAcknowledgement();
await verifyAdmission();
await verifyBoundedDiscovery();
console.log("Discord interaction resilience tests passed.");
