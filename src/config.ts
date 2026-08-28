import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalDiscordId(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^\d{16,22}$/.test(value)) throw new Error(`Invalid Discord ID in environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: optionalDiscordId("DISCORD_GUILD_ID"),
  raidHelperChannelId: optionalDiscordId("RAID_HELPER_CHANNEL_ID"),
  pizzaCoreRoleId: optionalDiscordId("PIZZA_CORE_ROLE_ID"),
  defaultRealm: process.env.WARMANE_DEFAULT_REALM?.trim() || "Lordaeron",
  headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false",
  warmaneCookie: process.env.WARMANE_COOKIE?.trim() || undefined,
  port: Number(process.env.PORT || 3000),
};
