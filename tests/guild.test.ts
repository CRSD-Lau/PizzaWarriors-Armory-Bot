import assert from "node:assert/strict";
import { parseGuildRoster } from "../src/guild.js";

const roster = parseGuildRoster(`
  <div class="name">Pizza Warriors</div>
  <div class="level-faction-realm">Alliance Guild, Lordaeron, 2 members<br />542 PVE Points</div>
  <tbody id="data-table-list">
    <tr><td><a href="/character/Lausudo/Lordaeron/profile">Lausudo</a></td><td><img alt="Human"></td><td><img alt="Paladin"></td><td><img alt="Alliance"></td><td>80</td><td>Small Council</td><td>2820</td><td><img alt="Engineering"><img alt="Jewelcrafting"></td></tr>
    <tr><td><a href="/character/Gilion/Lordaeron/profile">Gilion</a></td><td><img alt="Night Elf"></td><td><img alt="Hunter"></td><td><img alt="Alliance"></td><td>80</td><td>Core 1</td><td>3600</td><td></td></tr>
  </tbody>`, "Pizza Warriors", "Lordaeron");

assert.equal(roster.guildName, "Pizza Warriors");
assert.equal(roster.memberCount, 2);
assert.equal(roster.pvePoints, 542);
assert.deepEqual(roster.members[0], { name: "Lausudo", race: "Human", className: "Paladin", faction: "Alliance", level: 80, rank: "Small Council", achievementPoints: 2820, professions: ["Engineering", "Jewelcrafting"] });

console.log("Warmane guild roster parsing tests passed.");
