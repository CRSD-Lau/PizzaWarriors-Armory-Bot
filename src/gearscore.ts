/**
 * WotLK 3.3.5a GearScoreLite rules, adapted from Pizza Logs' tested scorer.
 * Equipment position comes from Warmane; equipment type comes from item metadata.
 */
export type GearScoreEquipLoc =
  | "INVTYPE_RELIC" | "INVTYPE_TRINKET" | "INVTYPE_2HWEAPON"
  | "INVTYPE_WEAPONMAINHAND" | "INVTYPE_WEAPONOFFHAND" | "INVTYPE_RANGED"
  | "INVTYPE_THROWN" | "INVTYPE_RANGEDRIGHT" | "INVTYPE_SHIELD"
  | "INVTYPE_WEAPON" | "INVTYPE_HOLDABLE" | "INVTYPE_HEAD"
  | "INVTYPE_NECK" | "INVTYPE_SHOULDER" | "INVTYPE_CHEST"
  | "INVTYPE_ROBE" | "INVTYPE_WAIST" | "INVTYPE_LEGS" | "INVTYPE_FEET"
  | "INVTYPE_WRIST" | "INVTYPE_HAND" | "INVTYPE_FINGER" | "INVTYPE_CLOAK"
  | "INVTYPE_BODY" | "INVTYPE_TABARD";

export type GearItem = {
  id: number;
  slot: string;
  name: string;
  itemLevel: number;
  quality: string;
  equipLoc?: GearScoreEquipLoc;
  iconUrl?: string;
  enchantId?: number;
  gemIds?: number[];
  socketCount?: number;
  auditDataAvailable?: boolean;
};

const SCALE = 1.8618;
const QUALITY: Record<string, number> = { poor: 0, common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5, artifact: 6, heirloom: 7 };
const ITEM_TYPES: Partial<Record<GearScoreEquipLoc, number>> = {
  INVTYPE_RELIC: 0.3164, INVTYPE_TRINKET: 0.5625, INVTYPE_2HWEAPON: 2,
  INVTYPE_WEAPONMAINHAND: 1, INVTYPE_WEAPONOFFHAND: 1, INVTYPE_RANGED: 0.3164,
  INVTYPE_THROWN: 0.3164, INVTYPE_RANGEDRIGHT: 0.3164, INVTYPE_SHIELD: 1,
  INVTYPE_WEAPON: 1, INVTYPE_HOLDABLE: 1, INVTYPE_HEAD: 1, INVTYPE_NECK: 0.5625,
  INVTYPE_SHOULDER: 0.75, INVTYPE_CHEST: 1, INVTYPE_ROBE: 1, INVTYPE_WAIST: 0.75,
  INVTYPE_LEGS: 1, INVTYPE_FEET: 0.75, INVTYPE_WRIST: 0.5625, INVTYPE_HAND: 0.75,
  INVTYPE_FINGER: 0.5625, INVTYPE_CLOAK: 0.5625,
};

const slotFallbacks: Record<string, GearScoreEquipLoc | undefined> = {
  head: "INVTYPE_HEAD", neck: "INVTYPE_NECK", shoulder: "INVTYPE_SHOULDER", back: "INVTYPE_CLOAK",
  chest: "INVTYPE_CHEST", shirt: "INVTYPE_BODY", wrist: "INVTYPE_WRIST", hands: "INVTYPE_HAND",
  waist: "INVTYPE_WAIST", legs: "INVTYPE_LEGS", feet: "INVTYPE_FEET", "ring 1": "INVTYPE_FINGER",
  "ring 2": "INVTYPE_FINGER", "trinket 1": "INVTYPE_TRINKET", "trinket 2": "INVTYPE_TRINKET",
  "main hand": "INVTYPE_WEAPON", "off hand": "INVTYPE_HOLDABLE", ranged: "INVTYPE_RANGEDRIGHT",
};

function itemScore(item: GearItem): { score: number; itemLevel: number; equipLoc: GearScoreEquipLoc } | null {
  const equipLoc = item.equipLoc ?? slotFallbacks[item.slot.toLowerCase()];
  const slotMod = equipLoc ? ITEM_TYPES[equipLoc] : undefined;
  let itemLevel = item.itemLevel;
  let rarity = QUALITY[item.quality.toLowerCase()];
  let qualityScale = 1;
  if (!equipLoc || !slotMod || !itemLevel || rarity === undefined) return null;
  if (rarity === 5) { qualityScale = 1.3; rarity = 4; }
  else if (rarity <= 1) { qualityScale = 0.005; rarity = 2; }
  else if (rarity === 7) { rarity = 3; itemLevel = 187.05; }
  const formula = itemLevel > 120
    ? ({ 4: [91.45, 0.65], 3: [81.375, 0.8125], 2: [73, 1] } as const)[rarity as 2 | 3 | 4]
    : ({ 4: [26, 1.2], 3: [0.75, 1.8], 2: [8, 2], 1: [0, 2.25] } as const)[rarity as 1 | 2 | 3 | 4];
  if (!formula) return null;
  return { score: Math.max(0, Math.floor(((itemLevel - formula[0]) / formula[1]) * slotMod * SCALE * qualityScale)), itemLevel: item.itemLevel, equipLoc };
}

function isTitanGripWeapon(equipLoc?: GearScoreEquipLoc): boolean {
  return equipLoc === "INVTYPE_2HWEAPON" || equipLoc === "INVTYPE_WEAPONMAINHAND" || equipLoc === "INVTYPE_WEAPONOFFHAND" || equipLoc === "INVTYPE_WEAPON";
}

export type GearScoreSummary = { score: number; averageItemLevel: number; scoredItemCount: number; itemScores: Map<number, number> };

export function calculateGearScore(items: GearItem[]): GearScoreSummary | null {
  const mainHand = items.find((item) => item.slot === "Main Hand");
  const offHand = items.find((item) => item.slot === "Off Hand");
  const mainHandLoc = mainHand ? itemScore(mainHand)?.equipLoc : undefined;
  const offHandLoc = offHand ? itemScore(offHand)?.equipLoc : undefined;
  const titanGrip = mainHand && offHand && isTitanGripWeapon(mainHandLoc) && isTitanGripWeapon(offHandLoc)
    && (mainHandLoc === "INVTYPE_2HWEAPON" || offHandLoc === "INVTYPE_2HWEAPON") ? 0.5 : 1;
  let score = 0;
  let itemLevelTotal = 0;
  let scoredItemCount = 0;
  const itemScores = new Map<number, number>();
  for (const item of items) {
    const result = itemScore(item);
    if (!result) continue;
    const multiplier = item.slot === "Main Hand" || item.slot === "Off Hand" ? titanGrip : 1;
    const adjusted = result.score * multiplier;
    score += adjusted;
    itemLevelTotal += result.itemLevel;
    scoredItemCount++;
    itemScores.set(item.id, Math.floor(adjusted));
  }
  return scoredItemCount ? { score: Math.floor(score), averageItemLevel: Math.floor(itemLevelTotal / scoredItemCount), scoredItemCount, itemScores } : null;
}
