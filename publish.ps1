# Quick Publish Script
# Run this to publish to both marketplaces

# Load tokens
$tokens = Get-Content -Path ".tokens" -Raw
$vsceToken = ($tokens | Select-String -Pattern 'VSCE_TOKEN=(.+)' | ForEach-Object { $_.Matches.Groups[1].Value }).Trim()
$ovsxToken = ($tokens | Select-String -Pattern 'OVSX_TOKEN=(.+)' | ForEach-Object { $_.Matches.Groups[1].Value }).Trim()

Write-Host "📦 Publishing Skylit.DEV I/O Extension..." -ForegroundColor Cyan
Write-Host ""

# Publish to VS Code Marketplace
Write-Host "🔵 Publishing to VS Code Marketplace..." -ForegroundColor Blue
npx vsce publish -p $vsceToken

Write-Host ""
Write-Host "✅ VS Code Marketplace - Done!" -ForegroundColor Green
Write-Host ""

# Publish to Open VSX
Write-Host "🟢 Publishing to Open VSX Registry..." -ForegroundColor Blue
npx ovsx publish -p $ovsxToken

Write-Host ""
Write-Host "✅ Open VSX Registry - Done!" -ForegroundColor Green
Write-Host ""
Write-Host "🎉 Published to both marketplaces successfully!" -ForegroundColor Cyan
