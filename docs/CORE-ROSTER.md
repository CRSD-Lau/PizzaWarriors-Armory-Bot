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

The background collector discovers Pizza Core events hourly and checks known events every five minutes. Before a raid starts, it saves the current core membership under that Raid-Helper event ID; `/ready` can also refresh this snapshot before the start. Membership freezes once the raid starts, and no manual command is required for automatic capture. Neither role mode nor roster-post mode retroactively backfills older raids using today's membership. Explicit historical or foreign-event views do not compare today's core, rewrite saved history, change the default core event, or offer reminder buttons.

The completed-raid report preserves these meanings:

- **Signed or Tentative**: attended.
- **Late or Bench**: did not attend.
- **Absent**: declared absence.
- **Missing / no signup**: no call/no show; the core member did not appear anywhere in that Raid-Helper event record.
- **Not tracked**: the member was not part of the saved core roster for that historical snapshot.

`/attendance` uses one window containing only completed raids with final rosters. It uses the current final Raid-Helper record when available and the durable final-roster archive otherwise. Upcoming and ongoing events are excluded, and older events with no available final roster are omitted. The card's count, date range, totals, date columns, review table, and recognition section all use the same included window.

The green **100% attendance** section requires every status in the nonempty included window to be Signed or Tentative and shows `100% · N/N`. A Missing, Absent, Late, Bench, or untracked historical event blocks recognition. Each review-row attendance denominator counts only the historical events in which that member was tracked.

The running bot checks for newly completed raids every five minutes after a five-minute end grace period and archives their final rosters. It also catches up on startup and retries temporary failures. Events without a usable end time retain the 18-hour completion fallback. The final archive is not pruned when older events leave the report. Historical roster membership remains attached to its original event; today's role does not backfill older membership. A completed event discovered without a pre-raid membership snapshot can retain its actual Raid-Helper signups, but cannot invent Missing entries. Archiving does not write to Raid-Helper.

## Notification safeguards

- Regular `/ready` requests remain silent and never ping members automatically.
- Only members with **Manage Events** or **Manage Server** can send the reminder.
- Discord is given an explicit allowlist containing only the affected user IDs; role, `@here`, and `@everyone` mentions are never enabled.
- An unchanged reminder cannot be sent again for 30 minutes. Its cooldown is saved before sending; a timeout or failed Discord response may retain that reservation to prevent duplicate pings. Check the channel before retrying. A changed signup state creates a new reminder fingerprint immediately.
- Old, foreign-server, or unverifiable event buttons fail closed before any current-role audit or ping.
- Tentative, bench, and absent members are visible in the comparison but are never included in the reminder.

## Local data

Current role membership is loaded on demand and is not stored as a continuously synchronized guild roster. The optional roster-post link and per-event reminder timestamps are kept only on the bot host in `data/core-rosters.json`. Historical snapshots store the exact core membership and signup state captured for each event in `data/core-attendance.json`; finalized Raid-Helper rosters are archived in `data/final-attendance.json`. All three files are excluded from Git.

All private stores preserve their current file format and use serialized atomic replacement. Invalid JSON, incompatible schemas, and read/write failures leave the previous saved file intact. Stop the bot before manually restoring a backup; do not run multiple writers against the same `data/` directory.
