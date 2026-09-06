import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const port of ["", "3000", "65535", "0", "-1", "65536", "3.5", "oops", "3e3"]) {
  const valid = ["", "3000", "65535"].includes(port);
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { config } from './src/config.ts'; console.log(config.port)"], {
    cwd: new URL("..", import.meta.url), windowsHide: true, encoding: "utf8",
    env: { ...process.env, DISCORD_TOKEN: "test", DISCORD_CLIENT_ID: "test", PORT: port },
  });
  assert.equal(result.status, valid ? 0 : 1, port);
  if (valid) assert.equal(result.stdout.trim(), port || "3000");
  else assert.match(result.stderr, /PORT must be an integer from 1 to 65535/);
}
console.log("Health-port configuration validation passed.");
