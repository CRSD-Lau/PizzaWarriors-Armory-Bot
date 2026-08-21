import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { auditGearPreparation, type GearPreparationAudit } from "./gear-audit.js";
import { calculateGearScore, type GearScoreSummary } from "./gearscore.js";
import { WarmaneArmory, type ArmoryCharacter } from "./armory.js";

const RAID_HELPER_API = "https://raid-helper.xyz/api/v4/events";
const LINKS_FILE = join(process.cwd(), "data", "raider-links.json");
const RECENT_EVENTS_FILE = join(process.cwd(), "data", "recent-ready-events.json");
const CORE_EVENT_KEY = "pizzacoreicc25";

export type RaiderLink = { name: string; realm: string };
export type RaidAttendance = "Signed" | "Late" | "Tentative" | "Bench" | "Absent";
export type RaidRole = "Tanks" | "Healers" | "Melee" | "Ranged";
export type RaidSignup = { discordUserId: string; displayName: string; reportedClass?: string; reportedSpec?: string; reportedRole?: RaidRole; status: RaidAttendance };
export type ReadyMember = {
  signup: RaidSignup;
  /** The character name resolved in Armory; the card always presents the event signup name. */
  characterName: string;
  className?: string;
  specName?: string;
  summary: GearScoreSummary;
  preparation: GearPreparationAudit;
  armoryUrl: string;
};
export type ReadyReport = {
  eventId: string;
  eventTitle: string;
  signups: RaidSignup[];
  activeSignups: RaidSignup[];
  members: ReadyMember[];
  unresolved: Array<{ signup: RaidSignup; reason: string }>;
};

type LinkStore = Record<string, RaiderLink>;
export type RecentReadyEvent = { eventId: string; title: string; usedAt: number };
type RecentEventStore = Record<string, RecentReadyEvent[]>;

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

const characterClasses: Record<string, string> = {
  deathknight: "Death Knight",
  druid: "Druid",
  hunter: "Hunter",
  mage: "Mage",
  paladin: "Paladin",
  priest: "Priest",
  rogue: "Rogue",
  shaman: "Shaman",
  warlock: "Warlock",
  warrior: "Warrior",
};

function characterClassForValue(value?: string): string | undefined {
  if (!value) return undefined;
  return characterClasses[value.toLowerCase().replace(/[^a-z]/g, "")];
}

function attendanceForValue(value?: string): RaidAttendance | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized.includes("bench")) return "Bench";
  if (normalized.includes("late")) return "Late";
  if (normalized.includes("tentative")) return "Tentative";
  if (normalized.includes("absence") || normalized.includes("absent") || normalized.includes("declined")) return "Absent";
  if (normalized.includes("sign") || normalized === "primary") return "Signed";
  return undefined;
}

function attendanceForRecord(record: Record<string, unknown>, inheritedStatus?: RaidAttendance, objectKey?: string): RaidAttendance {
  // Raid-Helper v4 identifies Bench, Tentative, Late, and Absence using the
  // selected event class. Its `status: primary` means this is the member's
  // primary signup—not that they are an active raider.
  return attendanceForValue(firstText(record, ["cClassName", "className"]))
    ?? attendanceForValue(firstText(record, ["status", "signup_status"]))
    ?? attendanceForValue(objectKey)
    ?? inheritedStatus
    ?? "Signed";
}

function statusForKey(key?: string): RaidAttendance | undefined {
  return attendanceForValue(key);
}

function extractSpec(record: Record<string, unknown>): string | undefined {
  const direct = firstText(record, ["cSpecName", "specName", "spec", "specialization", "role"]);
  if (direct) return direct;
  const values = record.specs;
  if (Array.isArray(values)) {
    const names = values.map((value) => typeof value === "string" ? value : isRecord(value) ? firstText(value, ["name", "spec", "title"]) : undefined).filter((value): value is string => Boolean(value));
    return names.length ? names.join(" / ") : undefined;
  }
  return undefined;
}

function normalizeRaidRole(value?: string): RaidRole | undefined {
  const normalized = value?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (normalized === "tank" || normalized === "tanks") return "Tanks";
  if (normalized === "healer" || normalized === "healers" || normalized === "heal") return "Healers";
  if (normalized === "melee" || normalized === "meleedps") return "Melee";
  if (normalized === "ranged" || normalized === "rangedps") return "Ranged";
  return undefined;
}

function roleForSpec(value?: string): RaidRole | undefined {
  const spec = value?.toLowerCase().replace(/[\s_-]+/g, "").replace(/\d+$/, "");
  if (!spec) return undefined;
  if (/^(protection|bloodtank|feraltank|guardian)$/.test(spec)) return "Tanks";
  if (/^(holy|discipline|restoration|resto)$/.test(spec)) return "Healers";
  if (/^(arms|fury|retribution|assassination|combat|subtlety|enhancement|unholy|feral|feralcat)$/.test(spec)) return "Melee";
  if (/^(balance|elemental|shadow|arcane|fire|affliction|demonology|destruction|beastmastery|marksmanship|marksman|survival)$/.test(spec)) return "Ranged";
  return undefined;
}

function extractRole(record: Record<string, unknown>, reportedSpec?: string): RaidRole | undefined {
  return normalizeRaidRole(firstText(record, ["cRoleName", "roleName", "role_name", "raidRole"])) ?? roleForSpec(reportedSpec);
}

/** Interpret Raid-Helper's public event response without relying on one template layout. */
export function parseRaidHelperSignups(payload: unknown): RaidSignup[] {
  const found = new Map<string, RaidSignup>();
  const walk = (value: unknown, inheritedStatus?: RaidAttendance, objectKey?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => walk(entry, inheritedStatus));
      return;
    }
    if (!isRecord(value)) return;
    const status = attendanceForRecord(value, inheritedStatus, objectKey);
    const discordUserId = firstText(value, ["entity_id", "entityId", "user_id", "userId", "member_id", "memberId", "discord_id", "discordId"])
      ?? (objectKey && /^\d{16,22}$/.test(objectKey) ? objectKey : undefined);
    const displayName = firstText(value, ["name", "display_name", "displayName", "nickname", "username", "character", "character_name"]);
    if (discordUserId && displayName) {
      const reportedClass = characterClassForValue(firstText(value, ["cClassName", "className"]));
      const reportedSpec = extractSpec(value);
      const reportedRole = extractRole(value, reportedSpec);
      found.set(discordUserId, { discordUserId, displayName, ...(reportedClass ? { reportedClass } : {}), ...(reportedSpec ? { reportedSpec } : {}), ...(reportedRole ? { reportedRole } : {}), status });
    }
    for (const [key, child] of Object.entries(value)) walk(child, statusForKey(key) ?? status, key);
  };
  walk(payload);
  return [...found.values()];
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

/** Remembers a small, per-guild event list for `/ready` and autocomplete. */
export class RecentReadyEvents {
  private store?: RecentEventStore;

  private async load(): Promise<RecentEventStore> {
    if (this.store) return this.store;
    try { this.store = JSON.parse(await readFile(RECENT_EVENTS_FILE, "utf8")) as RecentEventStore; }
    catch { this.store = {}; }
    return this.store;
  }

  private isCoreEvent(event: Pick<RecentReadyEvent, "title">): boolean {
    return event.title.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(CORE_EVENT_KEY);
  }

  async core(guildId: string): Promise<RecentReadyEvent | undefined> {
    return (await this.load())[guildId]?.find((event) => this.isCoreEvent(event));
  }

  async listCore(guildId: string): Promise<RecentReadyEvent[]> {
    return ((await this.load())[guildId] ?? []).filter((event) => this.isCoreEvent(event));
  }

  /** Other Raid-Helper events must never replace the Pizza Core default. */
  async rememberCore(guildId: string, event: Pick<RecentReadyEvent, "eventId" | "title">): Promise<void> {
    if (!this.isCoreEvent(event)) return;
    const store = await this.load();
    const previous = store[guildId] ?? [];
    store[guildId] = [{ ...event, usedAt: Date.now() }, ...previous.filter((entry) => entry.eventId !== event.eventId)].slice(0, 12);
    await mkdir(dirname(RECENT_EVENTS_FILE), { recursive: true });
    await writeFile(RECENT_EVENTS_FILE, JSON.stringify(store, null, 2));
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
  // Bench, tentative, and absent members are intentionally retained in the
  // report, but are not sent through Armory just to calculate raid readiness.
  // Late attendees remain in the live roster because they are still committed.
  const activeSignups = event.signups.filter((signup) => signup.status === "Signed" || signup.status === "Late");
  const results = await concurrentMap(activeSignups, 4, async (signup) => {
    const link = await input.links.get(input.guildId, signup.discordUserId);
    const directCharacterName = signup.displayName;
    try {
      let characterName = directCharacterName;
      let realm = input.realm;
      let character: ArmoryCharacter;
      try {
        character = await input.armory.getCharacterSummary(characterName, realm);
      } catch (directError) {
        // The event name is always the first and preferred Armory lookup. A
        // voluntary /raider link exists only as a fallback for Discord names
        // that are not the character's actual Armory name.
        if (!link || (link.name === directCharacterName && link.realm === realm)) throw directError;
        characterName = link.name;
        realm = link.realm;
        character = await input.armory.getCharacterSummary(characterName, realm);
      }
      const summary = calculateGearScore(character.items);
      if (!summary) throw new Error("insufficient equipped-item data");
      return { kind: "member" as const, member: { signup, characterName, className: signup.reportedClass ?? character.className, specName: signup.reportedSpec ?? "No event spec selected", summary, preparation: character.gearAudit ?? auditGearPreparation(character.items), armoryUrl: character.armoryUrl } };
    } catch (error) {
      return { kind: "unresolved" as const, unresolved: { signup, reason: error instanceof Error ? error.message : "armory lookup failed" } };
    }
  });
  return {
    eventId: event.eventId,
    eventTitle: event.title,
    signups: event.signups,
    activeSignups,
    members: results.filter((result): result is Extract<typeof result, { kind: "member" }> => result.kind === "member").map((result) => result.member),
    unresolved: results.filter((result): result is Extract<typeof result, { kind: "unresolved" }> => result.kind === "unresolved").map((result) => result.unresolved),
  };
}
