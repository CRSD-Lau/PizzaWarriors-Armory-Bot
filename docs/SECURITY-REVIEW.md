# Security Review

**Reviewed:** 2026-08-09  
**Scope:** Discord interaction handling, Warmane retrieval, card rendering, local configuration, dependencies, and repository hygiene.

## Result

No known production dependency vulnerabilities were reported by `npm audit --omit=dev`. The project does not persist guild-member data, does not read Discord message content, and keeps credentials outside version control.

## Controls verified

| Area | Control |
| --- | --- |
| Discord access | Slash commands only; `Guilds` intent only. |
| Credentials | `.env` and runtime cache are ignored; documented rotation and reporting path. |
| Untrusted armory data | Item text is HTML-escaped before card rendering. |
| Remote images | Card icons accept HTTPS `warmane.com` or subdomain URLs only. |
| Request pressure | Per-user/per-server 10-second lookup cooldown. |
| Supply chain | Locked dependency installation, CI audit, and weekly Dependabot updates. |

## Residual risks

- Warmane is an external, best-effort source and may rate-limit or challenge automated lookups.
- `WARMANE_COOKIE` is optional but sensitive. Treat it like a password and rotate it if exposed.
- The card renderer depends on an installed Google Chrome channel; the bot falls back to a text embed if card rendering fails.

## Follow-up cadence

Review dependencies weekly through Dependabot, run the release checklist before production changes, and revisit this review whenever Discord permissions, external sources, or rendering architecture changes.
