# Builds the base installer of Mango Code (app, agent, resources: no engines or NVIDIA libraries,
# they are downloaded at first run): prepares the staging, builds with cargo tauri build, signs.
# -Opencode <exe>: alternative path of mango-code.exe (passed as --opencode).
# -Version <x.y.z>: the version of this build instead of tauri.conf.json's (a test of the automatic update).
# -InsecureUpdates: the app also accepts an http update address on this PC (MANGO_UPDATE_URL): only for testing an
#   update before publishing it, never for a release.
# -Phase Build|Sign|All (default All): Build prepares the staging and builds the installer and never reads the signing
#   key; Sign only writes the installer's .sig. The release workflow runs them as two steps so that the key is in the
#   environment of the second one alone, not of the compilers and package scripts of the first.
#
# Automatic updates: the installer is signed with the key in TAURI_SIGNING_PRIVATE_KEY and
# TAURI_SIGNING_PRIVATE_KEY_PASSWORD (the release workflow's secrets) or, when they are not set, in
# %USERPROFILE%\.tauri\mango-code.key (password in mango-code.password next to it; the maintainer's, never in the
# repo). The .sig is what update-manifest.mjs puts into latest.json. Without the key (phase All) the installer is
# built anyway, without the signature: whoever installs it gets no updates from the official releases.
param([string]$Opencode, [string]$Version, [switch]$InsecureUpdates, [ValidateSet("All", "Build", "Sign")][string]$Phase = "All")
$ErrorActionPreference = "Stop"
$app = Split-Path $PSScriptRoot -Parent
$nsis = "$app\target\release\bundle\nsis"

if ($Phase -ne "Sign") {
    # mango-tune.exe goes in the installer next to the optimize skill, mango-launch.exe at the top of the resources
    # (prepare-installer.mjs copies them).
    Push-Location $app
    try {
        cargo build --release --locked -p engine --bin mango-tune --bin mango-launch
        if ($LASTEXITCODE) { throw "mango-tune and mango-launch build failed" }
    } finally { Pop-Location }

    $nodeArgs = @("$PSScriptRoot\prepare-installer.mjs")
    if ($Opencode) { $nodeArgs += @("--opencode", $Opencode) }
    node @nodeArgs
    if ($LASTEXITCODE) { throw "staging preparation failed" }

    # The build never signs: the .sig comes from the Sign phase, with the key in the environment of that command alone.
    $config = @{ bundle = @{ createUpdaterArtifacts = $false } }
    if ($Version) { $config.version = $Version }
    if ($InsecureUpdates) { $config.plugins = @{ updater = @{ dangerousInsecureTransportProtocol = $true } } }

    Push-Location "$app\src-tauri"
    try {
        # Tauri merges --config into tauri.conf.json (a file: a JSON on the PowerShell command line loses its quotes)
        $merge = Join-Path ([IO.Path]::GetTempPath()) "mango-tauri-config.json"
        $config | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $merge
        cargo tauri build --config $merge -- --locked
        if ($LASTEXITCODE) { throw "cargo tauri build failed" }
    } finally { Pop-Location }
}

if ($Phase -ne "Build") {
    $installers = @(Get-ChildItem "$nsis\*-setup.exe")
    if ($installers.Count -ne 1) { throw "one installer expected in $nsis, found $($installers.Count)" }
    # A stale .sig of an earlier build is never taken for the signature of this installer.
    Remove-Item "$($installers[0].FullName).sig" -ErrorAction SilentlyContinue

    $keyFile = Join-Path $env:USERPROFILE ".tauri\mango-code.key"
    $signArgs = @()
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and (Test-Path $keyFile)) {
        $signArgs = @("--private-key-path", $keyFile)
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content -Raw (Join-Path $env:USERPROFILE ".tauri\mango-code.password")).Trim()
    }
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $signArgs) {
        if ($Phase -eq "Sign") { throw "no signing key (TAURI_SIGNING_PRIVATE_KEY or $keyFile)" }
        Write-Warning "no signing key ($keyFile): installer without update signature"
    } else {
        try {
            cargo tauri signer sign @signArgs $installers[0].FullName
            if ($LASTEXITCODE) { throw "cargo tauri signer sign failed" }
        } finally {
            if ($signArgs) { Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue }
        }
    }
}

Get-ChildItem "$nsis\*.exe", "$nsis\*.sig" | ForEach-Object {
    "{0}  {1:N1} MiB" -f $_.FullName, ($_.Length / 1MB)
}
