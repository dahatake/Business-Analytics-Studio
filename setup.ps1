# Business Analytics Studio - setup (FR-107 / FR-108, Windows). One script for every setup step:
#
#  1. PC setup (default): Node.js check (or a per-folder Node.js install with -InstallNode), locked dependencies
#     (npm ci), build, pack-schema check, then the AI service you choose with -Ai (or interactively):
#       None     - no generative AI (the app works with its built-in sample and mock answers)
#       Copilot  - GitHub Copilot: checks the sign-in and models, offers "copilot login" (no prompt is sent)
#       Foundry  - Microsoft Foundry: with Azure CLI and -FoundryResourceId (or -ResourceGroup and -AccountName) checks
#                  that your account may call the model (read-only; Azure CLI is optional for users)
#       Both     - Copilot and Foundry
#     -WorkIq (optional, D-14) also checks the Microsoft Work IQ CLI (no Work IQ search, never accepts its EULA).
#  2. Azure administrator (-AzureAdmin): creates or reuses the resource group, the Microsoft Foundry resource
#     (kind AIServices, custom subdomain), the model deployment and a Microsoft Entra security group, and gives that
#     group the data-plane role on that one resource. -AddUser / -RemoveUser manage the group's members.
#     Nothing on this PC is installed in this mode. Every change is idempotent, shown first and skipped with -DryRun.
#
# Safe by design: no admin rights on the PC, no global installs, writes only inside this folder (.bas-runtime\node,
# node_modules, dist). Network: nodejs.org (only with -InstallNode), the npm registry, GitHub (Copilot) and Azure.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-Ai None|Copilot|Foundry|Both] [-InstallNode] [-WorkIq]
#                                                      [-SkipBuild] [-Force] [-DryRun] [-Yes]
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Ai Foundry -ResourceGroup rg-bas -AccountName bas-contoso
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -AzureAdmin -ResourceGroup rg-bas -Location japaneast `
#              -AccountName bas-contoso [-GroupName "BAS Users"] [-ExtraRoles Speech,Vision,Decision] [-DisableKeys]
#              [-AddUser a@contoso.com,b@contoso.com] [-RemoveUser c@contoso.com] [-DryRun]
# See users-guide/01-setup.md (users) and users-guide/09-admin-setup.md (administrators).
param(
  [ValidateSet('Ask', 'None', 'Copilot', 'Foundry', 'Both')]
  [string]$Ai = 'Ask',
  [switch]$InstallNode,
  [switch]$SkipBuild,
  [switch]$Force,
  [switch]$DryRun,
  [switch]$WorkIq,
  [switch]$Yes,
  [string]$FoundryResourceId = '',
  [switch]$AzureAdmin,
  [string]$SubscriptionId = '',
  [string]$ResourceGroup = '',
  [string]$Location = 'japaneast',
  [string]$AccountName = '',
  [string]$DeploymentName = 'gpt-6.2-sol',
  [string]$ModelName = 'gpt-6.2-sol',
  [string]$ModelVersion = '2026-11-17',
  [string]$ModelSku = 'GlobalStandard',
  [int]$Capacity = 0,
  [string]$GroupName = 'BAS Users',
  # Comma lists arrive as one string with powershell -File, so these are split and checked below.
  [string[]]$ExtraRoles = @(),
  [switch]$DisableKeys,
  [string[]]$AddUser = @(),
  [string[]]$RemoveUser = @()
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
function Split-List([string[]]$Values) { return @($Values | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$ExtraRoles = Split-List $ExtraRoles
$AddUser = Split-List $AddUser
$RemoveUser = Split-List $RemoveUser
foreach ($r in $ExtraRoles) {
  if ($r -notin @('Speech', 'Vision', 'Decision')) { Write-Host "Unknown -ExtraRoles value '$r'. Use Speech, Vision and/or Decision." -ForegroundColor Red; exit 1 }
}

function Fail([string]$Message, [string]$Action) {
  Write-Host "Setup failed: $Message" -ForegroundColor Red
  Write-Host "Next action: $Action" -ForegroundColor Yellow
  exit 1
}
function Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Info([string]$Text) { Write-Host "    $Text" }
function Warn([string]$Text) { Write-Host "    $Text" -ForegroundColor Yellow }
# .NET instead of Get-FileHash: that cmdlet is missing when powershell.exe inherits PowerShell 7's PSModulePath.
function Get-Sha256([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).ProviderPath)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}
function Invoke-Step([string]$Text, [scriptblock]$Action) {
  Step $Text
  if ($DryRun) { Info '(dry run: skipped)'; return }
  & $Action
  if ($LASTEXITCODE -ne 0) { Fail "$Text (exit code $LASTEXITCODE)" 'Read the messages above, fix the cause and run setup.ps1 again (it is safe to repeat).' }
}
function Test-Interactive { return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected }
# Asks before an action that changes something outside this folder. -Yes answers yes; -DryRun never asks.
function Confirm-Change([string]$Question) {
  if ($Yes -or $DryRun) { return $true }
  if (-not (Test-Interactive)) { Fail "Confirmation needed: $Question" 'Run setup.ps1 again in a terminal, or add -Yes to confirm in advance.' }
  $answer = Read-Host "    $Question [Y/n]"
  return ($answer -eq '' -or $answer -match '^(y|yes)$')
}

$MinNode = [version]'22.18.0'
$RuntimeDir = Join-Path $PSScriptRoot '.bas-runtime'
$LocalNode = Join-Path $RuntimeDir 'node'

# ---------------------------------------------------------------- Azure CLI helpers
# az is az.cmd: arguments pass through cmd.exe, so queries are filtered here in PowerShell instead of with --query.
function Invoke-Az([string[]]$AzArgs) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & az @AzArgs '--only-show-errors' 2>&1 } finally { $ErrorActionPreference = $prev }
  $code = $LASTEXITCODE
  $stdout = ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
  $stderr = ($out | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
  return [pscustomobject]@{ Ok = ($code -eq 0); Out = $stdout; Err = $stderr.Trim() }
}
function Get-AzJson([string[]]$AzArgs) {
  $r = Invoke-Az ($AzArgs + @('-o', 'json'))
  if (-not $r.Ok -or -not $r.Out.Trim()) { return $null }
  return ($r.Out | ConvertFrom-Json)
}
# UPN or object ID first; then e-mail address, because B2B guests have a UPN like name_contoso.com#EXT#@tenant.
function Find-EntraUser([string]$Id) {
  $user = Get-AzJson @('ad', 'user', 'show', '--id', $Id)
  if ($user -or $Id -notmatch '@') { return $user }
  $q = $Id.Replace("'", "''")
  $found = @(Get-AzJson @('ad', 'user', 'list', '--filter', "mail eq '$q' or otherMails/any(m:m eq '$q')"))
  $found = @($found | Where-Object { $_ })
  if ($found.Count -gt 1) { Fail "More than one user has the e-mail address $Id." 'Use the user principal name (UPN) or object ID shown in the Microsoft Entra admin center.' }
  if ($found.Count -eq 1) { return $found[0] }
  return $null
}
function Show-Command([string[]]$AzArgs) {
  return 'az ' + (($AzArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
}
# Runs a change (or prints it with -DryRun). Fails with the Azure CLI message and a next action.
function Invoke-AzChange([string]$Text, [string[]]$AzArgs, [string]$Action) {
  Step $Text
  Info (Show-Command $AzArgs)
  if ($DryRun) { Info '(dry run: not changed)'; return $null }
  $r = Invoke-Az ($AzArgs + @('-o', 'json'))
  if (-not $r.Ok) { Fail "$Text`n$($r.Err)" $Action }
  if ($r.Out.Trim()) { return ($r.Out | ConvertFrom-Json) }
  return $null
}
function Assert-AzCli([string]$Why) {
  if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    Fail "Azure CLI (az) was not found. $Why" 'Install it: winget install --exact --id Microsoft.AzureCLI (https://learn.microsoft.com/cli/azure/install-azure-cli-windows), open a new terminal, run az login, then run setup.ps1 again.'
  }
  $account = Get-AzJson @('account', 'show')
  if (-not $account) { Fail 'Azure CLI is not signed in.' 'Run az login (add --tenant <tenant id> for a specific directory), then run setup.ps1 again.' }
  if ($SubscriptionId -and $account.id -ne $SubscriptionId -and $account.name -ne $SubscriptionId) {
    $r = Invoke-Az @('account', 'set', '--subscription', $SubscriptionId)
    if (-not $r.Ok) { Fail "Subscription $SubscriptionId is not available to $($account.user.name)." 'Check the subscription ID with az account list -o table.' }
    $account = Get-AzJson @('account', 'show')
  }
  Info "Signed in as $($account.user.name)"
  Info "Tenant $($account.tenantId), subscription $($account.name) ($($account.id))"
  return $account
}
# Effective permission from ARM's permissions list (same rule as server/entra.ts permitted()).
function Test-Permitted($Perms, [string]$Action, [bool]$Data) {
  foreach ($p in $Perms) {
    $allow = if ($Data) { $p.dataActions } else { $p.actions }
    $deny = if ($Data) { $p.notDataActions } else { $p.notActions }
    $allowed = @($allow | Where-Object { $Action -like $_ }).Count -gt 0
    $denied = @($deny | Where-Object { $Action -like $_ }).Count -gt 0
    if ($allowed -and -not $denied) { return $true }
  }
  return $false
}
function Get-Permissions([string]$Scope) {
  $r = Get-AzJson @('rest', '--method', 'get', '--url', "https://management.azure.com$Scope/providers/Microsoft.Authorization/permissions?api-version=2022-04-01")
  if (-not $r) { return $null }
  return @($r.value)
}

# Data-plane roles on the Foundry resource (IDs match server/entra.ts; names as shown in the Azure portal).
$ChatAction = 'Microsoft.CognitiveServices/accounts/OpenAI/deployments/chat/completions/action'
$RoleTable = [ordered]@{
  Chat     = @{ Id = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'; Name = 'Cognitive Services OpenAI User'; Action = $ChatAction }
  Speech   = @{ Id = 'f2dc8367-1007-4938-bd23-fe263f013447'; Name = 'Cognitive Services Speech User'; Action = 'Microsoft.CognitiveServices/accounts/SpeechServices/unified-speech/frontend/action' }
  Vision   = @{ Id = 'a97b65f3-24c7-4388-baec-2e87135dc908'; Name = 'Cognitive Services User'; Action = 'Microsoft.CognitiveServices/accounts/ComputerVision/imageanalysis:analyze/action' }
  Decision = @{ Id = '53ca6127-db72-4b80-b1b0-d745d6d5456d'; Name = 'Foundry User (formerly Azure AI User)'; Action = 'Microsoft.CognitiveServices/accounts/MaaS/chat/completions/action' }
}

function Resolve-Account([bool]$Required) {
  if ($FoundryResourceId) {
    $a = Get-AzJson @('resource', 'show', '--ids', $FoundryResourceId)
  } elseif ($ResourceGroup -and $AccountName) {
    $a = Get-AzJson @('cognitiveservices', 'account', 'show', '-g', $ResourceGroup, '-n', $AccountName)
  } else {
    return $null
  }
  if (-not $a -and $Required) { Fail 'The Microsoft Foundry resource was not found or you cannot read it.' 'Check -FoundryResourceId (or -ResourceGroup and -AccountName) and the subscription (-SubscriptionId), or ask your Azure administrator.' }
  return $a
}

# ---------------------------------------------------------------- 2. Azure administrator
function Invoke-AzureAdmin {
  Step 'Azure administrator setup (Microsoft Foundry for BAS users)'
  if (-not $ResourceGroup -or -not $AccountName) { Fail '-ResourceGroup and -AccountName are required with -AzureAdmin, -AddUser and -RemoveUser.' 'Example: setup.ps1 -AzureAdmin -ResourceGroup rg-bas -Location japaneast -AccountName bas-contoso' }
  if ($AccountName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}[a-zA-Z0-9]$') { Fail "-AccountName '$AccountName' cannot be a custom subdomain." 'Use 3-64 letters, digits or hyphens (not at the start or end). It becomes https://<name>.openai.azure.com, so it must be unique in Azure.' }
  if ($DryRun) { Warn 'Dry run: nothing in Azure or Microsoft Entra ID is changed; the commands that would run are shown.' }
  $account = Assert-AzCli 'The administrator setup uses Azure CLI.'
  $onlyUsers = (-not $AzureAdmin)

  # Resource group
  $rg = Get-AzJson @('group', 'show', '-n', $ResourceGroup)
  if ($rg) { Step "Resource group $ResourceGroup exists ($($rg.location))" }
  elseif ($onlyUsers) { Fail "Resource group $ResourceGroup was not found." 'Run the administrator setup first: setup.ps1 -AzureAdmin -ResourceGroup ... -AccountName ...' }
  else {
    if (-not (Confirm-Change "Create resource group $ResourceGroup in $Location?")) { Fail 'Cancelled.' 'Run setup.ps1 again when ready.' }
    Invoke-AzChange "Creating resource group $ResourceGroup ($Location)" @('group', 'create', '-n', $ResourceGroup, '-l', $Location) 'You need Contributor (or Owner) on the subscription. Ask the subscription owner, or create the resource group and pass its name.' | Out-Null
  }

  # Microsoft Foundry resource (kind AIServices). Entra ID sign-in needs its custom subdomain.
  $acct = Get-AzJson @('cognitiveservices', 'account', 'show', '-g', $ResourceGroup, '-n', $AccountName)
  $resourceId = "/subscriptions/$($account.id)/resourceGroups/$ResourceGroup/providers/Microsoft.CognitiveServices/accounts/$AccountName"
  if ($acct) {
    $resourceId = $acct.id
    Step "Microsoft Foundry resource $AccountName exists (kind $($acct.kind), $($acct.location))"
    if ($acct.kind -ne 'AIServices') { Warn "Kind $($acct.kind): BAS lists only Microsoft Foundry resources (kind AIServices) for Entra ID sign-in." }
    if (-not $acct.properties.customSubDomainName) { Fail "$AccountName has no custom subdomain, so Microsoft Entra ID sign-in cannot use it." 'Use a Microsoft Foundry resource created with a custom subdomain (a new -AccountName creates one).' }
  } elseif ($onlyUsers) {
    Fail "Microsoft Foundry resource $AccountName was not found in $ResourceGroup." 'Run the administrator setup first: setup.ps1 -AzureAdmin -ResourceGroup ... -AccountName ...'
  } else {
    Info 'The resource itself has no fixed fee; model calls are billed per token to this subscription.'
    if (-not (Confirm-Change "Create Microsoft Foundry resource $AccountName (AIServices, S0, $Location)?")) { Fail 'Cancelled.' 'Run setup.ps1 again when ready.' }
    $acct = Invoke-AzChange "Creating Microsoft Foundry resource $AccountName" @('cognitiveservices', 'account', 'create', '-n', $AccountName, '-g', $ResourceGroup, '-l', $Location, '--kind', 'AIServices', '--sku', 'S0', '--custom-domain', $AccountName, '--yes') 'You need Contributor or Cognitive Services Contributor on the resource group. If the name is taken, choose another -AccountName.'
    if ($acct) { $resourceId = $acct.id }
  }
  $endpoint = "https://$AccountName.openai.azure.com/openai/v1"
  if ($acct -and $acct.properties.customSubDomainName) { $endpoint = "https://$($acct.properties.customSubDomainName).openai.azure.com/openai/v1" }

  if ($DisableKeys -and -not $onlyUsers) {
    if ($acct -and $acct.properties.disableLocalAuth -eq $true) { Step 'API keys are already disabled (Microsoft Entra ID only)' }
    else {
      Warn 'After this, the API key route of BAS stops working for this resource; every user signs in with Microsoft Entra ID.'
      if (Confirm-Change "Disable API keys on $AccountName?") {
        Invoke-AzChange 'Disabling API keys (disableLocalAuth=true)' @('resource', 'update', '--ids', $resourceId, '--set', 'properties.disableLocalAuth=true') 'You need Contributor or Cognitive Services Contributor on the resource.' | Out-Null
      }
    }
  }

  # Model deployment
  if (-not $onlyUsers) {
    $dep = Get-AzJson @('cognitiveservices', 'account', 'deployment', 'show', '-g', $ResourceGroup, '-n', $AccountName, '--deployment-name', $DeploymentName)
    if ($dep) { Step "Deployment $DeploymentName exists ($($dep.properties.model.name) $($dep.properties.model.version), $($dep.sku.name) capacity $($dep.sku.capacity))" }
    else {
      $quotaName = "OpenAI.$ModelSku.$ModelName"
      $usage = @(Get-AzJson @('cognitiveservices', 'usage', 'list', '-l', $Location)) | Where-Object { $_.name.value -eq $quotaName } | Select-Object -First 1
      $free = $null
      if ($usage) { $free = [int]($usage.limit - $usage.currentValue); Info "Quota $quotaName in ${Location}: $($usage.currentValue) used of $($usage.limit) (free $free)" }
      else { Warn "No quota named $quotaName in $Location. Check the model and region in the Foundry portal (Quota) or choose another -Location / -ModelSku." }
      $cap = $Capacity
      if ($cap -le 0) { if ($free -and $free -gt 0) { $cap = $free } else { $cap = 1 } }
      if ($null -ne $free -and $free -le 0) { Fail "No free quota is left for $quotaName in $Location (capacity is counted per subscription and region)." 'Lower the capacity of an existing deployment of this model, use another -Location or -ModelSku, or request more quota (https://aka.ms/oai/stuquotarequest).' }
      if ($null -ne $free -and $cap -gt $free) { Fail "Capacity $cap is more than the free quota ($free)." 'Pass a smaller -Capacity, free quota from another deployment, or request more quota (https://aka.ms/oai/stuquotarequest).' }
      if (-not (Confirm-Change "Deploy $ModelName $ModelVersion as '$DeploymentName' ($ModelSku, capacity $cap)?")) { Fail 'Cancelled.' 'Run setup.ps1 again when ready.' }
      Invoke-AzChange "Creating deployment $DeploymentName" @('cognitiveservices', 'account', 'deployment', 'create', '-g', $ResourceGroup, '-n', $AccountName, '--deployment-name', $DeploymentName, '--model-name', $ModelName, '--model-version', $ModelVersion, '--model-format', 'OpenAI', '--sku-name', $ModelSku, '--sku-capacity', "$cap") 'Check that the model version is offered in this region (Foundry portal > Models) and that you have Contributor or Cognitive Services Contributor.' | Out-Null
    }
  }

  # Microsoft Entra security group for BAS users
  $groups = @(Get-AzJson @('ad', 'group', 'list', '--display-name', $GroupName)) | Where-Object { $_ -and $_.displayName -eq $GroupName }
  $groupId = $null
  if ($groups.Count -gt 1) { Fail "More than one Microsoft Entra group is named '$GroupName'." 'Pass a unique -GroupName (rename one group in the Microsoft Entra admin center).' }
  if ($groups.Count -eq 1) { $groupId = $groups[0].id; Step "Microsoft Entra group '$GroupName' exists ($groupId)" }
  elseif ($onlyUsers) { Fail "Microsoft Entra group '$GroupName' was not found." 'Run the administrator setup first, or pass the -GroupName used then.' }
  else {
    if (-not (Confirm-Change "Create Microsoft Entra security group '$GroupName'?")) { Fail 'Cancelled.' 'Run setup.ps1 again when ready.' }
    $nick = ($GroupName -replace '[^A-Za-z0-9]', '').ToLowerInvariant()
    if (-not $nick) { $nick = 'basusers' }
    $g = Invoke-AzChange "Creating Microsoft Entra group '$GroupName'" @('ad', 'group', 'create', '--display-name', $GroupName, '--mail-nickname', $nick, '--description', "Users of Business Analytics Studio with Microsoft Foundry $AccountName") 'Your tenant may restrict group creation: ask a Groups Administrator to create the group, then pass its name with -GroupName.'
    if ($g) { $groupId = $g.id }
    if ($groupId) {
      $me = Get-AzJson @('ad', 'signed-in-user', 'show')
      if ($me) { Invoke-AzChange "Making $($me.userPrincipalName) an owner of the group (to add and remove members later)" @('ad', 'group', 'owner', 'add', '--group', $groupId, '--owner-object-id', $me.id) 'Add yourself as owner in the Microsoft Entra admin center.' | Out-Null }
    }
  }

  # Role assignments: the group, on this one resource only (not the resource group or subscription).
  if (-not $onlyUsers) {
    $wanted = @('Chat') + $ExtraRoles
    $existing = @()
    if (-not $DryRun -or $acct) { $existing = @(Get-AzJson @('role', 'assignment', 'list', '--scope', $resourceId)) }
    foreach ($key in $wanted) {
      $role = $RoleTable[$key]
      $has = $groupId -and @($existing | Where-Object { $_ -and $_.principalId -eq $groupId -and $_.roleDefinitionId -like "*/$($role.Id)" -and $_.scope -eq $resourceId }).Count -gt 0
      if ($has) { Step "Group already has '$($role.Name)' on $AccountName"; continue }
      $gid = if ($groupId) { $groupId } else { '<new group id>' }
      $azArgs = @('role', 'assignment', 'create', '--assignee-object-id', $gid, '--assignee-principal-type', 'Group', '--role', $role.Id, '--scope', $resourceId)
      if ($DryRun) { Invoke-AzChange "Assigning '$($role.Name)' to the group on $AccountName" $azArgs '' | Out-Null; continue }
      # A new group can take a short while to replicate; retry for about one minute.
      $done = $false
      for ($i = 0; $i -lt 6 -and -not $done; $i++) {
        $r = Invoke-Az ($azArgs + @('-o', 'json'))
        if ($r.Ok) { $done = $true; Step "Assigned '$($role.Name)' to the group on $AccountName" }
        elseif ($r.Err -match 'does not exist in the directory|PrincipalNotFound') { Start-Sleep -Seconds 10 }
        else { Fail "Assigning '$($role.Name)' failed.`n$($r.Err)" 'You need Owner, User Access Administrator or Role Based Access Control Administrator on the resource (or its resource group).' }
      }
      if (-not $done) { Fail "The new group is not visible to Azure RBAC yet." 'Wait a few minutes and run the same command again (completed steps are skipped).' }
    }
  }

  # Members
  foreach ($u in $AddUser) {
    $user = Find-EntraUser $u
    if (-not $user) { Fail "User $u was not found in this tenant." 'Use the user principal name (UPN) or object ID shown in the Microsoft Entra admin center. Guests must be invited first.' }
    $isMember = $false
    if ($groupId) { $c = Get-AzJson @('ad', 'group', 'member', 'check', '--group', $groupId, '--member-id', $user.id); $isMember = ($c -and $c.value -eq $true) }
    if ($isMember) { Step "$($user.userPrincipalName) is already a member"; continue }
    $gid = if ($groupId) { $groupId } else { '<new group id>' }
    Invoke-AzChange "Adding $($user.userPrincipalName) to '$GroupName'" @('ad', 'group', 'member', 'add', '--group', $gid, '--member-id', $user.id) 'You must be an owner of the group, or a Groups Administrator / User Administrator.' | Out-Null
  }
  foreach ($u in $RemoveUser) {
    $user = Find-EntraUser $u
    if (-not $user -or -not $groupId) { Warn "$u was not found (nothing to remove)."; continue }
    $c = Get-AzJson @('ad', 'group', 'member', 'check', '--group', $groupId, '--member-id', $user.id)
    if (-not ($c -and $c.value -eq $true)) { Step "$($user.userPrincipalName) is not a member (nothing to remove)"; continue }
    Invoke-AzChange "Removing $($user.userPrincipalName) from '$GroupName'" @('ad', 'group', 'member', 'remove', '--group', $groupId, '--member-id', $user.id) 'You must be an owner of the group, or a Groups Administrator / User Administrator.' | Out-Null
  }

  Write-Host ''
  if ($DryRun) { Write-Host 'Dry run finished. Nothing was changed.' -ForegroundColor Green }
  else { Write-Host 'Azure setup finished.' -ForegroundColor Green }
  Write-Host '  Tell BAS users:'
  Write-Host "    Tenant ID:            $($account.tenantId)"
  Write-Host "    Foundry resource:     $AccountName (resource group $ResourceGroup)"
  Write-Host "    Endpoint:             $endpoint"
  Write-Host "    Deployment:           $DeploymentName"
  Write-Host "    In BAS: AI settings > Microsoft Foundry > Microsoft Entra ID > Sign in with Microsoft, choose the tenant,"
  Write-Host "            $AccountName and $DeploymentName, then Test connection and save."
  Write-Host '  New members can call the model after their next sign-in: role changes take up to 10 minutes, and a group'
  Write-Host '  change reaches a signed-in user when the access token is renewed (sign out and in, or about 1 hour).'
  exit 0
}

if ($AzureAdmin -or $AddUser.Count -gt 0 -or $RemoveUser.Count -gt 0) { Invoke-AzureAdmin }

# ---------------------------------------------------------------- 1. PC setup: Node.js
function Get-NodeVersion {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try { return [version]((& node --version).TrimStart('v')) } catch { return $null }
}
function Install-LocalNode {
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  $platform = switch ($arch) { 'ARM64' { 'win-arm64' } 'AMD64' { 'win-x64' } default { $null } }
  if (-not $platform) { Fail "This PC ($arch) is not supported by the Node.js Windows builds." 'Use a 64-bit Windows PC (x64 or ARM64).' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # Authenticated corporate proxies: use the Windows sign-in.
  if ([Net.WebRequest]::DefaultWebProxy) { [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials }
  Step "Finding the latest Node.js LTS for $platform (https://nodejs.org/dist/index.json)"
  try { $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60 }
  catch { Fail "nodejs.org could not be reached: $($_.Exception.Message)" 'Check the proxy or firewall for https://nodejs.org, or install Node.js LTS with your company''s software catalog, then run setup.ps1 again.' }
  $release = $index | Where-Object { $_.lts -and ([version]$_.version.TrimStart('v')) -ge $MinNode -and ($_.files -contains "$platform-zip") } | Select-Object -First 1
  if (-not $release) { Fail 'No suitable Node.js LTS build was found.' 'Install Node.js LTS (22.18 or later) from https://nodejs.org/ and run setup.ps1 again.' }
  $v = $release.version
  $file = "node-$v-$platform.zip"
  $dist = "https://nodejs.org/dist/$v"
  Info "Node.js $v ($($release.lts) LTS) -> $LocalNode"
  if ($DryRun) { Info "(dry run: would download $dist/$file and verify it against $dist/SHASUMS256.txt)"; return }
  New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$dist/SHASUMS256.txt" -TimeoutSec 60).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($file))\s*$" } | Select-Object -First 1
  if (-not $line) { Fail "$file is not listed in $dist/SHASUMS256.txt." 'Run setup.ps1 again later, or install Node.js from https://nodejs.org/.' }
  $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
  $zip = Join-Path $RuntimeDir $file
  Step "Downloading $dist/$file"
  $prevProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -UseBasicParsing -Uri "$dist/$file" -OutFile $zip -TimeoutSec 900 } finally { $ProgressPreference = $prevProgress }
  $actual = Get-Sha256 $zip
  if ($actual -ne $expected) { Remove-Item -LiteralPath $zip -Force; Fail "$file does not match its SHA-256 in SHASUMS256.txt." 'The download was altered or incomplete (often a proxy). Run setup.ps1 again, or install Node.js from https://nodejs.org/.' }
  Info "SHA-256 verified ($expected)"
  $staging = Join-Path $RuntimeDir "node-$v-$platform"
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  # tar.exe (bsdtar, Windows 10 1803+) is much faster than Expand-Archive for the ~2 000 files of a Node.js zip.
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path -LiteralPath $tar) {
    & $tar -xf $zip -C $RuntimeDir
    if ($LASTEXITCODE -ne 0) { Fail "Extracting $file failed." "Delete $RuntimeDir and run setup.ps1 -InstallNode again." }
  } else {
    Expand-Archive -LiteralPath $zip -DestinationPath $RuntimeDir -Force
  }
  if (Test-Path -LiteralPath $LocalNode) { Remove-Item -LiteralPath $LocalNode -Recurse -Force }
  Move-Item -LiteralPath $staging -Destination $LocalNode
  Remove-Item -LiteralPath $zip -Force
  Set-Content -LiteralPath (Join-Path $LocalNode '.bas-node.json') -Encoding ascii -Value (@{ version = $v; sha256 = $expected; source = "$dist/$file" } | ConvertTo-Json)
}

# A Node.js installed by this script (.bas-runtime\node) wins over the PC's; run.cmd and start.ps1 do the same.
if (Test-Path -LiteralPath (Join-Path $LocalNode 'node.exe')) { $env:Path = "$LocalNode;$env:Path" }

Step 'Checking Node.js and npm'
$ver = Get-NodeVersion
if (-not $ver -or $ver -lt $MinNode) {
  if ($ver) { Warn "Node.js $ver is older than $MinNode." } else { Warn 'Node.js was not found.' }
  Info "setup.ps1 can install Node.js LTS into this folder only ($LocalNode): no admin rights, PATH and other apps unchanged."
  if (-not $InstallNode) {
    if ((Test-Interactive) -and -not $DryRun) {
      $InstallNode = Confirm-Change 'Download Node.js LTS from nodejs.org into this folder?'
    }
    if (-not $InstallNode -and -not $DryRun) { Fail 'Node.js 22.18 or later is required.' 'Run setup.ps1 -InstallNode (installs into this folder), or install Node.js LTS for your user from https://nodejs.org/ and open a new terminal.' }
  }
  Install-LocalNode
  if (-not $DryRun) {
    $env:Path = "$LocalNode;$env:Path"
    $ver = Get-NodeVersion
    if (-not $ver) { Fail 'The installed Node.js does not start.' "Delete $RuntimeDir and run setup.ps1 -InstallNode again." }
  }
}
if (-not $DryRun -and -not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found.' 'Reinstall Node.js (npm is included) or run setup.ps1 -InstallNode, then run setup.ps1 again.' }
if ($ver) { Info "Node.js $ver ($((Get-Command node).Source))" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Warn 'Note: administrator rights are not needed. Setup only writes inside this folder.'
}

# ---------------------------------------------------------------- 1. PC setup: dependencies and build
if (-not (Test-Path -LiteralPath 'package-lock.json')) { Fail 'package-lock.json is missing.' 'Restore the template folder completely (package-lock.json pins every dependency).' }
$lockHash = Get-Sha256 'package-lock.json'
$marker = 'node_modules/.bas-setup.json'
$upToDate = $false
if ((Test-Path -LiteralPath $marker) -and -not $Force) {
  try { $upToDate = ((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).lockHash -eq $lockHash) } catch { $upToDate = $false }
}

if ($upToDate) {
  Step 'Dependencies are already installed for this package-lock.json (skipping npm ci; use -Force to reinstall)'
} else {
  # npm ci deletes node_modules first; a running BAS (run.cmd / npm run dev) locks native files there and
  # npm ci then stops halfway and leaves node_modules broken. Refuse before touching anything.
  $modules = (Join-Path $PSScriptRoot 'node_modules').ToLowerInvariant()
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($modules) })
  if ($running.Count -gt 0 -and -not $DryRun) {
    $ids = ($running | ForEach-Object { $_.ProcessId }) -join ', '
    Fail "BAS is still running from this folder (node.exe process id $ids); npm ci cannot replace node_modules while it runs." "Stop it with Ctrl+C in the run.cmd window (then Y), or Stop-Process -Id <id>, and run setup.ps1 again."
  }
  # Local install only (no -g). npm ci contacts only the configured npm registry.
  Invoke-Step 'Installing the locked dependencies (npm ci)' { npm ci --no-audit --no-fund }
  if (-not $DryRun) { @{ lockHash = $lockHash; node = "$ver"; at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8 }
}

if (-not $SkipBuild) {
  Invoke-Step 'Building the app (npm run build -> dist/)' { npm run build }
}
Invoke-Step 'Checking the customer-pack schema (docs/pack.schema.json)' { node scripts/bas.ts schema --check }

# ---------------------------------------------------------------- 1. PC setup: AI service
if ($Ai -eq 'Ask') {
  if ((Test-Interactive) -and -not $DryRun) {
    Write-Host ''
    Write-Host 'Which generative AI will you use with BAS? (you can change it later in AI settings)'
    Write-Host '  1  None for now (built-in sample and mock answers only)'
    Write-Host '  2  GitHub Copilot (needs a GitHub account with a Copilot licence)'
    Write-Host '  3  Microsoft Foundry (needs an Azure subscription; your administrator gives access)'
    Write-Host '  4  Both'
    $pick = Read-Host '  Choose 1-4 [1]'
    $Ai = switch ($pick) { '2' { 'Copilot' } '3' { 'Foundry' } '4' { 'Both' } default { 'None' } }
  } else { $Ai = 'None' }
}
$useCopilot = ($Ai -eq 'Copilot' -or $Ai -eq 'Both')
$useFoundry = ($Ai -eq 'Foundry' -or $Ai -eq 'Both')

if ($useCopilot) {
  Step 'Checking GitHub Copilot (sign-in and models; no prompt is sent)'
  if ($DryRun) { Info '(dry run: would run node scripts/bas.ts copilot check)' }
  else {
    node scripts/bas.ts copilot check
    if ($LASTEXITCODE -ne 0 -and (Test-Interactive)) {
      if (Confirm-Change 'Sign in to GitHub now with the Copilot CLI (npx -y @github/copilot login)?') {
        npx -y @github/copilot login
        node scripts/bas.ts copilot check
      }
    }
    if ($LASTEXITCODE -ne 0) { Fail 'GitHub Copilot is not ready.' 'Follow the next action shown above, then run: node scripts/bas.ts copilot check' }
  }
}

if ($useFoundry) {
  Step 'Microsoft Foundry'
  $azAvailable = [bool](Get-Command az -ErrorAction SilentlyContinue)
  if (-not ($FoundryResourceId -or ($ResourceGroup -and $AccountName))) {
    Info 'BAS signs you in to Microsoft Entra ID itself and lists the Foundry resources you may use; Azure CLI is not needed.'
    Info 'To check your access now, run setup.ps1 -Ai Foundry -ResourceGroup <rg> -AccountName <name> (needs Azure CLI and az login).'
  } elseif (-not $azAvailable) {
    Warn 'Azure CLI is not installed, so your access cannot be checked here. BAS checks it in AI settings instead.'
  } elseif ($DryRun) {
    Info '(dry run: would read your permissions on the Foundry resource)'
  } else {
    $null = Assert-AzCli 'The access check uses Azure CLI.'
    $acct = Resolve-Account $true
    $perms = Get-Permissions $acct.id
    if ($null -eq $perms) { Fail 'Your permissions on the resource could not be read.' 'Ask your Azure administrator to add you to the BAS users group (users-guide/09-admin-setup.md).' }
    $deps = @(Get-AzJson @('cognitiveservices', 'account', 'deployment', 'list', '-g', $acct.resourceGroup, '-n', $acct.name))
    $chatDeps = @($deps | Where-Object { $_ -and $_.properties.provisioningState -eq 'Succeeded' })
    Info "Resource:   $($acct.name) ($($acct.location)), keys $(if ($acct.properties.disableLocalAuth) { 'disabled (Entra ID only)' } else { 'enabled' })"
    Info "Endpoint:   https://$($acct.properties.customSubDomainName).openai.azure.com/openai/v1"
    Info "Deployments: $(($chatDeps | ForEach-Object { $_.name }) -join ', ')"
    $ok = $true
    foreach ($key in $RoleTable.Keys) {
      $role = $RoleTable[$key]
      $can = Test-Permitted $perms $role.Action $true
      if ($key -eq 'Chat' -and -not $can) { $ok = $false }
      $mark = if ($can) { 'OK ' } else { '-- ' }
      Info "$mark $key ($($role.Name))"
    }
    if (-not $acct.properties.customSubDomainName) { Fail 'The resource has no custom subdomain, so Microsoft Entra ID sign-in cannot use it.' 'Ask your administrator for a Foundry resource with a custom subdomain.' }
    if (-not $ok) { Fail "You may not call models on $($acct.name) yet." 'Ask your Azure administrator to add you to the BAS users group (setup.ps1 -AddUser <you>), wait up to 10 minutes, run az logout / az login, and check again.' }
    if (-not ($chatDeps | Where-Object { $_.name -eq $DeploymentName })) { Warn "Deployment $DeploymentName was not found; choose another deployment in BAS or ask the administrator." }
    Info 'Next (in BAS): AI settings > Microsoft Foundry > Microsoft Entra ID > Sign in with Microsoft > choose this resource and deployment > Test connection and save.'
  }
}

if ($WorkIq) {
  Invoke-Step 'Checking the Microsoft Work IQ CLI (optional; no search, no EULA acceptance)' { node scripts/bas.ts workiq check }
}

Write-Host ''
Write-Host 'Setup finished.' -ForegroundColor Green
Write-Host "  AI service chosen: $Ai"
Write-Host '  Start the app (with AI and Work IQ):  .\run.cmd          (stop: Ctrl+C in that window, then Y)'
Write-Host '  Start without AI (static server):     .\start.ps1'
Write-Host '  Prepare a customer:                   node scripts/bas.ts build "Customer name"'
Write-Host '  Start a customer:                     .\start.ps1 -Customer "Customer name"'
if (-not $useCopilot) { Write-Host '  GitHub Copilot later:                 node scripts/bas.ts copilot check' }
if (-not $WorkIq) {
  Write-Host '  Work IQ (optional, Microsoft Foundry only): npm run workiq:check   (see users-guide/07-real-data-pack.md)'
}
exit 0
