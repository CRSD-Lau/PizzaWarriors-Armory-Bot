import assert from "node:assert/strict";
import { calculateGearScore } from "../src/gearscore.js";

const twoHandWithRelic = calculateGearScore([
  { id: 1, slot: "Main Hand", name: "Shadow's Edge", quality: "epic", itemLevel: 264, equipLoc: "INVTYPE_2HWEAPON" },
  { id: 2, slot: "Off Hand", name: "Libram of Three Truths", quality: "epic", itemLevel: 264, equipLoc: "INVTYPE_RELIC" },
]);
assert.equal(twoHandWithRelic?.score, 1144);

const titanGrip = calculateGearScore([
  { id: 1, slot: "Head", name: "Head", quality: "epic", itemLevel: 277, equipLoc: "INVTYPE_HEAD" },
  { id: 2, slot: "Neck", name: "Neck", quality: "epic", itemLevel: 277, equipLoc: "INVTYPE_NECK" },
  { id: 3, slot: "Main Hand", name: "Weapon", quality: "epic", itemLevel: 284, equipLoc: "INVTYPE_2HWEAPON" },
  { id: 4, slot: "Off Hand", name: "Weapon", quality: "epic", itemLevel: 284, equipLoc: "INVTYPE_2HWEAPON" },
  { id: 5, slot: "Ranged", name: "Ranged", quality: "epic", itemLevel: 284, equipLoc: "INVTYPE_RANGEDRIGHT" },
]);
assert.equal(titanGrip?.score, 2106);
assert.equal(titanGrip?.itemScores.get(3), 551);
assert.equal(titanGrip?.itemScores.get(4), 551);

console.log("GearScore compatibility tests passed.");

