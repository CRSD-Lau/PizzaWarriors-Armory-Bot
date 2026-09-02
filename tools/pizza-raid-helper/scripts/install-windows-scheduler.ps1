# Author and last modified by: Neil Mitchell.
# Stages a NEW disabled task. Never replaces or restarts the existing Armory bot.
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.pizza-core.local.json'),
  [Parameter(Mandatory)][string]$EnvPath
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$identityPrincipal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $identityPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this installer from an Administrator PowerShell session. Nothing has been installed.' }
$taskName = 'Pizza Core Weekly Raids'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$scriptPath = Join-Path $PSScriptRoot 'pizza-core-scheduler.mjs'
if ((Get-TimeZone).Id -ne 'Atlantic Standard Time') { throw 'This task requires the Halifax/Atlantic Windows timezone.' }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw 'Task already exists. Inspect it; installer never overwrites.' }
foreach ($path in @($nodeExe, $scriptPath, $ConfigPath, $EnvPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required runtime file is missing.' }
  if ($path.Contains('"')) { throw 'Quoted file paths are not supported.' }
}
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
$resolvedEnv = (Resolve-Path -LiteralPath $EnvPath).Path
$arguments = "--env-file=`"$resolvedEnv`" `"$scriptPath`" --config `"$resolvedConfig`""
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arguments -WorkingDirectory $PSScriptRoot
$friday = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Friday -At '23:00'
$saturday = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Saturday -At '03:00'
# Floating local boundaries keep 23:00/03:00 Halifax when daylight saving changes.
# New-ScheduledTaskTrigger otherwise serializes today's explicit UTC offset.
$friday.StartBoundary = (Get-Date).Date.AddHours(23).ToString("yyyy-MM-dd'T'HH:mm:ss")
$saturday.StartBoundary = (Get-Date).Date.AddHours(3).ToString("yyyy-MM-dd'T'HH:mm:ss")
$startup = New-ScheduledTaskTrigger -AtStartup
$startup.Delay = 'PT2M'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$task = New-ScheduledTask -Action $action -Trigger @($friday, $saturday, $startup) -Principal $principal -Settings $settings -Description 'PC-owned Pizza Core start and rollover. Friday 23:00 and Saturday 03:00 Halifax. Bounded startup recovery. Raid-Helper is the sole reminder sender.'
$task.Author = 'Neil Mitchell'
Register-ScheduledTask -TaskName $taskName -InputObject $task -ErrorAction Stop | Out-Null
$saved = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($saved.Settings.Enabled) { Disable-ScheduledTask -TaskName $taskName | Out-Null; throw 'Expected staged task to remain disabled.' }
Write-Output 'Staged disabled: Pizza Core Weekly Raids. Validate read-only under this principal; pause Codex before enabling the production action. WakeToRun is false.'
