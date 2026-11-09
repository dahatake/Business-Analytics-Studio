# Business Analytics Studio - setup (FR-107 / FR-108, Windows).
# Prepares the template on this PC: checks Node.js, installs the locked dependencies (npm ci) and builds the app.
# Safe by design: no admin rights, no global installs, no network access other than the npm registry (npm ci),
# idempotent (skips npm ci when package-lock.json has not changed since the last successful run).
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-SkipBuild] [-Force] [-DryRun]
param(
  [switch]$SkipBuild,
  [switch]$Force,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Fail([string]$Message, [string]$Action) {
  Write-Host "Setup failed: $Message" -ForegroundColor Red
  Write-Host "Next action: $Action" -ForegroundColor Yellow
  exit 1
}
function Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Invoke-Step([string]$Text, [scriptblock]$Action) {
  Step $Text
  if ($DryRun) { Write-Host '    (dry run: skipped)'; return }
  & $Action
  if ($LASTEXITCODE -ne 0) { Fail "$Text (exit code $LASTEXITCODE)" 'Read the messages above, fix the cause and run setup.ps1 again (it is safe to repeat).' }
}

$MinNode = [version]'22.18.0'

Step 'Checking Node.js and npm'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js was not found.' 'Install Node.js LTS (22.18 or later) for your user from https://nodejs.org/, open a new terminal and run setup.ps1 again.' }
$ver = [version]((node --version).TrimStart('v'))
if ($ver -lt $MinNode) { Fail "Node.js $ver is older than $MinNode." "Install Node.js $MinNode or later and run setup.ps1 again." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found.' 'Reinstall Node.js (npm is included) and run setup.ps1 again.' }
Write-Host "    Node.js $ver"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '    Note: administrator rights are not needed. Setup only writes inside this folder.' -ForegroundColor Yellow
}

if (-not (Test-Path -LiteralPath 'package-lock.json')) { Fail 'package-lock.json is missing.' 'Restore the template folder completely (package-lock.json pins every dependency).' }
$lockHash = (Get-FileHash -LiteralPath 'package-lock.json' -Algorithm SHA256).Hash
$marker = 'node_modules/.bas-setup.json'
$upToDate = $false
if ((Test-Path -LiteralPath $marker) -and -not $Force) {
  try { $upToDate = ((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).lockHash -eq $lockHash) } catch { $upToDate = $false }
}

if ($upToDate) {
  Step 'Dependencies are already installed for this package-lock.json (skipping npm ci; use -Force to reinstall)'
} else {
  # Local install only (no -g). npm ci contacts only the configured npm registry.
  Invoke-Step 'Installing the locked dependencies (npm ci)' { npm ci --no-audit --no-fund }
  if (-not $DryRun) { @{ lockHash = $lockHash; node = "$ver"; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8 }
}

if (-not $SkipBuild) {
  Invoke-Step 'Building the app (npm run build -> dist/)' { npm run build }
}
Invoke-Step 'Checking the customer-pack schema (docs/pack.schema.json)' { node scripts/bas.ts schema --check }

Write-Host ''
Write-Host 'Setup finished.' -ForegroundColor Green
Write-Host '  Start the template:        .\start.ps1'
Write-Host '  Prepare a customer:        node scripts/bas.ts build "Customer name"'
Write-Host '  Start a customer:          .\start.ps1 -Customer "Customer name"'
exit 0
