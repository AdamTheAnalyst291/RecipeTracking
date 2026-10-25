<#
.SYNOPSIS
  One command to run and look after Mealie on this Windows laptop.

.DESCRIPTION
  Usage:  .\mealie.cmd <command> [argument]

  setup            First-time setup: create .env, download Mealie, start it
  start            Start Mealie
  stop             Stop Mealie (your data is kept)
  restart          Restart Mealie (after editing .env)
  status           Is it running and answering?
  logs             Follow the live logs (Ctrl+C to exit)
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the version in docker-compose.yml
  backup           Save a full copy of Mealie's data to the backup folder
  restore <file>   Replace ALL Mealie data with a backup file
  schedule-backup  Add weekly backup (Sundays 3am) and recipe audit (3:30am) tasks to Task Scheduler
  audit            Check every recipe for missing steps, unit words in notes and diet tags that clash
  power            Keep the laptop awake while plugged in (lid close does nothing)
  help             Show this list
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'restart', 'status', 'logs', 'url', 'update',
               'backup', 'restore', 'schedule-backup', 'audit', 'power', 'help')]
  [string]$Command = 'help',

  [Parameter(Position = 1)]
  [string]$Arg
)

# Native commands (docker, powercfg) report failure through $LASTEXITCODE;
# 'Continue' keeps PowerShell 5.1 from turning their stderr output into errors.
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
Set-Location $Root

$Volume   = 'mealie-data'   # fixed name, set in docker-compose.yml
$TaskName = 'Mealie weekly backup'
$AuditTaskName = 'Mealie weekly recipe audit'

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

function Test-MealieUp {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$(Get-Port)/api/app/about" -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Wait-MealieUp([int]$TimeoutSeconds = 180) {
  Write-Step "Waiting for Mealie to answer (first start can take a minute)..."
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-MealieUp) { return $true }
    Start-Sleep -Seconds 3
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
  $port = Get-Port
  Write-Host ""
  Write-Host "  On this laptop:  http://localhost:$port"
  $ip = Get-LanIp
  if ($ip) { Write-Host "  On your phone:   http://${ip}:$port   (same Wi-Fi)" }
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

  Write-Step "Downloading Mealie"
  Invoke-Compose pull
  Write-Step "Starting Mealie"
  Invoke-Compose up -d

  if (Wait-MealieUp) {
    Write-Ok "Mealie is running."
    Show-Urls
    Write-Host "First login:  changeme@example.com / MyPassword  -> change both right away."
    Write-Host "Next: '.\mealie.cmd power' and '.\mealie.cmd schedule-backup'."
  } else {
    Stop-WithError "Mealie didn't answer within 3 minutes. Run '.\mealie.cmd logs' to see why."
  }
}

function Invoke-Status {
  Assert-Docker
  docker compose ps
  if (Test-MealieUp) { Write-Ok "Mealie is answering."; Show-Urls }
  else { Write-Host "Mealie is NOT answering on port $(Get-Port)." -ForegroundColor Yellow }
}

function Invoke-Backup {
  Assert-Docker
  $dir = Get-BackupDir
  $name = "mealie-data_$(Get-Date -Format 'yyyy-MM-dd_HHmm').tar.gz"

  # Stop briefly so the SQLite database is copied in a consistent state.
  $wasRunning = [bool](docker compose ps --status running -q 2>$null)
  if ($wasRunning) { Write-Step "Pausing Mealie for a clean copy"; docker compose stop | Out-Null }

  Write-Step "Saving $name"
  docker run --rm -v "${Volume}:/data:ro" -v "${dir}:/backup" alpine tar czf "/backup/$name" -C /data .
  $code = $LASTEXITCODE

  if ($wasRunning) { docker compose start | Out-Null }
  if ($code -ne 0) { Stop-WithError "Backup failed (exit code $code)." }

  $keep = [int](Get-EnvValue 'BACKUP_KEEP' '8')
  Get-ChildItem $dir -Filter 'mealie-data_*.tar.gz' |
    Sort-Object Name -Descending | Select-Object -Skip $keep | Remove-Item -Force

  Write-Ok "Backup saved: $(Join-Path $dir $name)"
}

function Invoke-Restore([string]$File) {
  if (-not $File -or -not (Test-Path $File)) {
    Stop-WithError "Usage: .\mealie.cmd restore <path to a mealie-data_*.tar.gz backup>"
  }
  Assert-Docker
  $full = (Resolve-Path $File).Path
  $dir  = Split-Path $full
  $name = Split-Path $full -Leaf

  $answer = Read-Host "This replaces ALL current Mealie data with $name. Type YES to continue"
  if ($answer -ne 'YES') { Write-Host "Cancelled. Nothing changed."; return }

  Write-Step "Backing up current data first, just in case"
  Invoke-Backup

  docker compose stop | Out-Null
  Write-Step "Restoring $name"
  docker run --rm -v "${Volume}:/data" -v "${dir}:/backup:ro" alpine `
    sh -c "find /data -mindepth 1 -delete && tar xzf '/backup/$name' -C /data"
  $code = $LASTEXITCODE
  Invoke-Compose up -d
  if ($code -ne 0) { Stop-WithError "Restore failed (exit code $code). Your pre-restore backup is in $(Get-BackupDir)." }

  if (Wait-MealieUp) { Write-Ok "Restored and running." }
  else { Stop-WithError "Restored, but Mealie isn't answering. Run '.\mealie.cmd logs'." }
}

function Invoke-Update {
  Assert-Docker
  Write-Step "Backing up before updating"
  Invoke-Backup
  Write-Step "Downloading the version set in docker-compose.yml"
  Invoke-Compose pull
  Invoke-Compose up -d
  if (Wait-MealieUp) { Write-Ok "Updated and running." }
  else { Stop-WithError "Mealie isn't answering after the update. Run '.\mealie.cmd logs'; '.\mealie.cmd restore' can roll back." }
}

function Invoke-ScheduleBackup {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\mealie.ps1`" backup"
  $trigger  = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Backs up Mealie data (mealie-home repo).' -Force | Out-Null
  if ($?) { Write-Ok "Scheduled '$TaskName' for Sundays at 3am. Backups go to $(Get-BackupDir)." }
  else { Stop-WithError "Couldn't create the scheduled task." }

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\mealie.ps1`" audit"
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:30am
  Register-ScheduledTask -TaskName $AuditTaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Checks Mealie recipes for data problems (mealie-home repo).' -Force | Out-Null
  if ($?) { Write-Ok "Scheduled '$AuditTaskName' for Sundays at 3:30am. Reports go to $(Get-BackupDir)." }
  else { Stop-WithError "Couldn't create the audit task." }
}

# Patterns for the diet and allergen checks. They match food names plus notes, so a
# "gluten-free" or "vegan" note, or a plant-based food, clears the match.
$AuditMeat   = '\b(chicken|beef|pork|lamb|veal|turkey|shrimp|fish|anchov\w*|bacon|sausage|steak|chuck|ham|gelatin)\b'
$AuditDairy  = '\b(milk|butter|cheese|cream|parmesan|mozzarella|provolone|cheddar|yogurt|ghee|ranch)\b'
$AuditGluten = '\b(orzo|wonton|egg roll|soy sauce|worcestershire|bread ?crumbs?|pasta|flour|panko|couscous|bulgur|barley|beer)\b'
$AuditNuts   = '\b(almond\w*|walnut\w*|pistachio\w*|peanut\w*|cashew\w*|pecan\w*|hazelnut\w*|macadamia|pine nut\w*)\b'
$AuditPlant  = 'gluten[- ]free|vegan|plant|almond milk|oat milk|coconut|peanut butter|rice flour|tapioca|tamari|chickpea flour'
$AuditUnitWords = @('clove', 'bunch', 'head', 'stick', 'knob', 'can', 'pinch', 'sprig', 'slice')

function Get-MealieToken {
  $token = $env:MEALIE_API_TOKEN
  if (-not $token) { $token = [Environment]::GetEnvironmentVariable('MEALIE_API_TOKEN', 'User') }
  if (-not $token) {
    Stop-WithError "Set an API token first: in Mealie open your profile > API Tokens, then run`n  [Environment]::SetEnvironmentVariable('MEALIE_API_TOKEN', '<token>', 'User')"
  }
  return $token
}

function Invoke-Audit {
  if (-not (Test-MealieUp)) { Stop-WithError "Mealie isn't answering on port $(Get-Port). Run '.\mealie.cmd start'." }
  $headers = @{ Authorization = "Bearer $(Get-MealieToken)" }
  $api = "http://localhost:$(Get-Port)/api"

  Write-Step "Reading recipes"
  $list = (Invoke-RestMethod -Uri "$api/recipes?perPage=-1" -Headers $headers).items
  $problems = New-Object System.Collections.Generic.List[string]

  foreach ($item in $list) {
    $r = Invoke-RestMethod -Uri "$api/recipes/$($item.slug)" -Headers $headers
    $issues = @()
    $tags = @($r.tags | ForEach-Object { $_.name })

    if (@($r.recipeInstructions).Count -eq 0) { $issues += 'no directions' }
    if (-not $r.recipeServings -and -not $r.recipeYieldQuantity) { $issues += 'no yield or servings' }
    if (-not $r.prepTime -and -not $r.totalTime) { $issues += 'no prep or total time' }
    if (@($r.recipeCategory).Count -eq 0) { $issues += 'no category' }
    if ($r.description -match 'https?://' -and -not $r.orgURL) { $issues += 'source link in description, not in Source field' }

    $lines = @()
    foreach ($ing in @($r.recipeIngredient)) {
      $note = [string]$ing.note
      if (-not $ing.food) {
        if ($ing.note -or $ing.originalText) { $issues += "ingredient not linked to a food: '$($ing.note)$($ing.originalText)'" }
        continue
      }
      $lines += "$($ing.food.name) $note"
      $first = ($note -split ',')[0].Trim().ToLower()
      if (-not $ing.unit -and $AuditUnitWords -contains $first) { $issues += "'$first' is in the note, not the unit: $($ing.food.name)" }
    }
    $animalFree = @($lines | Where-Object { $_ -notmatch $AuditPlant })
    $meat  = @($animalFree | Where-Object { $_ -match $AuditMeat })
    $dairy = @($animalFree | Where-Object { $_ -match $AuditDairy })
    $other = @($animalFree | Where-Object { $_ -match '\beggs?\b|honey|mayonnaise|fish sauce' })
    $gluten = @($lines | Where-Object { $_ -match $AuditGluten -and $_ -notmatch $AuditPlant })
    $nuts  = @($lines | Where-Object { $_ -match $AuditNuts -and $_ -notmatch 'nut[- ]free' })

    if ($tags -contains 'Vegan' -and ($meat + $dairy + $other).Count) { $issues += "tagged Vegan but has: $(($meat + $dairy + $other) -join '; ')" }
    if ($tags -contains 'Vegetarian' -and $meat.Count) { $issues += "tagged Vegetarian but has: $($meat -join '; ')" }
    if ($tags -contains 'Dairy-Free' -and $dairy.Count) { $issues += "tagged Dairy-Free but has: $($dairy -join '; ')" }
    if ($tags -contains 'Gluten-Free' -and $gluten.Count) { $issues += "tagged Gluten-Free but has: $($gluten -join '; ')" }
    if ($tags -notcontains 'Contains Nuts' -and $nuts.Count) { $issues += "has nuts but no 'Contains Nuts' tag: $($nuts -join '; ')" }

    foreach ($i in $issues) { $problems.Add("$($r.name): $i") }
  }

  # Foods that differ only by capital letters (e.g. "Pepper" and "pepper") split shopping lists.
  $foods = (Invoke-RestMethod -Uri "$api/foods?perPage=-1" -Headers $headers).items
  $foods | Group-Object { $_.name.ToLower() } | Where-Object { $_.Count -gt 1 } | ForEach-Object {
    $problems.Add("Duplicate food: $(($_.Group | ForEach-Object { $_.name }) -join ' / ')")
  }

  $report = Join-Path (Get-BackupDir) "mealie-audit_$(Get-Date -Format 'yyyy-MM-dd').txt"
  $header = "Mealie recipe audit, $(Get-Date -Format 'yyyy-MM-dd HH:mm'): $($list.Count) recipes, $($problems.Count) problems"
  @($header, '') + $problems | Out-File -FilePath $report -Encoding utf8
  Get-ChildItem (Get-BackupDir) -Filter 'mealie-audit_*.txt' |
    Sort-Object Name -Descending | Select-Object -Skip 8 | Remove-Item -Force

  $problems | ForEach-Object { Write-Host "  $_" }
  if ($problems.Count) { Write-Host "$($problems.Count) problems in $($list.Count) recipes. Report: $report" -ForegroundColor Yellow }
  else { Write-Ok "No problems in $($list.Count) recipes. Report: $report" }
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
  'start'           { Assert-Docker; Invoke-Compose up -d; if (Wait-MealieUp) { Write-Ok "Running."; Show-Urls } else { Stop-WithError "Started, but Mealie isn't answering. Run '.\mealie.cmd logs'." } }
  'stop'            { Assert-Docker; Invoke-Compose stop; Write-Ok "Stopped. Your data is kept." }
  'restart'         { Assert-Docker; Invoke-Compose up -d --force-recreate; if (Wait-MealieUp) { Write-Ok "Restarted." } }
  'status'          { Invoke-Status }
  'logs'            { Assert-Docker; docker compose logs -f --tail 100 }
  'url'             { Show-Urls }
  'update'          { Invoke-Update }
  'backup'          { Invoke-Backup }
  'restore'         { Invoke-Restore $Arg }
  'schedule-backup' { Invoke-ScheduleBackup }
  'audit'           { Invoke-Audit }
  'power'           { Invoke-Power }
  default {
    Write-Host @'
Usage:  .\mealie.cmd <command> [argument]

  setup            First-time setup: create .env, download Mealie, start it
  start | stop | restart
  status           Is it running and answering?
  logs             Follow the live logs (Ctrl+C to exit)
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the version in docker-compose.yml
  backup           Save a full copy of Mealie's data to the backup folder
  restore <file>   Replace ALL Mealie data with a backup file
  schedule-backup  Weekly backup (Sundays 3am) and recipe audit (3:30am) in Task Scheduler
  audit            Check recipes for data problems; report goes to the backup folder
  power            Keep the laptop awake while plugged in
'@
  }
}
