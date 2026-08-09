import assert from "node:assert/strict";
import { createUpgradePreview, findUpgradeProfile, findUpgradeProfiles, formatUpgradeSources } from "../src/upgrade.js";

const fury = findUpgradeProfiles("Warrior").find((profile) => profile.specName === "Fury");
assert.ok(fury, "Fury Warrior research profile should be present");
assert.equal(fury.status, "research", "research profiles must never be presented as approved recommendations");

const preview = createUpgradePreview("Lausudo", "Lordaeron", fury);
assert.equal(preview.characterName, "Lausudo");
assert.match(preview.headline, /not a live gear recommendation/i);
assert.equal(preview.steps.length, 3);
assert.match(formatUpgradeSources(fury), /forum\.warmane\.com/);
assert.equal(findUpgradeProfiles("No Such Class").length, 0);
assert.equal(findUpgradeProfile("Paladin", "Retribution")?.id, "paladin-retribution-pve");
assert.equal(findUpgradeProfile("Death Knight", "Frost")?.id, "death-knight-frost-pve");

console.log("Upgrade preview scaffold tests passed.");
