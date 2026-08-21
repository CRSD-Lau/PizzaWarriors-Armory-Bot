[CmdletBinding()]
param(
  [switch]$StartNow,
  [int]$LegacyPm2RootPid = 0,
  [uri]$HealthUri = 'http://127.0.0.1:3000/healthz'
)

$ErrorActionPreference = 'Stop'

$taskName = 'PizzaWarriors Armory Bot'
$legacyTaskNames = @(
  'PizzaWarriors Armory Bot - Logon Recovery',
  'PizzaWarriors Armory Watchdog'
)
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$botScript = Join-Path $PSScriptRoot 'run-bot.mjs'
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer from an Administrator PowerShell session.'
  }
}

function Backup-ScheduledTaskDefinitions {
  param([string[]]$Names)

  $documents = [Environment]::GetFolderPath('MyDocuments')
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path $documents "Codex Backups\PizzaWarriors-Armory-Bot\scheduled-tasks-$stamp"
  [IO.Directory]::CreateDirectory($backupDir) | Out-Null

  foreach ($name in $Names) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) { continue }

    $safeName = $name -replace '[^A-Za-z0-9._-]', '_'
    $xmlPath = Join-Path $backupDir "$safeName.xml"
    [IO.File]::WriteAllText($xmlPath, (Export-ScheduledTask -TaskName $name), [Text.Encoding]::Unicode)
  }

  return $backupDir
}

function Get-DescendantProcessIds {
  param(
    [int]$RootPid,
    [Microsoft.Management.Infrastructure.CimInstance[]]$Processes
  )

  $found = [Collections.Generic.HashSet[int]]::new()
  $queue = [Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $parentPid = $queue.Dequeue()
    foreach ($child in $Processes | Where-Object { [int]$_.ParentProcessId -eq $parentPid }) {
      $childPid = [int]$child.ProcessId
      if ($found.Add($childPid)) { $queue.Enqueue($childPid) }
    }
  }
  return @($found)
}

function Stop-LegacyPm2Tree {
  param([int]$RootPid)

  if ($RootPid -le 0) { return }

  $processes = @(Get-CimInstance Win32_Process)
  $root = $processes | Where-Object { [int]$_.ProcessId -eq $RootPid } | Select-Object -First 1
  if ($null -eq $root) {
    Write-Output "Legacy PM2 root PID $RootPid already exited."
    return
  }
  if ($root.Name -ine 'node.exe') {
    throw "Refusing to stop PID $RootPid because it is $($root.Name), not node.exe."
  }

  $descendants = @(Get-DescendantProcessIds -RootPid $RootPid -Processes $processes)
  $isPm2Daemon = $root.CommandLine -match '(?i)\\pm2\\lib\\Daemon\.js'
  $ownsHealthPort = $false
  try {
    $listenerPids = @(Get-NetTCPConnection -State Listen -LocalPort $HealthUri.Port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess)
    $ownsHealthPort = @($listenerPids | Where-Object { $_ -eq $RootPid -or $descendants -contains [int]$_ }).Count -gt 0
  } catch {
    $ownsHealthPort = $false
  }
  if (-not $isPm2Daemon -and -not $ownsHealthPort) {
    throw "Refusing to stop PID $RootPid because it cannot be verified as the PM2 tree or the current health-port owner."
  }

  & "$env:WINDIR\System32\taskkill.exe" /PID $RootPid /T /F | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "taskkill failed for legacy PM2 root PID $RootPid (exit $LASTEXITCODE)." }
}

function Wait-ForHealthyBot {
  param(
    [uri]$Uri,
    [string]$TaskName,
    [datetime]$NotBefore,
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
      $listener = Get-NetTCPConnection -State Listen -LocalPort $Uri.Port -ErrorAction Stop | Select-Object -First 1
      $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
      if ($task.State -eq 'Running' -and $owner.StartTime -ge $NotBefore.AddSeconds(-2)) {
        $health = Invoke-RestMethod -Uri $Uri -TimeoutSec 3
        if ($health.ok -eq $true -and $health.discordReady -eq $true) { return $true }
      }
    } catch {
      # The task may still be starting Playwright and Discord.
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Wait-ForStoppedBot {
  param([uri]$Uri, [string]$TaskName, [int]$TimeoutSeconds = 30)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Uri.Port -ErrorAction SilentlyContinue
    if (($null -eq $task -or $task.State -ne 'Running') -and $null -eq $listener) { return $true }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $false
}

Assert-Administrator
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node executable not found: $nodeExe" }
if (-not (Test-Path -LiteralPath $botScript)) { throw "Bot launcher not found: $botScript" }

$allTaskNames = @($taskName) + $legacyTaskNames
$backupDir = Backup-ScheduledTaskDefinitions -Names $allTaskNames
Write-Output "Backed up existing task definitions to: $backupDir"

Stop-LegacyPm2Tree -RootPid $LegacyPm2RootPid

foreach ($name in $legacyTaskNames) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task) { continue }
  if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Write-Output "Removed legacy task: $name"
}

$existingMainTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$wasRunning = $null -ne $existingMainTask -and $existingMainTask.State -eq 'Running'
if ($wasRunning) {
  Stop-ScheduledTask -TaskName $taskName
  if (-not (Wait-ForStoppedBot -Uri $HealthUri -TaskName $taskName)) {
    throw "The existing task or port $($HealthUri.Port) did not stop within 30 seconds. No replacement was started."
  }
}

$arguments = "--import tsx `"$botScript`""
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Description 'Runs the PizzaWarriors Armory Bot directly as one background process after Windows boots.' `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Write-Output "Installed single-instance task: $taskName"

if ($StartNow -or $wasRunning) {
  $launchStarted = Get-Date
  Start-ScheduledTask -TaskName $taskName
  if (-not (Wait-ForHealthyBot -Uri $HealthUri -TaskName $taskName -NotBefore $launchStarted)) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    throw "The new task did not become healthy at $HealthUri within 45 seconds. It was stopped and disabled; backups are at $backupDir."
  }
  Write-Output "Healthy: $HealthUri"
}
