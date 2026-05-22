# =============================================================================
# Packages teams-app/ into a zip ready for Teams Admin Center upload
#
# Usage:
#   .\deploy\package-teams-app.ps1 -AppId "your-azure-bot-app-id"
# =============================================================================

param(
    [Parameter(Mandatory)][string]$AppId,
    [string]$OutDir = "."
)

$RepoRoot  = Split-Path $PSScriptRoot -Parent
$AppDir    = Join-Path $RepoRoot "teams-app"
$Manifest  = Join-Path $AppDir "manifest.json"
$ZipPath   = Join-Path $OutDir "atlassian-teams-bot.zip"

# Patch App ID into manifest
$json = Get-Content $Manifest -Raw
$json = $json -replace "00000000-0000-0000-0000-000000000000", $AppId
Set-Content $Manifest $json -Encoding utf8

Write-Host "Patched manifest.json with App ID: $AppId" -ForegroundColor Cyan

# Validate icons exist
foreach ($icon in @("color.png", "outline.png")) {
    $iconPath = Join-Path $AppDir $icon
    if (-not (Test-Path $iconPath)) {
        Write-Warning "$icon not found in teams-app/. Add a 192x192 color.png and 32x32 outline.png before uploading."
    }
}

# Create zip
if (Test-Path $ZipPath) { Remove-Item $ZipPath }
$filesToZip = Get-ChildItem $AppDir -File | Where-Object { $_.Name -match "\.(json|png)$" }
Compress-Archive -Path $filesToZip.FullName -DestinationPath $ZipPath

Write-Host ""
Write-Host "Teams app package created: $ZipPath" -ForegroundColor Green
Write-Host ""
Write-Host "Upload steps:"
Write-Host "  1. Go to https://admin.teams.microsoft.com"
Write-Host "  2. Apps -> Manage apps -> Upload new app"
Write-Host "  3. Upload: $ZipPath"
Write-Host "  4. (Optional) Apps -> Setup policies -> Global -> add app to pin it for all users"
