# Changelog

All notable changes to PizzaWarriors Armory Bot are documented here.

## [Unreleased]

### Added

- Officer-invoked Pizza Core roster snapshots from directly mentioned Discord members.
- `/ready` comparison of core members across signed, late, tentative, bench, absent, and missing states.
- Targeted reminders only for core members with no event response, with exact user allowlists and duplicate-ping protection.

### Changed

- Consolidated Windows boot recovery into one silent, single-instance Task Scheduler process and disabled the obsolete PM2 recovery launchers.

### Security

- Kept the bot on the `Guilds` intent by using a deliberate message context command instead of monitoring channel content.
- Restricted core-roster configuration and reminders to event/server managers.

## [1.0.0] - 2026-08-09

### Added

- `/armory` Discord slash command for Warmane character lookup.
- WotLK 3.3.5a GearScoreLite-compatible scoring.
- PizzaWarriors equipment-card attachment with Warmane item thumbnails and character model preview.
- Raid-Helper readiness reporting, guild-roster pagination, local raider links, and reviewed upgrade cards.
- PM2 recovery scripts, health endpoint, CI, dependency updates, and security documentation.

### Security

- Added HTTPS Warmane icon-host validation, escaped card text, ignored local credentials, and lookup throttling.
