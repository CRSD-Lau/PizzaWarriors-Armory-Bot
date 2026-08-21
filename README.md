# PizzaWarriors Armory Bot

<p align="center">
  <img src="assets/pizzawarriors-armory-social-preview.png" alt="PizzaWarriors Armory Bot — Discord armory and raid-readiness tools for Warmane" width="100%">
</p>

<p align="center">
  <a href="https://github.com/CRSD-Lau/PizzaWarriors-Armory-Bot/actions/workflows/ci.yml"><img src="https://github.com/CRSD-Lau/PizzaWarriors-Armory-Bot/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white" alt="Node.js 24">
  <img src="https://img.shields.io/badge/WotLK-3.3.5a-f47b20" alt="WotLK 3.3.5a">
  <img src="https://img.shields.io/badge/license-UNLICENSED-6b7280" alt="UNLICENSED">
</p>

**A focused Discord armory and raid-readiness bot for Warmane characters.**

Look up a character with one slash command and receive a mobile-readable equipment card with real Warmane item icons, a live character render, average item level, and WotLK 3.3.5a GearScoreLite-compatible scoring.

<p align="center">
  <img src="assets/pizzawarriors-armory-card-preview.png" alt="PizzaWarriors Armory equipment card for Lausudo on Lordaeron" width="760">
</p>

## What it does

- Posts `/armory name:<character> [realm]` results directly in Discord.
- Reads equipped slots and item icons from the Warmane Armory.
- Calculates WotLK 3.3.5a GearScoreLite, including Titan's Grip/two-hand handling.
- Generates a branded PizzaWarriors equipment card with legendary orange GearScore and blue iLvl hierarchy.
- Includes an **Open Armory** link and a resilient text-embed fallback.
- Turns a live Raid-Helper event into a raid-readiness card with attendee GS, iLvl, and selected spec.
- Compares Raid-Helper responses with an officer-selected Pizza Core roster and can safely ping only core members who have not responded at all.
- Privately tracks Pizza Core signup responses week over week for officers without re-opening old Raid-Helper events.
- Browses the public Warmane guild roster in a branded 10-member Discord carousel.
- Builds upgrade cards directly from the PizzaWarriors Best-in-Slot Google Sheet, with owned-versus-target equipment.
- Runs without a database, web dashboard, message-content intent, or guild-roster sync.

## Commands

```text
/armory name:Lausudo realm:Lordaeron
```

```text
/ready event:<Raid-Helper message link or event ID> realm:Lordaeron
/attendance weeks:8
/raider link name:Lausudo realm:Lordaeron
/roster guild:"Pizza Warriors" realm:Lordaeron
/upgrade name:Lausudo realm:Lordaeron spec:Fury
```

`/ready` reads the public Raid-Helper event endpoint and checks active signed attendees against Warmane. If a member's Discord name is not their character name, they use `/raider link` once; the link is saved only on this host and only for this Discord server. Bench, late, tentative, and absent entries are excluded from the readiness total. Officers can also snapshot a directly mentioned core-roster post through **Apps → Set Pizza Core Roster**; see the [core-roster reminder guide](docs/CORE-ROSTER.md).

`/attendance` is an officer-only, ephemeral report showing the current core's rolling signup history. Every Pizza Core `/ready` run creates or refreshes one snapshot per Raid-Helper event ID. Missing means no signup existed anywhere in that event; explicit absent, tentative, bench, and late selections remain distinct. Raid-Helper cannot prove that a signed player actually attended the raid, so the bot does not invent true no-show records.

`/roster` defaults to **Pizza Warriors** on the configured realm. Its Previous and Next controls show ten characters at a time, while **Open Guild Armory** returns to the underlying public roster.

`/upgrade` loads its targets from the [PizzaWarriors Lordaeron Best-in-Slot List](https://docs.google.com/spreadsheets/d/1i5CFTZ8kIrISQzvNmJHx85smAYlkaCTO9q_UcsrcqqE/edit). The bot reads the selected class/spec column directly, caches it for five minutes, and links the exact class tab on every card. Update the sheet and the next fresh `/upgrade` request uses the new list—no code edit or bot restart is needed.

Supported realms are **Lordaeron**, **Icecrown**, and **Blackrock**. The configured default is Lordaeron. Anyone who can use the slash command may look up a public character; guild membership is intentionally not required.

## Requirements

- Node.js **24** or later
- Google Chrome (used in headless mode to render the card without opening terminal windows)
- A Discord application with a bot token and application ID

The bot needs only the `bot` and `applications.commands` invite scopes and the Discord **Guilds** gateway intent. It does not monitor channel messages or require a Raid-Helper API key. Saving the core roster and viewing private attendance history are restricted to members with **Manage Events**, with runtime checks also accepting **Manage Server**.

## Quick start

```powershell
git clone https://github.com/CRSD-Lau/PizzaWarriors-Armory-Bot.git
Set-Location PizzaWarriors-Armory-Bot
npm ci
Copy-Item .env.example .env
notepad .env
npm run dev
```

Set `DISCORD_GUILD_ID` while testing so Discord registers the slash command in your server immediately. Without it, global command propagation can take time.

Required variables:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-application-id
```

See [`.env.example`](.env.example) for the complete configuration reference. Never commit `.env`, a Discord token, or `WARMANE_COOKIE`.

## Production operation

Production uses one persistent Windows Task Scheduler process. Run the installer
once from Administrator PowerShell; it removes the obsolete PM2 watchdog and
logon tasks, registers a single S4U boot task, and prevents parallel instances.

```powershell
.\scripts\install-boot-recovery.ps1 -StartNow
Get-ScheduledTask -TaskName "PizzaWarriors Armory Bot"
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

Do not combine this task with a PM2 boot, logon, or repeating watchdog task.
The PM2 ecosystem file remains available only for deliberate interactive use.

- `GET /healthz` returns `{ "ok": true }` for health probes.
- Item metadata is cached locally for 30 days in `.cache/items.json` to reduce upstream requests.
- Lookups are throttled per Discord user and server to protect Warmane and the local renderer.
- If Warmane presents a Cloudflare challenge, `WARMANE_COOKIE` can be set from a browser session you control. Treat it as a password.

## Architecture

```text
Discord slash command
        │
        ▼
Warmane Armory ──► item metadata + equipped icons
        │
        ▼
WotLK GearScoreLite scorer ──► PizzaWarriors card renderer ──► Discord attachment

Raid-Helper event ID ──► public event signups ──► Warmane character links ──► raid-readiness card

PizzaWarriors Best-in-Slot Sheet ──► selected class/spec column ──► upgrade-target card
```

The bot uses the Warmane armory grid for the equipped position and icon, then enriches each item with type, level, and quality. The scoring rules are adapted from Pizza Logs' tested GearScoreLite implementation.

## Development and validation

```powershell
npm run typecheck
npm test
npm audit --omit=dev
```

CI runs the same checks on Node 24. Review [the release checklist](docs/RELEASE-CHECKLIST.md) before deploying.

## Security and privacy

- Secrets, runtime cache, and logs are excluded from Git.
- Rendered item-icon URLs are limited to HTTPS Warmane hosts.
- Character and item text is escaped before card rendering.
- No general Discord message content, voice activity, or gameplay attendance is stored.
- An officer-selected core snapshot stores only source-message identifiers, directly mentioned user IDs/display labels, and reminder timestamps in ignored `data/core-rosters.json`.
- Private signup history stores per-event Raid-Helper response states for the saved core roster in ignored `data/core-attendance.json`; `/attendance` replies are ephemeral.
- Optional `/raider link` entries contain only Discord user ID, character name, and realm in `data/raider-links.json`; the file is excluded from Git.

Read the [security policy](SECURITY.md) and the current [security review](docs/SECURITY-REVIEW.md) before hosting or contributing.

## Contributing

Contributions should stay focused on fast, dependable armory lookup and a clean Discord presentation. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

The source is published for transparent version history and review, but remains an internal PizzaWarriors guild utility. No license for reuse is granted; see [LICENSE](LICENSE) and the `UNLICENSED` package declaration.
