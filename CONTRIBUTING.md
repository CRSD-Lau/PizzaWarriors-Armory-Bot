# Contributing

Thanks for helping improve PizzaWarriors Armory Bot.

## Before opening a pull request

1. Keep the bot focused on armory lookup and presentation. Avoid unrelated guild-management features.
2. Run `npm run typecheck` and `npm test`.
3. Never commit `.env`, Discord tokens, Warmane cookies, PM2 logs, or `.cache/` data.
4. Preserve compatibility with WotLK 3.3.5a GearScoreLite rules. Add or update a test when changing scoring behavior.
5. Keep the Discord card mobile-readable and retain the text-embed fallback.

## Pull request expectations

- Explain the player-facing result and the technical approach.
- Include a screenshot for card-layout changes.
- Note any new environment variable, external endpoint, or dependency.
- Keep changes narrow and avoid drive-by formatting rewrites.
