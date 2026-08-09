export type GuildMember = {
  name: string;
  race: string;
  className: string;
  faction: string;
  level: number;
  rank: string;
  achievementPoints: number;
  professions: string[];
};

export type GuildRoster = {
  guildName: string;
  realm: string;
  faction: string;
  memberCount: number;
  pvePoints?: number;
  members: GuildMember[];
  armoryUrl: string;
};

const CACHE_AGE_MS = 5 * 60 * 1_000;
const cache = new Map<string, { expiresAt: number; roster: GuildRoster }>();

function decodeHtml(value: string): string {
  const text = value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const entities: Record<string, string> = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", "#39": "'" };
  return text.replace(/&(amp|apos|quot|lt|gt|#39);/g, (_match, entity: string) => entities[entity] ?? _match);
}

function cellImages(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/gi)].map((match) => decodeHtml(match[1]));
}

function memberFromRow(html: string): GuildMember | undefined {
  const cells = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
  if (cells.length < 7) return undefined;
  const name = decodeHtml(cells[0]).replace(/\s+(Captain|Leader)$/i, "").trim();
  const anchorName = cells[0].match(/<a\b[^>]*>([^<]+)<\/a>/i)?.[1];
  const className = cellImages(cells[2])[0];
  if (!anchorName || !className) return undefined;
  return {
    name: decodeHtml(anchorName),
    race: cellImages(cells[1])[0] ?? "Unknown",
    className,
    faction: cellImages(cells[3])[0] ?? "Unknown",
    level: Number.parseInt(decodeHtml(cells[4]), 10) || 0,
    rank: decodeHtml(cells[5]) || "Member",
    achievementPoints: Number.parseInt(decodeHtml(cells[6]).replace(/,/g, ""), 10) || 0,
    professions: cellImages(cells[7] ?? ""),
  };
}

export function guildArmoryUrl(guildName: string, realm: string): string {
  return `https://armory.warmane.com/guild/${encodeURIComponent(guildName).replace(/%20/g, "+")}/${encodeURIComponent(realm).replace(/%20/g, "+")}/summary`;
}

/** Parse the public Warmane guild member table (no Discord guild roster access is required). */
export function parseGuildRoster(html: string, requestedGuildName: string, realm: string): GuildRoster {
  const guildName = html.match(/<div class=["']name["']>([^<]+)<\/div>/i)?.[1] ?? requestedGuildName;
  const summary = decodeHtml(html.match(/<div class=["']level-faction-realm["']>([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const meta = summary.match(/^(Alliance|Horde) Guild,\s*([^,]+),\s*(\d+) members/i);
  const table = html.match(/<tbody\b[^>]*\bid=["']data-table-list["'][^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!table) throw new Error("Warmane did not return a guild member table.");
  const members = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((match) => {
    const member = memberFromRow(match[1]);
    return member ? [member] : [];
  });
  if (!members.length) throw new Error("Warmane returned an empty guild roster.");
  // Warmane emits its roster in guild-rank order. Capture that hierarchy and
  // enforce it in the card data so paging always starts with leadership.
  const rankOrder = new Map<string, number>();
  members.forEach((member) => {
    if (!rankOrder.has(member.rank)) rankOrder.set(member.rank, rankOrder.size);
  });
  members.sort((left, right) => (rankOrder.get(left.rank) ?? 0) - (rankOrder.get(right.rank) ?? 0)
    || right.level - left.level
    || left.name.localeCompare(right.name));
  return {
    guildName: decodeHtml(guildName),
    realm: meta?.[2]?.trim() ?? realm,
    faction: meta?.[1] ?? members[0].faction,
    memberCount: Number(meta?.[3]) || members.length,
    pvePoints: Number.parseInt(summary.match(/(\d[\d,]*)\s+PVE Points/i)?.[1]?.replace(/,/g, "") ?? "", 10) || undefined,
    members,
    armoryUrl: guildArmoryUrl(requestedGuildName, realm),
  };
}

export async function getGuildRoster(guildName: string, realm: string): Promise<GuildRoster> {
  const cacheKey = `${realm.toLowerCase()}:${guildName.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.roster;
  const response = await fetch(guildArmoryUrl(guildName, realm), { headers: { accept: "text/html", "user-agent": "PizzaWarriorsArmoryBot/1.0 (+Discord guild roster)" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Warmane returned ${response.status} for that guild.`);
  const roster = parseGuildRoster(await response.text(), guildName, realm);
  cache.set(cacheKey, { roster, expiresAt: Date.now() + CACHE_AGE_MS });
  return roster;
}
