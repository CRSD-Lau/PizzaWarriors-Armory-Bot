import { MessageFlags, type ButtonInteraction, type Interaction, type InteractionEditReplyOptions } from "discord.js";

type ErrorLogger = (message: string, error: unknown) => void;
const FAILURE_MESSAGE = "I could not complete that request. Please try again in a moment.";

/** Acknowledge paging before any network request or browser render can expire the interaction. */
export async function updateAfterAcknowledgement(
  interaction: Pick<ButtonInteraction, "deferUpdate" | "editReply">,
  buildMessage: () => Promise<InteractionEditReplyOptions>,
): Promise<void> {
  await interaction.deferUpdate();
  await interaction.editReply(await buildMessage());
}

/** Discord event listeners do not await async callbacks. Keep every rejection local. */
export async function handleInteractionSafely(
  interaction: Interaction,
  handler: (interaction: Interaction) => Promise<void>,
  logger: ErrorLogger = console.error,
): Promise<void> {
  const log = (message: string, error: unknown) => {
    // Even an unavailable logging destination must not reject an event callback.
    try { logger(message, error); } catch { /* No further reporting destination. */ }
  };
  try {
    await handler(interaction);
  } catch (error) {
    log("Discord interaction failed", error);
    try {
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await interaction.respond([]);
      } else if (interaction.isRepliable()) {
        const message = { content: FAILURE_MESSAGE, allowedMentions: { parse: [] as never[] } };
        if (interaction.deferred && interaction.ephemeral && !interaction.replied) {
          await interaction.editReply(message);
        } else if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ ...message, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ ...message, flags: MessageFlags.Ephemeral });
        }
      }
    } catch (responseError) {
      // An expired interaction or disconnected gateway can also reject its error reply.
      log("Discord interaction error response failed", responseError);
    }
  }
}

/** Bound expensive work without building a queue behind the serial browser workers. */
export class OperationAdmission {
  private readonly activeUsers = new Set<string>();

  constructor(private readonly maximum = 4) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Operation limit must be a positive integer.");
  }

  async run(userId: string, operation: () => Promise<void>, onBusy: () => Promise<void>): Promise<void> {
    if (this.activeUsers.has(userId) || this.activeUsers.size >= this.maximum) {
      await onBusy();
      return;
    }
    this.activeUsers.add(userId);
    try {
      await operation();
    } finally {
      this.activeUsers.delete(userId);
    }
  }
}

/** Resolve independent discovery candidates at a fixed concurrency, retaining successes. */
export async function collectSuccessful<T, R>(
  items: readonly T[],
  operation: (item: T) => Promise<R>,
  concurrency = 3,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  const results: Array<{ value: R } | undefined> = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { value: await operation(items[index]) }; }
      catch { /* One inaccessible event must not hide the other candidates. */ }
    }
  }));
  return results.flatMap((result) => result ? [result.value] : []);
}
