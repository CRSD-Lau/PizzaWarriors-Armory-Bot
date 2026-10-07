---
author: Neil Mitchell
creator: Neil Mitchell
last_modified_by: Neil Mitchell
modifier: Neil Mitchell
---

# Music in Pizza Warriors

Join a normal voice channel and use `/play query:<song or link>`. The bot joins you and plays the queue in order. Anyone in the same channel can pause, resume, skip, or stop. Requests from another room cannot move an active session. `/queue` and `/nowplaying` display the current recording and requester. Every music reply is private and dismissible, including errors. There are no public song announcements or automatic channel posts. No message-content intent or Administrator permission is needed.

## Sources and limits

- Song names search YouTube. Individual YouTube videos and public playlists are supported.
- Public Spotify track and playlist links supply title, artist and duration only. The bot finds a matching YouTube recording and shows the actual playback link. It does not stream Spotify audio or require a Spotify account.
- Spotify's public embed data exposes at most the first 100 songs. Public-page changes can break imports; unavailable/private links receive an error, without requesting account cookies. Use a YouTube link when matching fails.
- Imports and the waiting queue are capped at 100 songs. Queue replies report omitted/unavailable entries; playback skips inaccessible tracks.
- Private content, livestreams, podcasts, arbitrary media URLs, AFK channels and Stage channels are outside this feature.
- The bot leaves after 60 seconds with no waiting/current song or no human listeners. `/stop` immediately cancels pending work, clears the queue and leaves. Restarting clears all music state.
- The PC must remain awake and online. YouTube extraction is dependent on upstream availability; network blocks or source changes may need maintenance. No account cookies or automatic executable updates are used.

## Windows setup

The existing Node 24 runtime is compatible with the pinned `@discordjs/voice` 0.19.2 package. It includes DAVE encrypted voice support. FFmpeg must have the `libopus` encoder; audio is piped as Ogg Opus without a separate native Node Opus encoder.

```powershell
npm ci
.\scripts\install-music-tools.ps1
```

The installer downloads official yt-dlp **2026.08.19** into ignored `runtime/music`, verifies its pinned SHA-256 and version, and locates FFmpeg. It prints these settings for the private `.env`:

```dotenv
MUSIC_ENABLED=true
MUSIC_YTDLP_PATH=D:\path\to\bot\runtime\music\yt-dlp-2026.08.19.exe
MUSIC_FFMPEG_PATH=C:\path\to\ffmpeg.exe
```

Use absolute executable paths because Task Scheduler may have a different PATH. The yt-dlp executable includes its YouTube JavaScript components and uses the bot's Node executable. FFmpeg and yt-dlp run hidden with an explicit environment that excludes bot credentials. The bot does not save downloaded songs.

Keep the existing `DISCORD_GUILD_ID` so commands are registered to Pizza Warriors. In Discord, allow the bot **View Channel**, **Connect**, and **Speak** in the desired voice channels, plus its existing text reply permissions. Guild Voice States is a normal gateway intent; no new privileged intent toggle is required.

Discord counts the bot toward a voice channel's member limit. When a room is full, `/play` replies privately that a slot is needed. To let the bot join a full room while keeping its human limit, allow **Move Members** for the bot member in that channel's permissions. This is Discord's capacity-bypass permission; the music commands do not move other members. Scope this optional permission to the intended channel. Administrator permission is unnecessary.

Restart only the existing **PizzaWarriors Armory Bot** task after deployment. Do not reinstall it or restart **Pizza Core Weekly Raids**. The latter uses the same private `.env` for existing credentials but has its own runtime and journal.

## Checks and recovery

`/healthz` retains `ok` and `discordReady` and adds `music.enabled`, `music.ready`, and an optional diagnostic reason. Missing/invalid executables disable music while armory and raid commands remain usable. Setting `MUSIC_ENABLED=false` and restarting only the bot is the music kill switch.

Run `npm run typecheck`, `npm test`, `npm run test:raid-workflow`, `npm run test:cards`, and `npm audit --omit=dev` before deployment. Unit tests do not log in to Discord or contact music sources. The explicit source smoke check uses real providers without joining Discord:

```powershell
npm run test:music:sources -- --query "SOPHIE Immaterial official audio"
npm run test:music:sources -- --query "https://open.spotify.com/playlist/3Q4cPwMHY95ZHXtmcU2xvH"
```

After deployment, verify the named task, one expected bot process, health, registered commands and an armory lookup. The live acceptance check requires a listener in Discord: hear a YouTube search result and playlist transition, verify a Spotify song and playlist match the requested music, use pause/resume/skip/stop, and confirm automatic departure. Source decoding or a Ready voice connection alone does not establish audible playback.

Preserve the previous Git revision, lockfile, `.env`, private data, and task definitions before rollout. Roll back only the bot revision/dependencies/configuration if validation fails; leave the weekly scheduler and its journal untouched.
