# Release Checklist

Use this before publishing a version or changing the bot in production.

## Validation

- [ ] `npm ci` completes from a clean checkout.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm audit --omit=dev` reports no known production vulnerabilities.
- [ ] Test `/armory` against at least one character on each supported realm.
- [ ] Confirm the card uses real item icons, a readable character render, and the **Open Armory** button.

## Security and configuration

- [ ] `.env`, cookies, logs, and `.cache/` are not staged.
- [ ] Discord application token is stored only in the host's secret store or local `.env`.
- [ ] Optional `WARMANE_COOKIE` is current, necessary, and never committed.
- [ ] Bot invite uses only `bot` and `applications.commands`; no privileged gateway intents are enabled.

## Operations

- [ ] `GET /healthz` returns `{ "ok": true }` after deployment.
- [ ] PM2 shows `pizza-warriors-armory` as `online`.
- [ ] Boot and logon recovery tasks are present and use the hidden launcher.
- [ ] The current version and user-facing changes are recorded in `CHANGELOG.md`.

## GitHub

- [ ] CI is green.
- [ ] README screenshots and setup instructions match the current bot.
- [ ] A reviewer has checked the diff for accidental credentials and unrelated files.
