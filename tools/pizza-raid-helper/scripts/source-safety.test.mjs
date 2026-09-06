// Author: Neil Mitchell
// Last Modified By: Neil Mitchell
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateConfig } from "./pizza-core-rollover.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true }).toString();

test("published example has synthetic bindings, private credential references, and no activation", async () => {
  const raw = JSON.parse(await readFile(new URL("../config.pizza-core.example.json", import.meta.url), "utf8"));
  const config = validateConfig(raw);
  assert.equal(config.guildId, "100000000000000001");
  assert.equal(raw.statePath, "./runtime/pizza-core-rollover.json");
  assert.ok(Object.values(config.activation).every(value => value === false || value === null));
  assert.equal(config.credentials.discordTokenEnv, "DISCORD_TOKEN");
  assert.equal(config.credentials.raidHelperApiKeyEnv, "RAID_HELPER_API_KEY");
});

test("private deployment artifacts are excluded and absent from tracked workflow files", () => {
  const privatePaths = [".env", ".env.production", "runtime/pizza-core-rollover.json", "tools/pizza-raid-helper/config.pizza-core.local.json", "tools/pizza-raid-helper/config.json", "tools/pizza-raid-helper/runtime/roster.json"];
  for (const path of privatePaths) assert.equal(git("check-ignore", "--no-index", "--", path).trim(), path);
  const tracked = git("ls-files", "--", "tools/pizza-raid-helper").trim().split(/\r?\n/).filter(Boolean);
  assert.ok(tracked.length > 0, "Stage the public source before running the packaging check");
  assert.ok(tracked.every(path => !/\.local\.json$|(^|\/)runtime\/|\.env(?:\.|$)|\.(?:log|lock|bundle)$/.test(path)));
});

test("Armory recovery installer cannot terminate a shared legacy process tree", async () => {
  const source = await readFile(new URL("../../../scripts/install-boot-recovery.ps1", import.meta.url), "utf8");
  const guard = source.match(/function Stop-LegacyPm2Tree \{([\s\S]*?)\r?\n\}\r?\n/);
  assert.ok(guard, "The legacy PID migration guard must remain present.");
  assert.match(guard[1], /if \(\$RootPid -le 0\) \{ return \}/);
  assert.match(guard[1], /throw "Legacy PID \$RootPid is still running/);
  assert.match(guard[1], /stop only pizza-warriors-armory/);
  assert.doesNotMatch(source, /\btaskkill(?:\.exe)?\b|\bStop-Process\b|\bGet-DescendantProcessIds\b/i);
  assert.ok(source.indexOf("Stop-LegacyPm2Tree -RootPid") < source.indexOf("foreach ($name in $legacyTaskNames)"), "Refuse an unverified live PID before changing scheduled tasks.");
});
