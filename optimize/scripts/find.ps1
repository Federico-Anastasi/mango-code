# What is on this PC: where Mango Code lives, whether it is running, which engines and models it has, where `mango-tune.exe` is.
# Read-only. Usage: powershell -File find.ps1 [-Repo <Mango Code repo folder>]
param([string]$Repo = "")
$ErrorActionPreference = "Stop"

$dataDir = if ($env:MANGO_DATA) { $env:MANGO_DATA } else { Join-Path $env:LOCALAPPDATA "MangoCode" }
$app = Join-Path $env:LOCALAPPDATA "Mango Code"

$exe = @()
# the skill's own folder first: the installer puts mango-tune.exe next to it (resources\optimize)
$searchDirs = @((Split-Path $PSScriptRoot -Parent), (Join-Path $app "resources\optimize"), $app, (Join-Path $env:ProgramFiles "Mango Code"))
if ($Repo) { $searchDirs += @((Join-Path $Repo "app\target\release"), (Join-Path $Repo "app\target\debug")) }
foreach ($d in $searchDirs) { $f = Join-Path $d "mango-tune.exe"; if (Test-Path $f) { $exe += $f } }

# the distribution: MANGO_DIST, or the folder with mango-models.json
$dist = $null
$candidates = @($env:MANGO_DIST, (Join-Path $app "resources"), $app)
if ($Repo) { $candidates += (Join-Path $Repo "launcher") }
foreach ($c in $candidates) { if ($c -and (Test-Path (Join-Path $c "mango-models.json"))) { $dist = $c; break } }

$enginesDir = $null; $modelsDir = Join-Path $dataDir "models"
if ($dist) {
    $enginesDir = Join-Path $dist "engine"
    $pathsFile = Join-Path $dist "mango-paths.json"
    if (Test-Path $pathsFile) {
        $paths = Get-Content $pathsFile -Raw | ConvertFrom-Json
        if ($paths.llama) { $enginesDir = $paths.llama }
        if ($paths.models) { $modelsDir = $paths.models }
    }
}

$serviceFile = Join-Path $dataDir "service.json"
$running = $null
if (Test-Path $serviceFile) { $running = Get-Content $serviceFile -Raw | ConvertFrom-Json }

$servers = @()
if ($enginesDir -and (Test-Path $enginesDir)) {
    $servers = @(Get-ChildItem $enginesDir -Recurse -Filter llama-server.exe -Depth 3 | ForEach-Object { $_.DirectoryName })
}
$gguf = @()
if (Test-Path $modelsDir) {
    $gguf = @(Get-ChildItem $modelsDir -Recurse -Filter *.gguf -Depth 3 | ForEach-Object { [ordered]@{ file = $_.FullName; mib = [int]($_.Length / 1MB) } })
}
$profiles = @()
foreach ($d in @((Join-Path $dataDir "profiles"), $(if ($dist) { Join-Path $dist "profiles" }))) {
    if ($d -and (Test-Path $d)) { $profiles += Get-ChildItem $d -Filter *.json -Recurse | ForEach-Object { $_.FullName } }
}

[ordered]@{
    app_installed  = (Test-Path (Join-Path $app "mango-code.exe"))
    mango_tune     = $exe
    dist           = $dist
    data           = $dataDir
    engines        = $enginesDir
    engines_found  = $servers
    models         = $modelsDir
    models_gguf    = $gguf
    profiles       = $profiles
    tune_log       = (Join-Path $dataDir "optimize\log.jsonl")
    logs           = (Join-Path $dataDir "logs")
    running        = $running
} | ConvertTo-Json -Depth 4
