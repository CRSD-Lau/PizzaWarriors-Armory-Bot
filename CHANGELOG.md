---
author: Neil Mitchell
last_modified_by: Neil Mitchell
---

# Changelog

All notable changes to PizzaWarriors Armory Bot are documented here.

## [Unreleased]

## [1.0.1] - 2026-09-06

### Added

- Optional weekly Raid-Helper publication and Windows scheduling source with sanitized configuration, duplicate prevention, reconciliation, and failure/retry safeguards.
- Officer-invoked Pizza Core roster snapshots from directly mentioned Discord members.
- `/ready` comparison of core members across signed, late, tentative, bench, absent, and missing states.
- Targeted reminders only for core members with no event response, with exact user allowlists and duplicate-ping protection.
- Private officer-only `/attendance` cards with de-duplicated week-over-week Pizza Core signup history.

### Changed

- Updated plain `/ready` discovery to support Raid-Helper-authored Discord forum posts, including active and recently archived Pizza Core threads.
- Made the **Well Timed Pizza** Discord role the live Pizza Core source for `/ready`, reminders, and current-core attendance views.
- Made plain `/ready` discover the current Pizza Core ICC25 post instead of silently reusing a completed saved event.
- Expanded `/ready` core responses to list signed non-core guests, Tentative members, and Absent members by name alongside members who have not signed up.
- Added the Armory-reported current specialization and class to `/armory` cards and their text fallback.
- Consolidated Windows boot recovery into one silent, single-instance Task Scheduler process and disabled the obsolete PM2 recovery launchers.
- Standardized every generated card at 3× device resolution for clearer Discord previews and full-size viewing.

### Fixed

- Made private JSON persistence transactional and atomic; corrupt or incompatible saved files are preserved rather than replaced with empty data.
- Corrected stale item metadata overriding fresh values, long-lived incomplete cache entries, and missing one-hand/shirt/tabard metadata parsing.
- Bounded and coalesced source caches; stale summary fallback now remains visibly unverified on readiness cards.
- Contained Discord interaction failures, acknowledged roster paging before slow work, and added Unicode-safe paging buttons.
- Prevented historical/foreign-server raids from changing core history or enabling reminders; reminder reservations now precede sends.
- Centralized card capture/context cleanup while retaining 3× resolution and existing layouts.
- Made the legacy installer refuse unverified process-tree shutdown and fixed repository scheduler retries for transient GET failures without retrying uncertain mutations.
- Expanded automatically discovered bot regression tests and Windows/Linux CI coverage.

- Made `/ready` class colors follow Raid-Helper's selected class even when that signup's Armory gear profile is unavailable.
- Sent `/armory`, `/upgrade`, and `/roster` cards as direct image attachments instead of nesting them inside Discord image embeds.

### Security

- Enabled on-demand Discord member listing for one configured core role while retaining the minimal `Guilds` gateway subscription and exact-user reminder allowlists.
- Kept the bot on the `Guilds` intent by using a deliberate message context command instead of monitoring channel content.
- Restricted core-roster configuration and reminders to event/server managers.
- Restricted attendance history through command visibility, runtime permission checks, ephemeral replies, and an ignored host-local data file.

### Upgrade notes

- This release includes all guild workflow additions and reliability fixes merged since 1.0.0.
- Role-backed core lookup requires the configured Pizza Core role and Discord Server Members Intent; the bot continues to subscribe only to the Guilds gateway intent.
- Production operation uses the single Armory Windows task. Do not enable the obsolete PM2 boot, logon, or repeating recovery tasks alongside it.
- The optional weekly publisher has a separate installed path, private configuration, and journal. A source release does not update that installation or create another schedule.
- Keep one writer per private data directory and preserve backups. Corrupt saved files fail closed; historical attendance is not retroactively corrected, and stale gear remains unverified.

## [1.0.0] - 2026-08-09

### Added

- `/armory` Discord slash command for Warmane character lookup.
- WotLK 3.3.5a GearScoreLite-compatible scoring.
- PizzaWarriors equipment-card attachment with Warmane item thumbnails and character model preview.
- Raid-Helper readiness reporting, guild-roster pagination, local raider links, and reviewed upgrade cards.
- PM2 recovery scripts, health endpoint, CI, dependency updates, and security documentation.

### Security

- Added HTTPS Warmane icon-host validation, escaped card text, ignored local credentials, and lookup throttling.
