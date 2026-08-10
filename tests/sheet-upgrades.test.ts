import assert from "node:assert/strict";
import { __test } from "../src/sheet-upgrades.js";

const rows = __test.parseCsv(`PALADIN\n"SLOT v / SPEC >",HOLY,RET\nHead,"Sanctified Lightsworn Headguard","Sanctified Lightsworn Helmet"\nCape,"Cloak of Burning Dusk","Shadowvault Slayer's Cloak"\n"Gear exceptions",note,note`);
const targets = __test.targetsFor(rows, { className: "Paladin", selection: "Retribution", header: "RET", gid: 1, sheetName: "Paladin" });

assert.deepEqual(targets, [
  { slot: "Head", name: "Sanctified Lightsworn Helmet", icon: "inv_helmet_154", aliases: ["Sanctified Lightsworn Helmet"] },
  { slot: "Back", name: "Shadowvault Slayer's Cloak", icon: "inv_misc_cape_19", aliases: ["Shadowvault Slayer's Cloak"] },
]);

console.log("Google Sheets upgrade-source parsing tests passed.");
