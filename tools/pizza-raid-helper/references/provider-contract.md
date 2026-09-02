---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Provider contract

Checked against the production adapter on September 2, 2026. Recheck official documentation before changing API behavior. See [Raid-Helper API](https://raid-helper.dev/documentation/api), [advanced settings](https://raid-helper.dev/documentation/advanced), [Discord channels](https://docs.discord.com/developers/resources/channel), and [scheduled events](https://docs.discord.com/developers/resources/guild-scheduled-event).

## Raid-Helper

- API base: `https://raid-helper.xyz/api/v4`. The server API key is the raw `Authorization` header value, not Bearer. Public event GET needs no key. Never send the server key to session-authenticated web routes.
- Create: `POST /servers/{guild}/channels/{forum}/event`. Read: `GET /events/{event}`. Existing-event `PATCH /events/{event}` is a separately approved repair, not part of rollover.
- Use the same resolved Unix timestamp string for `date` and `time`. Preserve IANA timezone/calendar-date reasoning in the local plan.
- Create/edit uses singular `announcement`; GET returns `announcements`. The unsigned action belongs in `announcement.channel: unsignedping`, not the text. The first announcement slot is free; extra slots are Premium. Ordinary `advancedSettings.reminder: 30` is a separate attendee reminder, not Premium personal `/reminders` DMs.
- Require exact `30` or `"30"` on readback for both reminder offsets. Reject default booleans, other offsets, extra announcements, or substituted channels/text. The unsigned announcement's exact future text is defined by `buildPayload`.
- Reserved signup settings: `allowed_roles: Pizza Core`, `banned_roles: none`, `bench_overflow: true`, `queue_bench: false`, `lock_at_limit: false`, `duration: 240`, `limit: 25`, `deadline: 0`, `deletion: false`, `delete_thread: false`, `disable_archiving: true`, `opt_out: none`, `vacuum: false`, and `create_discordevent: false`.
- Role/tag/mention settings use names; locally pinned immutable IDs must resolve uniquely before mutation. `mentions: Pizza Core` creates the initial role ping. Later provider edits can clear the visible role mention, so retained creation evidence and the configured setting matter; unexpected roles/everyone remain drift.
- Role limits are Tanks 2, Melee 8, Ranged 10, Healers 5. The stock WotLK template may add its exact hidden unlimited DPS aggregate; only the known aggregate is accepted, not arbitrary extra roles.
- For a forum event, `channelId` may be the post ID rather than the parent forum. Verify parent and starter author through Discord. Do not infer absence from a server-event list filtered only by the parent forum ID.
- `status: primary` alone is not proof of attendance: inspect the signup's class/role, including Bench or Absence. Never publish raw member responses as validation data.

## Discord

- For a forum starter, thread ID and starter message ID equal the Raid-Helper event ID. Verify exact guild/parent, Raid-Helper ownership/author, required applied tags, and open state.
- Only after both successors verify, close the predecessor with `PATCH /channels/{thread}` body `{archived: true, locked: true}`. Verify both flags. No deletion.
- Native voice cards use `entity_type: 2`, `privacy_level: 2`, the configured voice channel, no recurrence, and no external-event location. Null/absent metadata and exactly `{}` are equivalent for a voice event; populated/other metadata is drift.
- Exact native identity binds guild, management-bot creator, name, description/occurrence marker, signup post, voice channel, normalized start/end, and eligible status. Interested subscriber counts are provider-managed and not part of the identity hash.
- Start only a journaled eligible Scheduled card with `status: 2`; complete only a recorded Active card with `status: 3`. Preserve Completed/Canceled and auto-completed voice cards.
- Discord exposes no supported bot write for arbitrary Interested subscriptions. Link the current Raid-Helper roster instead of copying members or pretending counts are synchronized.
- Respect shared collection/item cooldowns and global 429s. GET may retry at most twice with response-directed waits; the transport never blindly repeats POST/PATCH/DELETE. Uncertain mutations are resolved by journal/provider reconciliation.

The generic `raid-helper-event.mjs` parser and [legacy schema](config.schema.json) remain available for historical one-event workflows, but are not the recurring series runner. Do not invoke those legacy writes against a managed forum without separately reconciling their configuration.
