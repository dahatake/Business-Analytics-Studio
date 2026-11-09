# Business Analytics Studio - start (FR-141, Windows).
# Starts the built app on 127.0.0.1. With -Customer, starts work/<customer>/ built by `node scripts/bas.ts build`.
# Needs only Node.js (no admin rights, no global installs, no network).
#   powershell -ExecutionPolicy Bypass -File start.ps1 [-Customer "Contoso"] [-Port 4173]
param(
  [string]$Customer = '',
  [int]$Port = 4173
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$MinNode = [version]'22.18.0'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js was not found. Install Node.js LTS (22.18 or later), then run setup.ps1.' -ForegroundColor Red
  exit 1
}
$ver = [version]((node --version).TrimStart('v'))
if ($ver -lt $MinNode) {
  Write-Host "Node.js $ver is too old. Install Node.js $MinNode or later." -ForegroundColor Red
  exit 1
}

if ($Customer) {
  node scripts/bas.ts launch $Customer --port $Port
} else {
  if (-not (Test-Path -LiteralPath 'dist/index.html')) {
    Write-Host 'The app is not built yet. Run setup.ps1 first.' -ForegroundColor Red
    exit 1
  }
  node scripts/check-build.mjs $PSScriptRoot
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'The app was not rebuilt after the last change, so it would show an older version. Run npm run build, then start.ps1 again.' -ForegroundColor Red
    exit 1
  }
  node scripts/bas.ts serve --dir dist --port $Port
}
exit $LASTEXITCODE
