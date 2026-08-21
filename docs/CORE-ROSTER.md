# Pizza Core roster reminders

The bot can compare the canonical Pizza Core roster with every state in the current Raid-Helper event and safely notify only members who still need attention.

## Save or update the core roster

1. Use a Discord roster post that directly `@mentions` every Pizza Core member. Plain names and role mentions are intentionally not guessed.
2. Right-click the roster post.
3. Select **Apps → Set Pizza Core Roster**.
4. Confirm the private response reports the expected member count.

Running the same action on an edited or replacement post safely replaces the saved snapshot. The command requires Discord's **Manage Events** permission.

## Use it with `/ready`

Run `/ready` normally. The card adds a **Core roster responses** section that compares stable Discord user IDs across:

- Signed and late players, shown as active.
- Tentative players.
- Benched players.
- Absent players.
- Core members who do not appear in the event at all, shown as missing.

When a core member is completely missing from the event, the Discord post includes an officer-only **Ping missing signups** button. The reminder is a separate Discord message so its user mentions are actionable. Tentative, bench, and absent selections remain visible but are treated as intentional responses.

## Review week-over-week history

Run `/attendance` to receive a private officer report for the latest eight Pizza Core raids, or set `weeks` from 2 through 12. The command is hidden by default from members without **Manage Events**, checks **Manage Events** or **Manage Server** again at runtime, and always responds ephemerally so the result is visible only to the officer who invoked it.

Every Pizza Core `/ready` run creates or refreshes one saved snapshot keyed by the Raid-Helper event ID. Running `/ready` repeatedly for the same event updates that week instead of creating duplicates. `/attendance` also backfills any locally remembered Pizza Core events that do not have a snapshot yet.

The history preserves these meanings:

- **Missing / no signup**: the core member did not appear anywhere in the Raid-Helper event.
- **Absent, tentative, bench, or late**: the member deliberately selected that response.
- **Not tracked**: the member was not part of the saved core roster for that historical snapshot.

Raid-Helper signup data cannot prove whether someone who signed actually entered the raid. A true in-game no-show therefore is not inferred or silently mixed into missing-signup totals.

## Notification safeguards

- Regular `/ready` requests remain silent and never ping members automatically.
- Only members with **Manage Events** or **Manage Server** can send the reminder.
- Discord is given an explicit allowlist containing only the affected user IDs; role, `@here`, and `@everyone` mentions are never enabled.
- An unchanged reminder cannot be sent again for 30 minutes. A changed signup state creates a new reminder fingerprint immediately.
- Tentative, bench, and absent members are visible in the comparison but are never included in the reminder.

## Local data

The roster snapshot is stored only on the bot host in `data/core-rosters.json`. It contains the source message identifiers, the directly mentioned user IDs and display labels, and per-event reminder timestamps. Week-over-week response history is stored separately in `data/core-attendance.json`. Both files are excluded from Git.
