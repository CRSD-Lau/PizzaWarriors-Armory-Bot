---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Pizza Core roster reminders

The bot can compare the canonical Pizza Core roster with every state in the current Raid-Helper event and safely notify only members who still need attention.

## Configure the core role

1. Assign every current core raider the **Well Timed Pizza** role and remove it when they leave the core.
2. Copy that role's Discord ID into `PIZZA_CORE_ROLE_ID`.
3. In Discord's Developer Portal, open the application's **Bot** page and enable **Server Members Intent**.
4. Restart the bot and run `/ready`.

The role is refreshed directly from Discord whenever `/ready`, `/attendance`, or the reminder button needs the current core. No second roster update command is required. The optional **Apps → Set Pizza Core Roster** action may still save a roster-post link for the card's **Open Core Roster** button; its mentioned-member snapshot is not used while role mode is configured.

## Use it with `/ready`

Run `/ready` normally. The card adds a **Core roster responses** section that compares stable Discord user IDs across:

- Signed and late players, shown as active.
- Tentative players.
- Benched players.
- Absent players.
- Core members who do not appear in the event at all, shown as missing.
- Active signups outside the live core role, shown separately as non-core signed players.

The response box lists non-core signed players, missing core members, Tentative members, and Absent members by name. When a core member is completely missing from the event, the Discord post includes an officer-only **Ping missing signups** button. The reminder is a separate Discord message so its user mentions are actionable. Tentative, bench, and absent selections remain visible but are treated as intentional responses.

## Review week-over-week history

Run `/attendance` to receive a private officer report for the latest eight Pizza Core raids, or set `weeks` from 2 through 12. The command is hidden by default from members without **Manage Events**, checks **Manage Events** or **Manage Server** again at runtime, and always responds ephemerally so the result is visible only to the officer who invoked it.

Current/upcoming Pizza Core `/ready` runs create or refresh one saved snapshot keyed by the Raid-Helper event ID, after verifying that the event belongs to this Discord server. Running `/ready` repeatedly for the same event updates that week instead of creating duplicates. Neither role mode nor roster-post mode retroactively backfills older raids using today's membership. Explicit historical or foreign-event views do not compare today's core, rewrite saved history, change the default core event, or offer reminder buttons.

The history preserves these meanings:

- **Missing / no signup**: the core member did not appear anywhere in the Raid-Helper event.
- **Absent, tentative, bench, or late**: the member deliberately selected that response.
- **Not tracked**: the member was not part of the saved core roster for that historical snapshot.

Raid-Helper signup data cannot prove whether someone who signed actually entered the raid. A true in-game no-show therefore is not inferred or silently mixed into missing-signup totals.

## Notification safeguards

- Regular `/ready` requests remain silent and never ping members automatically.
- Only members with **Manage Events** or **Manage Server** can send the reminder.
- Discord is given an explicit allowlist containing only the affected user IDs; role, `@here`, and `@everyone` mentions are never enabled.
- An unchanged reminder cannot be sent again for 30 minutes. Its cooldown is saved before sending; a timeout or failed Discord response may retain that reservation to prevent duplicate pings. Check the channel before retrying. A changed signup state creates a new reminder fingerprint immediately.
- Old, foreign-server, or unverifiable event buttons fail closed before any current-role audit or ping.
- Tentative, bench, and absent members are visible in the comparison but are never included in the reminder.

## Local data

Current role membership is loaded on demand and is not stored as a continuously synchronized guild roster. The optional roster-post link and per-event reminder timestamps are kept only on the bot host in `data/core-rosters.json`. Week-over-week response history stores the exact core membership and signup state captured for each event in `data/core-attendance.json`. Both files are excluded from Git.

All private stores preserve their current file format and use serialized atomic replacement. Invalid JSON, incompatible schemas, and read/write failures leave the previous saved file intact. Stop the bot before manually restoring a backup; do not run multiple writers against the same `data/` directory.
