---
name: pizza-raid-helper
description: Preview, audit, and run the guarded Pizza Core weekly Raid-Helper signup and native Discord voice-event workflow. Keep provisioning, existing-event repairs, and live tests separately authorized.
metadata:
  author: Neil Mitchell
  last_modified_by: Neil Mitchell
---

# Pizza Raid Helper

This is the portable, public source of the installed weekly workflow. The committed example is inactive and uses synthetic identities. Cloning the repository does not configure a guild or activate a schedule.

Default to an offline `plan`. Read [operations and recovery](references/operations.md) before setup, scheduler changes, an existing-event repair, or explaining the member-facing workflow. Read [the provider contract](references/provider-contract.md) when changing API fields or interpreting readback. Use [the profile schema](references/pizza-core-config.schema.json) and a private `config.pizza-core.local.json` or explicit `--config` path.

## Required behavior

- Friday 22:00 `America/New_York`, 240 minutes. Compute local calendar dates rather than adding 168 elapsed hours. Native voice destination: the configured **Raid Chat (Open Mic)**.
- Raid-Helper creates each forum signup. The Armory bot creates/manages the native voice event and locks/archives the finished post. Do not provision channels during rollover or create a substitute post directly through Discord.
- Composition: 2 tanks, 8 melee, 10 ranged, 5 healers. Pizza Core members sign up normally; others are benched. This does not enroll the role automatically or copy the prior roster.
- One Core-only creation ping. Verify the unique role/tag names against configured immutable IDs. Never repeat the creation ping during adoption/recovery.
- Both pre-raid reminders are due 30 minutes before start. Raid-Helper's `reminder: 30` pings attendees using provider-standard text. One `announcement` with `channel: unsignedping` and `time: 30` targets unresponded Core members. Do not add an Armory reminder, second announcement slot, or Premium DM.
- For the unsigned audience, any class/spec or Bench/Late/Tentative/Absence response counts as a response. Global Raid-Helper Raider roles must remain Core-only; `allowed_roles` alone does not narrow that union. Production may use explicit dated `standing-core-only` administrative acceptance; otherwise require a real fresh dashboard observation as described in the operations guide. Never fabricate proof or silently change global roles.
- The calendar links the authoritative Raid-Helper roster. Discord Interested is not synchronized to signups and does not reserve a raid slot.

## Execution and safety

1. Require explicit apply/start authority or an already approved activated schedule. Load credentials from private environment variables or a private env file; never include values in configuration, output, Git, or receipts.
2. Preserve the canonical journal and activation evidence. The real-clock guards and mutex apply to both manual and scheduled mutations. Simulated `--at` is only for offline previews/audits/tests, never a mutation bypass.
3. Before successor creation, verify exact identity, forum/voice permissions, no competing provider recurrence, the configured audience contract, and absence of duplicate/orphan successors. A journal-owned prior native event may be completed independently before successor checks; report a partial result honestly.
4. Persist provider-specific create intents. Reconcile uncertain responses before retrying. Verify both successors before closing the predecessor. Never clear a journal or stale lock simply to unblock a run.
5. A current-raid repair needs separate authorization and fresh before/after verification of complete signup records and all unrelated fields. Do not silently repair legacy settings during rollover.
6. Live tests and immediate pings need their own permission. Configuration acceptance and offline tests are not proof of timed delivery or exact status exclusions. Do not rewrite historical canary timestamps when accepting a later release.

One scheduler owns creation. Never enable a second schedule while an existing Windows or Codex owner remains active. Publication is not deployment: inspect the installed task action before deleting or moving runtime files. Keep the installed runtime, credentials, private profile, canonical journal, and audit evidence even when deleting backup copies.

## Commands

From the repository root, use `node tools/pizza-raid-helper/scripts/pizza-core-rollover.mjs plan --config tools/pizza-raid-helper/config.pizza-core.example.json` for the safe example. Real `audit`, `start-native`, and `apply` use an explicitly selected private profile and Node's `--env-file` flag. The generic `raid-helper-event.mjs` module is retained for its shared parser and older one-event workflows; it is not this series' recurring entrypoint.

Run `npm run test:raid-workflow` after changes. The tests use fixtures, not the guild. A mutation/verification contract change requires an adapter-version bump and separately reconciled activation; a published source copy must never invent activation from passing tests.
