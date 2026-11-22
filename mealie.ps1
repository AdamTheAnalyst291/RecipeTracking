<#
.SYNOPSIS
  One command to run and look after the kitchen apps on this Windows laptop:
  Mealie (recipes), Grocy (pantry) and Actual Budget (money), plus the
  kitchen bridge that brings bank transactions into Actual.

.DESCRIPTION
  Usage:  .\mealie.cmd <command> [argument]

  setup            First-time setup: create .env, download the apps, start them
  start            Start all the apps
  stop             Stop them (your data is kept)
  restart          Restart them (after editing .env)
  status           Are they running and answering?
  logs [app]       Follow the live logs (Ctrl+C to exit); app = mealie, grocy, actual or bridge
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the versions in docker-compose.yml
  backup           Save a full copy of each app's data to the backup folder
  restore <file>   Replace ALL of one app's data with a backup file
  schedule-backup  Add weekly backup (Sundays 3am) and recipe audit (3:30am) tasks to Task Scheduler
  audit            Check every recipe for missing steps, unit words in notes and diet tags that clash
  staples [file]   Add the pantry staples in grocy\staples.csv to Grocy (safe to run again)
  power            Keep the laptop awake while plugged in (lid close does nothing)
  help             Show this list
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'restart', 'status', 'logs', 'url', 'update',
               'backup', 'restore', 'schedule-backup', 'audit', 'staples', 'power', 'help')]
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
$AuditTaskName = 'Mealie weekly recipe audit'

# One entry per app. Volume names are fixed in docker-compose.yml; backup
# files are named <Volume>_<date>.tar.gz, which is how restore finds the app.
$Apps = @(
  @{ Name = 'Mealie';        Service = 'mealie'; Volume = 'mealie-data'; PortKey = 'MEALIE_PORT'; DefaultPort = '9925'; Health = '/api/app/about' },
  @{ Name = 'Grocy';         Service = 'grocy';  Volume = 'grocy-data';  PortKey = 'GROCY_PORT';  DefaultPort = '9283'; Health = '/' },
  @{ Name = 'Actual Budget'; Service = 'actual'; Volume = 'actual-data'; PortKey = 'ACTUAL_PORT'; DefaultPort = '5006'; Health = '/health' },
  # Bank sync page; published on 127.0.0.1 only, so no phone address.
  @{ Name = 'Bridge';        Service = 'bridge'; Volume = 'bridge-data'; PortKey = 'BRIDGE_PORT'; DefaultPort = '8787'; Health = '/health'; LaptopOnly = $true }
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
    if ($ip -and -not $app.LaptopOnly) { Write-Host ("  {0,-14} your phone:  http://{1}:{2}   (same Wi-Fi)" -f '', $ip, $port) }
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

  Write-Step "Downloading Mealie, Grocy and Actual Budget, building the bridge"
  Invoke-Compose pull --ignore-buildable
  Write-Step "Starting them"
  Invoke-Compose up -d --build

  if (Wait-AppsUp) {
    Write-Ok "All the apps are running."
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
  Copy-BackupOffLaptop $dir $stamp $keep
}

# Optional second copy off the laptop, e.g. a Google Drive for desktop folder.
function Copy-BackupOffLaptop($Dir, $Stamp, [int]$Keep) {
  $copyDir = Get-EnvValue 'BACKUP_COPY_DIR' ''
  if (-not $copyDir) { return }
  $drive = Split-Path -Qualifier $copyDir -ErrorAction SilentlyContinue
  if ($drive -and -not (Test-Path "$drive\")) {
    Stop-WithError "Local backups are fine, but $drive isn't there, so nothing was copied to $copyDir. Is Google Drive for desktop running and signed in?"
  }
  New-Item -ItemType Directory -Force -Path $copyDir | Out-Null
  foreach ($app in $Apps) {
    $file = Join-Path $Dir "$($app.Volume)_$Stamp.tar.gz"
    Copy-Item $file $copyDir -Force -ErrorAction Stop
    Get-ChildItem $copyDir -Filter "$($app.Volume)_*.tar.gz" |
      Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Force
  }
  Write-Ok "Copied to $copyDir"
}

function Invoke-Restore([string]$File) {
  if (-not $File -or -not (Test-Path $File)) {
    Stop-WithError "Usage: .\mealie.cmd restore <path to a mealie-data_, grocy-data_, actual-data_ or bridge-data_ backup>"
  }
  Assert-Docker
  $full = (Resolve-Path $File).Path
  $dir  = Split-Path $full
  $name = Split-Path $full -Leaf

  $app = $Apps | Where-Object { $name -like "$($_.Volume)_*.tar.gz" } | Select-Object -First 1
  if (-not $app) { Stop-WithError "Can't tell which app $name belongs to. Backup files start with mealie-data_, grocy-data_, actual-data_ or bridge-data_." }

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
  Invoke-Compose pull --ignore-buildable
  Invoke-Compose up -d --build
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
  if (-not (Test-AppUp $Apps[0])) { Stop-WithError "Mealie isn't answering on port $(Get-Port). Run '.\mealie.cmd start'." }
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

function Get-GrocyKey {
  $key = $env:GROCY_API_KEY
  if (-not $key) { $key = [Environment]::GetEnvironmentVariable('GROCY_API_KEY', 'User') }
  if (-not $key) {
    Stop-WithError "Set an API key first: in Grocy open the user menu (top right) > Manage API keys > Add, then run`n  [Environment]::SetEnvironmentVariable('GROCY_API_KEY', '<key>', 'User')"
  }
  return $key
}

# Staples only (ADR-11): grocy\staples.csv lists the products Grocy tracks. Products,
# locations, units and groups are matched by name and only created when missing, so
# running this again is safe and never undoes changes made in Grocy. "Have now" sets
# the amount in stock (a stock count, not an addition); leave it blank to skip.
function Invoke-Staples {
  $grocy = $Apps | Where-Object { $_.Service -eq 'grocy' }
  if (-not (Test-AppUp $grocy)) { Stop-WithError "Grocy isn't answering on port $(Get-AppPort $grocy). Run '.\mealie.cmd start'." }
  $file = if ($Arg) { $Arg } else { Join-Path $Root 'grocy\staples.csv' }
  if (-not (Test-Path $file)) { Stop-WithError "Can't find $file." }
  $rows = @(Import-Csv $file | Where-Object { $_.Product })
  $headers = @{ 'GROCY-API-KEY' = (Get-GrocyKey) }
  $api = "http://localhost:$(Get-AppPort $grocy)/api"

  function Send-Grocy([string]$Path, $Body) {
    # UTF-8 bytes, because Grocy rejects a charset in the Content-Type header.
    $json = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
    try { Invoke-RestMethod -Method Post -Uri "$api/$Path" -Headers $headers -Body $json -ContentType 'application/json' -ErrorAction Stop }
    catch { Stop-WithError "Grocy refused POST $Path`: $($_.ErrorDetails.Message -replace '(?s),\s*"error_details".*', '}')" }
  }
  # Windows PowerShell 5.1 returns a JSON array as one object; foreach over a variable unrolls it.
  function Get-Grocy([string]$Path) { $list = Invoke-RestMethod -Uri "$api/$Path" -Headers $headers; foreach ($o in $list) { $o } }
  # name -> id for one Grocy table, creating any names in $Wanted that are missing.
  function Get-GrocyIds([string]$Entity, $Wanted, [scriptblock]$NewBody) {
    $ids = @{}
    foreach ($o in Get-Grocy "objects/$Entity") { $ids[$o.name.ToLower()] = $o.id }
    foreach ($name in $Wanted | Sort-Object -Unique) {
      if (-not $ids.ContainsKey($name.ToLower())) {
        $ids[$name.ToLower()] = (Send-Grocy "objects/$Entity" (& $NewBody $name)).created_object_id
        Write-Host "  + $Entity`: $name"
      }
    }
    return $ids
  }

  Write-Step "Checking locations, units and groups"
  $locations = Get-GrocyIds 'locations' ($rows | ForEach-Object { $_.Location }) { param($n) @{ name = $n; is_freezer = [int]($n -match 'freezer') } }
  $units = Get-GrocyIds 'quantity_units' ($rows | ForEach-Object { $_.Unit }) {
    param($n)
    $plural = if ($n -match '(s|sh|ch|x)$') { "$($n)es" } else { "$($n)s" }
    @{ name = $n; name_plural = $plural }
  }
  $groups = Get-GrocyIds 'product_groups' ($rows | ForEach-Object { $_.Group }) { param($n) @{ name = $n } }

  Write-Step "Adding $($rows.Count) staples"
  $products = @{}
  foreach ($o in Get-Grocy 'objects/products') { $products[$o.name.ToLower()] = $o.id }
  $inStock = @{}
  foreach ($s in Get-Grocy 'stock') { $inStock[[string]$s.product_id] = [double]$s.amount }
  $created = 0; $counted = 0
  foreach ($r in $rows) {
    $id = $products[$r.Product.ToLower()]
    if (-not $id) {
      $unit = $units[$r.Unit.ToLower()]
      $id = (Send-Grocy 'objects/products' @{
        name = $r.Product; description = $r.Note
        location_id = $locations[$r.Location.ToLower()]; product_group_id = $groups[$r.Group.ToLower()]
        qu_id_purchase = $unit; qu_id_stock = $unit; qu_id_consume = $unit; qu_id_price = $unit
        min_stock_amount = [double]$r.'Min stock'
        default_best_before_days = -1   # staples never "expire"; we only care whether there's enough
      }).created_object_id
      $products[$r.Product.ToLower()] = $id
      $created++
      Write-Host "  + $($r.Product) (min $($r.'Min stock') $($r.Unit), $($r.Location))"
    }
    $have = "$($r.'Have now')".Trim()
    # Grocy refuses a count that matches what it already has, so skip those.
    if ($have -ne '' -and [double]$have -ne [double]$inStock[[string]$id]) {
      Send-Grocy "stock/products/$id/inventory" @{ new_amount = [double]$have } | Out-Null
      $counted++
    }
  }

  $missing = @((Invoke-RestMethod -Uri "$api/stock/volatile" -Headers $headers).missing_products)
  Write-Ok "$created new staples, $($rows.Count - $created) already in Grocy, $counted stock counts set."
  if ($missing.Count) { Write-Host "Below minimum (shopping list candidates): $(($missing | ForEach-Object { $_.name }) -join ', ')" -ForegroundColor Yellow }
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
  'audit'           { Invoke-Audit }
  'staples'         { Invoke-Staples }
  'power'           { Invoke-Power }
  default {
    Write-Host @'
Usage:  .\mealie.cmd <command> [argument]

Runs Mealie (recipes), Grocy (pantry), Actual Budget (money) and the bank-sync bridge.

  setup            First-time setup: create .env, download the apps, start them
  start | stop | restart
  status           Are they running and answering?
  logs [app]       Follow the live logs (Ctrl+C to exit); app = mealie, grocy, actual or bridge
  url              Addresses to open on this laptop and on your phone
  update           Back up, then download and start the versions in docker-compose.yml
  backup           Save a full copy of each app's data to the backup folder
  restore <file>   Replace ALL of one app's data with a backup file
  schedule-backup  Weekly backup (Sundays 3am) and recipe audit (3:30am) in Task Scheduler
  audit            Check recipes for data problems; report goes to the backup folder
  staples [file]   Add the pantry staples in grocy\staples.csv to Grocy
  power            Keep the laptop awake while plugged in
'@
  }
}
