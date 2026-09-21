import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const fixtureDirectory = await mkdtemp(join(tmpdir(), "pizzawarriors-dotenv-"));
try {
  await writeFile(fixtureDirectory + "/.env", "DISCORD_TOKEN=fixture-token\nDISCORD_CLIENT_ID=fixture-client\nPORT=4312\n", "utf8");
  const { DISCORD_TOKEN: _token, DISCORD_CLIENT_ID: _clientId, PORT: _port, ...cleanEnvironment } = process.env;
  const configUrl = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "src", "config.ts")).href;
  const tsxLoader = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "node_modules", "tsx", "dist", "loader.mjs")).href;
  const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", `import { config } from '${configUrl}'; if (config.port !== 4312 || !config.discordToken || !config.discordClientId) process.exit(1);`], {
    cwd: fixtureDirectory, windowsHide: true, encoding: "utf8", env: cleanEnvironment,
  });
  assert.equal(result.status, 0, result.stderr);
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}
console.log("Health-port configuration validation passed.");
