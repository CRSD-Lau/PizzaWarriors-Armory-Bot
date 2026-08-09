import assert from "node:assert/strict";
import { parseRaidHelperSignups } from "../src/ready.js";

const signups = parseRaidHelperSignups({
  title: "Pizza ICC 25",
  signups: {
    signed: {
      "123456789012345678": { name: "Lausudo", specs: ["Protection"] },
      "123456789012345679": { display_name: "Qwark", spec: "Retribution" },
    },
    bench: {
      "123456789012345680": { name: "Benchwarrior", spec: "Fury" },
    },
  },
});

assert.deepEqual(signups, [
  { discordUserId: "123456789012345678", displayName: "Lausudo", reportedSpec: "Protection", status: "Signed" },
  { discordUserId: "123456789012345679", displayName: "Qwark", reportedSpec: "Retribution", status: "Signed" },
]);

console.log("Raid-Helper signup parsing tests passed.");
