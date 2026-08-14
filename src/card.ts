import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { isRecoverableBrowserError } from "./browser-recovery.js";
import type { GearItem, GearScoreSummary } from "./gearscore.js";
import type { UpgradeProfile, UpgradeTarget } from "./upgrade.js";
import type { ReadyReport } from "./ready.js";
import type { GuildRoster } from "./guild.js";
import { gearScoreTier, itemGearScoreTier } from "./score-tiers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_FILE = join(ROOT, "assets", "pizzawarriors-armory-discord-icon-1024.png");
const LEGENDARY = "#ff8000";

type CardInput = {
  name: string;
  realm: string;
  items: GearItem[];
  summary: GearScoreSummary;
  portrait?: Buffer;
};

const armorSlots = ["Head", "Neck", "Shoulder", "Back", "Chest", "Shirt", "Wrist", "Hands", "Waist", "Legs", "Feet"] as const;
const accessorySlots = ["Ring 1", "Ring 2", "Trinket 1", "Trinket 2"] as const;
const weaponSlots = ["Main Hand", "Off Hand", "Ranged"] as const;

const qualityColors: Record<string, string> = {
  poor: "#9d9d9d", common: "#f0f0f0", uncommon: "#1eff00", rare: "#0070dd", epic: "#a335ee", legendary: LEGENDARY, artifact: "#e6cc80", heirloom: "#00ccff",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

function dataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function safeIconUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const isApprovedHost = url.hostname === "warmane.com" || url.hostname.endsWith(".warmane.com") || url.hostname === "wow.zamimg.com";
    return url.protocol === "https:" && isApprovedHost ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function rows(items: GearItem[], scores: Map<number, number>, slots: readonly string[]): string {
  const wanted = new Map(items.map((item) => [item.slot, item]));
  return slots.flatMap((slot) => {
    const item = wanted.get(slot);
    if (!item) return [];
    const score = scores.get(item.id);
    const scoreColor = score === undefined ? undefined : itemGearScoreTier(score).color;
    const iconUrl = safeIconUrl(item.iconUrl);
    const icon = iconUrl
      ? `<img class="item-icon" src="${escapeHtml(iconUrl)}" alt="">`
      : `<span class="item-icon missing">?</span>`;
    const quality = qualityColors[item.quality.toLowerCase()] ?? qualityColors.epic;
    return `<div class="row">
      <span class="icon-frame" style="--quality:${quality}">${icon}</span>
      <span class="slot">${escapeHtml(item.slot)}</span>
      <span class="item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <span class="level">i${item.itemLevel}</span>
      <span class="item-score"${scoreColor ? ` style="color:${scoreColor}"` : ""}>${score?.toLocaleString() ?? "—"} GS</span>
    </div>`;
  }).join("");
}

function section(label: string, items: GearItem[], scores: Map<number, number>, slots: readonly string[]): string {
  return `<section><h2>${label}</h2>${rows(items, scores, slots)}</section>`;
}

export class ArmoryCardRenderer {
  private browser?: Browser;
  private browserLaunch?: Promise<Browser>;
  private logo?: Promise<string>;
  private renderQueue = Promise.resolve();

  async close(): Promise<void> { await this.resetBrowser(); }

  private async resetBrowser(expected?: Browser): Promise<void> {
    if (expected && this.browser !== expected) return;
    const browser = this.browser;
    this.browser = undefined;
    this.browserLaunch = undefined;
    await browser?.close().catch(() => undefined);
  }

  private async getBrowser(): Promise<Browser> {
    // Avoid Playwright's console-subsystem headless-shell on Windows.
    if (this.browser?.isConnected()) return this.browser;
    this.browser = undefined;
    this.browserLaunch ??= chromium.launch({ headless: true, channel: "chrome" })
      .then((browser) => {
        this.browser = browser;
        return browser;
      })
      .finally(() => { this.browserLaunch = undefined; });
    return this.browserLaunch;
  }

  /** Keep screenshot work single-filed so one Chrome renderer cannot be saturated. */
  private async queueRender<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.renderQueue;
    let release!: () => void;
    this.renderQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /** Replace a crashed Chrome worker and retry a pure card render once. */
  private async withBrowser<T>(operation: (browser: Browser) => Promise<T>): Promise<T> {
    return this.queueRender(() => this.renderWithRecovery(operation));
  }

  private async renderWithRecovery<T>(operation: (browser: Browser) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let browser: Browser | undefined;
      try {
        browser = await this.getBrowser();
        return await operation(browser);
      } catch (error) {
        if (attempt === 0 && isRecoverableBrowserError(error)) {
          console.warn("Card browser worker failed; replacing it and retrying the render once.", error);
          await this.resetBrowser(browser);
          continue;
        }
        throw error;
      }
    }
    throw new Error("Card browser recovery exhausted unexpectedly.");
  }

  private async getLogo(): Promise<string> {
    this.logo ??= readFile(LOGO_FILE).then((buffer) => dataUrl(buffer, "image/png"));
    return this.logo;
  }

  async render(input: CardInput): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
    const logo = await this.getLogo();
    const tier = gearScoreTier(input.summary.score);
    // Discord downscales attachment previews. Render at 2x so the character
    // thumbnail, item icons, and type remain crisp in the message preview.
    const context = await browser.newContext({ viewport: { width: 920, height: 1_400 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const portrait = input.portrait ? dataUrl(input.portrait, "image/png") : undefined;
    // A tall one-column card is height-capped and aggressively shrunk by Discord.
    // Two balanced columns make the attachment much wider and readable in-chat.
    const equipment = `<div class="equipment-grid"><div>${section("Armor", input.items, input.summary.itemScores, armorSlots.slice(0, 6))}${section("Accessories", input.items, input.summary.itemScores, accessorySlots)}</div><div>${section("Armor", input.items, input.summary.itemScores, armorSlots.slice(6))}${section("Weapons", input.items, input.summary.itemScores, weaponSlots)}</div></div>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; } body { margin: 0; padding: 24px; background: #0b0e13; color: #f2f4f8; font-family: "Segoe UI", Arial, sans-serif; }
      .card { width: 872px; overflow: hidden; border: 1px solid #323946; border-left: 6px solid ${tier.color}; border-radius: 14px; background: #151a22; box-shadow: 0 18px 50px rgba(0,0,0,.35); padding: 28px; }
      .brand { display: flex; align-items: center; gap: 12px; color: #f4f6fa; font-size: 20px; font-weight: 700; letter-spacing: -.2px; }
      .brand img { width: 38px; height: 38px; object-fit: cover; border-radius: 50%; border: 1px solid rgba(255,128,0,.65); }
      .identity { display: flex; justify-content: space-between; align-items: start; gap: 24px; margin: 24px 0 22px; }
      .name { color: #45a5ff; font-weight: 800; font-size: 34px; letter-spacing: -.8px; line-height: 1.08; }
      .realm { color: #95a0b4; font-weight: 600; font-size: 16px; margin-top: 7px; }
      .portrait { width: 164px; height: 204px; border: 1px solid #363e4d; border-radius: 12px; object-fit: contain; background: #0c0f14; }
      .stats { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid #303744; border-bottom: 1px solid #303744; padding: 18px 0; margin-bottom: 22px; }
      .stat { padding: 0 18px; border-left: 1px solid #303744; } .stat:first-child { padding-left: 0; border-left: 0; }
      .label { display: block; color: #a7b0c0; font-size: 13px; font-weight: 700; letter-spacing: .7px; text-transform: uppercase; }
      .value { display: block; margin-top: 7px; font-size: 31px; line-height: 1; font-weight: 800; letter-spacing: -.7px; } .gear .value, .gear .sub { color: ${tier.color}; } .item-score { color: #8994a6; } .level-stat .value, .level { color: #55aaff; }
      .sub { display: block; margin-top: 6px; color: #c5ccd7; font-size: 15px; font-weight: 600; }
      .equipment-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; } section + section { margin-top: 22px; } h2 { margin: 0 0 9px; color: #bfc8d6; font-size: 14px; font-weight: 800; letter-spacing: .9px; text-transform: uppercase; }
      .row { display: grid; grid-template-columns: 34px 64px minmax(0, 1fr) 48px 60px; align-items: center; min-height: 43px; gap: 7px; border-top: 1px solid #2a303b; padding: 4px 6px; background: rgba(8,12,18,.15); }
      .row:first-of-type { border-radius: 10px 10px 0 0; } .row:last-child { border-radius: 0 0 10px 10px; border-bottom: 1px solid #2a303b; }
      .icon-frame { width: 29px; height: 29px; display: block; overflow: hidden; border: 1px solid var(--quality); border-radius: 5px; background: #080a0e; } .item-icon { width: 100%; height: 100%; object-fit: cover; display: block; } .missing { color: #8d98a9; text-align: center; line-height: 27px; font-weight: 800; }
      .slot { color: #aeb8c8; font-size: 12px; font-weight: 600; } .item-name { overflow: hidden; color: #f1f3f7; font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .level, .item-score { justify-self: end; font-size: 12px; font-weight: 800; white-space: nowrap; } .level { background: #202937; border-radius: 5px; padding: 4px 5px; }
      .footer { margin-top: 26px; padding-top: 15px; border-top: 1px solid #303744; color: #8994a6; font-size: 12px; } .footer strong { color: #d9dfe9; }
    </style></head><body><main class="card">
      <header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Armory</span></header>
      <div class="identity"><div><div class="name">${escapeHtml(input.name)}</div><div class="realm">${escapeHtml(input.realm)} · Equipped Loadout</div></div>${portrait ? `<img class="portrait" src="${portrait}" alt="${escapeHtml(input.name)}">` : ""}</div>
      <div class="stats"><div class="stat gear"><span class="label">GearScore</span><span class="value">${input.summary.score.toLocaleString()}</span><span class="sub">${tier.label}</span></div><div class="stat level-stat"><span class="label">Average iLvl</span><span class="value">${input.summary.averageItemLevel}</span><span class="sub">Equipped average</span></div><div class="stat"><span class="label">Items scored</span><span class="value">${input.summary.scoredItemCount}/19</span><span class="sub">GearScoreLite</span></div></div>
      ${equipment}<div class="footer"><strong>PizzaWarriors Armory</strong> · Warmane Armory · WotLK 3.3.5a GearScoreLite</div>
    </main></body></html>`;
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), undefined, { timeout: 8_000 }).catch(() => undefined);
      return await page.locator(".card").screenshot({ type: "png" });
    } finally {
      await context.close();
    }
    });
  }

  /** Render real guide-backed upgrade targets using the same PizzaWarriors card language as Armory. */
  async renderUpgrade(input: { name: string; realm: string; className: string; specName: string; profile: UpgradeProfile; items: GearItem[]; portrait?: Buffer }): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
    const logo = await this.getLogo();
    const context = await browser.newContext({ viewport: { width: 920, height: 1_400 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const portrait = input.portrait ? dataUrl(input.portrait, "image/png") : undefined;
    const targets = input.profile.targets ?? [];
    const equipped = new Set(input.items.map((item) => item.id));
    const equippedNames = new Set(input.items.map((item) => item.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
    const targetOwned = (target: UpgradeTarget): boolean => (target.id !== undefined && equipped.has(target.id))
      || target.aliases?.some((alias) => equippedNames.has(alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())) === true;
    const targetRows = (list: UpgradeTarget[]) => list.map((target) => {
      const hasTarget = targetOwned(target);
      return `<div class="row"><span class="icon-frame" style="--quality:${hasTarget ? "#1eff75" : LEGENDARY}"><img class="item-icon" src="https://wow.zamimg.com/images/wow/icons/large/${escapeHtml(target.icon)}.jpg" alt=""></span><span class="slot">${escapeHtml(target.slot)}</span><span class="item-name" title="${escapeHtml(target.name)}">${escapeHtml(target.name)}</span><span class="status ${hasTarget ? "owned" : "target"}">${hasTarget ? "OWNED" : "TARGET"}</span></div>`;
    }).join("");
    const midpoint = Math.ceil(targets.length / 2);
    const targetContent = targets.length
      ? `<div class="grid"><section><h2>Priority targets</h2>${targetRows(targets.slice(0, midpoint))}</section><section><h2>Priority targets</h2>${targetRows(targets.slice(midpoint))}</section></div><div class="note">Targets are loaded from the PizzaWarriors Best-in-Slot sheet. Sheet changes flow into this card automatically; encounter needs, caps, and raid access still apply.</div>`
      : `<section class="source-card"><h2>Research source</h2><div class="source-title">${escapeHtml(input.profile.sources[0]?.title ?? "Warmane guide")}</div><div class="source-copy">This specialization has a live source profile, but its item path has not been curated yet. PizzaWarriors officers can replace this source or add a reviewed target list at any time.</div><div class="source-state">SOURCE LOADED · TARGET LIST PENDING</div></section>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:24px;background:#0b0e13;color:#f2f4f8;font-family:"Segoe UI",Arial,sans-serif}.card{width:872px;overflow:hidden;border:1px solid #323946;border-left:6px solid ${LEGENDARY};border-radius:14px;background:#151a22;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:28px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}.brand img{width:38px;height:38px;object-fit:cover;border-radius:50%;border:1px solid rgba(255,128,0,.65)}.identity{display:flex;justify-content:space-between;gap:24px;margin:24px 0 22px}.name{color:#45a5ff;font-weight:800;font-size:34px;letter-spacing:-.8px;line-height:1.08}.realm{color:#95a0b4;font-weight:600;font-size:16px;margin-top:7px}.portrait{width:164px;height:204px;border:1px solid #363e4d;border-radius:12px;object-fit:contain;background:#0c0f14}.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #303744;border-bottom:1px solid #303744;padding:18px 0;margin-bottom:22px}.stat{padding:0 18px;border-left:1px solid #303744}.stat:first-child{padding-left:0;border-left:0}.label{display:block;color:#a7b0c0;font-size:13px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.value{display:block;margin-top:7px;font-size:28px;line-height:1;font-weight:800;letter-spacing:-.7px;color:${LEGENDARY}}.sub{display:block;margin-top:6px;color:#c5ccd7;font-size:14px;font-weight:600}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}h2{margin:0 0 9px;color:#bfc8d6;font-size:14px;font-weight:800;letter-spacing:.9px;text-transform:uppercase}.row{display:grid;grid-template-columns:34px 61px minmax(0,1fr) 55px;align-items:center;min-height:43px;gap:7px;border-top:1px solid #2a303b;padding:4px 6px;background:rgba(8,12,18,.15)}.row:last-child{border-bottom:1px solid #2a303b}.icon-frame{width:29px;height:29px;display:block;overflow:hidden;border:1px solid var(--quality);border-radius:5px;background:#080a0e}.item-icon{width:100%;height:100%;object-fit:cover;display:block}.slot{color:#aeb8c8;font-size:12px;font-weight:600}.item-name{overflow:hidden;color:#f1f3f7;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.status{justify-self:end;font-size:10px;font-weight:800;letter-spacing:.4px}.target{color:${LEGENDARY}}.owned{color:#4ce887}.note{margin-top:22px;padding:13px 15px;border:1px solid #303744;border-radius:8px;color:#c5ccd7;font-size:13px}.source-card{min-height:180px;padding:22px;border:1px solid #303744;border-radius:10px;background:linear-gradient(135deg,#111722,#182230)}.source-title{color:#55aaff;font-size:22px;font-weight:800}.source-copy{max-width:620px;margin-top:13px;color:#c5ccd7;font-size:15px;line-height:1.45}.source-state{display:inline-block;margin-top:20px;padding:7px 9px;border-radius:5px;background:#202937;color:${LEGENDARY};font-size:11px;font-weight:800;letter-spacing:.6px}.footer{margin-top:20px;padding-top:15px;border-top:1px solid #303744;color:#8994a6;font-size:12px}.footer strong{color:#d9dfe9}
    </style></head><body><main class="card"><header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Upgrade Advisor</span></header><div class="identity"><div><div class="name">${escapeHtml(input.name)}</div><div class="realm">${escapeHtml(input.realm)} · ${escapeHtml(input.specName)} ${escapeHtml(input.className)}</div></div>${portrait ? `<img class="portrait" src="${portrait}" alt="">` : ""}</div><div class="stats"><div class="stat"><span class="label">Sheet targets</span><span class="value">${targets.length || "—"}</span><span class="sub">${targets.length ? "Live source matrix" : "Source loading"}</span></div><div class="stat"><span class="label">Already equipped</span><span class="value">${targets.length ? targets.filter(targetOwned).length : "—"}</span><span class="sub">${targets.length ? "Exact item matches" : "No target list yet"}</span></div><div class="stat"><span class="label">Profile status</span><span class="value">Live sheet</span><span class="sub">PizzaWarriors source</span></div></div>${targetContent}<div class="footer"><strong>PizzaWarriors Upgrade Advisor</strong> · ${escapeHtml(input.profile.sources[0]?.title ?? "Warmane source")}</div></main></body></html>`;
    try { await page.setContent(html, { waitUntil: "load" }); await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete), undefined, { timeout: 8_000 }).catch(() => undefined); return await page.locator(".card").screenshot({ type: "png" }); } finally { await context.close(); }
    });
  }

  /** Render a compact, raid-leader-friendly view of a live Raid-Helper signup roster. */
  async renderReady(input: { report: ReadyReport; realm: string }): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
    const logo = await this.getLogo();
    const context = await browser.newContext({ viewport: { width: 920, height: 1_400 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const members = [...input.report.members].sort((a, b) => b.summary.score - a.summary.score);
    const average = members.length ? Math.round(members.reduce((total, member) => total + member.summary.score, 0) / members.length) : 0;
    const ready = members.filter((member) => member.summary.score >= 5_000).length;
    const rosterRows = (list: typeof members) => list.map((member) => `<div class="ready-row"><span class="ready-name">${escapeHtml(member.characterName)}</span><span class="ready-spec">${escapeHtml(member.specName ?? member.className ?? "Spec unknown")}</span><span class="ready-ilvl">i${member.summary.averageItemLevel}</span><span class="ready-gs ${member.summary.score >= 5_000 ? "ready" : "review"}">${member.summary.score.toLocaleString()}</span></div>`).join("");
    const midpoint = Math.ceil(members.length / 2);
    const unresolved = input.report.unresolved.length ? `<div class="unresolved"><strong>${input.report.unresolved.length} need${input.report.unresolved.length === 1 ? "s" : ""} character link:</strong> ${input.report.unresolved.map(({ signup }) => escapeHtml(signup.displayName)).join(", ")}. They can run <strong>/raider link</strong>, then rerun <strong>/ready</strong>.</div>` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:24px;background:#0b0e13;color:#f2f4f8;font-family:"Segoe UI",Arial,sans-serif}.card{width:872px;overflow:hidden;border:1px solid #323946;border-left:6px solid ${LEGENDARY};border-radius:14px;background:#151a22;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:28px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}.brand img{width:38px;height:38px;object-fit:cover;border-radius:50%;border:1px solid rgba(255,128,0,.65)}.title{color:#45a5ff;font-weight:800;font-size:31px;letter-spacing:-.8px;line-height:1.08;margin-top:24px}.realm{color:#95a0b4;font-weight:600;font-size:16px;margin-top:7px}.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #303744;border-bottom:1px solid #303744;padding:18px 0;margin:22px 0}.stat{padding:0 18px;border-left:1px solid #303744}.stat:first-child{padding-left:0;border-left:0}.label{display:block;color:#a7b0c0;font-size:13px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.value{display:block;margin-top:7px;font-size:31px;line-height:1;font-weight:800;letter-spacing:-.7px;color:${LEGENDARY}}.stat:nth-child(2) .value{color:#55aaff}.stat:nth-child(3) .value{color:#4ce887}.sub{display:block;margin-top:6px;color:#c5ccd7;font-size:14px;font-weight:600}.roster{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.roster-head{display:grid;grid-template-columns:minmax(0,1fr) 94px 44px 58px;gap:7px;padding:0 7px 7px;color:#a7b0c0;font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}.ready-row{display:grid;grid-template-columns:minmax(0,1fr) 94px 44px 58px;align-items:center;min-height:42px;gap:7px;border-top:1px solid #2a303b;padding:5px 7px;background:rgba(8,12,18,.15)}.ready-row:last-child{border-bottom:1px solid #2a303b}.ready-name{overflow:hidden;color:#f1f3f7;font-size:13px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.ready-spec{overflow:hidden;color:#aeb8c8;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.ready-ilvl{justify-self:end;color:#55aaff;background:#202937;border-radius:5px;padding:4px 5px;font-size:12px;font-weight:800}.ready-gs{justify-self:end;font-size:13px;font-weight:800}.ready-gs.ready{color:#4ce887}.ready-gs.review{color:${LEGENDARY}}.empty{padding:20px;border:1px solid #303744;border-radius:8px;color:#c5ccd7}.unresolved{margin-top:20px;padding:12px 14px;border:1px solid rgba(255,128,0,.4);border-radius:8px;color:#d4d9e2;font-size:13px;line-height:1.45}.unresolved strong{color:${LEGENDARY}}.footer{margin-top:20px;padding-top:15px;border-top:1px solid #303744;color:#8994a6;font-size:12px}.footer strong{color:#d9dfe9}
    </style></head><body><main class="card"><header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Raid Readiness</span></header><div class="title">${escapeHtml(input.report.eventTitle)}</div><div class="realm">${escapeHtml(input.realm)} · Live Raid-Helper signups</div><div class="stats"><div class="stat"><span class="label">Signed up</span><span class="value">${input.report.signups.length}</span><span class="sub">Active attendees</span></div><div class="stat"><span class="label">Average GS</span><span class="value">${average.toLocaleString()}</span><span class="sub">Armory verified</span></div><div class="stat"><span class="label">Raid ready</span><span class="value">${ready}/${members.length}</span><span class="sub">5,000+ GearScore</span></div></div>${members.length ? `<div class="roster"><section><div class="roster-head"><span>Character</span><span>Spec</span><span>iLvl</span><span>GS</span></div>${rosterRows(members.slice(0, midpoint))}</section><section><div class="roster-head"><span>Character</span><span>Spec</span><span>iLvl</span><span>GS</span></div>${rosterRows(members.slice(midpoint))}</section></div>` : `<div class="empty">No signed attendees could be matched to a Warmane character yet.</div>`}${unresolved}<div class="footer"><strong>PizzaWarriors Raid Readiness</strong> · Raid-Helper live event ${escapeHtml(input.report.eventId)}</div></main></body></html>`;
    try { await page.setContent(html, { waitUntil: "load" }); return await page.locator(".card").screenshot({ type: "png" }); } finally { await context.close(); }
    });
  }

  /** Render ten public Warmane guild members at a time for Discord's readable preview size. */
  async renderRoster(input: { roster: GuildRoster; page: number; pageSize?: number }): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
    const logo = await this.getLogo();
    const pageSize = input.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(input.roster.members.length / pageSize));
    const pageIndex = Math.min(Math.max(input.page, 0), totalPages - 1);
    const members = input.roster.members.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
    const context = await browser.newContext({ viewport: { width: 920, height: 1_100 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const classColors: Record<string, string> = { "Death Knight": "#c41f3b", Druid: "#ff7d0a", Hunter: "#abd473", Mage: "#69ccf0", Paladin: "#f58cba", Priest: "#ffffff", Rogue: "#fff569", Shaman: "#0070de", Warlock: "#9482c9", Warrior: "#c79c6e" };
    const rows = (list: typeof members) => list.map((member) => `<div class="roster-row"><span class="member-name">${escapeHtml(member.name)}</span><span class="member-class" style="--class-color:${classColors[member.className] ?? "#c5ccd7"}">${escapeHtml(member.className)}</span><span class="member-level">${member.level}</span><span class="member-rank">${escapeHtml(member.rank)}</span><span class="member-points">${member.achievementPoints.toLocaleString()}</span></div>`).join("");
    const midpoint = Math.ceil(members.length / 2);
    const level80 = input.roster.members.filter((member) => member.level === 80).length;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:24px;background:#0b0e13;color:#f2f4f8;font-family:"Segoe UI",Arial,sans-serif}.card{width:872px;overflow:hidden;border:1px solid #323946;border-left:6px solid ${LEGENDARY};border-radius:14px;background:#151a22;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:28px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}.brand img{width:38px;height:38px;object-fit:cover;border-radius:50%;border:1px solid rgba(255,128,0,.65)}.title{color:#45a5ff;font-weight:800;font-size:34px;letter-spacing:-.8px;line-height:1.08;margin-top:24px}.realm{color:#95a0b4;font-weight:600;font-size:16px;margin-top:7px}.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #303744;border-bottom:1px solid #303744;padding:18px 0;margin:22px 0}.stat{padding:0 18px;border-left:1px solid #303744}.stat:first-child{padding-left:0;border-left:0}.label{display:block;color:#a7b0c0;font-size:13px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.value{display:block;margin-top:7px;font-size:30px;line-height:1;font-weight:800;letter-spacing:-.7px;color:${LEGENDARY}}.stat:nth-child(2) .value{color:#55aaff}.stat:nth-child(3) .value{color:#4ce887}.sub{display:block;margin-top:6px;color:#c5ccd7;font-size:14px;font-weight:600}.roster{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.head,.roster-row{display:grid;grid-template-columns:minmax(0,1fr) 80px 34px 88px 48px;align-items:center;gap:7px;padding:5px 7px}.head{padding-bottom:7px;color:#a7b0c0;font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}.roster-row{min-height:46px;border-top:1px solid #2a303b;background:rgba(8,12,18,.15)}.roster-row:last-child{border-bottom:1px solid #2a303b}.member-name{overflow:hidden;color:#f1f3f7;font-size:13px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.member-class{overflow:hidden;color:var(--class-color);font-size:12px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.member-level{justify-self:end;color:#55aaff;background:#202937;border-radius:5px;padding:4px 5px;font-size:12px;font-weight:800}.member-rank{overflow:hidden;color:#aeb8c8;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.member-points{justify-self:end;color:#c5ccd7;font-size:12px;font-weight:800}.footer{margin-top:20px;padding-top:15px;border-top:1px solid #303744;color:#8994a6;font-size:12px}.footer strong{color:#d9dfe9}
    </style></head><body><main class="card"><header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Guild Roster</span></header><div class="title">${escapeHtml(input.roster.guildName)}</div><div class="realm">${escapeHtml(input.roster.faction)} · ${escapeHtml(input.roster.realm)} · Warmane Armory</div><div class="stats"><div class="stat"><span class="label">Guild members</span><span class="value">${input.roster.memberCount}</span><span class="sub">Armory roster</span></div><div class="stat"><span class="label">Level 80s</span><span class="value">${level80}</span><span class="sub">Active end-game pool</span></div><div class="stat"><span class="label">Roster page</span><span class="value">${pageIndex + 1}/${totalPages}</span><span class="sub">10 members per page</span></div></div><div class="roster"><section><div class="head"><span>Character</span><span>Class</span><span>Lvl</span><span>Rank</span><span>AP</span></div>${rows(members.slice(0, midpoint))}</section><section><div class="head"><span>Character</span><span>Class</span><span>Lvl</span><span>Rank</span><span>AP</span></div>${rows(members.slice(midpoint))}</section></div><div class="footer"><strong>PizzaWarriors Guild Roster</strong> · Public Warmane Armory · Page ${pageIndex + 1} of ${totalPages}</div></main></body></html>`;
    try { await page.setContent(html, { waitUntil: "load" }); return await page.locator(".card").screenshot({ type: "png" }); } finally { await context.close(); }
    });
  }
}
