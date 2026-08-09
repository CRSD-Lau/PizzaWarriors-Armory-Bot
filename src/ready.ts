import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { calculateGearScore, type GearScoreSummary } from "./gearscore.js";
import { WarmaneArmory } from "./armory.js";

const RAID_HELPER_API = "https://raid-helper.xyz/api/v4/events";
const LINKS_FILE = join(process.cwd(), "data", "raider-links.json");

export type RaiderLink = { name: string; realm: string };
export type RaidSignup = { discordUserId: string; displayName: string; reportedSpec?: string; status: string };
export type ReadyMember = {
  signup: RaidSignup;
  characterName: string;
  className?: string;
  specName?: string;
  summary: GearScoreSummary;
  armoryUrl: string;
};
export type ReadyReport = {
  eventId: string;
  eventTitle: string;
  signups: RaidSignup[];
  members: ReadyMember[];
  unresolved: Array<{ signup: RaidSignup; reason: string }>;
};

type LinkStore = Record<string, RaiderLink>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function statusForKey(key?: string): string | undefined {
  if (!key) return undefined;
  const value = key.toLowerCase();
  if (value.includes("bench")) return "Bench";
  if (value.includes("late")) return "Late";
  if (value.includes("tentative")) return "Tentative";
  if (value.includes("absence") || value.includes("declined")) return "Absent";
  if (value.includes("sign")) return "Signed";
  return undefined;
}

function extractSpec(record: Record<string, unknown>): string | undefined {
  const direct = firstText(record, ["spec", "specialization", "role"]);
  if (direct) return direct;
  const values = record.specs;
  if (Array.isArray(values)) {
    const names = values.map((value) => typeof value === "string" ? value : isRecord(value) ? firstText(value, ["name", "spec", "title"]) : undefined).filter((value): value is string => Boolean(value));
    return names.length ? names.join(" / ") : undefined;
  }
  return undefined;
}

/** Interpret Raid-Helper's public event response without relying on one template layout. */
export function parseRaidHelperSignups(payload: unknown): RaidSignup[] {
  const found = new Map<string, RaidSignup>();
  const walk = (value: unknown, inheritedStatus?: string, objectKey?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, inheritedStatus));
      return;
    }
    if (!isRecord(value)) return;
    const status = firstText(value, ["status", "signup_status"]) ?? statusForKey(objectKey) ?? inheritedStatus ?? "Signed";
    const discordUserId = firstText(value, ["entity_id", "entityId", "user_id", "userId", "member_id", "memberId", "discord_id", "discordId"])
      ?? (objectKey && /^\d{16,22}$/.test(objectKey) ? objectKey : undefined);
    const displayName = firstText(value, ["name", "display_name", "displayName", "nickname", "username", "character", "character_name"]);
    if (discordUserId && displayName) {
      found.set(discordUserId, { discordUserId, displayName, reportedSpec: extractSpec(value), status });
    }
    for (const [key, child] of Object.entries(value)) walk(child, statusForKey(key) ?? status, key);
  };
  walk(payload);
  return [...found.values()].filter((signup) => !/bench|late|tentative|absent|declined/i.test(signup.status));
}

function eventIdFromInput(value: string): string | undefined {
  const match = value.match(/\d{16,22}/);
  return match?.[0];
}

export async function getRaidHelperEvent(value: string): Promise<{ eventId: string; title: string; signups: RaidSignup[] }> {
  const eventId = eventIdFromInput(value);
  if (!eventId) throw new Error("Provide a Raid-Helper event message link or its copied Discord event ID.");
  const response = await fetch(`${RAID_HELPER_API}/${eventId}`, { headers: { accept: "application/json", "user-agent": "PizzaWarriorsArmoryBot/1.0" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Raid-Helper returned ${response.status} for that event.`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("Raid-Helper returned an unexpected event response.");
  const title = firstText(payload, ["title", "name", "event_name", "eventName"]) ?? "Raid readiness";
  return { eventId, title, signups: parseRaidHelperSignups(payload) };
}

export class RaiderLinks {
  private store?: LinkStore;

  private async load(): Promise<LinkStore> {
    if (this.store) return this.store;
    try { this.store = JSON.parse(await readFile(LINKS_FILE, "utf8")) as LinkStore; }
    catch { this.store = {}; }
    return this.store;
  }

  async get(guildId: string, discordUserId: string): Promise<RaiderLink | undefined> {
    return (await this.load())[`${guildId}:${discordUserId}`];
  }

  async set(guildId: string, discordUserId: string, link: RaiderLink): Promise<void> {
    const store = await this.load();
    store[`${guildId}:${discordUserId}`] = link;
    await mkdir(dirname(LINKS_FILE), { recursive: true });
    await writeFile(LINKS_FILE, JSON.stringify(store, null, 2));
  }

  async remove(guildId: string, discordUserId: string): Promise<boolean> {
    const store = await this.load();
    const key = `${guildId}:${discordUserId}`;
    if (!store[key]) return false;
    delete store[key];
    await mkdir(dirname(LINKS_FILE), { recursive: true });
    await writeFile(LINKS_FILE, JSON.stringify(store, null, 2));
    return true;
  }
}

async function concurrentMap<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

export async function buildReadyReport(input: { event: string; realm: string; guildId: string; armory: WarmaneArmory; links: RaiderLinks }): Promise<ReadyReport> {
  const event = await getRaidHelperEvent(input.event);
  const results = await concurrentMap(event.signups, 4, async (signup) => {
    const link = await input.links.get(input.guildId, signup.discordUserId);
    const characterName = link?.name ?? signup.displayName;
    const realm = link?.realm ?? input.realm;
    try {
      const character = await input.armory.getCharacter(characterName, realm);
      const summary = calculateGearScore(character.items);
      if (!summary) throw new Error("insufficient equipped-item data");
      return { kind: "member" as const, member: { signup, characterName, className: character.className, specName: signup.reportedSpec ?? character.primarySpec, summary, armoryUrl: character.armoryUrl } };
    } catch (error) {
      return { kind: "unresolved" as const, unresolved: { signup, reason: error instanceof Error ? error.message : "armory lookup failed" } };
    }
  });
  return {
    eventId: event.eventId,
    eventTitle: event.title,
    signups: event.signups,
    members: results.filter((result): result is Extract<typeof result, { kind: "member" }> => result.kind === "member").map((result) => result.member),
    unresolved: results.filter((result): result is Extract<typeof result, { kind: "unresolved" }> => result.kind === "unresolved").map((result) => result.unresolved),
  };
}
