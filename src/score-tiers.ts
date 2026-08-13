export type GearScoreTier = {
  label: "Common" | "Uncommon" | "Rare" | "Epic" | "Elite" | "Legendary";
  color: `#${string}`;
};

const tiers: Array<GearScoreTier & { minimum: number }> = [
  { minimum: 6_200, label: "Legendary", color: "#ff8000" },
  { minimum: 5_700, label: "Elite", color: "#e74c3c" },
  { minimum: 5_000, label: "Epic", color: "#a335ee" },
  { minimum: 4_000, label: "Rare", color: "#0070dd" },
  { minimum: 2_500, label: "Uncommon", color: "#1eff00" },
  { minimum: 0, label: "Common", color: "#b0b0b0" },
];

const itemTiers: Array<GearScoreTier & { minimum: number }> = [
  { minimum: 500, label: "Legendary", color: "#ff8000" },
  { minimum: 400, label: "Elite", color: "#e74c3c" },
  { minimum: 300, label: "Epic", color: "#a335ee" },
  { minimum: 200, label: "Rare", color: "#0070dd" },
  { minimum: 100, label: "Uncommon", color: "#1eff00" },
  { minimum: 0, label: "Common", color: "#b0b0b0" },
];

function resolveTier(score: number, candidates: Array<GearScoreTier & { minimum: number }>): GearScoreTier {
  const { minimum: _minimum, ...tier } = candidates.find((candidate) => score >= candidate.minimum) ?? candidates[candidates.length - 1];
  return tier;
}

/** Classifies an overall WotLK GearScore for PizzaWarriors armory cards. */
export function gearScoreTier(score: number): GearScoreTier {
  return resolveTier(score, tiers);
}

/** Classifies an individual item GearScore on the card's 0–500+ scale. */
export function itemGearScoreTier(score: number): GearScoreTier {
  return resolveTier(score, itemTiers);
}
