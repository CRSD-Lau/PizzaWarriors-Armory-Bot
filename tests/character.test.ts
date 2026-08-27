import assert from "node:assert/strict";
import { formatCharacterSpecialization } from "../src/character.js";

assert.equal(formatCharacterSpecialization("Protection", "Paladin"), "Protection Paladin");
assert.equal(formatCharacterSpecialization("Frost", "Death Knight"), "Frost Death Knight");
assert.equal(formatCharacterSpecialization("Protection Paladin", "Paladin"), "Protection Paladin");
assert.equal(formatCharacterSpecialization("  Elemental  ", "  Shaman  "), "Elemental Shaman");
assert.equal(formatCharacterSpecialization(undefined, "Paladin"), undefined);

console.log("Character specialization tests passed.");
