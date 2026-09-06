import { join } from "node:path";
import { JsonStore } from "./json-store.js";

const LINKS_FILE = join(process.cwd(), "data", "raider-links.json");
const RECENT_EVENTS_FILE = join(process.cwd(), "data", "recent-ready-events.json");
const CORE_EVENT_KEY = "pizzacoreicc25";

export type RaiderLink = { name: string; realm: string };
export type RecentReadyEvent = { eventId: string; title: string; usedAt: number };
type LinkStore = Record<string, RaiderLink>;
type RecentEventStore = Record<string, RecentReadyEvent[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDiscordId(value: unknown): value is string {
  return typeof value === "string" && /^\d{16,22}$/.test(value);
}

function parseLinks(value: unknown): LinkStore {
  if (!isRecord(value)) throw new Error("Invalid raider links schema.");
  for (const [key, link] of Object.entries(value)) {
    if (!/^\d{16,22}:\d{16,22}$/.test(key) || !isRecord(link)
      || typeof link.name !== "string" || !link.name.trim()
      || typeof link.realm !== "string" || !link.realm.trim()) throw new Error("Invalid raider link.");
  }
  return value as LinkStore;
}

function parseEvents(value: unknown): RecentEventStore {
  if (!isRecord(value)) throw new Error("Invalid recent events schema.");
  for (const [guildId, events] of Object.entries(value)) {
    if (!validDiscordId(guildId) || !Array.isArray(events)) throw new Error("Invalid recent events guild.");
    for (const event of events) {
      if (!isRecord(event) || !validDiscordId(event.eventId)
        || typeof event.title !== "string" || !event.title.trim()
        || typeof event.usedAt !== "number" || !Number.isFinite(event.usedAt)) throw new Error("Invalid recent event.");
    }
  }
  return value as RecentEventStore;
}

export function isPizzaCoreEventTitle(title: string): boolean {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(CORE_EVENT_KEY);
}

export class RaiderLinks {
  private readonly store: JsonStore<LinkStore>;

  constructor(filePath = LINKS_FILE) {
    this.store = new JsonStore(filePath, parseLinks, () => ({}));
  }

  async get(guildId: string, discordUserId: string): Promise<RaiderLink | undefined> {
    return (await this.store.read())[`${guildId}:${discordUserId}`];
  }

  async set(guildId: string, discordUserId: string, link: RaiderLink): Promise<void> {
    await this.store.update((store) => {
      store[`${guildId}:${discordUserId}`] = { ...link };
    });
  }

  async remove(guildId: string, discordUserId: string): Promise<boolean> {
    return this.store.update((store) => {
      const key = `${guildId}:${discordUserId}`;
      if (!store[key]) return false;
      delete store[key];
      return true;
    });
  }
}

/** Remembers a small, per-guild event list for `/ready` and autocomplete. */
export class RecentReadyEvents {
  private readonly store: JsonStore<RecentEventStore>;

  constructor(filePath = RECENT_EVENTS_FILE) {
    this.store = new JsonStore(filePath, parseEvents, () => ({}));
  }

  async core(guildId: string): Promise<RecentReadyEvent | undefined> {
    return (await this.store.read())[guildId]?.find((event) => isPizzaCoreEventTitle(event.title));
  }

  async listCore(guildId: string): Promise<RecentReadyEvent[]> {
    return ((await this.store.read())[guildId] ?? []).filter((event) => isPizzaCoreEventTitle(event.title));
  }

  /** Other Raid-Helper events must never replace the Pizza Core default. */
  async rememberCore(guildId: string, event: Pick<RecentReadyEvent, "eventId" | "title">): Promise<void> {
    if (!isPizzaCoreEventTitle(event.title)) return;
    await this.store.update((store) => {
      const previous = store[guildId] ?? [];
      store[guildId] = [{ ...event, usedAt: Date.now() }, ...previous.filter((entry) => entry.eventId !== event.eventId)].slice(0, 12);
    });
  }
}
