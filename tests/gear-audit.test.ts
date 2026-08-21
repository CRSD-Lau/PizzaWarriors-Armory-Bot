import assert from "node:assert/strict";
import { auditGearPreparation } from "../src/gear-audit.js";
import type { GearItem } from "../src/gearscore.js";

const item = (overrides: Partial<GearItem>): GearItem => ({
  id: 1,
  slot: "Head",
  name: "Test item",
  itemLevel: 264,
  quality: "epic",
  equipLoc: "INVTYPE_HEAD",
  auditDataAvailable: true,
  socketCount: 2,
  enchantId: 3817,
  gemIds: [41398, 40119, 0],
  ...overrides,
});

const complete = auditGearPreparation([
  item({}),
  item({ id: 2, slot: "Waist", equipLoc: "INVTYPE_WAIST", socketCount: 2, enchantId: undefined, gemIds: [40119, 40119, 40119] }),
  item({ id: 3, slot: "Main Hand", equipLoc: "INVTYPE_2HWEAPON", socketCount: 0, enchantId: 3789, gemIds: [] }),
]);
assert.equal(complete.status, "complete");
assert.equal(complete.requiredEnchants, 2);
assert.equal(complete.requiredGems, 5);

const incomplete = auditGearPreparation([
  item({ enchantId: undefined, gemIds: [41398, 0, 0] }),
  item({ id: 2, slot: "Waist", equipLoc: "INVTYPE_WAIST", socketCount: 0, enchantId: undefined, gemIds: [] }),
]);
assert.equal(incomplete.status, "incomplete");
assert.deepEqual(incomplete.missingEnchants.map((issue) => issue.slot), ["Head"]);
assert.deepEqual(incomplete.missingGems.map((issue) => [issue.slot, issue.missing]), [["Head", 1], ["Waist", 1]]);

const blacksmith = auditGearPreparation([
  item({ slot: "Wrist", equipLoc: "INVTYPE_WRIST", socketCount: 1, gemIds: [40119, 0, 0] }),
], ["Blacksmithing"]);
assert.equal(blacksmith.status, "incomplete");
assert.deepEqual(blacksmith.missingGems.map((issue) => [issue.slot, issue.missing]), [["Wrist", 1]]);

const unverified = auditGearPreparation([item({ auditDataAvailable: false, socketCount: undefined })]);
assert.equal(unverified.status, "unverified");
assert.deepEqual(unverified.unverifiedSlots, ["Head"]);

const casterWand = auditGearPreparation([
  item({ slot: "Ranged", equipLoc: "INVTYPE_RANGED", socketCount: 0, enchantId: undefined, gemIds: [] }),
], [], "Priest");
assert.equal(casterWand.status, "complete");

const hunterBow = auditGearPreparation([
  item({ slot: "Ranged", equipLoc: "INVTYPE_RANGED", socketCount: 0, enchantId: undefined, gemIds: [] }),
], [], "Hunter");
assert.equal(hunterBow.status, "incomplete");
assert.deepEqual(hunterBow.missingEnchants.map((issue) => issue.slot), ["Ranged"]);

console.log("Gear preparation audit tests passed.");
