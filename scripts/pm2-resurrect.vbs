Option Explicit

' Legacy PM2 launcher intentionally disabled. The production bot now runs as
' one persistent Task Scheduler-owned Node process. Keeping this no-op file
' makes any not-yet-removed legacy task harmless instead of spawning PM2.
WScript.Quit 0
