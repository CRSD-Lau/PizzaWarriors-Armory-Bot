---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Release Checklist

Use this before publishing a version or changing the bot in production.

## Validation

- [ ] `npm ci` completes from a clean checkout.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run test:raid-workflow` passes, including failure/retry safeguards.
- [ ] `npm run test:cards` renders all five high-resolution card types without live Discord messages.
- [ ] `npm audit --omit=dev` reports no known production vulnerabilities.
- [ ] Music source smoke decodes non-silent YouTube and Spotify-matched audio on the target host; the pinned yt-dlp checksum matches.
- [ ] A listener confirms music in Discord, playlist transitions, pause/resume/skip/stop, channel restrictions, and automatic departure. Record this separately from source/health checks.
- [ ] Test `/armory` against at least one character on each supported realm.
- [ ] Confirm the card uses real item icons, a readable character render, and the **Open Armory** button.

## Security and configuration

- [ ] `.env`, cookies, logs, and `.cache/` are not staged.
- [ ] Discord application token is stored only in the host's secret store or local `.env`.
- [ ] Optional `WARMANE_COOKIE` is current, necessary, and never committed.
- [ ] Bot invite uses only `bot` and `applications.commands`; the client subscribes to Guilds and Guild Voice States. Music requires View Channel, Connect, and Speak in its voice channel. Enable Server Members Intent in the application only when role-backed core lookup needs the REST member list; Message Content remains unnecessary.
- [ ] Existing private JSON files pass the new validators read-only; back them up without committing them.
- [ ] Historical/foreign events cannot rewrite core history or send reminders; stale gear does not count as verified preparation.

## Operations

- [ ] `GET /healthz` returns `{ "ok": true }` after deployment.
- [ ] The `PizzaWarriors Armory Bot` task is running the direct Node action and `/healthz` reports Discord ready.
- [ ] The obsolete logon-recovery and five-minute watchdog tasks are absent.
- [ ] No shared PM2 daemon or unrelated process tree is stopped during installation.
- [ ] The separate weekly scheduler's installed path, configuration, and journal remain unchanged unless explicitly included in the deployment.
- [ ] The current version and user-facing changes are recorded in `CHANGELOG.md`.

## GitHub

- [ ] CI is green.
- [ ] README screenshots and setup instructions match the current bot.
- [ ] A reviewer has checked the diff for accidental credentials and unrelated files.
