# Security Review

**Reviewed:** 2026-08-20
**Scope:** Discord interaction handling, targeted core-roster reminders, Warmane retrieval, card rendering, local configuration, dependencies, and repository hygiene.

## Result

No known production dependency vulnerabilities were reported by `npm audit --omit=dev`. The bot retains only officer-selected Pizza Core IDs and display labels locally, does not monitor channel messages, and keeps credentials and roster snapshots outside version control.

## Controls verified

| Area | Control |
| --- | --- |
| Discord access | Slash commands plus an officer-invoked message context command; `Guilds` intent only and no broad Message Content access. |
| Core reminders | Manage Events/Manage Server gate, exact user-ID allowlist, no role/everyone mentions, and a 30-minute unchanged-state cooldown. |
| Local roster data | Only the selected message identifiers, mentioned core user IDs/display labels, and reminder timestamps are retained in an ignored local file. |
| Credentials | `.env` and runtime cache are ignored; documented rotation and reporting path. |
| Untrusted armory data | Item text is HTML-escaped before card rendering. |
| Remote images | Card icons accept HTTPS `warmane.com` or subdomain URLs only. |
| Request pressure | Per-user/per-server 10-second lookup cooldown. |
| Supply chain | Locked dependency installation, CI audit, and weekly Dependabot updates. |

## Residual risks

- Warmane is an external, best-effort source and may rate-limit or challenge automated lookups.
- `WARMANE_COOKIE` is optional but sensitive. Treat it like a password and rotate it if exposed.
- The card renderer depends on an installed Google Chrome channel; the bot falls back to a text embed if card rendering fails.
- Roster accuracy depends on the selected Discord post directly mentioning every core member; the bot refuses to guess plain names.

## Follow-up cadence

Review dependencies weekly through Dependabot, run the release checklist before production changes, and revisit this review whenever Discord permissions, external sources, or rendering architecture changes.
