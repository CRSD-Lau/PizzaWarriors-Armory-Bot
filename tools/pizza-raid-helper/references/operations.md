---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Weekly raid operation and recovery

## Ownership and member flow

This module is an optional deterministic scheduler companion to the Armory service. It uses the same bot identity but is not a second gateway client. Windows invokes the Node dispatcher; neither Codex nor a browser needs to be open. The PC must be awake and online. Source publication does not change a running task's executable, working directory, profile, or journal.

| Local schedule | Action |
| --- | --- |
| Friday 21:30 Eastern / 22:30 Halifax | Raid-Helper sends its standard attendee reminder and the separate unsigned-Core announcement. Windows sends neither. |
| Friday 22:00 Eastern / 23:00 Halifax | Start the exact journaled native voice event; recovery window is 30 minutes. |
| Saturday 03:00 Halifax | End the old native event if active; create/adopt and verify next Friday's signup/calendar pair; then lock and archive the old forum post. Recovery window is 12 hours. |
| Windows startup + two minutes | Check the current occurrence only; no bulk backfill outside its recovery window. |

The weekly post is **Pizza Core ICC25**, with that occurrence's date/time on the card and `PizzaCore` plus `Event` tags. The configured leader appears on the event; invoking the tool does not replace the leader. Composition is 2 tanks, 8 melee, 10 ranged, and 5 healers. The overall 25-player limit is visual, not a hard signup lock. Core members choose their class/spec each week; other members go to bench. Each new post requests signups with one Core-role ping. Discussion stays in the post until it is locked/archived, not deleted.

The matching native event uses **Raid Chat (Open Mic)** and links directly to the current signup post. Clicking Interested does not sign up for the raid. Discord may auto-complete a voice event when the room empties; never restart a terminal event or park a bot in voice to prevent that.

The standard attendee reminder has provider-controlled wording. It is not a configurable custom "Invites going out." message in this implementation. The future unsigned announcement says:

> Pizza Core: the raid starts in 30 minutes. Please sign up or mark your availability in this post.

Armory's officer-only manual missing-signups button remains manual. It is not invoked by the scheduler. Actual timed reminder delivery, forum routing, and each response-status exclusion require observation; passing tests and accepted settings alone do not prove delivery.

## Private configuration and initial setup

1. Keep the installed runtime/profile/journal if this guild already has a managed series. Do not install from the example over an existing task or replace a current raid.
2. For a genuinely new setup, copy `config.pizza-core.example.json` to a private `config.pizza-core.local.json`, or use an explicit private path outside the repository. Replace synthetic IDs with verified guild, forum, role, tag, leader, bot, and voice identities. Use an absolute private `statePath` to avoid a different journal being selected by another working directory. Schema: [pizza-core-config.schema.json](pizza-core-config.schema.json).
3. Obtain the Raid-Helper server API key via `/apikey`; store it as `RAID_HELPER_API_KEY` in the existing private bot `.env`. Reuse `DISCORD_TOKEN`. Never copy either value into the profile or a command literal.
4. Verify forum View Channel, Read Message History, and Manage Threads, plus voice View Channel, Connect, and Create Events. Administrator is unnecessary. The management bot operates only on its own recorded native events.
5. Audit real identities, permissions, existing occurrences, and absence of competing provider recurrence. Keep provisioning and repairs separately authorized. Never set canary booleans because unit tests passed; activation requires actual retained capability evidence and explicit acceptance of the current config fingerprint. Keep historical proof timestamps unchanged.

From the repository root:

```powershell
# Offline preview with synthetic bindings; creates nothing.
node tools/pizza-raid-helper/scripts/pizza-core-rollover.mjs plan --config tools/pizza-raid-helper/config.pizza-core.example.json

# Real read-only audit with a separately prepared private profile.
node --env-file="<private-env-path>" tools/pizza-raid-helper/scripts/pizza-core-rollover.mjs audit --config "<private-config-path>"

# Actual start/rollover are approved operations, never validation substitutes.
node --env-file="<private-env-path>" tools/pizza-raid-helper/scripts/pizza-core-rollover.mjs start-native --config "<private-config-path>"
node --env-file="<private-env-path>" tools/pizza-raid-helper/scripts/pizza-core-rollover.mjs apply --config "<private-config-path>"
```

The committed example deliberately has no activation. It is not a backup of production configuration and cannot recover deployment on its own. Credentials, current journal, and actual capability evidence must be retained privately.

## Reminder audience

Raid-Helper's unsigned pool is the union of server Raider roles and event allowed-role members. It has no documented server-key API for inspecting that global role selection. Keep Raider roles Core-only under one of these explicit contracts:

- `standing-core-only`: a dated approval by the configured administrator, bound to the exact guild/Core role, accepts that unmonitored later role changes may broaden the pool. It is acceptance, not a new dashboard observation.
- `fresh-dashboard` (default): inspect the actual authenticated Raid-Helper dashboard before creation and save `<statePath>.audience.json`. It must have `verified: true`, source `raid-helper-dashboard`, exact `guildId`, exactly one Core entry in `roleIds` and `roleNames`, and actual offset-qualified `verifiedAt` aged 0–15 minutes. On failure invalidate old positive proof with `verified: false`; never refresh a timestamp without observing the selection.

The audience gate applies after independent prior-native completion and before successor creation or old-forum closure. Missing evidence may therefore leave a partial cycle. Never bypass it or silently repair global roles.

## Windows installation and handoff

The supplied installer only creates a new **disabled** task named **Pizza Core Weekly Raids** and refuses to overwrite an existing task. It requires elevated PowerShell for registration and an explicit `-EnvPath`; it does not restart or reconfigure the Armory service. Its runtime principal is the current user, S4U, Limited. The machine timezone must be **Atlantic Standard Time**, including Halifax daylight saving.

```powershell
# For a separately approved NEW installation only:
& tools/pizza-raid-helper/scripts/install-windows-scheduler.ps1 -ConfigPath "<private-config-path>" -EnvPath "<private-env-path>"
```

Before enabling production, validate `pizza-core-scheduler.mjs --config <private-config-path> --check` under the actual scheduled-task principal. This is a read-only provider audit which writes local status. An interactive-shell audit does not prove background-account access. Preserve and restore the exact production action when performing the check. Disable competing Codex/provider schedules before handing off ownership, then verify enabled state, action, weekly and startup triggers, principal, next run, and an actual safe off-window no-op. Never enable two creators.

Weekly boundaries omit a UTC suffix/offset so Windows follows local daylight saving. The runner independently computes Eastern and Halifax dates. WakeToRun is false; StartWhenAvailable is best-effort catch-up. No task-level automatic restart is configured. The dispatcher retries only explicitly transient, non-uncertain failures up to three times with bounded waits and rechecks the recovery window.

The machine-specific one-off activation helper and historical test/repair scripts are intentionally not published. They are not portable deployment entrypoints. Existing deployments continue using their current verified runtime; a source update is not permission to reinstall or migrate a live task.

## Status and partial recovery

Read `<statePath>.scheduler-status.json`, `<statePath>.scheduler.log`, task history, and the canonical journal. Keep these private. Failures do not send automatic guild or Slack pings.

- Create intent/uncertain result: reconcile the exact occurrence with the provider before another POST. Never clear intent to force a retry.
- Existing verified successor: retain its ID and nested native checkpoint. Retries reverify it; they do not repeat the creation ping.
- `close-pending`: verify both saved successors before retrying only the old forum close.
- `native-end-pending`: keep succeeded work and retry only the exact journaled prior native transition; report partial until complete.
- Missing/changed/ambiguous identity, orphan native event, competing recurrence, changed fingerprint, or stale mutex: stop for deliberate reconciliation. No automatic deletion or replacement.
- Legacy bootstrap: only the explicitly pinned existing pair gets the legacy-policy exception; identity, composition, tags, native ownership/payload, and open forum checks still apply. New occurrences do not inherit that exception.
- Completed/canceled native events remain terminal. Missed starts do not fabricate attendance. No startup backfill beyond the current eligible window.

When accepting a material contract revision, separately record explicit approval, old/new config hashes, and actual verification. Reconcile only reviewed matching journal entries, preserving IDs, payload hashes, and historical timestamps. Never replace the canonical journal with an example or a second operational copy.

## Validation and source security

Run `npm run test:raid-workflow`. Fixtures cover timing/DST, composition, Core/bench settings, both reminders, permissions, identity drift, native lifecycle, duplicate prevention, uncertain responses, partial recovery, and safe inactive packaging. CI runs these alongside the Armory suite and typecheck. No live test or immediate ping is triggered.

Only source, synthetic examples, and sanitized documentation belong in Git. Do not publish private config, env files, current journal, audit receipts with member data, screenshots of rosters, or backups containing them. A runtime installation and its canonical state are not redundant backups.
