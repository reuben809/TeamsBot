# =============================================================================
# Atlassian Teams Bot — One-shot Azure deployment script (PowerShell)
#
# What this does:
#   1. Creates an Azure Container Registry
#   2. Builds and pushes both Docker images (mcp-atlassian + teams-bot)
#   3. Creates an Azure Container Apps environment
#   4. Deploys both containers (mcp-atlassian internal, teams-bot external HTTPS)
#   5. Prints the public HTTPS URL and next steps
#
# Prerequisites:
#   - Azure CLI installed:  winget install Microsoft.AzureCLI
#   - Docker Desktop running
#   - Run: az login
#
# Usage:
#   .\deploy\azure-deploy.ps1 -ResourceGroup "atlassian-bot-rg" -Location "eastus"
# =============================================================================

param(
    [string]$ResourceGroup  = "atlassian-bot-rg",
    [string]$Location       = "eastus",
    [string]$RegistryName   = "atlassianbotacr",   # must be globally unique, lowercase
    [string]$EnvName        = "atlassian-bot-env",
    [string]$AiApiKey       = $env:AI_API_KEY,
    [string]$AiEndpoint     = "https://models.inference.ai.azure.com",
    [string]$AiModel        = "gpt-4o-mini",
    [string]$EncryptionKey  = $env:ENCRYPTION_KEY,
    [string]$MsAppId        = $env:MICROSOFT_APP_ID,
    [string]$MsAppPassword  = $env:MICROSOFT_APP_PASSWORD
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

# Validate required secrets
if (-not $AiApiKey)      { throw "AI_API_KEY is required. Set it as env var or pass -AiApiKey." }
if (-not $EncryptionKey) { throw "ENCRYPTION_KEY is required. Generate with: -join ((1..32)|%{'{0:x}'-f(Get-Random 16)})" }

$RepoRoot = Split-Path $PSScriptRoot -Parent

# ---------------------------------------------------------------------------
# Step 1 — Resource group
# ---------------------------------------------------------------------------
Step "Creating resource group '$ResourceGroup' in $Location"
az group create --name $ResourceGroup --location $Location --output none
Ok "Resource group ready"

# ---------------------------------------------------------------------------
# Step 2 — Azure Container Registry
# ---------------------------------------------------------------------------
Step "Creating Container Registry '$RegistryName'"
az acr create `
    --resource-group $ResourceGroup `
    --name $RegistryName `
    --sku Basic `
    --admin-enabled true `
    --output none

$AcrLogin = az acr show --name $RegistryName --query loginServer -o tsv
$AcrUser  = az acr credential show --name $RegistryName --query username -o tsv
$AcrPass  = az acr credential show --name $RegistryName --query "passwords[0].value" -o tsv
Ok "Registry: $AcrLogin"

# ---------------------------------------------------------------------------
# Step 3 — Build and push images
# ---------------------------------------------------------------------------
Step "Logging Docker into ACR"
echo $AcrPass | docker login $AcrLogin --username $AcrUser --password-stdin

Step "Building and pushing mcp-atlassian image"
docker build -t "$AcrLogin/mcp-atlassian:latest" $RepoRoot
docker push "$AcrLogin/mcp-atlassian:latest"
Ok "mcp-atlassian pushed"

Step "Building and pushing teams-bot image"
docker build -t "$AcrLogin/teams-bot:latest" "$RepoRoot\teams-bot"
docker push "$AcrLogin/teams-bot:latest"
Ok "teams-bot pushed"

# ---------------------------------------------------------------------------
# Step 4 — Container Apps environment
# ---------------------------------------------------------------------------
Step "Creating Container Apps environment '$EnvName'"
az containerapp env create `
    --name $EnvName `
    --resource-group $ResourceGroup `
    --location $Location `
    --output none
Ok "Environment ready"

# ---------------------------------------------------------------------------
# Step 5 — Deploy mcp-atlassian (internal — not reachable from internet)
# ---------------------------------------------------------------------------
Step "Deploying mcp-atlassian (internal service)"
az containerapp create `
    --name mcp-atlassian `
    --resource-group $ResourceGroup `
    --environment $EnvName `
    --image "$AcrLogin/mcp-atlassian:latest" `
    --registry-server $AcrLogin `
    --registry-username $AcrUser `
    --registry-password $AcrPass `
    --target-port 3000 `
    --ingress internal `
    --min-replicas 1 `
    --max-replicas 3 `
    --env-vars `
        "FASTMCP_STATELESS_HTTP=true" `
        "MCP_TRANSPORT=streamable-http" `
        "HOST=0.0.0.0" `
        "PORT=3000" `
    --output none
Ok "mcp-atlassian deployed (internal)"

# ---------------------------------------------------------------------------
# Step 6 — Deploy teams-bot (external — public HTTPS)
# ---------------------------------------------------------------------------
Step "Deploying teams-bot (public HTTPS)"

# Build env-vars list
$EnvVars = @(
    "NODE_ENV=production",
    "PORT=3978",
    "MCP_SERVER_URL=http://mcp-atlassian:3000/mcp",
    "AI_ENDPOINT=$AiEndpoint",
    "AI_MODEL=$AiModel",
    "AI_API_KEY=secretref:ai-api-key",
    "ENCRYPTION_KEY=secretref:encryption-key"
)
if ($MsAppId)       { $EnvVars += "MICROSOFT_APP_ID=$MsAppId" }
if ($MsAppPassword) { $EnvVars += "MICROSOFT_APP_PASSWORD=secretref:ms-app-password" }

$Secrets = @(
    "ai-api-key=$AiApiKey",
    "encryption-key=$EncryptionKey"
)
if ($MsAppPassword) { $Secrets += "ms-app-password=$MsAppPassword" }

az containerapp create `
    --name teams-bot `
    --resource-group $ResourceGroup `
    --environment $EnvName `
    --image "$AcrLogin/teams-bot:latest" `
    --registry-server $AcrLogin `
    --registry-username $AcrUser `
    --registry-password $AcrPass `
    --target-port 3978 `
    --ingress external `
    --min-replicas 1 `
    --max-replicas 5 `
    --secrets ($Secrets -join " ") `
    --env-vars ($EnvVars -join " ") `
    --output none

$BotUrl = az containerapp show `
    --name teams-bot `
    --resource-group $ResourceGroup `
    --query "properties.configuration.ingress.fqdn" -o tsv

Ok "teams-bot deployed"

# ---------------------------------------------------------------------------
# Done — print next steps
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " DEPLOYMENT COMPLETE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " Bot public URL:       https://$BotUrl"
Write-Host " Messaging endpoint:   https://$BotUrl/api/messages"
Write-Host " Health check:         https://$BotUrl/health"
Write-Host ""
Write-Host "------------------------------------------------------------"
Write-Host " NEXT STEPS" -ForegroundColor Yellow
Write-Host "------------------------------------------------------------"
Write-Host ""
Write-Host " 1. Azure Bot registration"
Write-Host "    a. portal.azure.com -> Create resource -> Azure Bot"
Write-Host "    b. Messaging endpoint: https://$BotUrl/api/messages"
Write-Host "    c. Channels -> Microsoft Teams -> Enable"
Write-Host "    d. Copy App ID + App Password -> re-run this script with"
Write-Host "       -MsAppId and -MsAppPassword to update the container"
Write-Host ""
Write-Host " 2. Update teams-app/manifest.json"
Write-Host "    Replace 00000000-0000-0000-0000-000000000000 with your App ID"
Write-Host ""
Write-Host " 3. Publish to Teams Admin Center (org-wide)"
Write-Host "    admin.teams.microsoft.com -> Manage apps -> Upload new app"
Write-Host "    Upload: teams-app/manifest.json + color.png + outline.png (zipped)"
Write-Host ""
Write-Host " 4. (Optional) Auto-install for all users"
Write-Host "    Teams Admin -> Setup policies -> Global -> Add the app"
Write-Host "    -> Users find it pinned in their Teams sidebar automatically"
Write-Host ""
Write-Host "============================================================"
