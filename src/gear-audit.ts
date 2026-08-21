import type { GearItem, GearScoreEquipLoc } from "./gearscore.js";

export type GearPreparationIssue = { slot: string; itemName: string; missing: number };
export type GearPreparationAudit = {
  status: "complete" | "incomplete" | "unverified";
  missingEnchants: GearPreparationIssue[];
  missingGems: GearPreparationIssue[];
  unverifiedSlots: string[];
  requiredEnchants: number;
  presentEnchants: number;
  requiredGems: number;
  presentGems: number;
};

const REQUIRED_ENCHANT_TYPES = new Set<GearScoreEquipLoc>([
  "INVTYPE_HEAD", "INVTYPE_SHOULDER", "INVTYPE_CLOAK", "INVTYPE_CHEST", "INVTYPE_ROBE",
  "INVTYPE_WRIST", "INVTYPE_HAND", "INVTYPE_LEGS", "INVTYPE_FEET", "INVTYPE_2HWEAPON",
  "INVTYPE_WEAPONMAINHAND", "INVTYPE_WEAPONOFFHAND", "INVTYPE_WEAPON", "INVTYPE_SHIELD",
]);

function requiresEnchant(item: GearItem, className?: string): boolean {
  if (item.slot === "Ranged") return className === "Hunter" && item.equipLoc === "INVTYPE_RANGED";
  return Boolean(item.equipLoc && REQUIRED_ENCHANT_TYPES.has(item.equipLoc));
}

/**
 * Audit the PUG-standard preparation checks that can be proven from Warmane:
 * every normal enchantable slot, every native socket, an Eternal Belt Buckle
 * socket on level-70+ belts, and Blacksmith-only wrist/glove sockets.
 */
export function auditGearPreparation(items: GearItem[], professions: string[] = [], className?: string): GearPreparationAudit {
  const missingEnchants: GearPreparationIssue[] = [];
  const missingGems: GearPreparationIssue[] = [];
  const unverifiedSlots: string[] = [];
  const blacksmith = professions.some((profession) => /blacksmith/i.test(profession));
  let requiredEnchants = 0;
  let presentEnchants = 0;
  let requiredGems = 0;
  let presentGems = 0;

  for (const item of items) {
    if (item.equipLoc === "INVTYPE_BODY" || item.equipLoc === "INVTYPE_TABARD") continue;
    if (!item.auditDataAvailable) {
      unverifiedSlots.push(item.slot);
      continue;
    }

    if (requiresEnchant(item, className)) {
      requiredEnchants++;
      if (item.enchantId) presentEnchants++;
      else missingEnchants.push({ slot: item.slot, itemName: item.name, missing: 1 });
    }

    if (item.socketCount === undefined) {
      unverifiedSlots.push(item.slot);
      continue;
    }
    const buckleSocket = item.slot === "Waist" && item.itemLevel >= 70 ? 1 : 0;
    const blacksmithSocket = blacksmith && (item.slot === "Wrist" || item.slot === "Hands") && item.itemLevel >= 70 ? 1 : 0;
    const expected = item.socketCount + buckleSocket + blacksmithSocket;
    const filled = Math.min(expected, (item.gemIds ?? []).filter((gemId) => gemId > 0).length);
    requiredGems += expected;
    presentGems += filled;
    if (filled < expected) missingGems.push({ slot: item.slot, itemName: item.name, missing: expected - filled });
  }

  const status = unverifiedSlots.length
    ? "unverified"
    : missingEnchants.length || missingGems.length
      ? "incomplete"
      : "complete";
  return { status, missingEnchants, missingGems, unverifiedSlots, requiredEnchants, presentEnchants, requiredGems, presentGems };
}
