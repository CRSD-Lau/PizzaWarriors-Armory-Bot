# Security Review

**Reviewed:** 2026-08-28
**Scope:** Discord interaction handling, targeted core-roster reminders, Warmane retrieval, card rendering, local configuration, dependencies, and repository hygiene.

## Result

No known production dependency vulnerabilities were reported by `npm audit --omit=dev`. The bot loads one configured core role on demand, does not subscribe to member or message-content gateway events, and keeps credentials and attendance snapshots outside version control.

## Controls verified

| Area | Control |
| --- | --- |
| Discord access | `Guilds` gateway intent only; Server Members Intent enables on-demand HTTP member listing for one configured role, without subscribing to member events or broad Message Content access. |
| Core reminders | Missing-signup-only targeting, Manage Events/Manage Server gate, exact user-ID allowlist, no role/everyone mentions, and a 30-minute unchanged-state cooldown. |
| Local roster data | Current role membership is not continuously synchronized; optional source-message metadata and reminder timestamps remain local, while event-specific attendance snapshots retain only core IDs, labels, and response states. |
| Credentials | `.env` and runtime cache are ignored; documented rotation and reporting path. |
| Untrusted armory data | Item text is HTML-escaped before card rendering. |
| Remote images | Card icons accept HTTPS `warmane.com` or subdomain URLs only. |
| Request pressure | Per-user/per-server 10-second lookup cooldown. |
| Supply chain | Locked dependency installation, CI audit, and weekly Dependabot updates. |

## Residual risks

- Warmane is an external, best-effort source and may rate-limit or challenge automated lookups.
- `WARMANE_COOKIE` is optional but sensitive. Treat it like a password and rotate it if exposed.
- The card renderer depends on an installed Google Chrome channel; the bot falls back to a text embed if card rendering fails.
- Roster accuracy depends on consistently assigning and removing the configured **Well Timed Pizza** role. If Discord denies role-member refresh, the bot fails closed instead of silently reusing the stale message snapshot.

## Follow-up cadence

Review dependencies weekly through Dependabot, run the release checklist before production changes, and revisit this review whenever Discord permissions, external sources, or rendering architecture changes.
