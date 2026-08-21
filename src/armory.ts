import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { isRecoverableBrowserError, isTransientWarmaneProfileError } from "./browser-recovery.js";
import { config } from "./config.js";
import { auditGearPreparation, type GearPreparationAudit } from "./gear-audit.js";
import type { GearItem, GearScoreEquipLoc } from "./gearscore.js";

type EquippedSlot = { id: number; slot: string; fallbackEquipLoc: GearScoreEquipLoc; iconUrl?: string };
type ItemMetadata = Pick<GearItem, "name" | "itemLevel" | "quality" | "equipLoc" | "socketCount"> & { fetchedAt: number };
type Cache = { items: Record<string, ItemMetadata> };
type WarmaneApiEquipment = { name?: unknown; item?: unknown };
type WarmaneApiSummary = { class?: unknown; equipment?: unknown; talents?: unknown; error?: unknown };
type WarmaneHtmlEquipment = { id: number; enchantId?: number; gemIds: number[] };
type SummaryCacheEntry = { fetchedAt: number; character: ArmoryCharacter };
export type ArmoryCharacter = { armoryUrl: string; items: GearItem[]; portrait?: Buffer; className?: string; primarySpec?: string; gearAudit?: GearPreparationAudit };

const CACHE_FILE = join(process.cwd(), ".cache", "items.json");
const CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const USER_AGENT = "PizzaWarriorsArmoryBot/1.0 (+Discord armory lookup)";
const HTML_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const PROFILE_SELECTOR = "#character-profile, .item-left .item-slot";
const PROFILE_SELECTOR_TIMEOUT_MS = 8_000;
const PROFILE_RETRY_DELAY_MS = 250;
const SUMMARY_REQUEST_INTERVAL_MS = 3_500;
const SUMMARY_CACHE_AGE_MS = 5 * 60 * 1_000;
const SUMMARY_STALE_FALLBACK_AGE_MS = 6 * 60 * 60 * 1_000;
const qualityById: Record<number, string> = { 0: "poor", 1: "common", 2: "uncommon", 3: "rare", 4: "epic", 5: "legendary", 6: "artifact", 7: "heirloom" };
const inventoryType: Record<number, GearScoreEquipLoc | undefined> = {
  1: "INVTYPE_HEAD", 2: "INVTYPE_NECK", 3: "INVTYPE_SHOULDER", 4: "INVTYPE_BODY", 5: "INVTYPE_CHEST", 6: "INVTYPE_WAIST", 7: "INVTYPE_LEGS", 8: "INVTYPE_FEET", 9: "INVTYPE_WRIST", 10: "INVTYPE_HAND", 11: "INVTYPE_FINGER", 12: "INVTYPE_TRINKET", 13: "INVTYPE_WEAPON", 14: "INVTYPE_SHIELD", 15: "INVTYPE_RANGED", 16: "INVTYPE_CLOAK", 17: "INVTYPE_2HWEAPON", 20: "INVTYPE_ROBE", 21: "INVTYPE_WEAPONMAINHAND", 22: "INVTYPE_WEAPONOFFHAND", 23: "INVTYPE_HOLDABLE", 25: "INVTYPE_THROWN", 26: "INVTYPE_RANGEDRIGHT", 28: "INVTYPE_RELIC",
};

const sections: Array<{ selector: string; entries: Array<{ slot: string; fallbackEquipLoc: GearScoreEquipLoc }> }> = [
  { selector: ".item-left", entries: [{ slot: "Head", fallbackEquipLoc: "INVTYPE_HEAD" }, { slot: "Neck", fallbackEquipLoc: "INVTYPE_NECK" }, { slot: "Shoulder", fallbackEquipLoc: "INVTYPE_SHOULDER" }, { slot: "Back", fallbackEquipLoc: "INVTYPE_CLOAK" }, { slot: "Chest", fallbackEquipLoc: "INVTYPE_CHEST" }, { slot: "Shirt", fallbackEquipLoc: "INVTYPE_BODY" }, { slot: "Tabard", fallbackEquipLoc: "INVTYPE_TABARD" }, { slot: "Wrist", fallbackEquipLoc: "INVTYPE_WRIST" }] },
  { selector: ".item-right", entries: [{ slot: "Hands", fallbackEquipLoc: "INVTYPE_HAND" }, { slot: "Waist", fallbackEquipLoc: "INVTYPE_WAIST" }, { slot: "Legs", fallbackEquipLoc: "INVTYPE_LEGS" }, { slot: "Feet", fallbackEquipLoc: "INVTYPE_FEET" }, { slot: "Ring 1", fallbackEquipLoc: "INVTYPE_FINGER" }, { slot: "Ring 2", fallbackEquipLoc: "INVTYPE_FINGER" }, { slot: "Trinket 1", fallbackEquipLoc: "INVTYPE_TRINKET" }, { slot: "Trinket 2", fallbackEquipLoc: "INVTYPE_TRINKET" }] },
  { selector: ".item-bottom", entries: [{ slot: "Main Hand", fallbackEquipLoc: "INVTYPE_WEAPONMAINHAND" }, { slot: "Off Hand", fallbackEquipLoc: "INVTYPE_WEAPONOFFHAND" }, { slot: "Ranged", fallbackEquipLoc: "INVTYPE_RANGEDRIGHT" }] },
];

function armoryUrl(name: string, realm: string): string {
  const value = name.trim();
  return `https://armory.warmane.com/character/${encodeURIComponent(value[0].toUpperCase() + value.slice(1)).replace(/%20/g, "+")}/${encodeURIComponent(realm).replace(/%20/g, "+")}/summary`;
}

function armoryApiUrl(name: string, realm: string): string {
  const value = name.trim();
  return `https://armory.warmane.com/api/character/${encodeURIComponent(value[0].toUpperCase() + value.slice(1)).replace(/%20/g, "+")}/${encodeURIComponent(realm).replace(/%20/g, "+")}/summary`;
}

function equipmentSlot(equipLoc: GearScoreEquipLoc | undefined, occupied: Set<string>, fallbackIndex: number): string {
  const fixed: Partial<Record<GearScoreEquipLoc, string>> = {
    INVTYPE_HEAD: "Head", INVTYPE_NECK: "Neck", INVTYPE_SHOULDER: "Shoulder", INVTYPE_CLOAK: "Back",
    INVTYPE_CHEST: "Chest", INVTYPE_ROBE: "Chest", INVTYPE_BODY: "Shirt", INVTYPE_TABARD: "Tabard",
    INVTYPE_WRIST: "Wrist", INVTYPE_HAND: "Hands", INVTYPE_WAIST: "Waist", INVTYPE_LEGS: "Legs", INVTYPE_FEET: "Feet",
    INVTYPE_WEAPONOFFHAND: "Off Hand", INVTYPE_SHIELD: "Off Hand", INVTYPE_HOLDABLE: "Off Hand",
    INVTYPE_RANGED: "Ranged", INVTYPE_RANGEDRIGHT: "Ranged", INVTYPE_THROWN: "Ranged", INVTYPE_RELIC: "Ranged",
  };
  let slot = equipLoc ? fixed[equipLoc] : undefined;
  if (equipLoc === "INVTYPE_FINGER") slot = occupied.has("Ring 1") ? "Ring 2" : "Ring 1";
  if (equipLoc === "INVTYPE_TRINKET") slot = occupied.has("Trinket 1") ? "Trinket 2" : "Trinket 1";
  if (equipLoc === "INVTYPE_WEAPON" || equipLoc === "INVTYPE_WEAPONMAINHAND" || equipLoc === "INVTYPE_2HWEAPON") {
    slot = occupied.has("Main Hand") ? "Off Hand" : "Main Hand";
  }
  slot ??= `Unknown ${fallbackIndex + 1}`;
  occupied.add(slot);
  return slot;
}

class WarmaneSummaryRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

function normaliseEquipLoc(value: unknown): GearScoreEquipLoc | undefined {
  if (typeof value === "number") return inventoryType[value];
  const text = String(value ?? "").trim().toUpperCase();
  if (text in inventoryType) return inventoryType[Number(text)];
  return text.startsWith("INVTYPE_") ? text as GearScoreEquipLoc : undefined;
}

function decodeHtmlText(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|apos|gt|lt|quot);/g, (entity, code) => {
    if (code.startsWith("#")) {
      const base = code[1].toLowerCase() === "x" ? 16 : 10;
      const value = Number.parseInt(code.slice(base === 16 ? 2 : 1), base);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[code] ?? entity;
  });
}

function parseProfileEquipment(html: string): WarmaneHtmlEquipment[] {
  return [...html.matchAll(/\brel=["'](item=\d+[^"']*)["']/gi)].flatMap((match) => {
    const params = new URLSearchParams(decodeHtmlText(match[1]));
    const id = Number(params.get("item"));
    if (!id) return [];
    const enchantId = Number(params.get("ench")) || undefined;
    const gemIds = (params.get("gems") ?? "").split(":").filter(Boolean).map((value) => Number(value) || 0);
    return [{ id, ...(enchantId ? { enchantId } : {}), gemIds }];
  });
}

function parseProfileClass(html: string): string | undefined {
  const identity = decodeHtmlText(html.match(/level-race-class["']>\s*([^<]+)/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const classes = ["Death Knight", "Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"];
  return classes.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(identity));
}

function parseProfileProfessions(html: string): string[] {
  const section = html.match(/<h3>Professions<\/h3>([\s\S]*?)(?:<h3>Secondary Skills<\/h3>|$)/i)?.[1] ?? "";
  return [...section.matchAll(/<div class=["']text["']>\s*([^<\r\n]+?)\s*<span class=["']value["']/gi)]
    .map((match) => decodeHtmlText(match[1]).trim())
    .filter(Boolean);
}

function parseMetadata(html: string, includeSocketCount: boolean): Partial<ItemMetadata> {
  const title = html.match(/<title>([^<]+?)\s*(?:[-–]|\|)\s*(?:Item|WoW)/i)?.[1]?.trim();
  const itemLevel = Number(html.match(/Item Level\s*(\d{1,3})/i)?.[1] ?? 0) || undefined;
  const qualityId = Number(html.match(/class=["'][^"']*\bq([0-7])\b/i)?.[1]);
  const quality = qualityById[qualityId];
  const slotText = html.match(/<th[^>]*>\s*Slot\s*<\/th>\s*<td[^>]*>([^<]+)/i)?.[1]
    ?? html.match(/<b[^>]*class=["'][^"']*\bq[0-7]\b[^"']*["'][^>]*>.*?<\/b>[\s\S]*?<tr><td[^>]*>([^<]+)/i)?.[1];
  const freeText: Record<string, GearScoreEquipLoc> = { "main hand": "INVTYPE_WEAPONMAINHAND", "off hand": "INVTYPE_WEAPONOFFHAND", "two-hand": "INVTYPE_2HWEAPON", "held in off-hand": "INVTYPE_HOLDABLE", shield: "INVTYPE_SHIELD", ranged: "INVTYPE_RANGED", relic: "INVTYPE_RELIC", head: "INVTYPE_HEAD", neck: "INVTYPE_NECK", shoulder: "INVTYPE_SHOULDER", back: "INVTYPE_CLOAK", chest: "INVTYPE_CHEST", wrist: "INVTYPE_WRIST", hands: "INVTYPE_HAND", waist: "INVTYPE_WAIST", legs: "INVTYPE_LEGS", feet: "INVTYPE_FEET", finger: "INVTYPE_FINGER", trinket: "INVTYPE_TRINKET" };
  const equipLoc = Object.entries(freeText).find(([needle]) => slotText?.toLowerCase().includes(needle))?.[1];
  const socketCount = includeSocketCount
    ? [...html.matchAll(/class=["'][^"']*\bsocket-(?:meta|red|yellow|blue|prismatic)\b[^"']*["']/gi)].length
    : undefined;
  return { name: title ? decodeHtmlText(title) : undefined, itemLevel, quality, equipLoc, ...(socketCount !== undefined ? { socketCount } : {}) };
}

async function loadCache(): Promise<Cache> {
  try {
    const cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Cache;
    for (const metadata of Object.values(cache.items)) metadata.name = decodeHtmlText(metadata.name);
    return cache;
  } catch { return { items: {} }; }
}

async function saveCache(cache: Cache): Promise<void> {
  await mkdir(join(process.cwd(), ".cache"), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function concurrentMap<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
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

export class WarmaneArmory {
  private browser?: Browser;
  private browserLaunch?: Promise<Browser>;
  private cache?: Cache;
  private lookupQueue = Promise.resolve();
  private readonly inFlight = new Map<string, Promise<ArmoryCharacter>>();
  private readonly summaryCache = new Map<string, SummaryCacheEntry>();
  private lastSummaryRequestAt = 0;

  async close(): Promise<void> { await this.resetBrowser(); }

  /**
   * Keep public Warmane reads serial. A single lookup fans out to metadata
   * sources already, and multiple Chrome contexts were the source of the
   * Windows worker crashes seen during command bursts.
   */
  private async queueLookup<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lookupQueue;
    let release!: () => void;
    this.lookupQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async resetBrowser(expected?: Browser): Promise<void> {
    if (expected && this.browser !== expected) return;
    const browser = this.browser;
    this.browser = undefined;
    this.browserLaunch = undefined;
    await browser?.close().catch(() => undefined);
  }

  private async getBrowser(): Promise<Browser> {
    // Playwright's bundled headless-shell is a console executable on Windows.
    // Chrome's installed channel is a GUI executable, so command lookups do not
    // create a Windows Terminal tab when this bot launches its browser worker.
    if (this.browser?.isConnected()) return this.browser;
    this.browser = undefined;
    this.browserLaunch ??= chromium.launch({ headless: config.headless, channel: "chrome" })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => { this.browserLaunch = undefined; });
    return this.browserLaunch;
  }

  private async getItemMetadata(id: number, fallbackEquipLoc?: GearScoreEquipLoc, fallbackName?: string, requireSocketCount = false): Promise<ItemMetadata> {
    this.cache ??= await loadCache();
    const cached = this.cache.items[String(id)];
    if (cached && Date.now() - cached.fetchedAt < CACHE_AGE_MS && (!requireSocketCount || cached.socketCount !== undefined)) return cached;
    let result: Partial<ItemMetadata> = cached ? { ...cached } : {};
    for (const url of [`https://wotlk.cavernoftime.com/item=${id}`, `https://wotlk.wowhead.com/item=${id}`]) {
      try {
        const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
        if (!response.ok) continue;
        const parsed = parseMetadata(await response.text(), url.includes("cavernoftime.com"));
        // Do not let a partial second source replace usable data from the first.
        result = { ...parsed, ...result };
        if (result.name && result.itemLevel && result.quality && result.equipLoc && (!requireSocketCount || result.socketCount !== undefined)) break;
      } catch { /* Attempt the next metadata source. */ }
    }
    const equipLoc = result.equipLoc ?? fallbackEquipLoc;
    const metadata: ItemMetadata = {
      name: result.name ?? fallbackName ?? `Item ${id}`,
      itemLevel: result.itemLevel ?? 0,
      quality: result.quality ?? "epic",
      ...(equipLoc ? { equipLoc } : {}),
      ...(result.socketCount !== undefined ? { socketCount: result.socketCount } : {}),
      fetchedAt: Date.now(),
    };
    this.cache.items[String(id)] = metadata;
    await saveCache(this.cache);
    return metadata;
  }

  /** Uses Warmane's existing WebGL character model; portrait failure must never block GS. */
  private async capturePortrait(page: Page): Promise<Buffer | undefined> {
    try {
      const canvas = page.locator(".model canvas, canvas").first();
      await canvas.waitFor({ state: "visible", timeout: 8_000 });
      const box = await canvas.boundingBox();
      if (!box || box.width < 160 || box.height < 200) return undefined;
      // Warmane inserts the canvas before WebGL has painted the model. An empty
      // canvas is about 1 KB; wait for a real rendered frame rather than posting it.
      for (let attempt = 0; attempt < 8; attempt++) {
        await page.waitForTimeout(500);
        const portrait = await canvas.screenshot({ type: "png" });
        if (portrait.length > 8_000) return portrait;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Read a public Warmane character, including its first displayed talent specialization when available. */
  async getCharacter(name: string, realm: string): Promise<ArmoryCharacter> {
    const key = cacheKeyForCharacter(name, realm);
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.queueLookup(() => this.getCharacterWithRecovery(name, realm));
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Read the server-rendered character summary without launching the 3D model.
   * The item links include enchant and gem IDs, while a shared 3.5 second
   * cadence respects Warmane's profile rate limit.
   */
  async getCharacterSummary(name: string, realm: string): Promise<ArmoryCharacter> {
    const key = cacheKeyForCharacter(name, realm);
    const cached = this.summaryCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < SUMMARY_CACHE_AGE_MS) return cached.character;

    const inFlightKey = `summary:${key}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) return existing;
    const request = this.queueLookup(() => this.getCharacterSummaryWithRecovery(name, realm));
    this.inFlight.set(inFlightKey, request);
    try {
      const character = await request;
      this.summaryCache.set(key, { fetchedAt: Date.now(), character });
      return character;
    } catch (error) {
      if (cached && Date.now() - cached.fetchedAt < SUMMARY_STALE_FALLBACK_AGE_MS) {
        console.warn(`Warmane summary failed for ${name}-${realm}; using the recent cached snapshot.`, error);
        return cached.character;
      }
      throw error;
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async getCharacterSummaryWithRecovery(name: string, realm: string): Promise<ArmoryCharacter> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.getCharacterSummaryFromHtmlOnce(name, realm);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof WarmaneSummaryRequestError
          ? error.retryable
          : /fetch failed|timeout|timed out|aborted|network/i.test(error instanceof Error ? error.message : String(error));
        if (!retryable) throw error;
        if (attempt === 2) break;
        console.warn(`Warmane summary request failed for ${name}-${realm}; retrying after the shared rate-limit interval.`);
      }
    }
    console.warn(`Warmane profile modifiers remained unavailable for ${name}-${realm}; falling back to the JSON gear summary.`, lastError);
    return this.getCharacterSummaryFromApiOnce(name, realm);
  }

  private async waitForSummaryRequestInterval(): Promise<void> {
    const waitMs = SUMMARY_REQUEST_INTERVAL_MS - (Date.now() - this.lastSummaryRequestAt);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastSummaryRequestAt = Date.now();
  }

  private async getCharacterSummaryFromHtmlOnce(name: string, realm: string): Promise<ArmoryCharacter> {
    await this.waitForSummaryRequestInterval();
    const url = armoryUrl(name, realm);
    const response = await fetch(url, {
      headers: {
        accept: "text/html",
        "user-agent": HTML_USER_AGENT,
        ...(config.warmaneCookie ? { cookie: config.warmaneCookie } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new WarmaneSummaryRequestError(
        response.status === 429 || response.status === 403 ? "Warmane rate limited the character profile request." : `Warmane returned ${response.status} for that character.`,
        response.status === 429 || response.status === 403 || response.status >= 500,
      );
    }
    const html = await response.text();
    const equipment = parseProfileEquipment(html);
    if (!equipment.length) {
      const limited = /error code:\s*1015|too many requests|<title>\s*just a moment/i.test(html);
      throw new WarmaneSummaryRequestError(
        limited ? "Warmane returned a rate-limit page instead of that character." : "No equipped items were found. The character may not exist.",
        limited,
      );
    }

    const metadata = await concurrentMap(equipment, 3, async (item) => ({
      id: item.id,
      enchantId: item.enchantId,
      gemIds: item.gemIds,
      auditDataAvailable: true,
      ...(await this.getItemMetadata(item.id, undefined, undefined, true)),
    }));
    const occupied = new Set<string>();
    const items: GearItem[] = metadata.map((item, index) => ({
      ...item,
      slot: equipmentSlot(item.equipLoc, occupied, index),
    }));
    const className = parseProfileClass(html);
    const gearAudit = auditGearPreparation(items, parseProfileProfessions(html), className);
    return { armoryUrl: url, items, ...(className ? { className } : {}), gearAudit };
  }

  private async getCharacterSummaryFromApiOnce(name: string, realm: string): Promise<ArmoryCharacter> {
    await this.waitForSummaryRequestInterval();

    const response = await fetch(armoryApiUrl(name, realm), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new WarmaneSummaryRequestError(
        response.status === 429 ? "Warmane rate limited the character summary request." : `Warmane returned ${response.status} for that character.`,
        response.status === 429 || response.status >= 500,
      );
    }
    const payload = await response.json() as WarmaneApiSummary;
    const apiError = typeof payload.error === "string" ? payload.error.trim() : "";
    if (apiError) throw new WarmaneSummaryRequestError(`Warmane Armory: ${apiError}`, /too many requests|temporar|try again/i.test(apiError));
    if (!Array.isArray(payload.equipment) || !payload.equipment.length) {
      throw new WarmaneSummaryRequestError("No equipped items were found. The character may not exist.", false);
    }

    const equipment = payload.equipment.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as WarmaneApiEquipment;
      const id = Number(String(item.item ?? "").match(/^\d+/)?.[0]);
      if (!id) return [];
      return [{ id, name: typeof item.name === "string" ? item.name.trim() : undefined }];
    });
    const metadata = await concurrentMap(equipment, 3, async (item) => ({
      id: item.id,
      ...(await this.getItemMetadata(item.id, undefined, item.name)),
    }));
    const occupied = new Set<string>();
    const items: GearItem[] = metadata.map((item, index) => ({
      ...item,
      slot: equipmentSlot(item.equipLoc, occupied, index),
      auditDataAvailable: false,
    }));
    const talents = Array.isArray(payload.talents) ? payload.talents : [];
    const primaryTalent = talents.find((talent) => talent && typeof talent === "object" && typeof (talent as { tree?: unknown }).tree === "string") as { tree?: string } | undefined;
    const className = typeof payload.class === "string" && payload.class.trim() ? payload.class.trim() : undefined;
    return {
      armoryUrl: armoryUrl(name, realm),
      items,
      ...(className ? { className } : {}),
      ...(primaryTalent?.tree ? { primarySpec: primaryTalent.tree.trim() } : {}),
      gearAudit: auditGearPreparation(items, [], className),
    };
  }

  private async getCharacterWithRecovery(name: string, realm: string): Promise<ArmoryCharacter> {
    let browserRetriesRemaining = 1;
    let profileRetriesRemaining = 1;
    for (let attempt = 0; attempt < 3; attempt++) {
      let browser: Browser | undefined;
      try {
        browser = await this.getBrowser();
        return await this.getCharacterOnce(name, realm, browser);
      } catch (error) {
        if (browserRetriesRemaining > 0 && isRecoverableBrowserError(error)) {
          browserRetriesRemaining--;
          console.warn("Warmane browser worker failed; replacing it and retrying the lookup once.", error);
          await this.resetBrowser(browser);
          continue;
        }
        if (profileRetriesRemaining > 0 && isTransientWarmaneProfileError(error)) {
          profileRetriesRemaining--;
          console.warn(`Warmane profile did not load for ${name}-${realm}; retrying the lookup once.`);
          await new Promise((resolve) => setTimeout(resolve, PROFILE_RETRY_DELAY_MS));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Warmane browser recovery exhausted unexpectedly.");
  }

  private async getCharacterOnce(name: string, realm: string, browser: Browser): Promise<ArmoryCharacter> {
    const url = armoryUrl(name, realm);
    const context = await browser.newContext({ locale: "en-US", timezoneId: "America/Halifax", userAgent: USER_AGENT });
    if (config.warmaneCookie) {
      const cookies = config.warmaneCookie.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const equals = part.indexOf("=");
        return equals > 0 ? { name: part.slice(0, equals), value: part.slice(equals + 1), domain: ".warmane.com", path: "/", secure: true } : undefined;
      }).filter((cookie): cookie is { name: string; value: string; domain: string; path: string; secure: boolean } => Boolean(cookie));
      await context.addCookies(cookies);
    }
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // Warmane keeps a profile template in the DOM that can be visually hidden while its
      // equipment is usable. Wait for attachment rather than Playwright visibility.
      await page.waitForSelector(PROFILE_SELECTOR, { state: "attached", timeout: PROFILE_SELECTOR_TIMEOUT_MS });
      const equipped = await page.evaluate((pageSections) => pageSections.flatMap(({ selector, entries }) => {
        const root = document.querySelector(selector);
        if (!root) return [];
        return Array.from(root.querySelectorAll(".item-slot")).flatMap((node, index) => {
          const anchor = node.querySelector<HTMLAnchorElement>('a[rel*="item="], a[href*="item="]');
          const raw = anchor?.getAttribute("rel") ?? anchor?.getAttribute("href") ?? "";
          const id = Number(raw.match(/(?:^|[;?\/])item=(\d{2,7})/)?.[1]);
          const entry = entries[index];
          const iconUrl = node.querySelector<HTMLImageElement>("img")?.src?.replace(/^http:/i, "https:");
          return id && entry ? [{ id, ...entry, ...(iconUrl ? { iconUrl } : {}) }] : [];
        });
      }), sections) as EquippedSlot[];
      if (!equipped.length) throw new Error("No equipped items were found. The character may not exist, or Warmane blocked the lookup.");
      const portraitPromise = this.capturePortrait(page);
      const identity = await page.evaluate(() => {
        const levelRaceClass = document.querySelector(".level-race-class")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const classes = ["Death Knight", "Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"];
        const className = classes.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(levelRaceClass));
        const primarySpec = document.querySelector(".specialization")?.textContent
          ?.split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean)
          ?.match(/^(.+?)\s+\d+\s*\/\s*\d+\s*\/\s*\d+$/)?.[1]
          ?.trim();
        return { ...(className ? { className } : {}), ...(primarySpec ? { primarySpec } : {}) };
      });
      const items = await concurrentMap(equipped, 3, async (item) => ({
        id: item.id,
        slot: item.slot,
        ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
        ...(await this.getItemMetadata(item.id, item.fallbackEquipLoc)),
      }));
      const portrait = await portraitPromise;
      return { armoryUrl: url, items, ...identity, ...(portrait ? { portrait } : {}) };
    } finally {
      await context.close();
    }
  }
}

export function cacheKeyForCharacter(name: string, realm: string): string {
  return createHash("sha256").update(`${realm}:${name}`).digest("hex").slice(0, 10);
}
