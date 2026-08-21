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

When anyone is missing, tentative, or absent, the Discord post includes an officer-only **Ping outstanding core** button. The reminder is a separate Discord message so its user mentions are actionable.

## Notification safeguards

- Regular `/ready` requests remain silent and never ping members automatically.
- Only members with **Manage Events** or **Manage Server** can send the reminder.
- Discord is given an explicit allowlist containing only the affected user IDs; role, `@here`, and `@everyone` mentions are never enabled.
- An unchanged reminder cannot be sent again for 30 minutes. A changed signup state creates a new reminder fingerprint immediately.
- Bench members are visible in the comparison but are not included in the reminder.

## Local data

The snapshot is stored only on the bot host in `data/core-rosters.json`. It contains the source message identifiers, the directly mentioned user IDs and display labels, and per-event reminder timestamps. The file is excluded from Git.
