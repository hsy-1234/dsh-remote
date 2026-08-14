<#
.SYNOPSIS
    One-command install of dsh-remote from GitHub into the local DSH web profile.

.DESCRIPTION
    Automates the whole install the README describes:
      clone (pinned tag) -> npm install -> build -> BOM check
      -> deploy to ~/.dsh/profiles/web/node_modules/dsh-remote
      -> install the @deepseek-ai/dsh-typert-protocol dependency
      -> register the two patch entries in cordis.patch.yml (idempotent)

    After the script finishes, restart `dsh web` once. The plugin then shows
    the satellite panel and /remote command permanently.

.PARAMETER Repo
    Git repository to install from. Defaults to the canonical GitHub repo.

.PARAMETER Tag
    Release tag to pin. Defaults to the latest v0.0.x tag (v0.0.7+).

.PARAMETER WorkDir
    Directory for the temporary clone. Defaults to $env:TEMP\dsh-remote-install.

.PARAMETER KeepClone
    Keep the clone directory after install (useful for debugging).

.PARAMETER SkipTest
    Skip `npm test` during build.

.EXAMPLE
    ./scripts/install.ps1
    ./scripts/install.ps1 -Tag v0.0.7
#>
[CmdletBinding()]
param(
    [string]$Repo = 'https://github.com/hsy-1234/dsh-remote.git',
    [string]$Tag = 'v0.0.7',
    [string]$WorkDir = '',
    [switch]$KeepClone,
    [switch]$SkipTest
)

$ErrorActionPreference = 'Stop'
function Step([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "    OK: $m" -ForegroundColor Green }
function Warn([string]$m) { Write-Host "    WARN: $m" -ForegroundColor Yellow }

# ── 0. locate the web profile ────────────────────────────────────────────
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome 'profiles/web'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path $profileDir)) { throw "web profile not found at $profileDir - is dsh web installed?" }

# ── 1. clone the pinned tag ──────────────────────────────────────────────
if (-not $WorkDir) { $WorkDir = Join-Path $env:TEMP 'dsh-remote-install' }
$cloneDir = Join-Path $WorkDir 'dsh-remote'
if (Test-Path $cloneDir) { Remove-Item $cloneDir -Recurse -Force }
Step "Cloning $Repo (tag $Tag)"
git clone --depth 1 --branch $Tag $Repo $cloneDir 2>$null
if ($LASTEXITCODE -ne 0) { throw "git clone failed - is the tag '$Tag' published? (see https://github.com/hsy-1234/dsh-remote/releases)" }

# ── 2. build (and test) ─────────────────────────────────────────────────
Push-Location $cloneDir
try {
    Step 'Installing dependencies'
    npm install --no-audit --no-fund 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

    Step 'Building (npm run build)'
    npm run build 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed - did the clone come with lib/ prebuilt? run again clean' }

    if (-not $SkipTest) {
        Step 'Running tests (npm test)'
        npm test 2>$null
        if ($LASTEXITCODE -ne 0) { Warn 'npm test failed - installing anyway (build artifacts exist)' }
    }

    # ── 3. BOM check (the v0.0.3/0.0.4 crash cause) ──────────────────────
    $pkgBytes = [System.IO.File]::ReadAllBytes((Join-Path $cloneDir 'package.json'))
    if ($pkgBytes.Length -ge 3 -and $pkgBytes[0] -eq 0xEF -and $pkgBytes[1] -eq 0xBB -and $pkgBytes[2] -eq 0xBF) {
        throw "package.json has a UTF-8 BOM - this version cannot load. Use tag v0.0.7+."
    }
    Ok 'package.json BOM check passed'
}
finally { Pop-Location }

# ── 4. deploy into the profile node_modules ──────────────────────────────
$dest = Join-Path $profileDir "node_modules/dsh-remote"
Step "Deploying to $dest"
New-Item -ItemType Directory -Force -Path (Join-Path $dest 'lib') | Out-Null
Copy-Item (Join-Path $cloneDir 'lib/*.js')  (Join-Path $dest 'lib/') -Force
Copy-Item (Join-Path $cloneDir 'lib/*.d.ts') (Join-Path $dest 'lib/') -Force
Copy-Item (Join-Path $cloneDir 'package.json') $dest -Force
Ok 'plugin files deployed'

# ── 5. dependency (typert-protocol) into the profile ─────────────────────
Step 'Installing @deepseek-ai/dsh-typert-protocol into the profile'
Push-Location $profileDir
try {
    npm install @deepseek-ai/dsh-typert-protocol@^0.1.0-rc.6 --legacy-peer-deps --no-audit --no-fund 2>$null
    if ($LASTEXITCODE -ne 0) { Warn 'npm install of the dependency failed - the service entry may not load' }
}
finally { Pop-Location }

# ── 6. register the two patch entries (idempotent) ───────────────────────
Step 'Registering plugin entries in cordis.patch.yml'
$existing = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { '[]' }
if ($existing -match 'id:\s*dsh-remote(-service)?\s*$' -or $existing -match 'name:\s*''?dsh-remote') {
    Ok 'cordis.patch.yml already registers dsh-remote - leaving it untouched'
} else {
    $backup = "$patchPath.bak-install"
    Copy-Item $patchPath $backup -Force
    $registration = @'

# dsh-remote plugin registration (added by install.ps1)
- insert:
    - id: dsh-remote
      name: 'dsh-remote'
    - id: dsh-remote-service
      name: 'dsh-remote/remote'
'@
    $merged = $existing.TrimEnd() + $registration
    [System.IO.File]::WriteAllText($patchPath, $merged, (New-Object System.Text.UTF8Encoding($false)))
    Ok "registered (backup at $backup)"
}

# ── 7. cleanup + summary ─────────────────────────────────────────────────
if (-not $KeepClone) { Remove-Item $WorkDir -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '===============================================================' -ForegroundColor Green
Write-Host '  dsh-remote installed. Restart dsh web to activate:' -ForegroundColor Green
Write-Host '      dsh web' -ForegroundColor White
Write-Host '  Then: /remote for status, satellite panel for the UI.' -ForegroundColor Green
Write-Host '===============================================================' -ForegroundColor Green
