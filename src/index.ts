import { createServer } from "node:http";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { WarmaneArmory } from "./armory.js";
import { ArmoryCardRenderer } from "./card.js";
import { config } from "./config.js";
import { calculateGearScore } from "./gearscore.js";
import { upgradeSpecNames, getSheetUpgradeProfile } from "./sheet-upgrades.js";
import { buildReadyReport, RaiderLinks, RecentReadyEvents } from "./ready.js";
import { getGuildRoster, guildArmoryUrl, type GuildRoster } from "./guild.js";
import { gearScoreTier } from "./score-tiers.js";

const command = new SlashCommandBuilder()
  .setName("armory")
  .setDescription("Look up a Warmane character's equipped gear and GearScore")
  .addStringOption((option) => option.setName("name").setDescription("Character name").setRequired(true).setMaxLength(12))
  .addStringOption((option) => option.setName("realm").setDescription("Warmane realm").addChoices(
    { name: "Lordaeron", value: "Lordaeron" },
    { name: "Icecrown", value: "Icecrown" },
    { name: "Blackrock", value: "Blackrock" },
  ));

const upgradeCommand = new SlashCommandBuilder()
  .setName("upgrade")
  .setDescription("Show a PizzaWarriors sheet-based upgrade path for a Warmane character")
  .addStringOption((option) => option.setName("name").setDescription("Character name").setRequired(true).setMaxLength(12))
  .addStringOption((option) => option.setName("spec").setDescription("Specialization to evaluate").setRequired(true).setAutocomplete(true))
  .addStringOption((option) => option.setName("realm").setDescription("Warmane realm").addChoices(
    { name: "Lordaeron", value: "Lordaeron" },
    { name: "Icecrown", value: "Icecrown" },
    { name: "Blackrock", value: "Blackrock" },
  ));

const readyCommand = new SlashCommandBuilder()
  .setName("ready")
  .setDescription("Show GearScore and event-selected specs for the latest Raid-Helper roster")
  .addStringOption((option) => option.setName("event").setDescription("Optional: paste a new message link or choose a recent event").setAutocomplete(true))
  .addStringOption((option) => option.setName("realm").setDescription("Default realm for unlinked characters").addChoices(
    { name: "Lordaeron", value: "Lordaeron" },
    { name: "Icecrown", value: "Icecrown" },
    { name: "Blackrock", value: "Blackrock" },
  ));

const raiderCommand = new SlashCommandBuilder()
  .setName("raider")
  .setDescription("Link your Discord account to the Warmane character you bring to raids")
  .addSubcommand((subcommand) => subcommand.setName("link").setDescription("Save your raiding character for raid-readiness checks")
    .addStringOption((option) => option.setName("name").setDescription("Warmane character name").setRequired(true).setMaxLength(12))
    .addStringOption((option) => option.setName("realm").setDescription("Warmane realm").addChoices(
      { name: "Lordaeron", value: "Lordaeron" },
      { name: "Icecrown", value: "Icecrown" },
      { name: "Blackrock", value: "Blackrock" },
    )))
  .addSubcommand((subcommand) => subcommand.setName("unlink").setDescription("Remove your saved raiding character"));

const rosterCommand = new SlashCommandBuilder()
  .setName("roster")
  .setDescription("Browse a public Warmane guild roster, ten members at a time")
  .addStringOption((option) => option.setName("guild").setDescription("Guild name").setMaxLength(48))
  .addStringOption((option) => option.setName("realm").setDescription("Warmane realm").addChoices(
    { name: "Lordaeron", value: "Lordaeron" },
    { name: "Icecrown", value: "Icecrown" },
    { name: "Blackrock", value: "Blackrock" },
  ));

const armory = new WarmaneArmory();
const cards = new ArmoryCardRenderer();
const raiderLinks = new RaiderLinks();
const recentReadyEvents = new RecentReadyEvents();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const lookupCooldowns = new Map<string, number>();
const LOOKUP_COOLDOWN_MS = 10_000;
const ROSTER_PAGE_SIZE = 10;

function rosterButtonId(page: number, realm: string, guildName: string): string {
  return `roster:${page}:${realm}:${encodeURIComponent(guildName)}`;
}

function rosterButtons(roster: GuildRoster, page: number): ActionRowBuilder<ButtonBuilder> {
  const totalPages = Math.max(1, Math.ceil(roster.members.length / ROSTER_PAGE_SIZE));
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(rosterButtonId(Math.max(0, page - 1), roster.realm, roster.guildName)).setLabel("Previous").setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setLabel("Open Guild Armory").setStyle(ButtonStyle.Link).setURL(roster.armoryUrl),
    new ButtonBuilder().setCustomId(rosterButtonId(Math.min(totalPages - 1, page + 1), roster.realm, roster.guildName)).setLabel("Next").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

async function rosterMessage(roster: GuildRoster, page: number): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[]; files: AttachmentBuilder[] }> {
  const boundedPage = Math.min(Math.max(page, 0), Math.max(0, Math.ceil(roster.members.length / ROSTER_PAGE_SIZE) - 1));
  const cardName = `guild-roster-${boundedPage + 1}.png`;
  const card = await cards.renderRoster({ roster, page: boundedPage, pageSize: ROSTER_PAGE_SIZE });
  return {
    embeds: [new EmbedBuilder().setColor(0xff8000).setImage(`attachment://${cardName}`)],
    components: [rosterButtons(roster, boundedPage)],
    files: [new AttachmentBuilder(card, { name: cardName })],
  };
}

async function registerCommand(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);
  await rest.put(route, { body: [command.toJSON(), upgradeCommand.toJSON(), readyCommand.toJSON(), raiderCommand.toJSON(), rosterCommand.toJSON()] });
}

client.once(Events.ClientReady, () => console.log(`PizzaWarriors Armory Bot is ready as ${client.user?.tag}.`));
client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    const query = interaction.options.getFocused().toLowerCase();
    if (interaction.commandName === "upgrade") {
      await interaction.respond(upgradeSpecNames.filter((specName) => specName.toLowerCase().includes(query)).slice(0, 25).map((specName) => ({ name: specName, value: specName })));
      return;
    }
    if (interaction.commandName === "ready" && interaction.guildId) {
      const events = (await recentReadyEvents.list(interaction.guildId))
        .filter((event) => `${event.title} ${event.eventId}`.toLowerCase().includes(query))
        .slice(0, 25);
      await interaction.respond(events.map((event) => ({ name: `${event.title} · ${event.eventId}`, value: event.eventId })));
    }
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith("roster:")) {
    const [, pageText, realm, encodedGuild] = interaction.customId.split(":", 4);
    const page = Number.parseInt(pageText, 10);
    if (!realm || !encodedGuild || !Number.isInteger(page)) {
      await interaction.reply({ content: "That roster page has expired. Run /roster again.", flags: MessageFlags.Ephemeral });
      return;
    }
    try {
      const roster = await getGuildRoster(decodeURIComponent(encodedGuild), realm);
      await interaction.update(await rosterMessage(roster, page));
    } catch (error) {
      console.error("Guild roster page failed", error);
      await interaction.reply({ content: "I could not refresh that Warmane roster. Run /roster again in a moment.", flags: MessageFlags.Ephemeral });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "raider") {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Use this command inside the PizzaWarriors server so the character link stays private to this guild.", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = interaction.options.getSubcommand();
    if (action === "unlink") {
      const removed = await raiderLinks.remove(interaction.guildId, interaction.user.id);
      await interaction.reply({ content: removed ? "Your saved raiding character has been removed." : "You do not have a saved raiding character yet.", flags: MessageFlags.Ephemeral });
      return;
    }
    const name = interaction.options.getString("name", true).trim();
    const realm = interaction.options.getString("realm") ?? config.defaultRealm;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const character = await armory.getCharacter(name, realm);
      await raiderLinks.set(interaction.guildId, interaction.user.id, { name, realm });
      await interaction.editReply(`Linked **${name}** on **${realm}**${character.className ? ` (${character.primarySpec ?? character.className} ${character.className})` : ""}. Raid readiness will use this character when you sign up through Raid-Helper.`);
    } catch {
      await interaction.editReply("I could not verify that Warmane character. Check the spelling and realm, then try again.");
    }
    return;
  }
  if (interaction.commandName === "ready") {
    if (!interaction.guildId) {
      await interaction.reply({ content: "Use this command inside the PizzaWarriors server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const suppliedEvent = interaction.options.getString("event")?.trim();
    const savedEvent = suppliedEvent ? undefined : await recentReadyEvents.latest(interaction.guildId);
    if (!suppliedEvent && !savedEvent) {
      await interaction.reply({ content: "No recent Raid-Helper event is saved yet. Run **/ready** once with the Raid-Helper event message link; after that, plain **/ready** will use it automatically.", flags: MessageFlags.Ephemeral });
      return;
    }
    const event = suppliedEvent ?? savedEvent!.eventId;
    const realm = interaction.options.getString("realm") ?? config.defaultRealm;
    await interaction.reply({ content: suppliedEvent ? "Building raid-readiness card…" : `Building raid-readiness card for **${savedEvent!.title}**…`, flags: MessageFlags.SuppressNotifications });
    try {
      const report = await buildReadyReport({ event, realm, guildId: interaction.guildId, armory, links: raiderLinks });
      await recentReadyEvents.remember(interaction.guildId, { eventId: report.eventId, title: report.eventTitle });
      if (!report.activeSignups.length) {
        await interaction.editReply("I found that Raid-Helper event, but it has no signed or late attendees to check yet. Tentative, bench, and absent selections are shown separately and are not counted as raid-ready.");
        return;
      }
      const cardName = `raid-ready-${report.eventId}.png`;
      const card = await cards.renderReady({ report, realm });
      const embed = new EmbedBuilder().setColor(0xff8000).setImage(`attachment://${cardName}`);
      await interaction.editReply({ embeds: [embed], files: [new AttachmentBuilder(card, { name: cardName })] });
    } catch (error) {
      console.error("Raid readiness lookup failed", error);
      await interaction.editReply("I could not read that Raid-Helper event. Paste the event's Discord message link or copied event ID, then try again.");
    }
    return;
  }
  if (interaction.commandName === "roster") {
    const guildName = interaction.options.getString("guild")?.trim() || "Pizza Warriors";
    const realm = interaction.options.getString("realm") ?? config.defaultRealm;
    await interaction.reply({ content: "Loading guild roster…", flags: MessageFlags.SuppressNotifications });
    try {
      const roster = await getGuildRoster(guildName, realm);
      await interaction.editReply(await rosterMessage(roster, 0));
    } catch (error) {
      console.error("Guild roster lookup failed", error);
      await interaction.editReply(`I could not read **${guildName}** on **${realm}** from Warmane. Check the guild name and realm, then try again.`);
    }
    return;
  }
  if (interaction.commandName === "upgrade") {
    const name = interaction.options.getString("name", true).trim();
    const realm = interaction.options.getString("realm") ?? config.defaultRealm;
    const specName = interaction.options.getString("spec", true);
    await interaction.reply({ content: "Building upgrade card…", flags: MessageFlags.SuppressNotifications });
    try {
      const character = await armory.getCharacter(name, realm);
      if (!character.className) {
        await interaction.editReply("I found the character, but Warmane did not expose a usable class for this profile.");
        return;
      }
      const profile = await getSheetUpgradeProfile(character.className, specName);
      if (!profile) {
        await interaction.editReply(`I found a **${character.className}**, but the PizzaWarriors Best-in-Slot sheet does not have a **${specName}** column for that class.`);
        return;
      }
      const fileName = `${name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}-upgrade-card.png`;
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open Armory").setStyle(ButtonStyle.Link).setURL(character.armoryUrl),
        new ButtonBuilder().setLabel("Open Best-in-Slot Sheet").setStyle(ButtonStyle.Link).setURL(profile.sources[0].url),
      );
      const card = await cards.renderUpgrade({ name, realm, className: character.className, specName, profile, items: character.items, portrait: character.portrait });
      const embed = new EmbedBuilder().setColor(0xff8000).setImage(`attachment://${fileName}`);
      await interaction.editReply({ embeds: [embed], components: [buttons], files: [new AttachmentBuilder(card, { name: fileName })] });
    } catch (error) {
      console.error("Upgrade preview lookup failed", error);
      await interaction.editReply("I couldn't read that character's profile right now. Check the character name and realm, then try again in a moment.");
    }
    return;
  }
  if (interaction.commandName !== "armory") return;
  const now = Date.now();
  const cooldownKey = `${interaction.guildId ?? "direct"}:${interaction.user.id}`;
  const retryAt = lookupCooldowns.get(cooldownKey) ?? 0;
  if (retryAt > now) {
    const seconds = Math.ceil((retryAt - now) / 1_000);
    await interaction.reply({ content: `Please wait ${seconds} second${seconds === 1 ? "" : "s"} before another armory lookup.`, flags: MessageFlags.Ephemeral });
    return;
  }
  lookupCooldowns.set(cooldownKey, now + LOOKUP_COOLDOWN_MS);
  if (lookupCooldowns.size > 1_000) {
    for (const [key, expiresAt] of lookupCooldowns) if (expiresAt <= now) lookupCooldowns.delete(key);
  }
  const name = interaction.options.getString("name", true).trim();
  const realm = interaction.options.getString("realm") ?? config.defaultRealm;
  await interaction.reply({ content: "Reading Warmane Armory…", flags: MessageFlags.SuppressNotifications });
  try {
    const character = await armory.getCharacter(name, realm);
    const summary = calculateGearScore(character.items);
    if (!summary) throw new Error("Warmane returned equipment, but sufficient item data was unavailable to calculate GearScore.");
    const tier = gearScoreTier(summary.score);
    const fileStem = name.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
    const cardName = `${fileStem}-armory-card.png`;
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Open Armory").setStyle(ButtonStyle.Link).setURL(character.armoryUrl),
    );
    try {
      const card = await cards.render({ name, realm, items: character.items, summary, portrait: character.portrait });
      const embed = new EmbedBuilder().setColor(tier.color).setImage(`attachment://${cardName}`);
      await interaction.editReply({ embeds: [embed], components: [buttons], files: [new AttachmentBuilder(card, { name: cardName })] });
    } catch (cardError) {
      // The raw armory data remains useful if a browser/image host is temporarily unavailable.
      console.error("Armory card render failed; using text fallback", cardError);
      const description = character.items.map((item) => {
        const itemScore = summary.itemScores.get(item.id);
        return `**${item.slot}** · ${item.name} — iLvl ${item.itemLevel}${itemScore ? ` · ${itemScore} GS` : ""}`;
      }).reduce<string[]>((lines, line) => lines.join("\n").length + line.length <= 3_850 ? [...lines, line] : lines, []).join("\n") || "No displayable equipment.";
      const fallback = new EmbedBuilder()
        .setColor(tier.color)
        .setTitle(`${name} · ${realm}`)
        .setURL(character.armoryUrl)
        .setDescription(description)
        .addFields(
          { name: "GearScore", value: `**${summary.score.toLocaleString()}** · ${tier.label}`, inline: true },
          { name: "Average iLvl", value: String(summary.averageItemLevel), inline: true },
          { name: "Items scored", value: `${summary.scoredItemCount}/19`, inline: true },
        )
        .setFooter({ text: "Equipment from Warmane Armory · WotLK 3.3.5a GearScoreLite" })
        .setTimestamp();
      const portraitName = `${fileStem}-armory.png`;
      const files = character.portrait ? [new AttachmentBuilder(character.portrait, { name: portraitName })] : [];
      if (character.portrait) fallback.setThumbnail(`attachment://${portraitName}`);
      await interaction.editReply({ embeds: [fallback], components: [buttons], files });
    }
  } catch (error) {
    console.error("Armory lookup failed", error);
    await interaction.editReply("I couldn't read that character's equipment right now. Check the character name and realm, then try again in a moment.");
  }
});

createServer((request, response) => {
  if (request.url !== "/healthz") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
    return;
  }
  const healthy = client.isReady();
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: healthy, discordReady: client.isReady() }));
}).listen(config.port);

await registerCommand();
await client.login(config.discordToken);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await armory.close();
    await cards.close();
    client.destroy();
    process.exit(0);
  });
}
