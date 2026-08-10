import type { UpgradeProfile, UpgradeTarget } from "./upgrade.js";

const SPREADSHEET_ID = "1i5CFTZ8kIrISQzvNmJHx85smAYlkaCTO9q_UcsrcqqE";
const CACHE_AGE_MS = 5 * 60 * 1_000;

type SheetSpec = { className: string; selection: string; header: string; gid: number; sheetName: string };

const sheetSpecs: readonly SheetSpec[] = [
  { className: "Death Knight", selection: "Frost (ArP)", header: "FROST ARP", gid: 1860257745, sheetName: "DeathKnight" },
  { className: "Death Knight", selection: "Frost (Strength)", header: "FROST STR", gid: 1860257745, sheetName: "DeathKnight" },
  { className: "Death Knight", selection: "Unholy", header: "UNHOLY", gid: 1860257745, sheetName: "DeathKnight" },
  { className: "Death Knight", selection: "Blood DPS", header: "BLOOD DPS", gid: 1860257745, sheetName: "DeathKnight" },
  { className: "Death Knight", selection: "Blood Tank", header: "BLOOD TANK", gid: 1860257745, sheetName: "DeathKnight" },
  { className: "Druid", selection: "Feral DPS", header: "CAT", gid: 729245629, sheetName: "Druid" },
  { className: "Druid", selection: "Feral Tank", header: "BEAR", gid: 729245629, sheetName: "Druid" },
  { className: "Druid", selection: "Balance", header: "BALANCE", gid: 729245629, sheetName: "Druid" },
  { className: "Druid", selection: "Restoration", header: "RESTORATION", gid: 729245629, sheetName: "Druid" },
  { className: "Hunter", selection: "Marksmanship", header: "MARKSMANSHIP", gid: 812897183, sheetName: "Hunter" },
  { className: "Hunter", selection: "Survival", header: "SURVIVAL", gid: 812897183, sheetName: "Hunter" },
  { className: "Mage", selection: "Arcane (TTW 1)", header: "TORMENT OF THE WEAK option 1", gid: 70849825, sheetName: "Mage" },
  { className: "Mage", selection: "Arcane (TTW 2)", header: "TORMENT OF THE WEAK option 2", gid: 70849825, sheetName: "Mage" },
  { className: "Mage", selection: "Arcane", header: "ARCANE", gid: 70849825, sheetName: "Mage" },
  { className: "Paladin", selection: "Holy", header: "HOLY", gid: 1774197139, sheetName: "Paladin" },
  { className: "Paladin", selection: "Retribution", header: "RET", gid: 1774197139, sheetName: "Paladin" },
  { className: "Paladin", selection: "Protection", header: "PROT", gid: 1774197139, sheetName: "Paladin" },
  { className: "Paladin", selection: "Protection (Expertise)", header: "PROT (EXPERTISE)", gid: 1774197139, sheetName: "Paladin" },
  { className: "Paladin", selection: "Protection (Block)", header: "PROT (block)", gid: 1774197139, sheetName: "Paladin" },
  { className: "Priest", selection: "Shadow", header: "SHADOW", gid: 1264470097, sheetName: "Priest" },
  { className: "Priest", selection: "Discipline", header: "DISCIPLINE", gid: 1264470097, sheetName: "Priest" },
  { className: "Priest", selection: "Holy", header: "HOLY", gid: 1264470097, sheetName: "Priest" },
  { className: "Rogue", selection: "Combat (2-piece)", header: "COMBAT 2P", gid: 522322245, sheetName: "Rogue" },
  { className: "Rogue", selection: "Assassination (2-piece)", header: "ASSASSINATION 2P", gid: 522322245, sheetName: "Rogue" },
  { className: "Shaman", selection: "Elemental", header: "ELEMENTAL", gid: 1864204526, sheetName: "Shaman" },
  { className: "Shaman", selection: "Restoration", header: "RESTORATION", gid: 1864204526, sheetName: "Shaman" },
  { className: "Shaman", selection: "Enhancement", header: "ENHANCEMENT", gid: 1864204526, sheetName: "Shaman" },
  { className: "Shaman", selection: "Enhancement (Option 2)", header: "ENHANCEMENT option 2", gid: 1864204526, sheetName: "Shaman" },
  { className: "Warlock", selection: "Demonology", header: "DEMONOLOGY", gid: 1328025789, sheetName: "Warlock" },
  { className: "Warlock", selection: "Affliction", header: "AFFLICTION", gid: 1328025789, sheetName: "Warlock" },
  { className: "Warrior", selection: "Fury", header: "FURY", gid: 1598714998, sheetName: "Warrior" },
  { className: "Warrior", selection: "Fury (No Shadowmourne)", header: "Fury (No SM)", gid: 1598714998, sheetName: "Warrior" },
  { className: "Warrior", selection: "Protection", header: "PROTECTION", gid: 1598714998, sheetName: "Warrior" },
  { className: "Warrior", selection: "Protection (Block Gear)", header: "PROTECTION (Block Gear)", gid: 1598714998, sheetName: "Warrior" },
];

const slotMap: Record<string, string> = { Head: "Head", Neck: "Neck", Shoulders: "Shoulder", Cape: "Back", Chest: "Chest", Wrist: "Wrist", Hands: "Hands", Belt: "Waist", Legs: "Legs", Feet: "Feet", "Ring 1": "Ring 1", "Ring 2": "Ring 2", "Trinket 1": "Trinket 1", "Trinket 2": "Trinket 2", Weapon: "Main Hand", "Offhand/Shield": "Off Hand", Relic: "Ranged" };
const slotIcons: Record<string, string> = { Head: "inv_helmet_154", Neck: "inv_jewelry_necklace_48", Shoulder: "inv_shoulder_117", Back: "inv_misc_cape_19", Chest: "inv_chest_plate22", Wrist: "inv_bracer_43", Hands: "inv_gauntlets_85", Waist: "inv_belt_63", Legs: "inv_pants_plate_33", Feet: "inv_boots_plate_12", "Ring 1": "inv_jewelry_ring_84", "Ring 2": "inv_jewelry_ring_84", "Trinket 1": "inv_jewelry_trinket_04", "Trinket 2": "inv_jewelry_trinket_04", "Main Hand": "inv_sword_153", "Off Hand": "inv_shield_75", Ranged: "inv_relics_libramofhope" };
const csvCache = new Map<number, { expiresAt: number; rows: string[][] }>();

export const upgradeSpecNames = [...new Set(sheetSpecs.map((spec) => spec.selection))];

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell.trim()); cell = ""; }
    else if (character === "\n") { row.push(cell.trim()); rows.push(row); row = []; cell = ""; }
    else if (character !== "\r") cell += character;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

async function getRows(gid: number): Promise<string[][]> {
  const cached = csvCache.get(gid);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&gid=${gid}`;
  const response = await fetch(url, { headers: { accept: "text/csv", "user-agent": "PizzaWarriorsArmoryBot/1.0 (+Google Sheets upgrade source)" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Google Sheets returned ${response.status}.`);
  const rows = parseCsv(await response.text());
  csvCache.set(gid, { rows, expiresAt: Date.now() + CACHE_AGE_MS });
  return rows;
}

function matchesFor(value: string): string[] {
  // Commas are part of many actual WoW item names (for example Mithrios,
  // Bronzebeard's Legacy), while slashes/newlines are the sheet's alternatives.
  return value.split(/\n|\s*\/\s*/).map((part) => part.replace(/\([^)]*\)/g, "").trim()).filter((part) => part.length > 2);
}

function targetsFor(rows: string[][], spec: SheetSpec): UpgradeTarget[] {
  const headerRow = rows.findIndex((row) => normalise(row[0] ?? "") === "slot v spec");
  if (headerRow < 0) throw new Error(`The ${spec.sheetName} sheet has no spec header row.`);
  const column = rows[headerRow].findIndex((value) => normalise(value) === normalise(spec.header));
  if (column < 1) throw new Error(`The ${spec.header} column was not found in the ${spec.sheetName} sheet.`);
  return rows.slice(headerRow + 1).flatMap((row) => {
    const slot = slotMap[(row[0] ?? "").trim()];
    const name = (row[column] ?? "").trim();
    if (!slot || !name) return [];
    return [{ slot, name: name.replace(/\s+/g, " "), icon: slotIcons[slot] ?? "inv_misc_questionmark", aliases: matchesFor(name) }];
  });
}

/** Load the selected upgrade path directly from the PizzaWarriors authoritative sheet. */
export async function getSheetUpgradeProfile(className: string, selection: string): Promise<UpgradeProfile | undefined> {
  const spec = sheetSpecs.find((candidate) => candidate.className.toLowerCase() === className.toLowerCase() && candidate.selection.toLowerCase() === selection.toLowerCase());
  if (!spec) return undefined;
  const targets = targetsFor(await getRows(spec.gid), spec);
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?gid=${spec.gid}#gid=${spec.gid}`;
  return {
    id: `sheet-${spec.className.toLowerCase().replace(/\s+/g, "-")}-${spec.selection.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    className: spec.className,
    specName: spec.selection,
    status: "approved",
    content: "ICC / Ruby Sanctum",
    reviewNote: "PizzaWarriors Lordaeron Best-in-Slot List — live Google Sheets source.",
    sources: [{ title: `${spec.className} ${spec.selection} Best-in-Slot List`, url, publishedYear: 2026, note: "Live PizzaWarriors spreadsheet source." }],
    targets,
  };
}

export const __test = { parseCsv, targetsFor };
