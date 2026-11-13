# Builds the agent from the repo's sources (packages/opencode, at the root): the web interface embedded, the Bun
# runtime included. One binary, <opencode>\web\mango-code.exe, which the app and the installer use. By default
# <opencode> is launcher\opencode (ignored by git), or the "opencode" folder that launcher\mango-paths.json names.
# It needs the Bun that package.json names (packageManager) or a later one, and takes 5-15 minutes. It leaves bun.lock as it was.
#
#   .\build-agent.ps1                    # default place
#   .\build-agent.ps1 -Opencode D:\agent # somewhere else
param([string]$Opencode)
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$paths = "$repo\launcher\mango-paths.json"
if (-not $Opencode -and (Test-Path $paths)) { $Opencode = (Get-Content $paths -Raw | ConvertFrom-Json).opencode }
if (-not $Opencode) { $Opencode = "$repo\launcher\opencode" }
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw "bun is missing: without it there is no agent" }
$wanted = (Get-Content "$repo\package.json" -Raw | ConvertFrom-Json).packageManager -replace "^bun@", ""
$have = (bun --version).Trim()
if ([version]$have -lt [version]$wanted) { throw "bun $wanted or later is needed (package.json, packageManager) and the one in PATH is ${have}: put a newer one first in PATH" }

# HUSKY=0: opencode's `prepare` script would install a git hook that runs the typecheck on every push.
$env:HUSKY = "0"
$env:OPENCODE_VERSION = "1.19.5-mango"
$env:OPENCODE_CHANNEL = "latest"
Push-Location $repo
try {
    bun install --frozen-lockfile
    if ($LASTEXITCODE) { throw "bun install failed" }
    Push-Location packages\opencode
    try {
        # --skip-install: the build's own `bun install` is for the other platforms (musl, macOS, Linux) and rewrites bun.lock
        bun run script/build.ts --single --skip-install
        if ($LASTEXITCODE) { throw "the agent's build failed" }
    } finally { Pop-Location }
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path "$Opencode\web" | Out-Null
Copy-Item "$repo\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" "$Opencode\web\mango-code.exe" -Force
Write-Host "$Opencode\web\mango-code.exe"
