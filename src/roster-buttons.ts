export type RosterPage = { page: number; realm: string; guildName: string };
const REALMS = new Set(["Lordaeron", "Icecrown", "Blackrock"]);

function validPage(input: RosterPage): boolean {
  return Number.isSafeInteger(input.page) && input.page >= 0 && input.page <= 999_999
    && REALMS.has(input.realm) && Boolean(input.guildName.trim()) && input.guildName.length <= 48;
}

/** Raw Unicode avoids percent-encoding a 48-character guild beyond Discord's 100-character limit. */
export function rosterButtonId(page: number, realm: string, guildName: string): string {
  const input = { page, realm, guildName };
  if (!validPage(input)) throw new Error("Invalid guild roster page.");
  return `roster-v2:${page}:${realm}:${guildName}`;
}

export function parseRosterButtonId(value: string): RosterPage | undefined {
  const match = /^(roster-v2|roster):(\d+):([^:]+):([\s\S]+)$/.exec(value);
  if (!match) return undefined;
  try {
    const input = {
      page: Number(match[2]),
      realm: match[3],
      guildName: match[1] === "roster" ? decodeURIComponent(match[4]) : match[4],
    };
    return validPage(input) ? input : undefined;
  } catch {
    return undefined;
  }
}
