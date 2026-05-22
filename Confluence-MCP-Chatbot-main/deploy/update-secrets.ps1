# =============================================================================
# Update secrets in a running teams-bot Container App
# Run this after you get your Azure Bot App ID + Password
#
# Usage:
#   .\deploy\update-secrets.ps1 -MsAppId "your-id" -MsAppPassword "your-pass"
# =============================================================================

param(
    [Parameter(Mandatory)][string]$MsAppId,
    [Parameter(Mandatory)][string]$MsAppPassword,
    [string]$ResourceGroup = "atlassian-bot-rg"
)

Write-Host "Updating Azure Bot credentials in teams-bot container..." -ForegroundColor Cyan

az containerapp secret set `
    --name teams-bot `
    --resource-group $ResourceGroup `
    --secrets "ms-app-password=$MsAppPassword"

az containerapp update `
    --name teams-bot `
    --resource-group $ResourceGroup `
    --set-env-vars `
        "MICROSOFT_APP_ID=$MsAppId" `
        "MICROSOFT_APP_PASSWORD=secretref:ms-app-password"

Write-Host "Done. The container will restart with the new credentials." -ForegroundColor Green
