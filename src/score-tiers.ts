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

/** Classifies an overall WotLK GearScore for PizzaWarriors armory cards. */
export function gearScoreTier(score: number): GearScoreTier {
  const { minimum: _minimum, ...tier } = tiers.find((candidate) => score >= candidate.minimum) ?? tiers[tiers.length - 1];
  return tier;
}
