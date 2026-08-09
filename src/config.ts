import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
  defaultRealm: process.env.WARMANE_DEFAULT_REALM?.trim() || "Lordaeron",
  headless: (process.env.HEADLESS ?? "true").toLowerCase() !== "false",
  warmaneCookie: process.env.WARMANE_COOKIE?.trim() || undefined,
  port: Number(process.env.PORT || 3000),
};

