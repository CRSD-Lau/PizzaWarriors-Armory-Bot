import assert from "node:assert/strict";
import { ButtonBuilder, ButtonStyle } from "discord.js";
import { parseRosterButtonId, rosterButtonId } from "../src/roster-buttons.js";

for (const guildName of ["Pizza Warriors", "Crème: 100%", "龍".repeat(48), "🍕".repeat(24)]) {
  const customId = rosterButtonId(999_999, "Lordaeron", guildName);
  assert.ok(customId.length <= 100);
  const button = new ButtonBuilder().setCustomId(customId).setLabel("Next").setStyle(ButtonStyle.Secondary).toJSON();
  assert.ok("custom_id" in button);
  assert.equal(button.custom_id, customId, "the generated ID must pass Discord builder validation");
  assert.deepEqual(parseRosterButtonId(customId), { page: 999_999, realm: "Lordaeron", guildName });
}

assert.deepEqual(parseRosterButtonId("roster:1:Icecrown:Cr%C3%A8me%3A%20100%25"), {
  page: 1, realm: "Icecrown", guildName: "Crème: 100%",
});
for (const customId of [
  "roster:1:Lordaeron:%bad", "roster:1x:Lordaeron:Pizza", "roster:-1:Lordaeron:Pizza",
  "roster-v2:1:OtherRealm:Pizza", "roster-v2:1:Lordaeron: ", "roster-v2:1000000:Lordaeron:Pizza",
]) assert.equal(parseRosterButtonId(customId), undefined);

console.log("Guild roster button compatibility tests passed.");
