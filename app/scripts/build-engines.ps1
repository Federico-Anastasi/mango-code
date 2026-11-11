# Builds one of our two llama.cpp forks from source, for whoever works on the forks (the app downloads the built ones
# from the fork's release, as launcher\mango-engines.json says; this is for trying a change, or a new engine).
#
#   .\build-engines.ps1 prism    # PrismML's fork (3.6, 3.8, Bonsai 2, LFM): 15-30 minutes
#   .\build-engines.ps1 toq      # ik_llama.cpp with trellis weights (TOQ): 30-90 minutes
#   .\build-engines.ps1 prism -Llama D:\ai\llama-cpp
#
# The fork's source is cloned at the tag whose release mango-engines.json downloads, and built with the fork's own
# mango-ci\build.ps1 (the one its GitHub Actions run) for the CUDA architectures of the GPUs in this PC, into
# <llama>\prism or <llama>\toq. <llama> is the "llama" folder of launcher\mango-paths.json, or "llama-cpp" next to the
# repo. Needs git, CMake, Ninja, CUDA's nvcc 12.x and, for toq, clang-cl and the MSVC environment.
param(
    [Parameter(Mandatory)][ValidateSet("prism", "toq")][string]$Engine,
    [string]$Llama
)
$ErrorActionPreference = "Stop"
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$paths = "$repo\launcher\mango-paths.json"
if (-not $Llama -and (Test-Path $paths)) { $Llama = (Get-Content $paths -Raw | ConvertFrom-Json).llama }
if (-not $Llama) { $Llama = Join-Path (Split-Path $repo -Parent) "llama-cpp" }
$version = (Get-Content "$repo\launcher\mango-engines.json" -Raw | ConvertFrom-Json).$Engine.version
$tag = "$Engine-$version"
$out = "$Llama\$Engine"

foreach ($c in @("cmake", "nvcc", "git", "ninja")) {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "$c is missing: the $Engine engine cannot be built without it" }
}

# The CUDA architectures of the GPUs present (e.g. 61;75;86), not a generic list: less device code means less VRAM
# taken by the modules. TU116 (GTX 16xx, no tensor cores) is recognized by name.
$gpus = & nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader 2>$null
if (-not $gpus) { throw "nvidia-smi does not answer: there is no GPU to build for" }
$archs = @(); $tu116 = $false
foreach ($g in $gpus) {
    $name, $cc = $g -split ",\s*"
    $archs += ($cc -replace "\.", "")
    if ($name -match "GTX 16\d\d") { $tu116 = $true }
}
$archs = @($archs | Sort-Object -Unique)

# The fork's source at the tag, cloned once and moved to the tag on later runs.
$src = Join-Path (Split-Path $repo -Parent) "temp\mango-$Engine"
if (-not (Test-Path "$src\.git")) {
    New-Item -ItemType Directory -Force -Path (Split-Path $src) | Out-Null
    git clone -q -c core.autocrlf=false -c advice.detachedHead=false --depth 1 --branch $tag "https://github.com/Federico-Anastasi/mango-$Engine.git" $src
    if ($LASTEXITCODE) { throw "clone of mango-$Engine failed" }
} else {
    git -C $src fetch -q --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
    if ($LASTEXITCODE) { throw "fetch of mango-$Engine $tag failed" }
    git -C $src checkout -q -f $tag
    git -C $src clean -q -fd -e build
}

# The two forks take the architectures differently: prism as plain numbers (and the TU116 switch), toq as "<arch>-real".
if ($Engine -eq "prism") {
    & "$src\mango-ci\build.ps1" -Variant cuda-12 -Out $out -Archs ($archs -join ";") -Tu116:$tu116 -Jobs 8 | Out-Null
} else {
    & "$src\mango-ci\build.ps1" -Variant cuda-12 -Out $out -Archs (($archs | ForEach-Object { "$_-real" }) -join ";") -Jobs 8 | Out-Null
}

# The CUDA runtime from the toolkit used for the build goes next to llama-server.exe: the engine finds it there even
# if the toolkit is not in the PATH.
$bin = if ($env:CUDA_PATH) { Join-Path $env:CUDA_PATH "bin" } else { Split-Path (Get-Command nvcc).Source }
foreach ($f in @("cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll")) {
    if (-not (Test-Path "$bin\$f")) { throw "$bin\$f is missing: the engine will not find the CUDA runtime" }
    Copy-Item "$bin\$f" $out -Force
}
Write-Host "$out\llama-server.exe"
