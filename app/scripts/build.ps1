# Builds the base installer of Mango Code (app, agent, resources: no engines or NVIDIA libraries,
# they are downloaded at first run): prepares the staging, then cargo tauri build.
# -Opencode <exe>: alternative path of mango-code.exe (passed as --opencode).
param([string]$Opencode)
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

Push-Location "$app\src-tauri"
try {
    cargo tauri build
    if ($LASTEXITCODE) { throw "cargo tauri build failed" }
} finally { Pop-Location }

Get-ChildItem "$app\target\release\bundle\nsis\*.exe" | ForEach-Object {
    "{0}  {1:N1} MiB" -f $_.FullName, ($_.Length / 1MB)
}
