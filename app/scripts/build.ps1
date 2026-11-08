# Builds the base installer of Mango Code (app, agent, resources: no engines or NVIDIA libraries,
# they are downloaded at first run): prepares the staging, then cargo tauri build.
# -Opencode <exe>: alternative path of mango-code.exe (passed as --opencode).
# -Version <x.y.z>: the version of this build instead of tauri.conf.json's (a test of the automatic update).
# -InsecureUpdates: the app also accepts an http update address on this PC (MANGO_UPDATE_URL): only for testing an
#   update before publishing it, never for a release.
#
# Automatic updates: the installer is signed with the key in TAURI_SIGNING_PRIVATE_KEY and
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD (the release workflow's secrets) or, when they are not set, in
# %USERPROFILE%\.tauri\mango-code.key (password in mango-code.password next to it; the maintainer's, never in the
# repo). The build also writes the installer's .sig, which
# update-manifest.mjs puts into latest.json. Without the key the installer is built anyway, without the signature:
# whoever installs it gets no updates from the official releases.
param([string]$Opencode, [string]$Version, [switch]$InsecureUpdates)
$ErrorActionPreference = "Stop"
$app = Split-Path $PSScriptRoot -Parent

# mango-tune.exe goes in the installer next to the optimize skill (prepare-installer.mjs copies it).
Push-Location $app
try {
    cargo build --release -p engine --bin mango-tune
    if ($LASTEXITCODE) { throw "mango-tune build failed" }
} finally { Pop-Location }

$nodeArgs = @("$PSScriptRoot\prepare-installer.mjs")
if ($Opencode) { $nodeArgs += @("--opencode", $Opencode) }
node @nodeArgs
if ($LASTEXITCODE) { throw "staging preparation failed" }

$config = @{}
$key = Join-Path $env:USERPROFILE ".tauri\mango-code.key"
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path $key)) {
    $env:TAURI_SIGNING_PRIVATE_KEY = $key
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw (Join-Path $env:USERPROFILE ".tauri\mango-code.password")).Trim()
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    Write-Warning "no signing key ($key): installer without update signature"
    $config.bundle = @{ createUpdaterArtifacts = $false }
}
if ($Version) { $config.version = $Version }
if ($InsecureUpdates) { $config.plugins = @{ updater = @{ dangerousInsecureTransportProtocol = $true } } }

Push-Location "$app\src-tauri"
try {
    # Tauri merges --config into tauri.conf.json (a file: a JSON on the PowerShell command line loses its quotes)
    if ($config.Count) {
        $merge = Join-Path ([IO.Path]::GetTempPath()) "mango-tauri-config.json"
        $config | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $merge
        cargo tauri build --config $merge
    } else {
        cargo tauri build
    }
    if ($LASTEXITCODE) { throw "cargo tauri build failed" }
} finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

Get-ChildItem "$app\target\release\bundle\nsis\*.exe", "$app\target\release\bundle\nsis\*.sig" | ForEach-Object {
    "{0}  {1:N1} MiB" -f $_.FullName, ($_.Length / 1MB)
}
