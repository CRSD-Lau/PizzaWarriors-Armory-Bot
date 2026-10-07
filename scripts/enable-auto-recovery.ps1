# Author/Creator and Last Modified By: Neil Mitchell.
[CmdletBinding()]
param(
  [string]$BotRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupDirectory = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Codex Backups\PizzaWarriors-Armory-Bot')
)

$ErrorActionPreference = 'Stop'
$taskName = 'PizzaWarriors Armory Bot'
$botRootPath = (Resolve-Path -LiteralPath $BotRoot).Path.TrimEnd('\')
$botScript = Join-Path $botRootPath 'scripts\run-bot.mjs'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$actions = @($task.Actions)
if ($actions.Count -ne 1 -or
    $actions[0].Execute -ne 'C:\Program Files\nodejs\node.exe' -or
    $actions[0].Arguments -ne "--import tsx `"$botScript`"" -or
    $actions[0].WorkingDirectory.TrimEnd('\') -ne $botRootPath) {
  throw 'The task action does not match this bot runtime. No task changes were made.'
}
if ($task.Settings.MultipleInstances -ne 2) {
  throw 'The task must use IgnoreNew to prevent duplicate instances. No task changes were made.'
}
if (-not $task.Settings.Enabled) {
  throw 'The bot task is disabled, possibly for maintenance. No task changes were made.'
}

$triggers = @($task.Triggers)
$boot = @($triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })
$recovery = @($triggers | Where-Object { $_.Id -eq 'BotAutoRecovery' })
if ($boot.Count -ne 1 -or @($triggers | Where-Object {
  $_.CimClass.CimClassName -ne 'MSFT_TaskBootTrigger' -and $_.Id -ne 'BotAutoRecovery'
}).Count -ne 0 -or $recovery.Count -gt 1) {
  throw 'Unexpected task triggers found. No task changes were made.'
}
if ($recovery.Count -eq 1 -and $recovery[0].Enabled -and
    $recovery[0].CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and
    [string]::IsNullOrEmpty($recovery[0].EndBoundary) -and
    $recovery[0].Repetition.Interval -eq 'PT1M' -and
    [string]::IsNullOrEmpty($recovery[0].Repetition.Duration) -and
    -not $recovery[0].Repetition.StopAtDurationEnd) {
  Write-Output 'One-minute automatic recovery is already configured.'
  return
}

[IO.Directory]::CreateDirectory($BackupDirectory) | Out-Null
$backup = Join-Path $BackupDirectory ('bot-task-before-auto-recovery-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
[IO.File]::WriteAllText($backup, (Export-ScheduledTask -TaskName $taskName), [Text.Encoding]::Unicode)

# Omitting RepetitionDuration repeats indefinitely. IgnoreNew skips ticks while
# the existing direct Node process is running; no second service is installed.
$timer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$timer.Id = 'BotAutoRecovery'
$timer.Repetition.StopAtDurationEnd = $false
Set-ScheduledTask -TaskName $taskName -Trigger @($boot[0], $timer) | Out-Null

$updated = Get-ScheduledTask -TaskName $taskName
$savedTimer = @($updated.Triggers | Where-Object { $_.Id -eq 'BotAutoRecovery' })
if ($savedTimer.Count -ne 1 -or -not $savedTimer[0].Enabled -or
    $savedTimer[0].CimClass.CimClassName -ne 'MSFT_TaskTimeTrigger' -or
    -not [string]::IsNullOrEmpty($savedTimer[0].EndBoundary) -or
    $savedTimer[0].Repetition.Interval -ne 'PT1M' -or
    -not [string]::IsNullOrEmpty($savedTimer[0].Repetition.Duration) -or
    $savedTimer[0].Repetition.StopAtDurationEnd -or $updated.Settings.MultipleInstances -ne 2) {
  throw "Recovery trigger verification failed. Original task definition: $backup"
}
Write-Output "Automatic recovery enabled: one-minute checks on the existing task. Backup: $backup"
Write-Output 'For maintenance, disable the task before stopping it; enable and start it when finished.'
