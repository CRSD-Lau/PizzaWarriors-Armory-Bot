---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Security Review

**Reviewed:** 2026-09-06
**Scope:** Discord interaction handling, targeted core-roster reminders, Warmane retrieval, card rendering, local configuration, dependencies, and repository hygiene.

## Result

No known production dependency vulnerabilities were reported by `npm audit --omit=dev`. The bot loads one configured core role on demand, does not subscribe to member or message-content gateway events, and keeps credentials and attendance snapshots outside version control.

## Controls verified

| Area | Control |
| --- | --- |
| Discord access | `Guilds` gateway intent only; on-demand REST reads are limited to configured signup-channel/forum metadata and one configured core role. Server Members Intent enables role lookup without subscribing to member events or broad Message Content access. |
| Core reminders | Current server-owned event validation, missing-signup-only targeting, Manage Events/Manage Server gate, exact user-ID allowlist, no role/everyone mentions, and a durable pre-send 30-minute cooldown reservation. |
| Local roster data | Current role membership is not continuously synchronized; optional source-message metadata and reminder timestamps remain local, while event-specific attendance snapshots retain only core IDs, labels, and response states. |
| Credentials | `.env` and runtime cache are ignored; documented rotation and reporting path. |
| Untrusted armory data | Item text is HTML-escaped before card rendering. |
| Remote images | Card icons accept HTTPS `warmane.com`, its subdomains, or `wow.zamimg.com`; text remains HTML-escaped. |
| Request pressure | One expensive request per user, four total; serial browser work; three concurrent discovery reads; bounded summary/roster caches; duplicate source requests coalesce. |
| Private persistence | Single-process serialized transactions, schema validation, flushed atomic replacement, and no in-memory commit after a failed write. Invalid files are never silently reset. |
| Discord failures | Early acknowledgement for paging and private mutations, contained async handler/error-response failures, private busy/error responses. |
| Supply chain | Locked dependency installation, CI audit, and weekly Dependabot updates. |

## Residual risks

- Warmane is an external, best-effort source and may rate-limit or challenge automated lookups.
- Automatic Raid-Helper discovery depends on access to active and public archived threads in the configured signup forum; it accepts only threads owned by Raid-Helper and narrows to the Pizza Core forum tag when present.
- `WARMANE_COOKIE` is optional but sensitive. Treat it like a password and rotate it if exposed.
- The card renderer depends on an installed Google Chrome channel; the bot falls back to a text embed if card rendering fails.
- Roster accuracy depends on consistently assigning and removing the configured **Well Timed Pizza** role. If Discord denies role-member refresh, the bot fails closed instead of silently reusing the stale message snapshot.
- Private state is host-local, not encrypted or replicated. Atomic replacement does not protect against disk loss or two independent bot writers. Restrict folder access and maintain backups.
- Readiness is a source-based check, not proof of actual raid attendance or optimal gems/enchants. Cached outage gear is labelled and does not certify current preparation.
- The standalone manual raid publisher lacks the weekly runner's durable transaction lock. Do not run concurrent manual `apply` operations for one occurrence. See the [full review](REVIEW-2026-09-06.md) for the deployment boundary and remaining limitations.

## Follow-up cadence

Review dependencies weekly through Dependabot, run the release checklist before production changes, and revisit this review whenever Discord permissions, external sources, or rendering architecture changes.
