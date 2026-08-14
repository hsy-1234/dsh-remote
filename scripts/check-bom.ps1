<#
.SYNOPSIS
    Fail when any tracked file carries a UTF-8 BOM.

.DESCRIPTION
    The v0.0.3/v0.0.4 releases shipped a package.json with a UTF-8 BOM which
    crashed dsh's JSON.parse on install. This check keeps every tracked file
    BOM-free. Run it in CI or as a pre-commit check:
        pwsh ./scripts/check-bom.ps1
#>
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bad = @()
Get-ChildItem $root -Recurse -File | Where-Object {
    $_.FullName -notmatch 'node_modules|\.git\\|\\lib\\' -and $_.Extension -in '.json', '.js', '.ts', '.yml', '.yaml', '.md', '.ps1'
} | ForEach-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        $bad += $_.FullName
    }
}
if ($bad.Count -gt 0) {
    Write-Host 'BOM found in:' -ForegroundColor Red
    $bad | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
Write-Host 'No BOM found - all clean.' -ForegroundColor Green
exit 0
