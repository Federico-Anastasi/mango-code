# setup.ps1 - from a freshly cloned repo to a working `mango-code`.
#
#   .\setup.ps1                      # everything: engines, models, npm, config, command
#   .\setup.ps1 -Only models -Model 3.8   # only one part (llama-prism|llama-toq|models|npm|config|command|opencode|launch)
#   .\setup.ps1 -Only llama-prism    # builds the PrismML fork with the mango patches (3.6, 3.8, bonsai2, lfm)
#   .\setup.ps1 -Only llama-toq      # builds ik_llama.cpp with the trellis patch (toq)
#   .\setup.ps1 -Llama D:\ai\llama-cpp -Models D:\ai\models    # somewhere other than the defaults
#
# WHY IT EXISTS: the repo contains neither the engine binaries (~1.2 GB) nor the GGUFs (~60 GB) -
# they simply do not belong in git. But "not versionable" does not mean "fend for yourself": here is the
# CODE that gets them, so the repo is truly self-consistent. Everything a new machine
# needs to know is in this file or in the JSON files it writes.
#
# IDEMPOTENT: what is already there (and is the right size) is not downloaded again.

param(
    [ValidateSet("all","llama-prism","llama-toq","models","npm","config","command","opencode","launch")]
    [string]$Only = "all",
    [string]$Model,                     # with -Only models: download only this one
    [string]$Llama,                     # where to put the engines (one folder per engine)
    [string]$Models,                    # where to put the GGUFs
    [string]$Opencode,                  # where to put the agent binary (by default launcher\opencode)
    [switch]$Force                      # download again even what is already there
)

$ErrorActionPreference = "Stop"
$SELF = $PSScriptRoot
# The terminal's language helper (T), shared with mango-code.ps1 and mango-engine.ps1.
. "$SELF\mango-catalog.ps1"
$CFG  = Get-Content "$SELF\mango-models.json" -Raw | ConvertFrom-Json

$e = [char]27
$o = "$e[38;5;208m"; $g = "$e[38;5;71m"; $y = "$e[38;5;223m"; $d = "$e[38;5;245m"; $r = "$e[0m"
# Set-Content -Encoding utf8 on PowerShell 5.1 writes the BOM, and a JSON with a BOM makes node's
# JSON.parse blow up (it reads mango-models.json and the like). We always write without it.
function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Step($s) { Write-Host "$o==>$r $s" }
function Ok($s)   { Write-Host ("  " + $g + "ok" + $r + " " + $s) }
function Warn($s) { Write-Host "  ! $s" -ForegroundColor Yellow }
function Info($s) { Write-Host "$d  $s$r" }

# --- where things go ---------------------------------------------------------------------
# The defaults are folders next to the repo (llama-cpp, models), derived from the REPO's location:
# if you clone elsewhere, the siblings follow. The agent lives inside the repo, in launcher\opencode.
$PARENT = Split-Path (Split-Path $SELF -Parent) -Parent
if (Test-Path "$SELF\mango-paths.json") {
    $P = Get-Content "$SELF\mango-paths.json" -Raw | ConvertFrom-Json
    if (-not $Llama  -and $P.llama)  { $Llama  = $P.llama }
    if (-not $Models -and $P.models) { $Models = $P.models }
    if (-not $Opencode -and $P.opencode) { $Opencode = $P.opencode }
}
if (-not $Llama)  { $Llama  = Join-Path $PARENT "llama-cpp" }
if (-not $Models) { $Models = Join-Path $PARENT "models" }
if (-not $Opencode) { $Opencode = Join-Path $SELF "opencode" }

# --- prerequisites ------------------------------------------------------------------------
function Test-Prereqs {
    Step (T "prerequisiti" "prerequisites")
    $miss = @()
    foreach ($c in @(
        @{n="node";   why=(T "MCP della ricerca web, del browser e dei documenti" "the web search, browser and documents MCPs")},
        @{n="npm";    why=(T "le dipendenze del launcher" "the launcher's dependencies")},
        @{n="curl";   why=(T "download di binari e modelli" "downloading binaries and models")}
    )) {
        if (Get-Command $c.n -ErrorAction SilentlyContinue) { Ok "$($c.n)" }
        else { $miss += $c; Warn (T "$($c.n) MANCA - serve per: $($c.why)" "$($c.n) MISSING - needed for: $($c.why)") }
    }
    if ($miss.Count) {
        Write-Host ""
        Warn (T "installa quanto sopra e rilancia. node: https://nodejs.org" "install the above and run again. node: https://nodejs.org")
        exit 1
    }
    # nvidia-smi is not required (llama.cpp also runs on CPU) but without a GPU the setup
    # downloads the CUDA build anyway: better to say so now than after 400 MB.
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $gpus = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) -join " | "
        Ok "GPU: $gpus"
    } else {
        Warn (T "nvidia-smi non trovato: senza GPU NVIDIA la build CUDA non serve a niente (e il modello sara' lentissimo)" "nvidia-smi not found: without an NVIDIA GPU the CUDA build is useless (and the model will be very slow)")
    }
}

# --- engines ------------------------------------------------------------------------------
# Each local model declares its engine in mango-models.json ("engine"). `prism` and `toq` are built
# from source, from our forks at a fixed tag: no downloaded binaries.
# The three CUDA runtimes (cudart, cuBLAS) are copied from the toolkit used for the build next to
# llama-server.exe: the engine finds them there even if the toolkit is not in the PATH.

# The CUDA archs of the GPUs present (e.g. 61;75;86), not a generic list: less device code =
# less VRAM taken by the modules. TU116 (GTX 16xx, no tensor cores) is recognized by name.
function Get-GpuArchs {
    $gpus = & nvidia-smi --query-gpu=name,compute_cap --format=csv,noheader 2>$null
    if (-not $gpus) { return $null }
    $archs = @(); $tu116 = $false
    foreach ($g in $gpus) {
        $n, $cc = $g -split ",\s*"
        $archs += ($cc -replace "\.", "")
        if ($n -match "GTX 16\d\d") { $tu116 = $true }
    }
    @{ archs = @($archs | Sort-Object -Unique); tu116 = $tu116 }
}

# The fork's source at `tag`, cloned once and moved to the tag on later runs (the tag changes when
# mango-models.json changes it). Returns $null if git fails.
function Get-ForkSource([string]$repo, [string]$tag, [string]$src) {
    if (-not (Test-Path "$src\.git")) {
        New-Item -ItemType Directory -Force -Path (Split-Path $src) | Out-Null
        git clone -q -c core.autocrlf=false -c advice.detachedHead=false --depth 1 --branch $tag "https://github.com/Federico-Anastasi/$repo.git" $src
        if ($LASTEXITCODE -ne 0) { Warn (T "clone di $repo fallito" "clone of $repo failed"); return $null }
        return $src
    }
    git -C $src fetch -q --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
    if ($LASTEXITCODE -ne 0) { Warn (T "fetch di $repo $tag fallito" "fetch of $repo $tag failed"); return $null }
    git -C $src checkout -q -f $tag
    git -C $src clean -q -fd -e build
    $src
}

function Copy-CudaRuntime([string]$dst) {
    $bin = Join-Path $env:CUDA_PATH "bin"
    foreach ($f in @("cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll")) {
        if (-not (Test-Path "$bin\$f")) { Warn (T "manca $(Join-Path $bin $f): il motore non trovera' il runtime CUDA" "$(Join-Path $bin $f) is missing: the engine will not find the CUDA runtime"); return }
        Copy-Item "$bin\$f" $dst -Force
    }
}

# --- prism: PrismML's fork of llama.cpp (3.6, 3.8, Bonsai 2, LFM) ---------------------------
# `setup.ps1 -Only llama-prism`: Bonsai 2 does NOT run on stock llama.cpp (weights in rotated basis,
# PQ2_0/PTQ1_0 types), and on the other models the fork with the clock keeper writes faster. Our fork
# mango-prism is cloned at the mango-models.json tag (prism_build) and built into $Llama\prism\. Its
# `mango` branch brings: TU116 (1660S on dp4a), CUDA graphs on Pascal, clock keeper
# (GGML_CUDA_CLOCK_KEEPER), the PQ2_0 MMVQ geometry for Pascal/Turing - measured: decode on 3 GPUs
# 17.4 -> 28.4 tok/s -, the ubatch of the MTP draft only (LLAMA_MTP_UBATCH), which makes the 3.6 draft
# fit at 128k, and the conversations' on-disk memory (--cache-disk). mango-ci\build.ps1 is the script
# that also builds in GitHub Actions: here the same one is run, with the archs of this PC's GPUs.
function Install-LlamaPrism {
    $tag = $CFG.prism_build
    Step "mango-prism $tag -> $Llama\prism"
    foreach ($c in @("cmake","nvcc","git","ninja")) {
        if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Warn (T "manca ${c}: senza, i modelli prism non partono" "${c} is missing: without it, the prism models do not start"); return }
    }
    $ga = Get-GpuArchs
    if (-not $ga) { Warn (T "nvidia-smi non risponde: build saltata" "nvidia-smi does not answer: build skipped"); return }
    $archs = $ga.archs -join ";"; $tu116 = $ga.tu116
    Info "arch $archs  tu116=$tu116"

    $src = Get-ForkSource "mango-prism" $tag (Join-Path $PARENT "temp\mango-prism")
    if (-not $src) { return }
    $buildScript = "$src\mango-ci\build.ps1"
    Info (T "compilazione (15-30 min)..." "building (15-30 min)...")
    try { & $buildScript -Variant cuda-12 -Out "$Llama\prism" -Archs $archs -Tu116:$tu116 -Jobs 8 | Out-Null }
    catch { Warn (T "build fallita: $_ (rilancia $buildScript per vedere l'errore)" "build failed: $_ (run $buildScript again to see the error)"); return }
    Copy-CudaRuntime "$Llama\prism"
    Ok "$Llama\prism\llama-server.exe (3.6, 3.8, bonsai2, lfm)"
}

# --- toq: ik_llama.cpp with trellis weights (TOQ) -------------------------------------------
# `setup.ps1 -Only llama-toq`: TOQ-v1 has its weights in trellis format (TRL2_M/TRL3_M), which only our
# fork mango-toq reads (its `mango` branch: trellis weights, prompt prefill on the main GPU, MTP, on-disk
# memory, batched generation). It is cloned at the mango-models.json tag (toq_build) and built with
# mango-ci\build.ps1, the script that also builds in GitHub Actions, with the archs of this PC's GPUs.
# Toolchain (looked up by the script): clang-cl (LLVM, or Visual Studio's "C++ Clang tools"
# component), Ninja, nvcc 12.x and the MSVC environment (vcvars64): it is the one the engine was measured with.
function Install-LlamaToq {
    $tag = $CFG.toq_build
    Step "mango-toq $tag -> $Llama\toq"
    foreach ($c in @("cmake","nvcc","git","ninja")) {
        if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Warn (T "manca ${c}: senza, toq non parte" "${c} is missing: without it, toq does not start"); return }
    }
    $ga = Get-GpuArchs
    if (-not $ga) { Warn (T "nvidia-smi non risponde: build saltata" "nvidia-smi does not answer: build skipped"); return }
    $archs = ($ga.archs | ForEach-Object { "$_-real" }) -join ";"
    Info "arch $archs"

    $src = Get-ForkSource "mango-toq" $tag (Join-Path $PARENT "temp\mango-toq")
    if (-not $src) { return }
    $buildScript = "$src\mango-ci\build.ps1"
    Info (T "compilazione (30-90 min)..." "building (30-90 min)...")
    try { & $buildScript -Variant cuda-12 -Out "$Llama\toq" -Archs $archs -Jobs 8 | Out-Null }
    catch { Warn (T "build fallita: $_ (rilancia $buildScript per vedere l'errore)" "build failed: $_ (run $buildScript again to see the error)"); return }
    Copy-CudaRuntime "$Llama\toq"
    Ok "$Llama\toq\llama-server.exe (toq)"
}

# --- models -------------------------------------------------------------------------------
# The GGUFs are downloaded with curl and not with `hf download`: on Windows the huggingface_hub
# downloader trips on the name of its cache (WinError 123), and curl resumes by itself.
function Get-HfToken {
    if ($env:HF_TOKEN) { return $env:HF_TOKEN }
    $f = Join-Path $env:USERPROFILE ".cache\huggingface\token"
    if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
    return $null
}

function Install-Models {
    Step (T "modelli -> $Models" "models -> $Models")
    $token = Get-HfToken
    $keys = if ($Model) { @($Model) } else { $CFG.models.PSObject.Properties.Name }

    foreach ($k in $keys) {
        $m = $CFG.models.$k
        if (-not $m) { Warn (T "modello '$k' sconosciuto" "unknown model '$k'"); continue }
        Write-Host "$d  --- $k : $($m.label) $($m.quant)$r"
        if (-not $m.files) { Warn (T "$k non ha file da scaricare nel catalogo" "$k has no files to download in the catalog"); continue }
        # Each catalog file: path under the models folder, size, and its own repo/revision if they do not
        # come from the model's repo (like the 3.6's mmproj).
        foreach ($f in $m.files) {
            $dst  = Join-Path $Models $f.path
            $file = Split-Path $f.path -Leaf
            $repo = if ($f.repo) { $f.repo } else { $m.repo }
            $rev  = if ($f.revision) { $f.revision } else { $m.revision }
            $want = [int64]$f.size
            New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
            if ((Test-Path $dst) -and -not $Force) {
                $have = (Get-Item $dst).Length
                if ($have -eq $want) { Ok (T "$file gia' completo ($([math]::Round($have/1GB,2)) GB)" "$file already complete ($([math]::Round($have/1GB,2)) GB)"); continue }
                Info (T "$file incompleto ($([math]::Round($have/1GB,2)) / $([math]::Round($want/1GB,2)) GB): riprendo" "$file incomplete ($([math]::Round($have/1GB,2)) / $([math]::Round($want/1GB,2)) GB): resuming")
            }
            if (-not $repo) { Warn (T "$file non ha un repo da cui scaricarlo" "$file has no repo to download it from"); continue }
            $url = "https://huggingface.co/$repo/resolve/$rev/$file"
            Info (T "download $file ($([math]::Round($want/1GB,2)) GB)" "downloading $file ($([math]::Round($want/1GB,2)) GB)")
            $ca = @("-L","-C","-","--fail","--retry","5","--retry-delay","5","--progress-bar","-o",$dst)
            if ($token) { $ca += @("-H","Authorization: Bearer $token") }
            & curl.exe @ca $url
            if ($LASTEXITCODE -ne 0) {
                Warn (T "download fallito: $file" "download failed: $file")
                if ($m._gated) { Warn (T "Repo GATED: apri https://huggingface.co/$repo da loggato e accetta i termini, poi rilancia." "GATED repo: open https://huggingface.co/$repo while logged in and accept the terms, then run again.") }
                if (-not $token) { Warn (T "Nessun token HF trovato: `hf auth login` (o `$env:HF_TOKEN`)." "No HF token found: `hf auth login` (or `$env:HF_TOKEN`).") }
                continue
            }
            $have = (Get-Item $dst).Length
            if ($have -eq $want) { Ok "$file ($([math]::Round($have/1GB,2)) GB)" }
            else { Warn (T "$file dimensione diversa dall'attesa ($have vs $want): rilancia per riprendere" "$file size differs from expected ($have vs $want): run again to resume") }
        }
    }
}

# --- node dependencies ---------------------------------------------------------------------
function Install-Npm {
    Step (T "dipendenze node" "node dependencies")
    # The launcher's packages, and those of the agent's plugins (`opencode-home`, which the installer carries too).
    foreach ($dir in @($SELF, (Join-Path $SELF "opencode-home"))) {
        Push-Location $dir
        try {
            # `npm ci` and not `npm install`: it respects the lockfile, which is the point of having it.
            npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { Warn (T "npm ci fallito, provo npm install" "npm ci failed, trying npm install"); npm install --no-audit --no-fund }
            Ok (T "node_modules pronto in $dir" "node_modules ready in $dir")
        } finally { Pop-Location }
    }
}

# --- opencode (Mango Code's agent) -----------------------------------------------------------
# `setup.ps1 -Only opencode`: one binary for the app and for the terminal, built from the repo's
# sources (`packages/opencode`, at the root) with Bun: embedded web UI, Bun runtime included.
# It ends up in <opencode>\web\mango-code.exe; by default <opencode> is launcher\opencode, ignored by git.
# HUSKY=0: opencode's `prepare` script would install a git hook that runs the typecheck on every push.
$OPENCODE_BUILD_VERSION = "1.18.23-mango"
function Install-Opencode {
    Step "opencode $OPENCODE_BUILD_VERSION -> $Opencode\web\mango-code.exe"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Warn (T "manca bun (1.4.2 o piu'): senza, l'agente non c'e'" "bun (1.4.2 or newer) is missing: without it, there is no agent"); return }
    $repo = Split-Path $SELF -Parent
    Push-Location $repo
    try {
        $env:HUSKY = "0"
        bun install --frozen-lockfile | Out-Null
        if ($LASTEXITCODE -ne 0) { Warn (T "bun install fallito" "bun install failed"); return }
        Push-Location "packages\opencode"
        try {
            $env:OPENCODE_VERSION = $OPENCODE_BUILD_VERSION; $env:OPENCODE_CHANNEL = "latest"
            Info (T "compilazione (5-15 min)..." "building (5-15 min)...")
            bun run script/build.ts --single | Out-Null
            if ($LASTEXITCODE -ne 0) { Warn (T "build fallita" "build failed"); return }
        } finally { Pop-Location }
    } finally { Pop-Location }
    New-Item -ItemType Directory -Force -Path "$Opencode\web" | Out-Null
    Copy-Item "$repo\packages\opencode\dist\opencode-windows-x64\bin\opencode.exe" "$Opencode\web\mango-code.exe" -Force
    Ok "$Opencode\web\mango-code.exe"
}

# --- mango-launch: the app's logic, for the terminal --------------------------------------------
# mango-engine.ps1 does not choose the engine and its arguments: it asks this program (app\crates\engine), the same
# plan as the app. It is built like the app: it needs Rust (cargo).
function Install-Launch {
    Step "mango-launch -> app\target\release\mango-launch.exe"
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Warn (T "manca cargo (Rust): senza, il terminale non sa che motore accendere" "cargo (Rust) is missing: without it, the terminal does not know which engine to start"); return }
    Push-Location (Join-Path (Split-Path $SELF -Parent) "app")
    try {
        cargo build --release -p engine --bin mango-launch
        if ($LASTEXITCODE -ne 0) { Warn (T "build fallita" "build failed"); return }
    } finally { Pop-Location }
    Ok "app\target\release\mango-launch.exe"
}

# --- config with THIS machine's paths ---------------------------------------------------
# mango-paths.json contains absolute paths: it is MACHINE stuff, not repo stuff, and it is gitignored.
# Same rule as opencode.json, which mango-code.ps1 generates at every start: the template
# is versioned, never the generated file.
function Install-Config {
    Step "config"
    New-Item -ItemType Directory -Force -Path $Models | Out-Null
    New-Item -ItemType Directory -Force -Path $Llama | Out-Null
    New-Item -ItemType Directory -Force -Path $Opencode | Out-Null
    $json = [ordered]@{
        _note  = "Where binaries and weights are ON THIS MACHINE. Generated by setup.ps1 and gitignored, like all configs: the .template.json files are versioned, never the generated file."
        llama  = (Resolve-Path $Llama).Path
        models = (Resolve-Path $Models).Path
        opencode = (Resolve-Path $Opencode).Path
    } | ConvertTo-Json
    Write-Utf8NoBom "$SELF\mango-paths.json" $json
    Ok "mango-paths.json (llama: $Llama · models: $Models · opencode: $Opencode)"
}

# --- the `mango-code` command ----------------------------------------------------------------
# Without this the repo is complete but the command does not exist: it is the missing line.
function Install-Command {
    Step (T "comando mango-code nel profilo PowerShell" "mango-code command in the PowerShell profile")
    $line = 'function mango-code { & "' + $SELF + '\mango-code.ps1" @args }'
    if (-not (Test-Path $PROFILE)) {
        New-Item -ItemType File -Force -Path $PROFILE | Out-Null
        Ok (T "creato $PROFILE" "created $PROFILE")
    }
    $cur = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($cur -match '(?m)^\s*function mango-code\s*\{') {
        # Rewrites the existing line. It goes line by line and not with a replacement regex
        # because the path may contain $ and backslashes, which in a replacement would be magic.
        $lines = @(Get-Content $PROFILE)
        $out = $lines | ForEach-Object { if ($_ -match '^\s*function mango-code\s*\{') { $line } else { $_ } }
        $upd = ($out -join "`r`n")
        if ($upd -ne ($lines -join "`r`n")) { Set-Content $PROFILE -Value $upd -Encoding utf8; Ok (T "funzione aggiornata" "function updated") }
        else { Ok (T "funzione gia' presente e corretta" "function already present and correct") }
    } else {
        Add-Content $PROFILE -Value "`n$line" -Encoding utf8
        Ok (T "funzione aggiunta a $PROFILE" "function added to $PROFILE")
    }
    Info (T "aprire un terminale NUOVO perche' il profilo venga riletto" "open a NEW terminal so the profile is read again")
}

# --- run --------------------------------------------------------------------------------------
Write-Host ""
Write-Host "$o  mango-code setup$r$d  -  $(T 'da repo clonata a tool funzionante' 'from a cloned repo to a working tool')$r"
Write-Host ""

if ($Only -eq "all") { Test-Prereqs }
switch ($Only) {
    "all"     { Install-LlamaPrism; Install-LlamaToq; Install-Models; Install-Npm; Install-Config; Install-Command; Install-Launch; Install-Opencode }
    "llama-prism" { Install-LlamaPrism }
    "llama-toq"   { Install-LlamaToq }
    "models"  { Install-Models }
    "npm"     { Install-Npm }
    "config"  { Install-Config }
    "command" { Install-Command }
    "opencode" { Install-Opencode }
    "launch"  { Install-Launch }
}

Write-Host ""
if ($Only -eq "all") {
    Write-Host (T "$g  fatto.$r Apri un terminale nuovo e lancia $y mango-code $r" "$g  done.$r Open a new terminal and run $y mango-code $r")
    Write-Host (T "$d  modelli disponibili: mango-code -Models$r" "$d  available models: mango-code -Models$r")
    Write-Host ""
}
