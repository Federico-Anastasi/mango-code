# mango-engine.ps1 - starts llama-server with the right model. It knows nothing about the agent that
# talks to it: mango-code.ps1 launches it.
#
#   .\mango-engine.ps1 -Model 3.8      # starts (or reuses) the engine, returns the model card
#   .\mango-engine.ps1 -Models         # lists the configured models
#
# What to start and with which arguments is NOT decided by this file: it is decided by the app's own logic
# (app\crates\engine-cfg, via mango-launch.exe): the PC's profile if it applies, otherwise the general plan with
# the official llama.cpp. Here we start the process the plan describes and keep track of what is running.
# If the app is open, the engine is the app's (the manager on the engine port): we ask it.
#
# ONE object goes on the pipeline: Key, Label, Quant, Kind, Ctx, Engine, Build. The on-screen messages go
# through Write-Host, which does NOT end up in the pipeline: the caller receives only the object, and can use
# its fields (the agent needs Ctx to avoid overrunning the context).
# Ctx is the model's whole context: the engine serves ONE dev only.

param(
    [string]$Model,
    [switch]$Models,
    [string]$Remote,        # start NOTHING: the engine runs on another PC (host or host:port)
    [switch]$Lan,           # expose THIS machine's engine to the other PCs on the LAN (sticky)
    [switch]$NoLan,         # ...and this one closes it back to 127.0.0.1 only
    [switch]$Install,       # first download the engine and the model weights, if missing
    [switch]$Quiet          # no progress messages: the caller prints them
)

$ErrorActionPreference = "Stop"
$SELF    = $PSScriptRoot
$RUNTIME = "$SELF\runtime"
$ACTIVE  = "$RUNTIME\active-model.txt"   # key of the model loaded right now (sticky)
$BINDF   = "$RUNTIME\engine-bind.txt"    # on WHICH interface the running engine listens
$LANF    = "$RUNTIME\engine-lan.txt"     # marker: the engine must be exposed to the LAN (sticky)
$ENGF    = "$RUNTIME\engine.json"        # the engine started from here: the process and the call that saves the conversation
# The engine port is the app's (MANGO_ENGINE_PORT in the tests).
$PORT    = if ($env:MANGO_ENGINE_PORT) { [int]$env:MANGO_ENGINE_PORT } else { 8080 }
$LOCAL_URL = "http://127.0.0.1:$PORT"

# --- models ----------------------------------------------------------------------------
. "$SELF\mango-catalog.ps1"
$CAT  = Get-Catalog $SELF
$CFG  = $CAT.Cfg
$KEYS = $CAT.Keys
function Get-ActiveKey { if (Test-Path $ACTIVE) { (Get-Content $ACTIVE -Raw).Trim() } else { $null } }

$esc = [char]27
$dim = "$esc[38;5;245m"; $off = "$esc[0m"
function Say($t) { if (-not $Quiet) { Write-Host "$dim   $t$off" } }

# --- the app's logic: mango-launch.exe -----------------------------------------------------
# From the repo it lives in app\target (release if present, otherwise debug); MANGO_LAUNCH points to another one.
$LAUNCHER = if ($env:MANGO_LAUNCH) { $env:MANGO_LAUNCH } else {
    foreach ($b in "release", "debug") { $f = "$SELF\..\app\target\$b\mango-launch.exe"; if (Test-Path $f) { $f; break } }
}
function Assert-Launcher {
    if ($LAUNCHER -and (Test-Path $LAUNCHER)) { return }
    Write-Host (T "mango-engine | manca mango-launch.exe: e' la logica dell'app che sceglie motore e argomenti" "mango-engine | mango-launch.exe is missing: it is the app's logic that chooses the engine and its arguments") -ForegroundColor Red
    Write-Host (T "  costruiscilo con:  .\setup.ps1 -Only launch" "  build it with:  .\setup.ps1 -Only launch") -ForegroundColor Yellow
    exit 1
}

# Runs mango-launch.exe on this folder's distribution; returns the code, the output and the errors.
function Invoke-Launcher([string[]]$a) {
    Assert-Launcher
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $LAUNCHER
    $psi.Arguments = $a -join " "
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables["MANGO_DIST"] = $SELF
    $p = [System.Diagnostics.Process]::Start($psi)
    $err = $p.StandardError.ReadToEndAsync()
    $out = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    [pscustomobject]@{ Code = $p.ExitCode; Out = $out; Err = $err.Result.Trim() }
}

# Like Invoke-Launcher, but with progress on the terminal (downloads take minutes).
function Install-Model([string]$key) {
    Assert-Launcher
    $env:MANGO_DIST = $SELF
    & $LAUNCHER install --model $key | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

# The engine plan of a model on this PC.
function Get-Plan([string]$key) {
    $r = Invoke-Launcher @("plan", "--model", $key, "--port", $PORT)
    if ($r.Code -ne 0) {
        Write-Host "mango-engine | $($r.Err)" -ForegroundColor Red
        # A model that does not fit in memory is not fixed by downloading: the sentence already says what to do.
        # The text comes from the app's logic, in the current language.
        if ($r.Err -notmatch "Scegli un modello|[Cc]hoose a smaller model") {
            Write-Host (T "  se mancano il motore o i pesi:  mango-code -Model $key -Install" "  if the engine or the weights are missing:  mango-code -Model $key -Install") -ForegroundColor Yellow
        }
        exit 1
    }
    $r.Out | ConvertFrom-Json
}

if ($Models) {
    $r = Invoke-Launcher @("models")
    if ($r.Code -ne 0) { Write-Host "mango-engine | $($r.Err)" -ForegroundColor Red; exit 1 }
    $ctxOf = @{}; $missingOf = @{}; $placementOf = @{}
    foreach ($x in ($r.Out | ConvertFrom-Json).models) { $ctxOf[$x.model] = [int]$x.context; $missingOf[$x.model] = $x.missing; $placementOf[$x.model] = $x.placement }
    $act = Get-ActiveKey
    Write-Host ""
    foreach ($k in $KEYS) {
        $mi = $CFG.models.$k
        $mark = if ($k -eq $act) { "*" } else { " " }
        # The cloud models come after the local ones, separated.
        if ($mi.cloud -and $CAT.Local -notcontains $k -and -not $cloudSep) { $cloudSep = $true; Write-Host "" }
        if ($mi.cloud) {
            $have = if (Test-Path "$SELF\mango-secrets.json") { "" } else { T "  [mango-secrets.json mancante - vedi mango-secrets.example.json]" "  [mango-secrets.json missing - see mango-secrets.example.json]" }
            $ctx = if ($mi.ctx) { [int]$mi.ctx } else { [int]$CFG.ctx }
        } else {
            # Where it runs: all on the GPUs (nothing to say), all on the CPU, or nowhere.
            $have = switch ($placementOf[$k]) { "cpu" { T "  [sul processore: piu' lento]" "  [on the CPU: slower]" } $null { T "  [non ci sta in questo computer]" "  [does not fit on this computer]" } default { "" } }
            if ($missingOf[$k]) { $have += T "  [non pronto: $($missingOf[$k])]" "  [not ready: $($missingOf[$k])]" }
            $ctx = $ctxOf[$k]
        }
        $mine = if ($CAT.User -contains $k) { T "  [tuo]" "  [yours]" } else { "" }
        Write-Host ("  $mark $k  {0,-24} {1,-18} {2}k ctx  {3}{4}{5}" -f $mi.label, $mi.quant, [int]($ctx/1024), $mi.kind, $mine, $have)
    }
    Write-Host (T "`n  * = caricato adesso - scegli con: mango-code -Model <chiave> (-Install scarica cio' che manca)`n" "`n  * = loaded now - choose with: mango-code -Model <key> (-Install downloads what is missing)`n")
    exit 0
}

# --- REMOTE ENGINE: the weights are on ANOTHER PC ------------------------------------------
# Nothing is started or stopped here: VRAM, GGUF and llama-server belong to the other machine.
# This branch exists for one reason only: downstream (generated configs, context, status line)
# the model's CARD is still needed, so we ASK the server for it instead of deducing it from
# mango-models.json. Deducing it would be the usual bug of the number written in two places:
# which model is running is decided by whoever keeps it running, not by this machine's file.
function Resolve-EngineUrl([string]$h) {
    $h = "$h".Trim()
    if ($h -notmatch '^https?://') { $h = "http://$h" }
    if ($h -notmatch ':\d+$')      { $h = "${h}:8080" }
    return $h.TrimEnd('/')
}

if ($Remote) {
    $URL = Resolve-EngineUrl $Remote
    try {
        $props = Invoke-RestMethod -Uri "$URL/props" -TimeoutSec 5
    } catch {
        Write-Host (T "mango-engine | nessun motore risponde su $URL" "mango-engine | no engine answers at $URL") -ForegroundColor Red
        Write-Host (T "  sul PC che tiene il modello:   mango-code -Lan -EngineOnly" "  on the PC that holds the model:   mango-code -Lan -EngineOnly") -ForegroundColor Yellow
        Write-Host (T "  l'IP giusto lo stampa quel comando (oppure: ipconfig -> IPv4)" "  that command prints the right IP (or: ipconfig -> IPv4)") -ForegroundColor Yellow
        exit 1
    }

    # /props gives the server's REAL context and which gguf it loaded. The "nice" model name is only
    # found if that gguf is also in THIS copy's mango-models.json; if it is not (the server may have
    # loaded something else) the file name stays - a raw, honest label is better than an invented card.
    $ctx   = 0
    if ($props.default_generation_settings.n_ctx) { $ctx = [int]$props.default_generation_settings.n_ctx }
    $mpath = "$($props.model_path)"
    $leaf  = if ($mpath) { ($mpath -split '[\\/]')[-1] } else { "" }
    $label = if ($leaf) { $leaf -replace '\.gguf$','' } else { T "modello remoto" "remote model" }
    $quant = T "remoto" "remote"
    $key   = "remote"
    foreach ($k in $KEYS) {
        $mi = $CFG.models.$k
        if ($mi.gguf -and ((($mi.gguf -split '[\\/]')[-1]) -eq $leaf)) {
            $key = $k; $label = $mi.label; $quant = $mi.quant
            if (-not $ctx) { $ctx = if ($mi.ctx) { [int]$mi.ctx } else { [int]$CFG.ctx } }
            break
        }
    }
    if (-not $ctx) { $ctx = [int]$CFG.ctx }

    [pscustomobject]@{
        Key    = $key
        Label  = $label
        Quant  = $quant
        Kind   = "remote"
        Ctx    = $ctx
        Engine = T "motore remoto" "remote engine"
        Build  = "n/a"
        Url    = $URL
        Remote = $true
    }
    return
}

# --- the engine that is already there ---------------------------------------------------------
function Test-Server { try { (Invoke-WebRequest "$LOCAL_URL/health" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { $false } }

# The app's manager, if it is the one holding the engine port: it answers /engine with its phase. A llama-server
# started from a terminal answers 404.
function Get-Manager {
    try { $g = Invoke-RestMethod "$LOCAL_URL/engine" -TimeoutSec 2; if ($g.phase) { $g } } catch { }
}

# A POST to the engine (save or reload the conversation), as the app's manager does it.
function Invoke-Call($c) {
    if ($c.body) { Invoke-RestMethod -Method Post -Uri $c.url -Body $c.body -ContentType "application/json" -TimeoutSec $c.timeout_s | Out-Null }
    else { Invoke-RestMethod -Method Post -Uri $c.url -TimeoutSec $c.timeout_s | Out-Null }
}

# Stops the engine started from this terminal (the last one): first it makes it save the conversation, then stops it.
# Only the process we started is stopped: another llama-server that is not ours (`base`'s, or the app's) may be
# running on the same machine, and it is left alone.
function Stop-MangoEngine {
    if (-not (Test-Path $ENGF)) { return }
    $e = Get-Content $ENGF -Raw | ConvertFrom-Json
    $proc = Get-Process -Id $e.pid -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq "llama-server" }
    if ($proc) {
        if ($e.shutdown) {
            try { Invoke-Call $e.shutdown } catch { Write-Host (T "$dim   la conversazione non si e' salvata: $($_.Exception.Message)$off" "$dim   the conversation was not saved: $($_.Exception.Message)$off") }
        }
        $proc | Stop-Process -Force
        $proc.WaitForExit(15000) | Out-Null
    }
    Remove-Item $ENGF
}

# Precedence: explicit -Model > the one the app's manager is running now > last used (sticky) > mango-models.json default.
$G = Get-Manager
if (-not $Model -and $G) { $Model = $G.model }
if (-not $Model) { $Model = Get-ActiveKey }
if (-not $Model) { $Model = $CFG.default }
if ($KEYS -notcontains $Model) {
    Write-Host (T "mango-engine | modello '$Model' sconosciuto. Disponibili: $($KEYS -join ', ')" "mango-engine | unknown model '$Model'. Available: $($KEYS -join ', ')") -ForegroundColor Red
    exit 1
}
$M = $CFG.models.$Model

# --- CLOUD model (no engine) ------------------------------------------------------------
# 'cloud' in mango-models.json means: no gguf, no llama-server, no VRAM.
# We stop here: nothing to load, the caller reads the key from mango-secrets.json.
if ($M.cloud) {
    # A cloud model does not need the GPUs: if the local engine was started from here, it is stopped.
    # Otherwise it would keep occupying VRAM for a model that serves nobody.
    if (Test-Path $ENGF) {
        Say (T "modello cloud: spengo il motore locale (non serve)..." "cloud model: stopping the local engine (not needed)...")
        Stop-MangoEngine
    }
    Set-Content -Path $ACTIVE -Value $Model -Encoding ascii
    [pscustomobject]@{
        Key    = $Model
        Label  = $M.label
        Quant  = $M.quant
        Kind   = $M.kind
        Ctx    = $(if ($M.ctx) { [int]$M.ctx } else { [int]$CFG.ctx })
        Engine = "cloud ($($M.cloud.provider))"
        Build  = "n/a"
        Url    = $LOCAL_URL
        Cloud  = $M.cloud
    }
    return
}

New-Item -ItemType Directory -Force -Path $RUNTIME | Out-Null
if ($Install) { Install-Model $Model }

# --- the engine is the app's -------------------------------------------------------------------
# With the app open the port belongs to its manager: the only one that can change model without messing up the GPUs.
# We ask it for the model and use its state (the real context and GPUs, those of its plan).
if ($G) {
    if ($Lan) { Write-Host (T "$dim   -Lan non vale: il motore e' quello dell'app, che ascolta solo su questo PC.$off" "$dim   -Lan has no effect: the engine is the app's, which listens only on this PC.$off") }
    if ($G.phase -ne "running" -or $G.model -ne $Model) {
        Say (T "il motore e' quello dell'app: gli chiedo '$Model'..." "the engine is the app's: asking it for '$Model'...")
        try {
            $G = Invoke-RestMethod -Method Post -Uri "$LOCAL_URL/engine/model" -Body (@{ model = $Model } | ConvertTo-Json -Compress) `
                -ContentType "application/json" -TimeoutSec 900
        } catch {
            $msg = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error.message } catch { $null }
            $why = if ($msg) { $msg } else { $_.Exception.Message }
            Write-Host (T "mango-engine | l'app non accende '$Model': $why" "mango-engine | the app cannot start '$Model': $why") -ForegroundColor Red
            exit 1
        }
    }
    if (@($G.gpus).Count -eq 0) { Write-Host (T "mango-engine | $Model gira tutto sul processore: piu' lento." "mango-engine | $Model runs entirely on the CPU: slower.") -ForegroundColor Yellow }
    Set-Content -Path $ACTIVE -Value $Model -Encoding ascii
    [pscustomobject]@{
        Key     = $Model
        Gpus    = @($G.gpus).Count
        Label   = $G.name
        Quant   = $M.quant
        Kind    = $M.kind
        Ctx     = [int]$G.context
        Engine  = T "motore dell'app" "the app's engine"
        Build   = T "gestore" "manager"
        Url     = $LOCAL_URL
        Manager = $true
    }
    return
}

# --- this terminal starts the engine ------------------------------------------------------------
# ONE DEV ONLY: one llama-server, weights loaded ONCE, -np 1. The whole model context
# (ctx) goes to that single session: no fixed slot to split.
# The plan is made before stopping the other engine: a model that cannot be started leaves the engine as it was.
$plan = Get-Plan $Model
$engineKind = Split-Path (Split-Path $plan.executable -Parent) -Leaf

# --- exposing the engine to the LAN (sticky, like the model) ---------------------
# UNCHANGED default: --host 127.0.0.1, so only this PC sees the engine. -Lan puts it on
# 0.0.0.0 and leaves a marker, so it need not be repeated at every start; -NoLan removes it.
# Sticky but not on by default, because 0.0.0.0 is a SECURITY decision: llama-server
# has no authentication, anyone on the network who finds it can use it. On the home wifi that is
# exactly what you want; on someone else's network it is not, and it must stay an explicit choice.
if ($Lan)   { Set-Content -Path $LANF -Value "1" -Encoding ascii }
if ($NoLan) { Remove-Item $LANF -ErrorAction SilentlyContinue }
$LanOn    = Test-Path $LANF
$BindWant = if ($LanOn) { "0.0.0.0" } else { "127.0.0.1" }
function Get-Bind { if (Test-Path $BINDF) { (Get-Content $BINDF -Raw).Trim() } else { "127.0.0.1" } }

# This machine's private IPv4: needed only to PRINT it, otherwise the user has to look it up
# with ipconfig. Loopback, APIPA and virtual adapters (Hyper-V, WSL, VPN) are discarded:
# they have a real IP, but not the one the other PC can knock on.
function Get-LanIP {
    try {
        $c = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
             Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
                            $_.InterfaceAlias -notmatch 'Loopback|vEthernet|WSL|VirtualBox|VMware|Hyper-V' }
        ($c | Select-Object -First 1).IPAddress
    } catch { $null }
}

# Firewall rule: without it, Windows blocks the inbound port and the other PC cannot get in -
# and the symptom is a silent timeout, identical to the one of a wrong IP. -Profile Private: it applies
# on the home wifi, NOT on a network marked public. Without administrator rights it does not
# fail: it prints the line to paste, once.
function Grant-EngineFirewall {
    $name = "mango-code engine ($PORT)"
    $rule = "New-NetFirewallRule -DisplayName '$name' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $PORT -Profile Private"
    try { if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) { return $true } } catch { return $false }
    try { Invoke-Expression "$rule -ErrorAction Stop" | Out-Null; return $true } catch { }
    # A normal user cannot create the rule: it takes the admin. Instead of printing a command to
    # paste (which then does not get pasted, and the symptom from the other PC is a silent timeout,
    # identical to the one of a wrong IP) the Windows window that asks for it is opened. Once only:
    # from the second start the rule is already there and we do not even get here.
    Say (T "serve l'autorizzazione di Windows per aprire la porta $PORT in ingresso (una volta sola)..." "Windows authorization is needed to open inbound port $PORT (once only)...")
    try {
        Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait `
            -ArgumentList "-NoProfile","-Command",$rule -ErrorAction Stop
    } catch { return $false }   # UAC cancelled: carry on anyway, the engine is up regardless
    try { return [bool](Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) } catch { return $false }
}

# The running engine is reused ONLY if it holds the model we want: changing model means
# reloading the weights, there is no shortcut. active-model.txt says what is loaded.
$loaded = Get-ActiveKey
# We also restart when ONLY the interface changes: an engine born on 127.0.0.1 does not become
# reachable from the LAN by asking it later, the host is chosen at start. Not the other way round:
# one already on 0.0.0.0 serves localhost just as well, so a start without -Lan does not
# make it reload - that would be 20 s and the weights up again for nothing.
$rebind = $LanOn -and (Get-Bind) -ne "0.0.0.0"
if ((Test-Server) -and ($loaded -ne $Model -or $rebind)) {
    if (-not (Test-Path $ENGF)) {
        Write-Host (T "mango-engine | sulla porta $PORT c'e' un motore che questo terminale non ha acceso: chiudilo e rilancia" "mango-engine | on port $PORT there is an engine this terminal did not start: close it and run again") -ForegroundColor Red
        exit 1
    }
    if ($rebind -and $loaded -eq $Model) { Say (T "il motore ascolta solo in locale: lo riavvio aperto alla LAN..." "the engine listens only locally: restarting it open to the LAN...") }
    else { Say (T "cambio modello ($loaded -> $Model): spengo il motore..." "changing model ($loaded -> $Model): stopping the engine...") }
    Stop-MangoEngine
    for ($i=0; $i -lt 20; $i++) { if (-not (Test-Server)) { break }; Start-Sleep -Milliseconds 500 }
    if (Test-Server) {
        Write-Host (T "mango-engine | il motore di prima risponde ancora sulla porta ${PORT}: non riesco a spegnerlo" "mango-engine | the previous engine still answers on port ${PORT}: I cannot stop it") -ForegroundColor Red
        exit 1
    }
}

if (Test-Server) {
    $engine = "warm engine"; $engineKind = T "gia acceso" "already running"
} else {
    if ($plan.placement -eq "cpu") { Write-Host (T "mango-engine | $Model non ci sta nelle schede video: gira tutto sul processore, piu' lento." "mango-engine | $Model does not fit on the graphics cards: it runs entirely on the CPU, slower.") -ForegroundColor Yellow }
    Say (T "avvio motore ($($plan.gpus) GPU) ~20 s..." "starting engine ($($plan.gpus) GPU) ~20 s...")
    # --host is the only thing in the plan that this terminal decides: the LAN is its own choice (see above).
    $a = @($plan.args)
    $a[[array]::IndexOf($a, "--host") + 1] = $BindWant
    # Start-Process joins the arguments with spaces and no quotes: a path with spaces (C:\Users\First Last\...)
    # would be split.
    $argLine = ($a | ForEach-Object { if ("$_" -match '[\s"]') { '"' + ("$_" -replace '"', '\"') + '"' } else { "$_" } }) -join " "

    # The plan's environment variables: they apply to THIS start and are then removed, otherwise they would stay in the
    # shell and would start the next model's engine.
    $envSet = @()
    foreach ($p in $plan.env.PSObject.Properties) { Set-Item -Path "env:$($p.Name)" -Value "$($p.Value)"; $envSet += $p.Name }
    # Start-Process with output to file makes the engine inherit all the inheritable handles, including the pipes this
    # terminal writes to (Windows PowerShell 5.1 keeps a copy of them besides standard output): whoever reads them to
    # the end would wait for the engine to shut down. For the start the pipes are not inherited; afterwards they are,
    # because the agent launched later writes to the same output.
    if (-not ('Mango.Handles' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace Mango {
    public static class Handles {
        [DllImport("kernel32.dll")] static extern bool GetHandleInformation(IntPtr h, out int flags);
        [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
        [DllImport("kernel32.dll")] static extern int GetFileType(IntPtr h);
        public static long[] DisinheritPipes() {
            var cleared = new List<long>();
            for (long i = 4; i < 0x100000; i += 4) {
                int f; var h = new IntPtr(i);
                if (GetHandleInformation(h, out f) && (f & 1) != 0 && GetFileType(h) == 3 && SetHandleInformation(h, 1, 0)) cleared.Add(i);
            }
            return cleared.ToArray();
        }
        public static void RestorePipes(long[] cleared) { foreach (var i in cleared) SetHandleInformation(new IntPtr(i), 1, 1); }
    }
}
'@
    }
    $pipes = [Mango.Handles]::DisinheritPipes()
    try {
        # Working directory declared by the plan: TOQ's engine writes `llama.log` in its own, not where the command is launched.
        $proc = Start-Process -FilePath $plan.executable -ArgumentList $argLine -PassThru `
            -RedirectStandardOutput "$RUNTIME\srv_out.log" -RedirectStandardError "$RUNTIME\srv_err.log" `
            -WorkingDirectory $plan.workdir -WindowStyle Hidden
    } finally { [Mango.Handles]::RestorePipes($pipes) }
    foreach ($n in $envSet) { Remove-Item -Path "env:$n" -ErrorAction SilentlyContinue }
    for ($i=0; $i -lt ($plan.wait_s / 2); $i++) { Start-Sleep 2; if ((Test-Server) -or $proc.HasExited) { break } }
    if (-not (Test-Server)) {
        # An engine that does not start is almost always out of memory (OOM), and the useful message is buried
        # at the bottom of a long log. We pull it out and say what to do: without this you end up
        # retrying at random.
        Write-Host (T "mango-engine | il motore non e' partito" "mango-engine | the engine did not start") -ForegroundColor Red
        $log = if (Test-Path "$RUNTIME\srv_err.log") { Get-Content "$RUNTIME\srv_err.log" -Raw } else { "" }
        if ($log -match "out of memory|failed to allocate|cudaMalloc|CUDA error") {
            Write-Host (T "  causa: memoria esaurita (OOM)." "  cause: out of memory (OOM).") -ForegroundColor Yellow
            Write-Host (T "  Il piano e' calcolato sull'hardware: scegli un modello piu' piccolo (mango-code -Models)," "  The plan is computed from the hardware: choose a smaller model (mango-code -Models),") -ForegroundColor Yellow
            Write-Host (T "  oppure, se il modello ha un tuo profilo, correggilo (ub, ts) in $DATA\profiles." "  or, if the model has a profile of yours, fix it (ub, ts) in $DATA\profiles.") -ForegroundColor Yellow
        }
        ($log -split "`n" | Where-Object { $_ -match "error|ERR|failed|out of memory" } | Select-Object -Last 5) |
            ForEach-Object { Write-Host "  $($_.Trim())" -ForegroundColor DarkGray }
        Write-Host (T "  log completo: $RUNTIME\srv_err.log" "  full log: $RUNTIME\srv_err.log") -ForegroundColor DarkGray
        if (-not $proc.HasExited) { $proc | Stop-Process -Force }
        exit 1
    }
    # The saved conversation is reloaded as the app does it; if that fails the engine runs anyway and rereads everything.
    if ($plan.startup) {
        try { Invoke-Call $plan.startup } catch { Say (T "la conversazione salvata non si e' ricaricata: $($_.Exception.Message)" "the saved conversation was not reloaded: $($_.Exception.Message)") }
    }
    $engine = "engine ready ($engineKind)"
    # Written AFTER a successful start: if the server does not start, these files do not lie.
    @{ pid = $proc.Id; model = $Model; shutdown = $plan.shutdown } | ConvertTo-Json -Depth 4 | Set-Content -Path $ENGF -Encoding ascii
    Set-Content -Path $BINDF -Value $BindWant -Encoding ascii
}
Set-Content -Path $ACTIVE -Value $Model -Encoding ascii

$LanUrl = $null
if ($LanOn) {
    if (-not (Grant-EngineFirewall)) {
        Write-Host (T "   la regola firewall per la $PORT non c'e' e non ho i diritti per crearla." "   the firewall rule for port $PORT is missing and I do not have the rights to create it.") -ForegroundColor Yellow
        Write-Host (T "   in un PowerShell da AMMINISTRATORE, una volta sola:" "   in an ADMINISTRATOR PowerShell, once only:") -ForegroundColor Yellow
        Write-Host "   New-NetFirewallRule -DisplayName 'mango-code engine ($PORT)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $PORT -Profile Private" -ForegroundColor DarkGray
    }
    $ip = Get-LanIP
    if ($ip) { $LanUrl = "http://${ip}:$PORT"; Say (T "aperto alla LAN: dall'altro PC ->  mango-code -Remote $ip" "open to the LAN: from the other PC ->  mango-code -Remote $ip") }
    else     { Say (T "aperto alla LAN (IPv4 privato non rilevato: usa ipconfig)" "open to the LAN (private IPv4 not detected: use ipconfig)") }
}

# The ONLY output on the pipeline: the card of the running model. The launcher uses it for the status
# line and to tell the agent how much context it really has (128k on the MoE, 80k on the dense).
[pscustomobject]@{
    Key    = $Model
    Gpus   = $plan.gpus
    Label  = $plan.label
    Quant  = $M.quant
    Kind   = $M.kind
    Ctx    = [int]$plan.context
    Engine = $engine
    Build  = $engineKind
    Url    = $LOCAL_URL
    Pid    = $(if (Test-Path $ENGF) { (Get-Content $ENGF -Raw | ConvertFrom-Json).pid })
    Lan    = $LanOn
    LanUrl = $LanUrl
}
