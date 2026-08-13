import assert from "node:assert/strict";
import { gearScoreTier } from "../src/score-tiers.js";

assert.deepEqual(gearScoreTier(0), { label: "Common", color: "#b0b0b0" });
assert.equal(gearScoreTier(2_499).label, "Common");
assert.equal(gearScoreTier(2_500).label, "Uncommon");
assert.equal(gearScoreTier(4_000).label, "Rare");
assert.equal(gearScoreTier(5_000).label, "Epic");
assert.equal(gearScoreTier(5_700).label, "Elite");
assert.equal(gearScoreTier(6_199).label, "Elite");
assert.deepEqual(gearScoreTier(6_200), { label: "Legendary", color: "#ff8000" });

console.log("GearScore tier tests passed.");
