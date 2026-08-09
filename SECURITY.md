# Security Policy

## Supported version

Security fixes are applied to the current `master` branch.

## Reporting a vulnerability

Please use GitHub's private security advisory flow for this repository. If that is unavailable, contact PizzaWarriors leadership privately. Do not open a public issue for a suspected token leak, session-cookie exposure, or vulnerability.

Include a clear reproduction, affected version or commit, impact, and any suggested mitigation. Please avoid accessing data that does not belong to you or disrupting Warmane, Discord, or guild services while validating a finding.

## Credential handling

- Keep `DISCORD_TOKEN`, `WARMANE_COOKIE`, and any host credentials only in `.env` or your hosting provider's secret store.
- Never paste a full token or cookie into an issue, Discord message, commit, screenshot, or pull request.
- If a credential is exposed, rotate it immediately in the relevant provider, replace the local secret, and review bot logs and deployment history.

## Security controls in this project

- The bot uses Discord slash commands and the `Guilds` intent only; it does not read message content.
- Armory artwork URLs are restricted to HTTPS Warmane hosts before they are rendered into a card.
- Card markup escapes character and item text before rendering.
- A per-user, per-server lookup cooldown limits repeated browser-backed requests.
- Dependencies are lockfile-installed in CI and production dependencies are audited.
