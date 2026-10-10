# ============================================================
# PostgreSQL backup for costcontrol
# Keeps a rolling set of recent dumps and deletes older ones.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
# ============================================================
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $here '..\data\config.json'
$backupDir = Join-Path $here '..\backups'
$Keep = 14

if (-not (Test-Path $configPath)) {
  Write-Host 'config.json is missing - run from the project folder.' -ForegroundColor Red
  exit 1
}

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

# Find pg_dump in PATH, or in a common PostgreSQL install location.
$exe = $null
$cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
if ($cmd) { $exe = $cmd.Source }

if (-not $exe) {
  foreach ($pattern in @(
    'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe',
    'C:\Program Files (x86)\PostgreSQL\*\bin\pg_dump.exe'
  )) {
    $f = Get-ChildItem $pattern -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($f) { $exe = $f.FullName; break }
  }
}

if (-not $exe) {
  Write-Host 'Could not find pg_dump. Add PostgreSQL\bin to PATH.' -ForegroundColor Red
  exit 1
}

$db = if ($cfg.database) { $cfg.database } else { 'costcontrol' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $backupDir "costcontrol-$stamp.dump"

$env:PGPASSWORD = $cfg.password
& $exe -h $cfg.host -p $cfg.port -U $cfg.user -d $db -Fc -f $out
$code = $LASTEXITCODE
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

if ($code -ne 0) {
  Write-Host "pg_dump failed (exit code $code)" -ForegroundColor Red
  exit 1
}

$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "Backup created: $out ($size MB)" -ForegroundColor Green

# Keep only the most recent $Keep dumps.
Get-ChildItem $backupDir -Filter 'costcontrol-*.dump' |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep |
  Remove-Item -Force

Write-Host "Backups kept: $((Get-ChildItem $backupDir -Filter 'costcontrol-*.dump').Count) (max $Keep)"