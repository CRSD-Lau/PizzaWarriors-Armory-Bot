import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./json-store.js";
import type { GearItem, GearScoreEquipLoc } from "./gearscore.js";

export type MetadataFields = Partial<Pick<GearItem, "name" | "itemLevel" | "quality" | "equipLoc" | "socketCount">>;
export type ItemMetadata = Pick<GearItem, "name" | "itemLevel" | "quality" | "equipLoc" | "socketCount"> & { fetchedAt: number };
type CacheEntry = MetadataFields & { fetchedAt: number; complete: boolean; retryAfter?: number };
type CacheFile = { items: Record<string, CacheEntry> };
const CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const RETRY_INTERVAL_MS = 60_000;
const qualities = new Set(["poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom"]);
const equipLocations = new Set<string>([
  "INVTYPE_RELIC", "INVTYPE_TRINKET", "INVTYPE_2HWEAPON", "INVTYPE_WEAPONMAINHAND", "INVTYPE_WEAPONOFFHAND",
  "INVTYPE_RANGED", "INVTYPE_THROWN", "INVTYPE_RANGEDRIGHT", "INVTYPE_SHIELD", "INVTYPE_WEAPON", "INVTYPE_HOLDABLE",
  "INVTYPE_HEAD", "INVTYPE_NECK", "INVTYPE_SHOULDER", "INVTYPE_CHEST", "INVTYPE_ROBE", "INVTYPE_WAIST", "INVTYPE_LEGS",
  "INVTYPE_FEET", "INVTYPE_WRIST", "INVTYPE_HAND", "INVTYPE_FINGER", "INVTYPE_CLOAK", "INVTYPE_BODY", "INVTYPE_TABARD",
]);

export function decodeHtmlText(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|apos|gt|lt|quot);/g, (entity, code: string) => {
    if (code.startsWith("#")) {
      const base = code[1].toLowerCase() === "x" ? 16 : 10;
      const point = Number.parseInt(code.slice(base === 16 ? 2 : 1), base);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
    }
    return named[code] ?? entity;
  });
}

export function parseMetadata(html: string, includeSocketCount: boolean): MetadataFields {
  const title = html.match(/<title>([^<]+?)\s*(?:[-–]|\|)\s*(?:Item|WoW)/i)?.[1]?.trim();
  const itemLevel = Number(html.match(/Item Level\s*(\d{1,3})/i)?.[1] ?? 0) || undefined;
  const qualityNames = ["poor", "common", "uncommon", "rare", "epic", "legendary", "artifact", "heirloom"];
  const quality = qualityNames[Number(html.match(/class=["'][^"']*\bq([0-7])\b/i)?.[1])];
  const slotText = html.match(/<th[^>]*>\s*Slot\s*<\/th>\s*<td[^>]*>([^<]+)/i)?.[1]
    ?? html.match(/<b[^>]*class=["'][^"']*\bq[0-7]\b[^"']*["'][^>]*>.*?<\/b>[\s\S]*?<tr><td[^>]*>([^<]+)/i)?.[1];
  const freeText: Record<string, GearScoreEquipLoc> = {
    "held in off-hand": "INVTYPE_HOLDABLE", "main hand": "INVTYPE_WEAPONMAINHAND", "off hand": "INVTYPE_WEAPONOFFHAND",
    "two-hand": "INVTYPE_2HWEAPON", "one-hand": "INVTYPE_WEAPON", shield: "INVTYPE_SHIELD", ranged: "INVTYPE_RANGED",
    relic: "INVTYPE_RELIC", head: "INVTYPE_HEAD", neck: "INVTYPE_NECK", shoulder: "INVTYPE_SHOULDER", back: "INVTYPE_CLOAK",
    chest: "INVTYPE_CHEST", wrist: "INVTYPE_WRIST", hands: "INVTYPE_HAND", waist: "INVTYPE_WAIST", legs: "INVTYPE_LEGS",
    feet: "INVTYPE_FEET", finger: "INVTYPE_FINGER", trinket: "INVTYPE_TRINKET", shirt: "INVTYPE_BODY", tabard: "INVTYPE_TABARD",
  };
  const equipLoc = Object.entries(freeText).find(([needle]) => slotText?.toLowerCase().includes(needle))?.[1];
  // A generic HTML/error page is not evidence that an item has zero sockets.
  const socketCount = includeSocketCount && title && itemLevel && quality && equipLoc
    ? [...html.matchAll(/class=["'][^"']*\bsocket-(?:meta|red|yellow|blue|prismatic)\b[^"']*["']/gi)].length
    : undefined;
  return { name: title ? decodeHtmlText(title) : undefined, itemLevel, quality, equipLoc, ...(socketCount !== undefined ? { socketCount } : {}) };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Ignore undefined/invalid provider fields so a partial page cannot erase valid metadata. */
export function validMetadata(value: unknown): MetadataFields {
  if (!record(value)) return {};
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const quality = typeof value.quality === "string" ? value.quality.toLowerCase() : "";
  return {
    ...(name && !/^Item \d+$/.test(name) ? { name } : {}),
    ...(typeof value.itemLevel === "number" && Number.isFinite(value.itemLevel) && value.itemLevel > 0 ? { itemLevel: value.itemLevel } : {}),
    ...(qualities.has(quality) ? { quality } : {}),
    ...(typeof value.equipLoc === "string" && equipLocations.has(value.equipLoc) ? { equipLoc: value.equipLoc as GearScoreEquipLoc } : {}),
    ...(typeof value.socketCount === "number" && Number.isInteger(value.socketCount) && value.socketCount >= 0 ? { socketCount: value.socketCount } : {}),
  };
}

export function completeMetadata(value: MetadataFields): boolean {
  return Boolean(value.name && value.itemLevel && value.quality && value.equipLoc);
}

/** Earlier successful sources win; stale cache is merged separately, underneath fresh data. */
export function mergeMetadataSources(preferred: MetadataFields, fallback: MetadataFields): MetadataFields {
  return { ...validMetadata(fallback), ...validMetadata(preferred) };
}

/** A disposable item cache; fallback display values are never persisted as verified item facts. */
export class ItemMetadataCache {
  private loadPromise?: Promise<CacheFile>;
  private writeQueue = Promise.resolve();
  private readonly inFlight = new Map<number, Promise<CacheEntry>>();
  private readonly now: () => number;
  private readonly read: () => Promise<unknown>;
  private readonly write: (value: CacheFile) => Promise<void>;

  constructor(
    filePath: string,
    private readonly fetchMetadata: (id: number, requireSocketCount: boolean) => Promise<MetadataFields>,
    options: { now?: () => number; read?: () => Promise<unknown>; write?: (value: CacheFile) => Promise<void> } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.read = options.read ?? (async () => JSON.parse(await readFile(filePath, "utf8")) as unknown);
    this.write = options.write ?? ((value) => atomicWriteJson(filePath, value));
  }

  private load(): Promise<CacheFile> {
    this.loadPromise ??= (async () => {
      const items: Record<string, CacheEntry> = {};
      try {
        const payload = await this.read();
        if (record(payload) && record(payload.items)) {
          for (const [id, value] of Object.entries(payload.items)) {
            if (!/^\d+$/.test(id) || !record(value)) continue;
            const fields = validMetadata(value);
            const fetchedAt = typeof value.fetchedAt === "number" && Number.isFinite(value.fetchedAt) ? value.fetchedAt : 0;
            items[id] = { ...fields, fetchedAt, complete: value.complete !== false && completeMetadata(fields) };
          }
        }
      } catch {
        // This contains only reproducible public item facts, never private guild state.
      }
      return { items };
    })();
    return this.loadPromise;
  }

  async get(id: number, fallbackEquipLoc?: GearScoreEquipLoc, fallbackName?: string, requireSocketCount = false): Promise<ItemMetadata> {
    const cache = await this.load();
    const cached = cache.items[String(id)];
    const now = this.now();
    let entry = cached;
    const fresh = cached?.complete && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < CACHE_AGE_MS
      && (!requireSocketCount || cached.socketCount !== undefined);
    if (!fresh && !(cached?.retryAfter && cached.retryAfter > now)) {
      let request = this.inFlight.get(id);
      if (!request) {
        request = this.refresh(cache, id, requireSocketCount);
        this.inFlight.set(id, request);
      }
      try { entry = await request; }
      finally { if (this.inFlight.get(id) === request) this.inFlight.delete(id); }
    }
    const equipLoc = entry?.equipLoc ?? fallbackEquipLoc;
    return {
      name: entry?.name ?? fallbackName ?? `Item ${id}`,
      itemLevel: entry?.itemLevel ?? 0,
      quality: entry?.quality ?? "epic",
      ...(equipLoc ? { equipLoc } : {}),
      ...(entry?.socketCount !== undefined ? { socketCount: entry.socketCount } : {}),
      fetchedAt: entry?.fetchedAt ?? 0,
    };
  }

  private async refresh(cache: CacheFile, id: number, requireSocketCount: boolean): Promise<CacheEntry> {
    let fresh: MetadataFields;
    try { fresh = validMetadata(await this.fetchMetadata(id, requireSocketCount)); }
    catch { fresh = {}; }
    const cached = cache.items[String(id)];
    const now = this.now();
    const refreshed = completeMetadata(fresh);
    const entry: CacheEntry = {
      ...mergeMetadataSources(fresh, cached ?? {}),
      // A failed/partial refresh must not renew the age of stale facts.
      fetchedAt: refreshed ? now : cached?.fetchedAt ?? 0,
      complete: refreshed || cached?.complete === true,
      ...(!refreshed || (requireSocketCount && fresh.socketCount === undefined) ? { retryAfter: now + RETRY_INTERVAL_MS } : {}),
    };
    cache.items[String(id)] = entry;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(() => this.write(cache));
    // Cache persistence is an optimization: a disk error must not discard fetched gear.
    await this.writeQueue.catch(() => console.warn("Item metadata cache could not be saved; using the fetched data in memory."));
    return entry;
  }
}
