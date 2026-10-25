<#
.SYNOPSIS
  One command to run and look after the kitchen apps on this Windows laptop:
  Mealie (recipes), Grocy (pantry) and Actual Budget (money).

.DESCRIPTION
  Usage:  .\mealie.cmd <command> [argument]

  setup            First-time setup: create .env, download the apps, start them
  start            Start all three apps
  stop             Stop them (your data is kept)
  restart          Restart them (after editing .env)
  status           Are they running and answering?
  logs [app]       Follow the live logs (Ctrl+C to exit); app = mealie, grocy or actual
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the versions in docker-compose.yml
  backup           Save a full copy of each app's data to the backup folder
  restore <file>   Replace ALL of one app's data with a backup file
  schedule-backup  Add a weekly backup task to Windows Task Scheduler (Sundays 3am)
  power            Keep the laptop awake while plugged in (lid close does nothing)
  help             Show this list
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'restart', 'status', 'logs', 'url', 'update',
               'backup', 'restore', 'schedule-backup', 'power', 'help')]
  [string]$Command = 'help',

  [Parameter(Position = 1)]
  [string]$Arg
)

# Native commands (docker, powercfg) report failure through $LASTEXITCODE;
# 'Continue' keeps PowerShell 5.1 from turning their stderr output into errors.
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
Set-Location $Root

$TaskName = 'Mealie weekly backup'

# One entry per app. Volume names are fixed in docker-compose.yml; backup
# files are named <Volume>_<date>.tar.gz, which is how restore finds the app.
$Apps = @(
  @{ Name = 'Mealie';        Service = 'mealie'; Volume = 'mealie-data'; PortKey = 'MEALIE_PORT'; DefaultPort = '9925'; Health = '/api/app/about' },
  @{ Name = 'Grocy';         Service = 'grocy';  Volume = 'grocy-data';  PortKey = 'GROCY_PORT';  DefaultPort = '9283'; Health = '/' },
  @{ Name = 'Actual Budget'; Service = 'actual'; Volume = 'actual-data'; PortKey = 'ACTUAL_PORT'; DefaultPort = '5006'; Health = '/health' }
)

# ---------------------------------------------------------------- helpers

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message)   { Write-Host $Message -ForegroundColor Green }
function Stop-WithError([string]$Message) {
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Get-EnvValue([string]$Key, [string]$Default) {
  $file = Join-Path $Root '.env'
  if (Test-Path $file) {
    foreach ($line in Get-Content $file) {
      if ($line -match "^\s*$Key\s*=\s*(.*)$") {
        $value = $Matches[1].Trim().Trim('"').Trim("'")
        if ($value) { return $value }
      }
    }
  }
  return $Default
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $file = Join-Path $Root '.env'
  $lines = @(Get-Content $file)
  $found = $false
  $lines = $lines | ForEach-Object {
    if ($_ -match "^\s*$Key\s*=") { $found = $true; "$Key=$Value" } else { $_ }
  }
  if (-not $found) { $lines += "$Key=$Value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

function Get-Port { return (Get-EnvValue 'MEALIE_PORT' '9925') }

function Get-AppPort($App) { return (Get-EnvValue $App.PortKey $App.DefaultPort) }

function Get-LanIp {
  $config = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1
  if ($config -and $config.IPv4Address) { return $config.IPv4Address[0].IPAddress }
  return $null
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Stop-WithError "Docker isn't installed. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
  }
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Stop-WithError "Docker Desktop isn't running. Open it, wait until it says 'Engine running', then try again."
  }
}

function Test-AppUp($App) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$(Get-AppPort $App)$($App.Health)" -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Wait-AppsUp($Which = $Apps, [int]$TimeoutSeconds = 180) {
  Write-Step "Waiting for the apps to answer (first start can take a minute)..."
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $down = @($Which | Where-Object { -not (Test-AppUp $_) })
    if ($down.Count -eq 0) { return $true }
    Start-Sleep -Seconds 3
  }
  foreach ($app in $Which) {
    if (-not (Test-AppUp $app)) { Write-Host "$($app.Name) isn't answering on port $(Get-AppPort $app)." -ForegroundColor Yellow }
  }
  return $false
}

function Invoke-Compose {
  docker compose @args
  if ($LASTEXITCODE -ne 0) { Stop-WithError "docker compose $($args -join ' ') failed (exit code $LASTEXITCODE)." }
}

function Get-BackupDir {
  $dir = Get-EnvValue 'BACKUP_DIR' ''
  if (-not $dir) {
    if ($env:OneDrive) { $dir = Join-Path $env:OneDrive 'MealieBackups' }
    else { $dir = Join-Path $Root 'backups' }
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return (Resolve-Path $dir).Path
}

function Show-Urls {
  $ip = Get-LanIp
  Write-Host ""
  foreach ($app in $Apps) {
    $port = Get-AppPort $app
    Write-Host ("  {0,-14} this laptop: http://localhost:{1}" -f $app.Name, $port)
    if ($ip) { Write-Host ("  {0,-14} your phone:  http://{1}:{2}   (same Wi-Fi)" -f '', $ip, $port) }
  }
  Write-Host ""
  Write-Host "  Actual Budget only opens over https on other devices: see 'Reaching it from your phone' in README.md."
  Write-Host ""
}

# ---------------------------------------------------------------- commands

function Invoke-Setup {
  Assert-Docker
  $envFile = Join-Path $Root '.env'
  if (-not (Test-Path $envFile)) {
    Write-Step "Creating .env from .env.example"
    Copy-Item (Join-Path $Root '.env.example') $envFile
    $ip = Get-LanIp
    if ($ip) { Set-EnvValue 'BASE_URL' "http://${ip}:$(Get-Port)" }
  } else {
    Write-Step ".env already exists, keeping your settings"
  }

  Write-Step "Downloading Mealie, Grocy and Actual Budget"
  Invoke-Compose pull
  Write-Step "Starting them"
  Invoke-Compose up -d

  if (Wait-AppsUp) {
    Write-Ok "All three apps are running."
    Show-Urls
    Write-Host "First logins (change the passwords right away):"
    Write-Host "  Mealie:        changeme@example.com / MyPassword"
    Write-Host "  Grocy:         admin / admin"
    Write-Host "  Actual Budget: set a server password the first time you open it"
    Write-Host "Next: '.\mealie.cmd power' and '.\mealie.cmd schedule-backup'."
  } else {
    Stop-WithError "Not everything answered within 3 minutes. Run '.\mealie.cmd logs' to see why."
  }
}

function Invoke-Status {
  Assert-Docker
  docker compose ps
  foreach ($app in $Apps) {
    if (Test-AppUp $app) { Write-Ok "$($app.Name) is answering." }
    else { Write-Host "$($app.Name) is NOT answering on port $(Get-AppPort $app)." -ForegroundColor Yellow }
  }
  Show-Urls
}

function Invoke-Backup {
  Assert-Docker
  $dir = Get-BackupDir
  $stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
  $keep = [int](Get-EnvValue 'BACKUP_KEEP' '8')

  # Stop briefly so each SQLite database is copied in a consistent state.
  $wasRunning = [bool](docker compose ps --status running -q 2>$null)
  if ($wasRunning) { Write-Step "Pausing the apps for a clean copy"; docker compose stop | Out-Null }

  $failed = @()
  foreach ($app in $Apps) {
    $name = "$($app.Volume)_$stamp.tar.gz"
    Write-Step "Saving $name"
    docker run --rm -v "$($app.Volume):/data:ro" -v "${dir}:/backup" alpine tar czf "/backup/$name" -C /data .
    if ($LASTEXITCODE -ne 0) { $failed += $app.Name; continue }
    Get-ChildItem $dir -Filter "$($app.Volume)_*.tar.gz" |
      Sort-Object Name -Descending | Select-Object -Skip $keep | Remove-Item -Force
  }

  if ($wasRunning) { docker compose start | Out-Null }
  if ($failed) { Stop-WithError "Backup failed for: $($failed -join ', ')." }

  Write-Ok "Backups saved in $dir"
}

function Invoke-Restore([string]$File) {
  if (-not $File -or -not (Test-Path $File)) {
    Stop-WithError "Usage: .\mealie.cmd restore <path to a mealie-data_, grocy-data_ or actual-data_ backup>"
  }
  Assert-Docker
  $full = (Resolve-Path $File).Path
  $dir  = Split-Path $full
  $name = Split-Path $full -Leaf

  $app = $Apps | Where-Object { $name -like "$($_.Volume)_*.tar.gz" } | Select-Object -First 1
  if (-not $app) { Stop-WithError "Can't tell which app $name belongs to. Backup files start with mealie-data_, grocy-data_ or actual-data_." }

  $answer = Read-Host "This replaces ALL current $($app.Name) data with $name. Type YES to continue"
  if ($answer -ne 'YES') { Write-Host "Cancelled. Nothing changed."; return }

  Write-Step "Backing up current data first, just in case"
  Invoke-Backup

  docker compose stop $app.Service | Out-Null
  Write-Step "Restoring $name"
  docker run --rm -v "$($app.Volume):/data" -v "${dir}:/backup:ro" alpine `
    sh -c "find /data -mindepth 1 -delete && tar xzf '/backup/$name' -C /data"
  $code = $LASTEXITCODE
  Invoke-Compose up -d
  if ($code -ne 0) { Stop-WithError "Restore failed (exit code $code). Your pre-restore backup is in $(Get-BackupDir)." }

  if (Wait-AppsUp @($app)) { Write-Ok "$($app.Name) restored and running." }
  else { Stop-WithError "Restored, but $($app.Name) isn't answering. Run '.\mealie.cmd logs $($app.Service)'." }
}

function Invoke-Update {
  Assert-Docker
  Write-Step "Backing up before updating"
  Invoke-Backup
  Write-Step "Downloading the versions set in docker-compose.yml"
  Invoke-Compose pull
  Invoke-Compose up -d
  if (Wait-AppsUp) { Write-Ok "Updated and running." }
  else { Stop-WithError "Not everything is answering after the update. Run '.\mealie.cmd logs'; '.\mealie.cmd restore' can roll back." }
}

function Invoke-ScheduleBackup {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\mealie.ps1`" backup"
  $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Backs up Mealie, Grocy and Actual Budget data (mealie-home repo).' -Force | Out-Null
  if ($?) { Write-Ok "Scheduled '$TaskName' for Sundays at 3am. Backups go to $(Get-BackupDir)." }
  else { Stop-WithError "Couldn't create the scheduled task." }
}

function Invoke-Power {
  Write-Step "Plugged in: never sleep or hibernate; closing the lid does nothing. On battery stays as it was."
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setactive SCHEME_CURRENT
  if ($LASTEXITCODE -eq 0) { Write-Ok "Power settings updated." }
  else { Stop-WithError "powercfg failed (exit code $LASTEXITCODE). Try running from an administrator terminal." }
  Write-Host "Also set a ~80% charge limit in your laptop maker's app to protect the battery."
}

# ---------------------------------------------------------------- dispatch

switch ($Command) {
  'setup'           { Invoke-Setup }
  'start'           { Assert-Docker; Invoke-Compose up -d; if (Wait-AppsUp) { Write-Ok "Running."; Show-Urls } else { Stop-WithError "Started, but not everything is answering. Run '.\mealie.cmd logs'." } }
  'stop'            { Assert-Docker; Invoke-Compose stop; Write-Ok "Stopped. Your data is kept." }
  'restart'         { Assert-Docker; Invoke-Compose up -d --force-recreate; if (Wait-AppsUp) { Write-Ok "Restarted." } }
  'status'          { Invoke-Status }
  'logs'            { Assert-Docker; if ($Arg) { docker compose logs -f --tail 100 $Arg } else { docker compose logs -f --tail 100 } }
  'url'             { Show-Urls }
  'update'          { Invoke-Update }
  'backup'          { Invoke-Backup }
  'restore'         { Invoke-Restore $Arg }
  'schedule-backup' { Invoke-ScheduleBackup }
  'power'           { Invoke-Power }
  default {
    Write-Host @'
Usage:  .\mealie.cmd <command> [argument]

Runs Mealie (recipes), Grocy (pantry) and Actual Budget (money).

  setup            First-time setup: create .env, download the apps, start them
  start | stop | restart
  status           Are they running and answering?
  logs [app]       Follow the live logs (Ctrl+C to exit); app = mealie, grocy or actual
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the versions in docker-compose.yml
  backup           Save a full copy of each app's data to the backup folder
  restore <file>   Replace ALL of one app's data with a backup file
  schedule-backup  Weekly backup task in Windows Task Scheduler (Sundays 3am)
  power            Keep the laptop awake while plugged in
'@
  }
}
