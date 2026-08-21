import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { isRecoverableBrowserError } from "./browser-recovery.js";
import type { GearItem, GearScoreSummary } from "./gearscore.js";
import type { UpgradeProfile, UpgradeTarget } from "./upgrade.js";
import type { RaidRole, RaidSignup, ReadyReport } from "./ready.js";
import type { GuildRoster } from "./guild.js";
import type { CoreRosterAudit, CoreRosterAuditEntry, CoreRosterStatus } from "./core-roster.js";
import type { CoreAttendanceHistory } from "./core-attendance.js";
import { gearScoreTier, itemGearScoreTier } from "./score-tiers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_FILE = join(ROOT, "assets", "pizzawarriors-armory-discord-icon-1024.png");
const LEGENDARY = "#ff8000";
const CARD_DEVICE_SCALE_FACTOR = 3;
const RAID_READY_GEAR_SCORE = 5_800;
const RAID_SIZE = 25;
const ROLE_TARGETS: ReadonlyArray<{ role: RaidRole; label: string; target: number }> = [
  { role: "Tanks", label: "Tanks", target: 2 },
  { role: "Healers", label: "Healers", target: 5 },
  { role: "Melee", label: "Melee", target: 8 },
  { role: "Ranged", label: "Ranged", target: 10 },
];

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
const classColors: Record<string, string> = {
  "Death Knight": "#c41f3b", Druid: "#ff7d0a", Hunter: "#abd473", Mage: "#69ccf0", Paladin: "#f58cba",
  Priest: "#ffffff", Rogue: "#fff569", Shaman: "#0070de", Warlock: "#9482c9", Warrior: "#c79c6e",
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
    // Discord downscales attachment previews. Render at 3x so the character
    // thumbnail, item icons, and type remain crisp in the message preview.
    const context = await browser.newContext({ viewport: { width: 920, height: 1_400 }, deviceScaleFactor: CARD_DEVICE_SCALE_FACTOR });
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
    const context = await browser.newContext({ viewport: { width: 920, height: 1_400 }, deviceScaleFactor: CARD_DEVICE_SCALE_FACTOR });
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
  async renderReady(input: { report: ReadyReport; realm: string; coreRoster?: CoreRosterAudit }): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
      const logo = await this.getLogo();
      const context = await browser.newContext({ viewport: { width: 920, height: 1_600 }, deviceScaleFactor: CARD_DEVICE_SCALE_FACTOR });
      const page = await context.newPage();
      const members = [...input.report.members].sort((a, b) => b.summary.score - a.summary.score);
      const attendance = (status: "Signed" | "Late" | "Tentative" | "Bench" | "Absent") => input.report.signups.filter((signup) => signup.status === status);
      const signed = attendance("Signed");
      const late = attendance("Late");
      const average = members.length ? Math.round(members.reduce((total, member) => total + member.summary.score, 0) / members.length) : 0;
      const memberBySignup = new Map(members.map((member) => [member.signup.discordUserId, member]));
      const ready = ROLE_TARGETS.reduce((total, group) => total + Math.min(group.target, members.filter((member) => (
        member.signup.reportedRole === group.role
        && member.summary.score >= RAID_READY_GEAR_SCORE
        && member.preparation.status === "complete"
      )).length), 0);
      const openSpots = Math.max(0, RAID_SIZE - input.report.activeSignups.length);
      const notReady = RAID_SIZE - ready;
      const readinessSub = notReady === 0
        ? `Full ${RAID_SIZE}-player roster · 5,800+ GS`
        : openSpots > 0
          ? `${notReady} required slot${notReady === 1 ? "" : "s"} not ready · ${openSpots} signup${openSpots === 1 ? "" : "s"} missing`
          : `${notReady} required role slot${notReady === 1 ? "" : "s"} below GS or unfilled`;
      const readinessColor = ready === RAID_SIZE ? "#4ce887" : LEGENDARY;
      const formatSpec = (value: string) => value.replace(/_/g, " ").replace(/(?<=\D)1$/, "");
      const rosterRows = (list: RaidSignup[]) => list.map((signup) => {
        const member = memberBySignup.get(signup.discordUserId);
        const score = member?.summary.score;
        const preparation = member?.preparation.status;
        const prepLabel = preparation === "complete" ? "✓" : preparation === "incomplete" ? "!" : "?";
        return `<div class="ready-row"><span class="ready-name" style="color:${classColors[member?.className ?? ""] ?? "#f1f3f7"}">${escapeHtml(signup.displayName)}</span><span class="ready-spec">${escapeHtml(formatSpec(signup.reportedSpec ?? "No spec"))}</span><span class="ready-ilvl">${member ? `i${member.summary.averageItemLevel}` : "—"}</span><span class="ready-gs ${score !== undefined && score >= RAID_READY_GEAR_SCORE ? "ready" : "review"}">${score?.toLocaleString() ?? "—"}</span><span class="prep ${preparation ?? "unverified"}">${prepLabel}</span></div>`;
      }).join("");
      const sortByGearScore = (left: RaidSignup, right: RaidSignup) => (memberBySignup.get(right.discordUserId)?.summary.score ?? -1)
        - (memberBySignup.get(left.discordUserId)?.summary.score ?? -1);
      const roleSections = ROLE_TARGETS.map((group) => {
        const signups = input.report.activeSignups.filter((signup) => signup.reportedRole === group.role).sort(sortByGearScore);
        const state = signups.length < group.target ? "short" : signups.length > group.target ? "over" : "full";
        return `<section class="role-section"><div class="role-heading"><span>${group.label}</span><b class="${state}">${signups.length}/${group.target}</b></div><div class="roster-head"><span>Signup name</span><span>Event spec</span><span>iLvl</span><span>GS</span><span>Prep</span></div>${signups.length ? rosterRows(signups) : `<div class="empty-role">No ${group.label.toLowerCase()} signed</div>`}</section>`;
      });
      const unassigned = input.report.activeSignups.filter((signup) => !signup.reportedRole).sort(sortByGearScore);
      const unassignedSection = unassigned.length ? `<section class="role-section unassigned"><div class="role-heading"><span>Role not selected</span><b class="short">${unassigned.length}</b></div><div class="roster-head"><span>Signup name</span><span>Event spec</span><span>iLvl</span><span>GS</span><span>Prep</span></div>${rosterRows(unassigned)}</section>` : "";
      const groupedRoles = `<div class="role-column">${roleSections[0] ?? ""}${roleSections[2] ?? ""}</div><div class="role-column">${roleSections[1] ?? ""}${roleSections[3] ?? ""}</div>${unassignedSection}`;
      const coreNames = (entries: readonly CoreRosterAuditEntry[]) => entries.map((entry) => escapeHtml(entry.displayName)).join(" &nbsp;•&nbsp; ");
      const coreActionRow = (label: string, entries: readonly CoreRosterAuditEntry[], tone: string) => entries.length
        ? `<div class="core-action-row"><b class="${tone}">${label} · ${entries.length}</b><span>${coreNames(entries)}</span></div>`
        : "";
      const coreSummary = input.coreRoster ? `<section class="core-check"><div class="core-check-head"><div><span>Core roster responses</span><b>${input.coreRoster.respondedCount}/${input.coreRoster.entries.length}</b></div><strong class="${input.coreRoster.actionable.length ? "attention" : "complete"}">${input.coreRoster.actionable.length ? `${input.coreRoster.actionable.length} need signup` : "All responded"}</strong></div><div class="core-counts"><span class="active">Active <b>${input.coreRoster.signed.length + input.coreRoster.late.length}</b></span><span>Tentative <b>${input.coreRoster.tentative.length}</b></span><span>Bench <b>${input.coreRoster.bench.length}</b></span><span>Absent <b>${input.coreRoster.absent.length}</b></span><span>Missing <b>${input.coreRoster.missing.length}</b></span></div><div class="core-actions">${coreActionRow("Not signed up", input.coreRoster.missing, "missing")}</div></section>` : "";
      const statusNames = (status: "Late" | "Tentative" | "Bench" | "Absent") => {
        const people = attendance(status);
        if (!people.length) return "";
        return `<div class="attendance-note"><strong>${status} · ${people.length}</strong><span>${people.map((signup) => `${escapeHtml(signup.displayName)}${signup.reportedSpec ? ` · ${escapeHtml(formatSpec(signup.reportedSpec))}` : ""}`).join(" &nbsp;•&nbsp; ")}</span></div>`;
      };
      const preparationIssues = members.filter((member) => member.preparation.status !== "complete").map((member) => {
        const details = member.preparation.status === "unverified"
          ? "Gem/enchant data could not be verified"
          : [
              ...member.preparation.missingEnchants.map((issue) => `${issue.slot} enchant`),
              ...member.preparation.missingGems.map((issue) => `${issue.slot} gem${issue.missing === 1 ? "" : ` ×${issue.missing}`}`),
            ].join(" · ");
        return `<div class="prep-note"><b style="color:${classColors[member.className ?? ""] ?? "#f1f3f7"}">${escapeHtml(member.signup.displayName)}</b><span>${escapeHtml(details || "Preparation incomplete")}</span></div>`;
      });
      const preparationSummary = preparationIssues.length ? `<div class="prep-summary"><div class="prep-summary-title">Needs gems or enchants · ${preparationIssues.length}</div>${preparationIssues.join("")}</div>` : "";
      const unresolved = input.report.unresolved.length ? `<div class="unresolved"><strong>${input.report.unresolved.length} Armory gear profile${input.report.unresolved.length === 1 ? "" : "s"} unavailable:</strong> ${input.report.unresolved.map(({ signup }) => escapeHtml(signup.displayName)).join(", ")}. Each event signup name was checked exactly as shown. Use <strong>/raider link</strong> only when a signup name genuinely differs from the in-game character.</div>` : "";
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:0;padding:24px;background:#0b0e13;color:#f2f4f8;font-family:"Segoe UI",Arial,sans-serif}.card{width:872px;overflow:hidden;border:1px solid #323946;border-left:6px solid ${LEGENDARY};border-radius:14px;background:#151a22;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:28px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}.brand img{width:38px;height:38px;object-fit:cover;border-radius:50%;border:1px solid rgba(255,128,0,.65)}.title{color:#45a5ff;font-weight:800;font-size:31px;letter-spacing:-.8px;line-height:1.08;margin-top:24px}.realm{color:#95a0b4;font-weight:600;font-size:16px;margin-top:7px}.stats{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid #303744;border-bottom:1px solid #303744;padding:18px 0;margin:22px 0}.stat{padding:0 18px;border-left:1px solid #303744}.stat:first-child{padding-left:0;border-left:0}.label{display:block;color:#a7b0c0;font-size:13px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.value{display:block;margin-top:7px;font-size:31px;line-height:1;font-weight:800;letter-spacing:-.7px;color:${LEGENDARY}}.stat:nth-child(2) .value{color:#55aaff}.stat:nth-child(3) .value{color:${readinessColor}}.sub{display:block;margin-top:6px;color:#c5ccd7;font-size:14px;font-weight:600}.attendance{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:-6px 0 20px}.attendance-count{padding:9px 10px;border:1px solid #303744;border-radius:7px;background:#111722;color:#aeb8c8;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase}.attendance-count b{display:block;margin-top:4px;color:#f2f4f8;font-size:18px;letter-spacing:0}.attendance-count.bench b{color:${LEGENDARY}}.attendance-count.absent b{color:#eb6c70}.attendance-count.tentative b{color:#f2c94c}.core-check{margin:0 0 22px;padding:14px;border:1px solid #303744;border-radius:9px;background:#111722}.core-check-head{display:flex;align-items:center;justify-content:space-between;gap:16px}.core-check-head div{display:flex;align-items:baseline;gap:10px}.core-check-head span{color:#a7b0c0;font-size:12px;font-weight:800;letter-spacing:.65px;text-transform:uppercase}.core-check-head b{color:#f2f4f8;font-size:20px}.core-check-head strong{border-radius:6px;padding:5px 8px;font-size:12px;text-transform:uppercase}.core-check-head strong.attention{background:rgba(255,128,0,.12);color:${LEGENDARY}}.core-check-head strong.complete{background:rgba(76,232,135,.1);color:#4ce887}.core-counts{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}.core-counts span{border-radius:5px;background:#202937;padding:5px 7px;color:#aeb8c8;font-size:11px;font-weight:700}.core-counts span.active b{color:#4ce887}.core-counts b{margin-left:3px;color:#f2f4f8}.core-actions{display:grid;gap:5px;margin-top:10px}.core-actions:empty{display:none}.core-action-row{display:flex;gap:10px;color:#c5ccd7;font-size:12px;line-height:1.4}.core-action-row b{min-width:105px}.core-action-row b.missing{color:${LEGENDARY}}.core-action-row b.tentative{color:#f2c94c}.core-action-row b.absent{color:#eb6c70}.core-action-row span{color:#aeb8c8}.role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:18px;align-items:start}.role-column{display:grid;gap:20px;align-content:start;min-width:0}.role-section{min-width:0}.role-section.unassigned{grid-column:1/-1;margin-top:20px}.role-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#c7d0dd;font-size:14px;font-weight:800;letter-spacing:.8px;text-transform:uppercase}.role-heading b{border-radius:5px;padding:4px 7px;background:#202937;color:#4ce887;font-size:12px;letter-spacing:0}.role-heading b.short{color:${LEGENDARY}}.role-heading b.over{color:#55aaff}.roster-head{display:grid;grid-template-columns:minmax(0,1fr) 82px 42px 55px 40px;gap:6px;padding:0 7px 7px;color:#a7b0c0;font-size:10px;font-weight:800;letter-spacing:.55px;text-transform:uppercase}.ready-row{display:grid;grid-template-columns:minmax(0,1fr) 82px 42px 55px 40px;align-items:center;min-height:42px;gap:6px;border-top:1px solid #2a303b;padding:5px 7px;background:rgba(8,12,18,.15)}.ready-row:last-child{border-bottom:1px solid #2a303b}.ready-name{overflow:hidden;color:#f1f3f7;font-size:13px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.ready-spec{overflow:hidden;color:#aeb8c8;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}.ready-ilvl{justify-self:end;color:#55aaff;background:#202937;border-radius:5px;padding:4px 5px;font-size:12px;font-weight:800}.ready-gs{justify-self:end;font-size:13px;font-weight:800}.ready-gs.ready{color:#4ce887}.ready-gs.review{color:${LEGENDARY}}.prep{justify-self:end;width:27px;border-radius:5px;padding:3px 0;text-align:center;background:#202937;font-size:13px;font-weight:900}.prep.complete{color:#4ce887}.prep.incomplete{color:${LEGENDARY}}.prep.unverified{color:#8994a6}.empty-role{border:1px dashed #303744;border-radius:7px;padding:13px;color:#8994a6;font-size:12px}.prep-summary{display:grid;gap:6px;margin-top:20px;padding:13px 14px;border:1px solid rgba(255,128,0,.4);border-radius:8px;background:#111722}.prep-summary-title{color:${LEGENDARY};font-size:12px;font-weight:800;letter-spacing:.6px;text-transform:uppercase}.prep-note{display:flex;gap:10px;color:#c5ccd7;font-size:12px;line-height:1.35}.prep-note b{min-width:110px}.prep-note span{color:#aeb8c8}.attendance-notes{display:grid;gap:7px;margin-top:20px}.attendance-note{display:flex;gap:10px;border-left:3px solid #4a5361;padding:7px 10px;background:#111722;color:#c5ccd7;font-size:12px;line-height:1.4}.attendance-note strong{min-width:92px;color:#f2f4f8}.attendance-note span{color:#aeb8c8}.empty{padding:20px;border:1px solid #303744;border-radius:8px;color:#c5ccd7}.unresolved{margin-top:20px;padding:12px 14px;border:1px solid rgba(255,128,0,.4);border-radius:8px;color:#d4d9e2;font-size:13px;line-height:1.45}.unresolved strong{color:${LEGENDARY}}.footer{margin-top:20px;padding-top:15px;border-top:1px solid #303744;color:#8994a6;font-size:12px}.footer strong{color:#d9dfe9}
      </style></head><body><main class="card"><header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Raid Readiness</span></header><div class="title">${escapeHtml(input.report.eventTitle)}</div><div class="realm">${escapeHtml(input.realm)} · Raid-Helper signup selections</div><div class="stats"><div class="stat"><span class="label">Signed</span><span class="value">${signed.length}</span><span class="sub">${late.length ? `${late.length} late attendee${late.length === 1 ? "" : "s"}` : "Active roster"}</span></div><div class="stat"><span class="label">Average GS</span><span class="value">${average.toLocaleString()}</span><span class="sub">${members.length}/${input.report.activeSignups.length} gear profiles loaded</span></div><div class="stat"><span class="label">Raid ready</span><span class="value">${ready}/${RAID_SIZE}</span><span class="sub">${readinessSub}</span></div></div><div class="attendance"><div class="attendance-count"><span>Signed</span><b>${signed.length}</b></div><div class="attendance-count tentative"><span>Tentative</span><b>${attendance("Tentative").length}</b></div><div class="attendance-count bench"><span>Bench</span><b>${attendance("Bench").length}</b></div><div class="attendance-count absent"><span>Absent</span><b>${attendance("Absent").length}</b></div></div>${coreSummary}${input.report.activeSignups.length ? `<div class="role-grid">${groupedRoles}</div>` : `<div class="empty">No signed or late attendees are currently on the active roster.</div>`}${preparationSummary}<div class="attendance-notes">${statusNames("Late")}${statusNames("Tentative")}${statusNames("Bench")}${statusNames("Absent")}</div>${unresolved}<div class="footer"><strong>PizzaWarriors Raid Readiness</strong> · 5,800+ GS · Gemmed · Enchanted · Raid-Helper event ${escapeHtml(input.report.eventId)}</div></main></body></html>`;
      try { await page.setContent(html, { waitUntil: "load" }); return await page.locator(".card").screenshot({ type: "png" }); } finally { await context.close(); }
    });
  }

  /** Render a private, current-core view of stored Raid-Helper response history. */
  async renderAttendance(input: { history: CoreAttendanceHistory }): Promise<Buffer> {
    return this.withBrowser(async (browser) => {
      const logo = await this.getLogo();
      const { history } = input;
      const cardWidth = Math.max(872, 340 + history.events.length * 62);
      const context = await browser.newContext({ viewport: { width: cardWidth + 48, height: 1_600 }, deviceScaleFactor: CARD_DEVICE_SCALE_FACTOR });
      const page = await context.newPage();
      const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/Halifax" });
      const gridColumns = `minmax(170px,1fr) repeat(${history.events.length},58px) 52px 52px`;
      const statusMeta: Record<CoreRosterStatus, { label: string; title: string; tone: string }> = {
        Signed: { label: "✓", title: "Signed", tone: "signed" },
        Late: { label: "L", title: "Late", tone: "late" },
        Tentative: { label: "T", title: "Tentative", tone: "tentative" },
        Bench: { label: "B", title: "Bench", tone: "bench" },
        Absent: { label: "A", title: "Absent", tone: "absent" },
        Missing: { label: "M", title: "No signup", tone: "missing" },
      };
      const statusBadge = (status: CoreRosterStatus | undefined) => {
        if (!status) return `<span class="status untracked" title="Not on that saved core roster">—</span>`;
        const meta = statusMeta[status];
        return `<span class="status ${meta.tone}" title="${meta.title}">${meta.label}</span>`;
      };
      const eventHeaders = history.events.map((event) => `<span class="event-date" title="${escapeHtml(event.title)}"><b>${dateFormat.format(new Date(event.startsAt))}</b><small>${new Date(event.startsAt).getFullYear()}</small></span>`).join("");
      const attentionMembers = history.members.filter((member) => member.missingCount > 0 || member.absentCount > 0);
      const rows = attentionMembers.map((member) => {
        const tone = member.missingCount ? "attention" : member.absentCount ? "absence" : "reliable";
        return `<div class="history-row" style="grid-template-columns:${gridColumns}"><span class="member-name ${tone}">${escapeHtml(member.displayName)}</span>${member.statuses.map(statusBadge).join("")}<span class="count missing-count">${member.missingCount}</span><span class="count absent-count">${member.absentCount}</span></div>`;
      }).join("") || `<div class="empty-history">Every currently tracked core member has responded without an explicit absence in this window.</div>`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:0;padding:24px;background:#0b0e13;color:#f2f4f8;font-family:"Segoe UI",Arial,sans-serif}.card{width:${cardWidth}px;overflow:hidden;border:1px solid #323946;border-left:6px solid ${LEGENDARY};border-radius:14px;background:#151a22;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:28px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:700}.brand img{width:38px;height:38px;object-fit:cover;border-radius:50%;border:1px solid rgba(255,128,0,.65)}.title{margin-top:24px;color:#45a5ff;font-size:34px;font-weight:800;letter-spacing:-.8px;line-height:1.08}.subtitle{margin-top:7px;color:#95a0b4;font-size:16px;font-weight:600}.stats{display:grid;grid-template-columns:repeat(4,1fr);margin:22px 0;padding:18px 0;border-top:1px solid #303744;border-bottom:1px solid #303744}.stat{padding:0 16px;border-left:1px solid #303744}.stat:first-child{padding-left:0;border-left:0}.label{display:block;color:#a7b0c0;font-size:12px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}.value{display:block;margin-top:7px;color:#55aaff;font-size:29px;font-weight:800;letter-spacing:-.6px;line-height:1}.stat:nth-child(2) .value{color:${LEGENDARY}}.stat:nth-child(3) .value{color:#eb6c70}.stat:nth-child(4) .value{color:#4ce887}.sub{display:block;margin-top:6px;color:#c5ccd7;font-size:13px;font-weight:600}.section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;color:#c7d0dd;font-size:13px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}.section-title b{border-radius:5px;padding:4px 7px;background:#202937;color:${LEGENDARY};font-size:12px}.table{overflow:hidden;border:1px solid #303744;border-radius:9px;background:#111722}.history-head,.history-row{display:grid;align-items:center;gap:4px;padding:7px 9px}.history-head{grid-template-columns:${gridColumns};min-height:50px;color:#a7b0c0;font-size:10px;font-weight:800;letter-spacing:.55px;text-transform:uppercase}.history-row{min-height:39px;border-top:1px solid #2a303b;background:rgba(8,12,18,.15)}.member-name{overflow:hidden;color:#f1f3f7;font-size:13px;font-weight:800;text-overflow:ellipsis;white-space:nowrap}.member-name.attention{color:${LEGENDARY}}.member-name.absence{color:#eb8a8e}.event-date{display:grid;justify-items:center;line-height:1.05;text-transform:none}.event-date b{color:#c7d0dd;font-size:11px}.event-date small{margin-top:3px;color:#687386;font-size:9px}.status{justify-self:center;width:27px;border-radius:5px;padding:4px 0;text-align:center;background:#202937;font-size:12px;font-weight:900}.status.signed{color:#4ce887}.status.late{color:#55aaff}.status.tentative{color:#f2c94c}.status.bench{color:#69ccf0}.status.absent{color:#eb6c70}.status.missing{color:${LEGENDARY};background:rgba(255,128,0,.12)}.status.untracked{color:#586273;background:transparent}.count{justify-self:center;font-size:13px;font-weight:800}.missing-count{color:${LEGENDARY}}.absent-count{color:#eb6c70}.empty-history{padding:18px;border-top:1px solid #2a303b;color:#4ce887;font-size:13px;font-weight:700}.legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px;color:#aeb8c8;font-size:11px}.legend span{display:flex;align-items:center;gap:6px}.legend b{display:inline-grid;width:20px;height:20px;place-items:center;border-radius:4px;background:#202937}.privacy{margin-top:16px;padding:12px 14px;border:1px solid #303744;border-radius:8px;background:#111722;color:#aeb8c8;font-size:12px;line-height:1.45}.privacy strong{color:#d9dfe9}.footer{margin-top:20px;padding-top:15px;border-top:1px solid #303744;color:#8994a6;font-size:12px}.footer strong{color:#d9dfe9}
      </style></head><body><main class="card"><header class="brand"><img src="${logo}" alt="PizzaWarriors"><span>PizzaWarriors Officer Tools</span></header><div class="title">Pizza Core Signup History</div><div class="subtitle">Private officer report · Rolling ${history.events.length} raid${history.events.length === 1 ? "" : "s"}</div><div class="stats"><div class="stat"><span class="label">Raids tracked</span><span class="value">${history.events.length}</span><span class="sub">One snapshot per event</span></div><div class="stat"><span class="label">No signup</span><span class="value">${history.missingSignups}</span><span class="sub">Missing responses</span></div><div class="stat"><span class="label">Absent</span><span class="value">${history.explicitAbsences}</span><span class="sub">Selected in Raid-Helper</span></div><div class="stat"><span class="label">Response rate</span><span class="value">${history.responseRate}%</span><span class="sub">${history.reliableMembers}/${history.members.length} with no signup misses</span></div></div><div class="section-title"><span>Members needing review</span><b>${attentionMembers.length}</b></div><div class="table"><div class="history-head"><span>Core member</span>${eventHeaders}<span>Miss</span><span>Abs</span></div>${rows}</div><div class="legend"><span><b class="status signed">✓</b>Signed</span><span><b class="status late">L</b>Late</span><span><b class="status tentative">T</b>Tentative</span><span><b class="status bench">B</b>Bench</span><span><b class="status absent">A</b>Absent</span><span><b class="status missing">M</b>No signup</span><span><b class="status untracked">—</b>Not yet on saved roster</span></div><div class="privacy"><strong>What this proves:</strong> Missing means the member did not appear anywhere in that Raid-Helper event. Absent, tentative, and bench are deliberate selections. A true in-raid no-show cannot be inferred from signup data and is not silently recorded as one.</div><div class="footer"><strong>PizzaWarriors Core Attendance</strong> · Captured automatically by /ready · Stored privately on the bot host</div></main></body></html>`;
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
    const context = await browser.newContext({ viewport: { width: 920, height: 1_100 }, deviceScaleFactor: CARD_DEVICE_SCALE_FACTOR });
    const page = await context.newPage();
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
