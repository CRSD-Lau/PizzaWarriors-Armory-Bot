import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { isRecoverableBrowserError } from "./browser-recovery.js";
import { config } from "./config.js";
import type { GearItem, GearScoreEquipLoc } from "./gearscore.js";

type EquippedSlot = { id: number; slot: string; fallbackEquipLoc: GearScoreEquipLoc; iconUrl?: string };
type ItemMetadata = Pick<GearItem, "name" | "itemLevel" | "quality" | "equipLoc"> & { fetchedAt: number };
type Cache = { items: Record<string, ItemMetadata> };
export type ArmoryCharacter = { armoryUrl: string; items: GearItem[]; portrait?: Buffer; className?: string; primarySpec?: string };

const CACHE_FILE = join(process.cwd(), ".cache", "items.json");
const CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const USER_AGENT = "PizzaWarriorsArmoryBot/1.0 (+Discord armory lookup)";
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

function parseMetadata(html: string): Partial<ItemMetadata> {
  const title = html.match(/<title>([^<]+?)\s*(?:[-–]|\|)\s*(?:Item|WoW)/i)?.[1]?.trim();
  const itemLevel = Number(html.match(/Item Level\s*(\d{1,3})/i)?.[1] ?? 0) || undefined;
  const qualityId = Number(html.match(/class=["'][^"']*\bq([0-7])\b/i)?.[1]);
  const quality = qualityById[qualityId];
  const slotText = html.match(/<th[^>]*>\s*Slot\s*<\/th>\s*<td[^>]*>([^<]+)/i)?.[1]
    ?? html.match(/<b[^>]*class=["'][^"']*\bq[0-7]\b[^"']*["'][^>]*>.*?<\/b>[\s\S]*?<tr><td[^>]*>([^<]+)/i)?.[1];
  const freeText: Record<string, GearScoreEquipLoc> = { "main hand": "INVTYPE_WEAPONMAINHAND", "off hand": "INVTYPE_WEAPONOFFHAND", "two-hand": "INVTYPE_2HWEAPON", "held in off-hand": "INVTYPE_HOLDABLE", shield: "INVTYPE_SHIELD", ranged: "INVTYPE_RANGED", relic: "INVTYPE_RELIC", head: "INVTYPE_HEAD", neck: "INVTYPE_NECK", shoulder: "INVTYPE_SHOULDER", back: "INVTYPE_CLOAK", chest: "INVTYPE_CHEST", wrist: "INVTYPE_WRIST", hands: "INVTYPE_HAND", waist: "INVTYPE_WAIST", legs: "INVTYPE_LEGS", feet: "INVTYPE_FEET", finger: "INVTYPE_FINGER", trinket: "INVTYPE_TRINKET" };
  const equipLoc = Object.entries(freeText).find(([needle]) => slotText?.toLowerCase().includes(needle))?.[1];
  return { name: title ? decodeHtmlText(title) : undefined, itemLevel, quality, equipLoc };
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

  private async getItemMetadata(id: number, fallbackEquipLoc: GearScoreEquipLoc): Promise<ItemMetadata> {
    this.cache ??= await loadCache();
    const cached = this.cache.items[String(id)];
    if (cached && Date.now() - cached.fetchedAt < CACHE_AGE_MS) return cached;
    let result: Partial<ItemMetadata> = {};
    for (const url of [`https://wotlk.cavernoftime.com/item=${id}`, `https://wotlk.wowhead.com/item=${id}`]) {
      try {
        const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(12_000) });
        if (!response.ok) continue;
        const parsed = parseMetadata(await response.text());
        // Do not let a partial second source replace usable data from the first.
        result = { ...parsed, ...result };
        if (result.name && result.itemLevel && result.quality && result.equipLoc) break;
      } catch { /* Attempt the next metadata source. */ }
    }
    const metadata: ItemMetadata = { name: result.name ?? `Item ${id}`, itemLevel: result.itemLevel ?? 0, quality: result.quality ?? "epic", equipLoc: result.equipLoc ?? fallbackEquipLoc, fetchedAt: Date.now() };
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

  private async getCharacterWithRecovery(name: string, realm: string): Promise<ArmoryCharacter> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let browser: Browser | undefined;
      try {
        browser = await this.getBrowser();
        return await this.getCharacterOnce(name, realm, browser);
      } catch (error) {
        if (attempt === 0 && isRecoverableBrowserError(error)) {
          console.warn("Warmane browser worker failed; replacing it and retrying the lookup once.", error);
          await this.resetBrowser(browser);
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
      await page.waitForSelector("#character-profile, .item-left .item-slot", { state: "attached", timeout: 15_000 });
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
