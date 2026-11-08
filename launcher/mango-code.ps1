# mango-code.ps1 - ONE command: starts the model (if needed) and launches the agent (opencode) on top of it.
#
#   mango-code                      # opens the interactive agent on the local model
#   mango-code -p "do X"            # one-shot: every arg after it goes to the agent
#   mango-code -Model 3.8           # picks the model (see mango-models.json)
#   mango-code -Models              # lists the configured models and which one is active
#   mango-code -Model 3.6 -Install  # ...first downloading the missing engine and weights
#   mango-code -EngineOnly          # starts llama-server only
#   mango-code -Lan                 # ...and makes it reachable from the other PCs on the wifi
#   mango-code -Remote 192.168.1.20 # starts NOTHING here: uses the model on that other PC
#   mango-code -Local               # back to this machine's model
#   mango-code -Chrome              # checks/unlocks the integration with YOUR Chrome
#   mango-code -Chrome -Sandbox     # ...or opens a separate browser, all its own
#   mango-code -Web                 # Mango Code in the browser: engine + agent server with the
#                                    # web UI, prints the address to open (opens nothing by itself)
#   mango-code -Web -Dir C:\project  # ...with the chosen working dir (default: the current one)
#   mango-code -Team                # a TEAM in several windows, with roles:
#                                    # -Model (default: 3.6) is the local DEV (128k),
#                                    # -Manager (default: deepseek) reasons and instructs it,
#                                    # and the manager can start up to 4 cloud AGENTS
#                                    # (-Agent, default: deepseek) when needed.
#                                    # You talk to the manager; dev and agents can also be opened separately.
#
# It ALWAYS runs fully autonomous: the agent never asks permission for commands/edits.
# Deliberate choice: local machine, personal use.
#
# The engine lives in mango-engine.ps1 and knows nothing about who talks to it. The agent is
# opencode (MIT, model-agnostic), with its config isolated in opencode-home\, generated at every
# start from the template with the numbers of the running model.
#
# PATH: $SELF = this folder (all of mango-code's files live here, versioned).

param(
    [string]$Model,
    [switch]$Models,
    [switch]$Install,         # before starting the model, download the missing engine and weights
    [switch]$EngineOnly,      # start the engine only, without opening the agent
    [string]$Remote,          # use the engine of ANOTHER PC on the LAN (host or host:port) - sticky
    [switch]$Local,           # ...and this goes back to this machine's engine
    [switch]$Lan,             # expose this machine's engine to the LAN (sticky)
    [switch]$NoLan,           # ...and this closes it again to 127.0.0.1 only
    [switch]$Chrome,          # unlock/check the browser the MCP server will attach to
    [switch]$Sandbox,         # with -Chrome: open the separate browser instead of your profile
    [switch]$Voice,           # (compat) dictation is ON by default: hold SPACE and speak
    [switch]$NoVoice,         # turn dictation off for this session
    [switch]$Web,             # opencode serve with the built-in web UI, on 127.0.0.1 (no password: local pages only)
    [string]$Dir,             # with -Web: the server's working dir (default: the current one)
    [switch]$Team,            # a team in several windows: manager (cloud) + local dev (3.6)
    [string]$Manager,         # key in mango-models.json of the manager model (default: deepseek)
    [string]$Agent,           # with -Team: key of the model of the startable agents (default: deepseek)
    [string]$p,               # the one-shot documented everywhere: mango-code -p "do X"
    [Parameter(ValueFromRemainingArguments=$true)] $AgentArgs
)

# -p MUST be a declared parameter, it cannot stay among the $AgentArgs. The param block above
# has a [Parameter(...)], and that is enough to make the script an "advanced function": from then
# on PowerShell adds the common parameters and tries to complete abbreviations, so -p becomes
# ambiguous between -ProgressAction and -PipelineVariable and the script dies before starting
# ("the parameter name 'p' is ambiguous", PowerShell 7). Once declared, -p is an EXACT match and
# wins over any completion; then it is put back at the head of the agent's arguments, where the
# rest of the file expects it.
$ErrorActionPreference = "Stop"
if ($p) { $AgentArgs = @("-p", $p) + @($AgentArgs | Where-Object { $_ }) }
$SELF     = $PSScriptRoot
. "$SELF\mango-catalog.ps1"   # T (messages in the current language) and Get-Catalog
$RUNTIME  = "$SELF\runtime"
$REMOTE_F = "$RUNTIME\remote-host.txt"      # engine of another PC, if chosen (sticky)

if ($Models) { & "$SELF\mango-engine.ps1" -Models; exit $LASTEXITCODE }

# --- WHERE THE MODEL RUNS ------------------------------------------------------------------
# Same precedence as the model: explicit choice > last used > this machine. Sticky because on a laptop "the model lives on the desktop" is not an exception to
# redeclare every time, it is the normal state of that PC; -Local cancels it.
New-Item -ItemType Directory -Force -Path $RUNTIME | Out-Null
if ($Local) {
    Remove-Item $REMOTE_F -ErrorAction SilentlyContinue
    $Remote = $null
} elseif ($Remote) {
    Set-Content -Path $REMOTE_F -Value $Remote -Encoding ascii
} elseif (Test-Path $REMOTE_F) {
    $Remote = (Get-Content $REMOTE_F -Raw).Trim()
}

if ($Team -and -not $Manager) { $Manager = "deepseek" }
# -Web does not combine with the team, which is made of terminal windows.
if ($Web) {
    if ($Team) { Write-Host (T "mango-code | -Web e -Team non vanno insieme." "mango-code | -Web and -Team cannot be used together.") -ForegroundColor Red; exit 1 }
    if ($AgentArgs -or $p) { Write-Host (T "mango-code | -Web non lancia prompt: apri l'indirizzo e scrivi nella pagina." "mango-code | -Web does not run prompts: open the address and type in the page.") -ForegroundColor Red; exit 1 }
}
# The team's local dev is the only dev: if the user did not pick an explicit -Model, use
# 3.6 (Qwen3.6-35B-A3B, 128k of context for that single session). An explicit -Model
# stays sovereign.
if ($Team -and -not $Remote -and -not $PSBoundParameters.ContainsKey('Model')) { $Model = "3.6" }

$e = [char]27
$o = "$e[38;5;208m"; $g = "$e[38;5;71m"; $y = "$e[38;5;223m"; $d = "$e[38;5;245m"; $r = "$e[0m"
# single-quoted here-string: backtick (` = PowerShell escape) and backslash are LITERAL.
$art = @'
                                                   _
   _ __ ___   __ _ _ __   __ _  ___   ___ ___   __| | ___
  | '_ ` _ \ / _` | '_ \ / _` |/ _ \ / __/ _ \ / _` |/ _ \
  | | | | | | (_| | | | | (_| | (_) | (_| (_) | (_| |  __/
  |_| |_| |_|\__,_|_| |_|\__, |\___/ \___\___/ \__,_|\___|
                         |___/
'@
Write-Host ""
Write-Host "$o$art$r"
Write-Host (T "$g            il tuo agente di coding, in locale$r" "$g            your coding agent, running locally$r")

# --- browser profile -----------------------------------------------------------------------
# Seeds the mango-code profile ONCE with the cookies of the real one, so the model starts
# already logged in wherever you are logged in.
#
# Why a separate profile and not yours: on the DEFAULT profile Chrome shows "Allow remote
# debugging?" at every connection; it is a security measure of theirs and cannot be turned
# off. A browser we start with --remote-debugging-port on a user data dir of our own asks
# nothing. The price would be starting logged out of everything: it is paid once, here.
#
# It must be done with Chrome CLOSED: Cookies is a SQLite file held open exclusively and with
# the browser running the copy fails with "Device or resource busy" (measured). So it never
# blocks anything: if Chrome is open it gives up silently and tries again at the next start.
#
# Login Data is NOT copied: cookies are enough to stay logged in, and duplicating the saved
# passwords would only be one more place they can leak from.
function Copy-ChromeProfile {
    param([string]$Profile, [switch]$Loud)
    # Explicit marker, NOT the presence of the Cookies file: Chrome itself creates that file
    # at first start, so having opened the browser once would be enough to make it look like
    # the seeding already happened - and nothing would ever be copied.
    $stamp = "$Profile\.mango-seeded"
    if (Test-Path $stamp) { return $true }
    if (Get-Process chrome -ErrorAction SilentlyContinue) {
        if ($Loud) {
            Write-Host (T "$y   prima chiudi Chrome: i cookie sono bloccati mentre e' aperto.$r" "$y   close Chrome first: the cookies are locked while it is open.$r")
        }
        return $false
    }
    $src = "$env:LOCALAPPDATA\Google\Chrome\User Data"
    if (-not (Test-Path "$src\Default\Network\Cookies")) { return $false }
    New-Item -ItemType Directory -Force -Path "$Profile\Default\Network" | Out-Null
    Copy-Item "$src\Local State" "$Profile\Local State" -Force -ErrorAction SilentlyContinue
    foreach ($f in @("Preferences", "Secure Preferences", "Web Data", "Bookmarks")) {
        Copy-Item "$src\Default\$f" "$Profile\Default\$f" -Force -ErrorAction SilentlyContinue
    }
    Copy-Item "$src\Default\Network\Cookies" "$Profile\Default\Network\Cookies" -Force -ErrorAction SilentlyContinue
    Copy-Item "$src\Default\Local Storage" "$Profile\Default\Local Storage" -Recurse -Force -ErrorAction SilentlyContinue
    $ok = Test-Path "$Profile\Default\Network\Cookies"
    if ($ok) {
        Set-Content -Path $stamp -Value (Get-Date -Format s) -Encoding ascii
        Write-Host (T "$d   copiati i tuoi cookie nel browser di mango-code (una volta sola).$r" "$d   copied your cookies into the mango-code browser (once only).$r")
    }
    return $ok
}

# --- BROWSER -----------------------------------------------------------------------------
# -Chrome does NOT open a browser to work in: it checks (and unlocks) the integration with
# YOUR Chrome, which is the best level of the cascade described in mango-chrome-mcp.mjs. The
# engine does not need to be running: it exits before starting it.
#
# Why we don't just open it ourselves: since Chrome 136 --remote-debugging-port is refused
# on the default user data dir - it was the hole that let any local process read anyone's
# cookies. The only door left is a toggle INSIDE Chrome (chrome://inspect ->
# #remote-debugging) that by design no program can flip on the user's behalf. So the most
# useful thing is: tell them whether it is already on, and otherwise open that page right in
# front of them. Once flipped, mango-chrome-mcp detects it by itself by reading
# DevToolsActivePort and you never think about it again.
if ($Chrome) {
    $exe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
             "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
             "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
           Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) {
        Write-Host (T "mango-code | Chrome non trovato nei percorsi standard." "mango-code | Chrome not found in the standard locations.") -ForegroundColor Red
        exit 1
    }

    # -Sandbox: the old way. SEPARATE browser, a profile of its own in runtime\chrome-profile.
    # Useful when you do NOT want the model to see your real sessions: you log in here, and from
    # then on it sees only what you gave it.
    if ($Sandbox) {
        $prof = "$RUNTIME\chrome-profile"
        # Two ways to bring your logins in, and BOTH are needed because they cover two opposite
        # situations. With Chrome CLOSED the files are copied (fast, it also brings along
        # preferences and bookmarks). With Chrome OPEN the files are locked with no sharing - both
        # Copy-Item and esentutl /y failed, MEASURED - so we go through the protocol: the cookies
        # are read from the real Chrome via CDP and rewritten here. The consent banner is paid
        # once, at the import, and never again: from then on the default profile is not touched.
        if (-not (Copy-ChromeProfile -Profile $prof)) {
            if (Test-Path "$prof\.mango-seeded") {
                # already seeded: not repeated at every start
            } elseif (Test-Path "$env:LOCALAPPDATA\Google\Chrome\User Data\DevToolsActivePort") {
                Write-Host (T "$d   Chrome e' aperto: porto dentro i login via CDP...$r" "$d   Chrome is open: bringing the logins in via CDP...$r")
                & node "$SELF\mango-cookie-import.mjs"
            } else {
                Write-Host (T "$y   partirai SLOGGATO.$r" "$y   you will start LOGGED OUT.$r")
                Write-Host (T "$d   per portarti dentro i login: o chiudi Chrome e rilancia, oppure$r" "$d   to bring your logins in: either close Chrome and run again, or$r")
                Write-Host (T "$d   accendi il debug con $y'mango-code -Chrome'$d e rilancia questo comando.$r" "$d   turn on debugging with $y'mango-code -Chrome'$d and run this command again.$r")
            }
        }
        New-Item -ItemType Directory -Force -Path $prof | Out-Null
        $up = $false
        try { $up = (Invoke-WebRequest -Uri "http://127.0.0.1:9333/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { }
        if ($up) {
            Write-Host (T "$d   browser separato gia' acceso su $y 9333$r" "$d   separate browser already running on $y 9333$r")
        } else {
            Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=9333", "--user-data-dir=$prof")
            Write-Host (T "$d   browser separato acceso su $y 9333$d, profilo $prof$r" "$d   separate browser started on $y 9333$d, profile $prof$r")
        }
        Write-Host (T "$d   fai i login qui: restano, e il modello vede solo questi.$r" "$d   log in here: the logins stay, and the model sees only these.$r")
        Write-Host ""
        exit 0
    }

    # Default: YOUR Chrome, real profile. If it is already debuggable there is nothing to do.
    $port = $null
    $dtap = "$env:LOCALAPPDATA\Google\Chrome\User Data\DevToolsActivePort"
    if (Test-Path $dtap) { $port = (Get-Content $dtap -TotalCount 1).Trim() }
    $live = $false
    if ($port) {
        try { $live = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch { }
    }
    if ($live) {
        Write-Host (T "$g   il tuo Chrome e' gia' collegato (porta $port).$r" "$g   your Chrome is already connected (port $port).$r")
        Write-Host (T "$d   il modello lavora sulle tue schede, con i tuoi login. Non serve altro.$r" "$d   the model works on your tabs, with your logins. Nothing else is needed.$r")
        Write-Host ""
        exit 0
    }

    # It is not: YOU have to flip the switch, once, inside Chrome.
    # It is not laziness on our side - since Chrome 136 --remote-debugging-port on the default
    # profile is refused on purpose (it was the hole that let any local process read anyone's
    # cookies), and the ONLY door left is that toggle. So the most we can do is open the
    # right page right in front of you.
    Start-Process -FilePath $exe -ArgumentList @("chrome://inspect/#remote-debugging")
    Write-Host (T "$y   ti ho aperto chrome://inspect nel tuo Chrome.$r" "$y   I opened chrome://inspect in your Chrome.$r")
    Write-Host (T "$d   accendi $y'Enable remote debugging'$d e rilancia mango-code: il modello usa le$r" "$d   turn on $y'Enable remote debugging'$d and run mango-code again: the model uses$r")
    Write-Host (T "$d   TUE schede e i TUOI login.$r" "$d   YOUR tabs and YOUR logins.$r")
    Write-Host ""
    Write-Host (T "$d   PERO' Chrome ti chiedera' $y'Vuoi consentire il debug remoto?'$d a OGNI$r" "$d   BUT Chrome will ask $y'Allow remote debugging?'$d at EVERY$r")
    Write-Host (T "$d   connessione: e' una sua misura di sicurezza sul profilo default, non si$r" "$d   connection: it is a security measure of theirs on the default profile, it$r")
    Write-Host (T "$d   spegne. Se ti da' fastidio usa $y-Chrome -Sandbox${d}: browser separato, zero$r" "$d   cannot be turned off. If it bothers you use $y-Chrome -Sandbox${d}: separate browser, zero$r")
    Write-Host (T "$d   banner, e la prima volta si porta dentro i cookie del tuo profilo.$r" "$d   banners, and the first time it brings in the cookies of your profile.$r")
    Write-Host ""
    exit 0
}

# --- the browser as a SERVICE -----------------------------------------------------------
# If the profile is seeded, WE start the browser here, on 9333, and the MCP attaches to it
# with --browserUrl. It used not to be so: when 9333 was off, the MCP server opened one of its
# own with --userDataDir, i.e. over a PIPE and with no debug port. Three consequences, and
# all three were felt on 2026-08-26:
#   - it cannot be inspected from outside: with a hung session there is no way to look at what
#     the browser is doing, and diagnosis becomes guessing;
#   - it dies with the MCP server, and every MCP restart opens another one on the same profile;
#   - if someone closes those processes, the running session is left without a browser and does
#     not notice - it just times out on every call.
# Started here, instead, it is a single process, with a port, that outlives the agent.
function Start-MangoBrowser {
    $prof = "$RUNTIME\chrome-profile"
    if (-not (Test-Path "$prof\.mango-seeded")) { return }   # empty: the real Chrome is better
    try { if ((Invoke-WebRequest "http://127.0.0.1:9333/json/version" -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200) { return } } catch { }
    $exe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
             "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
             "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
           Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) { return }
    Start-Process -FilePath $exe -ArgumentList @("--remote-debugging-port=9333", "--user-data-dir=$prof")
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try { if ((Invoke-WebRequest "http://127.0.0.1:9333/json/version" -TimeoutSec 1 -UseBasicParsing).StatusCode -eq 200) {
            Write-Host (T "$d   browser acceso sulla $y 9333$d (profilo seminato, zero banner)$r" "$d   browser started on $y 9333$d (seeded profile, zero banners)$r"); return } } catch { }
    }
    Write-Host (T "$y   il browser non ha risposto sulla 9333: l'MCP se ne aprira' uno suo.$r" "$y   the browser did not answer on 9333: the MCP will open one of its own.$r")
}
Start-MangoBrowser

# --- ENGINE ------------------------------------------------------------------------------
# Everything about llama-server (models, VRAM, templates, patches) lives in there.
# With a remote engine it starts nothing: it queries the other PC and returns the same card.
if ($Remote -and $Model) {
    Write-Host (T "$y   -Model non vale su un motore remoto: quale modello e' acceso lo decide $Remote.$r" "$y   -Model has no effect on a remote engine: $Remote decides which model is running.$r")
}
$eargs = @{}
if ($Model)  { $eargs.Model  = $Model }
if ($Remote) { $eargs.Remote = $Remote }
if ($Lan)    { $eargs.Lan    = $true }
if ($NoLan)  { $eargs.NoLan  = $true }
if ($Install) { $eargs.Install = $true }
$M = & "$SELF\mango-engine.ps1" @eargs
if (-not $M) { exit 1 }

# The local model sees images only if it has the encoder (mmproj). A remote engine whose
# catalog entry is unknown stays as it was: images on.
$CAT = Get-Catalog $SELF
$CFG = $CAT.Cfg
$localEntry = $CFG.models.($M.Key)
$localImage = -not ($localEntry -and -not $localEntry.cloud -and -not $localEntry.mmproj)

# The engine address in ONE place only: from here down nobody rewrites 127.0.0.1 by hand.
# It feeds the baseURL of the 'mango' provider and the /metrics readers, via MANGO_ENGINE_URL: if
# the engine is on the other PC the status bar's t/s must be asked to it too, otherwise they
# would measure a machine that does not compute.
$BASE = $M.Url
$env:MANGO_ENGINE_URL = $BASE

$ctxk = "$([int]($M.Ctx/1024))k ctx"
$where = if ($M.Cloud) { "$($M.Cloud.provider)" } elseif ($M.Remote) { "LAN" } elseif ($M.Gpus) { "$($M.Gpus) GPU" } else { T "GPU locali" "local GPUs" }
Write-Host "$d   $($M.Label) $d  $where  $ctxk  $(T 'autonomo' 'autonomous')  no-subagent  $g$($M.Engine)$r"

if ($EngineOnly) {
    if ($M.Remote) {
        Write-Host (T "$y   il motore non e' qui: gira su $BASE. Niente da accendere.$r" "$y   the engine is not here: it runs on $BASE. Nothing to start.$r")
        Write-Host ""
        exit 0
    }
    if ($M.Cloud) {
        Write-Host (T "$y   '$($M.Key)' e' un modello cloud: non c'e' nessun motore locale da tenere acceso.$r" "$y   '$($M.Key)' is a cloud model: there is no local engine to keep running.$r")
        Write-Host ""
        exit 0
    }
    if ($M.Manager) {
        Write-Host (T "$d   il motore e' quello dell'app, su $BASE . Si spegne chiudendo l'app.$r" "$d   the engine is the app's, on $BASE . It stops when you close the app.$r")
        Write-Host ""
        exit 0
    }
    Write-Host (T "$d   motore su $BASE . Resta acceso.$r" "$d   engine on $BASE . It stays running.$r")
    if ($M.LanUrl) { Write-Host (T "$d   dagli altri PC del wifi: $y$($M.LanUrl)$r$d  ->  mango-code -Remote $($M.LanUrl -replace 'https?://|:8080','')$r" "$d   from the other PCs on the wifi: $y$($M.LanUrl)$r$d  ->  mango-code -Remote $($M.LanUrl -replace 'https?://|:8080','')$r") }
    if ($M.Pid) { Write-Host (T "$d   per spegnerlo: Stop-Process -Id $($M.Pid)$r" "$d   to stop it: Stop-Process -Id $($M.Pid)$r") }
    Write-Host ""
    exit 0
}

Write-Host ""

# --- voice (dictation) ---------------------------------------------------------------------
# Voice is ON by default, always local (faster-whisper on the CPU, mango-voice.py).
# - In the terminal: holding the space bar starts listening and the text is typed in. The
#   hook acts ONLY when THIS console is in the foreground: it is given the title
#   "Mango Code" (in Windows Terminal that is how the right tab is recognized among the others
#   of the same window) and the title the agent would write over it is turned off. In all
#   the other windows space stays a normal key.
# - With -Web there is no hook: the transcription service (mango-voice.py --serve) starts, and
#   the page's microphone button uses it through the web server (-Web block, further below).
# The voice process dies with this session (--parent) and is shut down when the session ends;
# -NoVoice turns it off for this session. `-Voice` is still accepted for compatibility.
# The log is in runtime\logs\voice-*.log.
if ($Voice) { $NoVoice = $false }
if (-not $NoVoice -and -not (Test-Path "$SELF\mango-voice.py")) { $NoVoice = $true }   # without mango-voice.py there is no dictation
if (-not $NoVoice -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host (T "$y   voce: python non e' nel PATH, salto la dettatura.$r" "$y   voice: python is not in the PATH, skipping dictation.$r")
    $NoVoice = $true
}
New-Item -ItemType Directory -Force -Path "$RUNTIME\logs" | Out-Null
$VOICE_PROC = $null
$VOICE_TITLE = $null
if (-not $NoVoice -and -not $Web) {
    $console = & python "$SELF\mango-voice.py" --print-console
    if ($console -match '^[1-9][0-9]*$') {
        $VOICE_TITLE = $Host.UI.RawUI.WindowTitle
        $Host.UI.RawUI.WindowTitle = "Mango Code"
        $env:OPENCODE_DISABLE_TERMINAL_TITLE = "1"
        $VOICE_PROC = Start-Process -FilePath "python" -ArgumentList @("$SELF\mango-voice.py", "--console", $console, "--parent", "$PID") `
            -WorkingDirectory $SELF -WindowStyle Hidden -PassThru -RedirectStandardError "$RUNTIME\logs\voice-hook.log"
        Write-Host (T "$d   voce: accesa (default), tieni premuto SPAZIO in questa finestra per dettare. Per spegnerla: -NoVoice$r" "$d   voice: on (default), hold SPACE in this window to dictate. To turn it off: -NoVoice$r")
    } else {
        Write-Host (T "$y   voce: questa sessione non ha una console, salto la dettatura.$r" "$y   voice: this session has no console, skipping dictation.$r")
    }
}
# Turns off this session's voice and gives the console its title back. Called when the agent
# exits: launched from the profile, mango-code runs inside the shell that stays open afterwards.
function Stop-MangoVoice {
    if ($VOICE_PROC) { Stop-Process -Id $VOICE_PROC.Id -ErrorAction SilentlyContinue }
    if ($null -ne $VOICE_TITLE) { $Host.UI.RawUI.WindowTitle = $VOICE_TITLE }
}

# --- the config generator ---------------------------------------------------------------
# One rule for the project: the TEMPLATE is versioned, never the generated file. A config file
# with an absolute path or the model's context inside is STATE, not source: versioning it
# means being born dirty on every other machine and lying at the first model change.
# Used by the opencode configs (dev, manager, team agents).
function Write-FromTemplate {
    param([string]$Template, [string]$Out, [hashtable]$Vars)
    if (-not (Test-Path $Template)) {
        Write-Host (T "mango-code | manca $Template" "mango-code | missing $Template") -ForegroundColor Red; exit 1
    }
    $t = Get-Content $Template -Raw
    foreach ($k in $Vars.Keys) { $t = $t.Replace("{{$k}}", [string]$Vars[$k]) }
    Set-Content -Path $Out -Value $t -Encoding utf8
}

# Backslashes must be doubled: the placeholder lives inside a JSON string.
$SELFJ = $SELF.Replace("\", "\\")

# BINARY: the same as the app's, <opencode>\web\mango-code.exe, built from the repo sources
# (setup.ps1 -Only opencode). No fallback to the official opencode: it has neither the t/s bar,
# nor the offline web UI, nor the origin check (without it, a web page can drive the agent).
# By default <opencode> is launcher\opencode; another location goes in mango-paths.json, which
# belongs to the MACHINE, not to the repo.
$OCDIR = "$SELF\opencode"
if (Test-Path "$SELF\mango-paths.json") {
    $PP = Get-Content "$SELF\mango-paths.json" -Raw | ConvertFrom-Json
    if ($PP.opencode) { $OCDIR = $PP.opencode }
}
$OCEXE = "$OCDIR\web\mango-code.exe"
if (-not (Test-Path $OCEXE)) {
    Write-Host (T "mango-code | manca l'agente (compilato dal repo): $OCEXE" "mango-code | the agent (built from the repo) is missing: $OCEXE") -ForegroundColor Red
    Write-Host (T "  costruiscilo con:  .\setup.ps1 -Only opencode" "  build it with:  .\setup.ps1 -Only opencode") -ForegroundColor Yellow
    exit 1
}

# Silent seeding of the browser profile: if it is still empty and Chrome is CLOSED, the
# cookies are copied now. So there is no command to remember - the first start of mango-code
# with Chrome closed makes the model's browser start logged in. If Chrome is open nothing
# happens and it is retried next time: it neither blocks nor slows anything down.
Copy-ChromeProfile -Profile "$RUNTIME\chrome-profile" | Out-Null

$OCHOME = "$SELF\opencode-home"

# --- generated config ----------------------------------------------------------------------
# opencode.json is NOT written by hand: it is generated from the template by substituting the
# numbers of the model running RIGHT NOW. The context changes with the model (128k on the 3.6
# MoE, 80k on the dense 3.8) and if it sat fixed inside the config it would be the third place
# where that number lives: sooner or later it would lie. Single source: mango-models.json.
# Generation cap: one eighth of the context, between 4k and 16k. It is not magic, it is the
# compromise between "long answer cut in half" and "the model eats the context in a single turn".
$outCap = [Math]::Max(4096, [Math]::Min(16384, [int]($M.Ctx / 8)))

# The template's 'openrouter' provider is ALWAYS declared (see opencode.template.json), but
# its numbers (context/output/cost) come from the cloud entry of mango-models.json, not from
# the model running now: they are properties of THAT model, not of the selected one. If there
# is none (no cloud model in mango-models.json), harmless values are kept: the block stays
# there but no 'model'/'small_model' ever points to 'openrouter/...'.
$cloudEntry = $CFG.models.PSObject.Properties.Value | Where-Object { $_.cloud } | Select-Object -First 1
$orKey = "sk-or-v1-not-configured"
if (Test-Path "$SELF\mango-secrets.json") {
    $secrets = Get-Content "$SELF\mango-secrets.json" -Raw | ConvertFrom-Json
    if ($cloudEntry -and $secrets.($cloudEntry.cloud.api_key_field)) { $orKey = $secrets.($cloudEntry.cloud.api_key_field) }
}
$orOutCap = if ($cloudEntry) { [Math]::Max(4096, [Math]::Min(16384, [int]($cloudEntry.ctx / 8))) } else { 4096 }

$localAttachment = if ($localImage) { "true" } else { "false" }
$localInputModalities = if ($localImage) { '["text", "image"]' } else { '["text"]' }
# A model that cannot see images looks at pages as text: its own instructions, no screenshots.
function Get-ScreenshotTool([bool]$img) { if ($img) { "true" } else { "false" } }

# Images: the cloud model's 'image' block in mango-models.json (checked against OpenRouter's
# public API) decides whether opencode can send it an image. modalities.input MUST contain
# "image": that is where provider.ts computes capabilities.input.image from, not from 'attachment'.
$orImage = [bool]($cloudEntry -and $cloudEntry.cloud.image)
$orAttachment = if ($orImage) { "true" } else { "false" }
$orInputModalities = if ($orImage) { '["text", "image"]' } else { '["text"]' }

# PROVIDER/MODEL_REF are the model running RIGHT NOW: mango/local if local, otherwise
# provider/id of the cloud block. It is what ends up in "model" and "small_model".
$provider = "mango"; $modelRef = "local"
if ($M.Cloud) { $provider = $M.Cloud.provider_key; $modelRef = $M.Cloud.model_id }
# MANGO_IMAGE_MODELS: the ids of the models that see images. The opencode plugins
# mango-discipline and mango-web-diet read it to choose the conversation reminders.
$env:MANGO_IMAGE_MODELS = if ($localImage) { $modelRef } else { "" }

Write-FromTemplate "$OCHOME\opencode.template.json" "$OCHOME\opencode.json" @{
    BASE_URL     = "$BASE/v1"
    CTX          = $M.Ctx
    OUTPUT       = $outCap
    LABEL        = "$($M.Label)"
    MODEL_KEY    = $M.Key
    LOCAL_ATTACHMENT = $localAttachment
    LOCAL_INPUT_MODALITIES = $localInputModalities
    SCREENSHOT_TOOL = Get-ScreenshotTool $localImage
    SELF         = $SELFJ
    PROVIDER     = $provider
    MODEL_REF    = $modelRef
    OR_BASE_URL  = $(if ($cloudEntry) { $cloudEntry.cloud.base_url } else { "https://openrouter.ai/api/v1" })
    OR_API_KEY   = $orKey
    OR_MODEL_ID  = $(if ($cloudEntry) { $cloudEntry.cloud.model_id } else { "unused/unused" })
    OR_LABEL     = $(if ($cloudEntry) { $cloudEntry.label } else { "n/a" })
    OR_CTX       = $(if ($cloudEntry) { $cloudEntry.ctx } else { 128000 })
    OR_OUTPUT    = $orOutCap
    OR_COST_IN   = $(if ($cloudEntry) { $cloudEntry.cloud.cost.input } else { 0 })
    OR_COST_OUT  = $(if ($cloudEntry) { $cloudEntry.cloud.cost.output } else { 0 })
    OR_COST_CACHE = $(if ($cloudEntry) { $cloudEntry.cloud.cost.cache_read } else { 0 })
    OR_ATTACHMENT = $orAttachment
    OR_INPUT_MODALITIES = $orInputModalities
    PLUGIN_LIST  = ""
    ROLE_INSTRUCTIONS = $(if ($Team) { ", `"$SELFJ\\opencode-home\\MANGO-dev.md`"" } else { "" })
}

# --- -Team: second window + the MANAGER's config -----------------------------------------
# It touches nothing of the above: $OCHOME\opencode.json stays the DEV's config (the local
# model, exactly as in normal use - only with the extra role instruction, just added above).
# The manager lives in ANOTHER config folder, with ANOTHER model, and starts in ANOTHER window -
# so the user can enter the dev's at any time and talk to it directly, without going through
# the manager.
if ($Team) {
    $KEYS = $CAT.Keys
    if ($KEYS -notcontains $Manager) {
        Write-Host (T "mango-code | manager '$Manager' sconosciuto. Disponibili: $($KEYS -join ', ')" "mango-code | unknown manager '$Manager'. Available: $($KEYS -join ', ')") -ForegroundColor Red
        exit 1
    }
    $mgrEntry = $CFG.models.$Manager
    if (-not $mgrEntry.cloud) {
        Write-Host (T "mango-code | '$Manager' non e' un modello cloud: solo un modello cloud puo' fare da manager (il dev e' gia' quello locale)." "mango-code | '$Manager' is not a cloud model: only a cloud model can act as manager (the dev is already the local one).") -ForegroundColor Red
        exit 1
    }
    if ($Manager -eq $M.Key) {
        Write-Host (T "mango-code | manager e dev non possono essere lo stesso modello ($Manager)." "mango-code | manager and dev cannot be the same model ($Manager).") -ForegroundColor Red
        exit 1
    }

    $mgrCtx    = if ($mgrEntry.ctx) { [int]$mgrEntry.ctx } else { [int]$CFG.ctx }
    $mgrOutCap = [Math]::Max(4096, [Math]::Min(16384, [int]($mgrCtx / 8)))
    $mgrImage = [bool]$mgrEntry.cloud.image
    $mgrAttachment = if ($mgrImage) { "true" } else { "false" }
    $mgrInputModalities = if ($mgrImage) { '["text", "image"]' } else { '["text"]' }
    $mgrKey    = "sk-or-v1-not-configured"
    if (Test-Path "$SELF\mango-secrets.json") {
        $s2 = Get-Content "$SELF\mango-secrets.json" -Raw | ConvertFrom-Json
        if ($s2.($mgrEntry.cloud.api_key_field)) { $mgrKey = $s2.($mgrEntry.cloud.api_key_field) }
    }
    if ($mgrKey -eq "sk-or-v1-not-configured") {
        Write-Host (T "mango-code | manca $SELF\mango-secrets.json (o la chiave $($mgrEntry.cloud.api_key_field)): vedi mango-secrets.example.json." "mango-code | $SELF\mango-secrets.json is missing (or the key $($mgrEntry.cloud.api_key_field)): see mango-secrets.example.json.") -ForegroundColor Red
        exit 1
    }

    # The plugins must be DECLARED here: this folder is not the dev's OPENCODE_CONFIG_DIR, so
    # the automatic scan of 'plugin\' next to the file does not see them.
    $pluginList = ('"' + "$SELFJ\\opencode-home\\plugin\\mango-discipline.js" + '", "' + "$SELFJ\\opencode-home\\plugin\\mango-team.js" + '"')

    $OCHOME_MGR = "$RUNTIME\opencode-manager"
    New-Item -ItemType Directory -Force -Path $OCHOME_MGR | Out-Null
    Write-FromTemplate "$OCHOME\opencode.template.json" "$OCHOME_MGR\opencode.json" @{
        BASE_URL      = "$BASE/v1"
        CTX           = $mgrCtx
        OUTPUT        = $mgrOutCap
        LABEL         = "$($mgrEntry.label) $($mgrEntry.quant)"
        MODEL_KEY     = $Manager
        LOCAL_ATTACHMENT = $localAttachment
        LOCAL_INPUT_MODALITIES = $localInputModalities
        SCREENSHOT_TOOL = Get-ScreenshotTool $mgrImage
        SELF          = $SELFJ
        PROVIDER      = $mgrEntry.cloud.provider_key
        MODEL_REF     = $mgrEntry.cloud.model_id
        OR_BASE_URL   = $mgrEntry.cloud.base_url
        OR_API_KEY    = $mgrKey
        OR_MODEL_ID   = $mgrEntry.cloud.model_id
        OR_LABEL      = $mgrEntry.label
        OR_CTX        = $mgrCtx
        OR_OUTPUT     = $mgrOutCap
        OR_COST_IN    = $mgrEntry.cloud.cost.input
        OR_COST_OUT   = $mgrEntry.cloud.cost.output
        OR_COST_CACHE = $mgrEntry.cloud.cost.cache_read
        OR_ATTACHMENT = $mgrAttachment
        OR_INPUT_MODALITIES = $mgrInputModalities
        PLUGIN_LIST   = $pluginList
        ROLE_INSTRUCTIONS = ", `"$SELFJ\\opencode-home\\MANGO-manager.md`""
    }

    # --- AGENTS (up to 4) on OpenRouter ----------------------------------------------------
    # The manager can start, WHEN NEEDED, up to 4 agents in separate windows (the
    # `launch_agent` tool of mango-team.js). Each is an opencode process of its own, with ITS
    # config folder and ITS cloud model. Here the folders and scripts are prepared, NOTHING
    # is started: starting is on the manager's request, as for the dev.
    $agentKey = if ($Agent) { $Agent } else { "deepseek" }
    if ($KEYS -notcontains $agentKey) {
        Write-Host (T "mango-code | agente '$agentKey' sconosciuto. Disponibili: $($KEYS -join ', ')" "mango-code | unknown agent '$agentKey'. Available: $($KEYS -join ', ')") -ForegroundColor Red
        exit 1
    }
    $agentEntry = $CFG.models.$agentKey
    if (-not $agentEntry.cloud) {
        Write-Host (T "mango-code | '$agentKey' non e' un modello cloud: gli agenti usano un modello cloud (OpenRouter)." "mango-code | '$agentKey' is not a cloud model: agents use a cloud model (OpenRouter).") -ForegroundColor Red
        exit 1
    }
    if ($agentKey -eq $M.Key) {
        Write-Host (T "mango-code | l'agente e il dev non possono essere lo stesso modello ($agentKey)." "mango-code | the agent and the dev cannot be the same model ($agentKey).") -ForegroundColor Red
        exit 1
    }
    $agentCtx    = if ($agentEntry.ctx) { [int]$agentEntry.ctx } else { 262144 }
    $agentOutCap = [Math]::Max(4096, [Math]::Min(16384, [int]($agentCtx / 8)))
    $agentImage = [bool]$agentEntry.cloud.image
    $agentAttachment = if ($agentImage) { "true" } else { "false" }
    $agentInputModalities = if ($agentImage) { '["text", "image"]' } else { '["text"]' }
    $agentApiKey = "sk-or-v1-not-configured"
    if (Test-Path "$SELF\mango-secrets.json") {
        $s3 = Get-Content "$SELF\mango-secrets.json" -Raw | ConvertFrom-Json
        if ($s3.($agentEntry.cloud.api_key_field)) { $agentApiKey = $s3.($agentEntry.cloud.api_key_field) }
    }
    if ($agentApiKey -eq "sk-or-v1-not-configured") {
        Write-Host (T "mango-code | manca la chiave $($agentEntry.cloud.api_key_field) in mango-secrets.json per gli agenti." "mango-code | the key $($agentEntry.cloud.api_key_field) is missing in mango-secrets.json for the agents.") -ForegroundColor Red
        exit 1
    }

    $AGENT_MAX   = 4
    $AGENT_DIR   = "$RUNTIME\mango-agents"
    $AGENT_PORTS = @(4092, 4093, 4094, 4095)
    New-Item -ItemType Directory -Force -Path $AGENT_DIR | Out-Null
    for ($i = 1; $i -le $AGENT_MAX; $i++) {
        $port = $AGENT_PORTS[$i - 1]
        $adir = "$RUNTIME\opencode-agent-$i"
        New-Item -ItemType Directory -Force -Path $adir | Out-Null
        Write-FromTemplate "$OCHOME\opencode.template.json" "$adir\opencode.json" @{
            BASE_URL      = "$BASE/v1"
            CTX           = $agentCtx
            OUTPUT        = $agentOutCap
            LABEL         = "$($agentEntry.label) $($agentEntry.quant)"
            MODEL_KEY     = $agentKey
            LOCAL_ATTACHMENT = $localAttachment
            LOCAL_INPUT_MODALITIES = $localInputModalities
            SCREENSHOT_TOOL = Get-ScreenshotTool $agentImage
            SELF          = $SELFJ
            PROVIDER      = $agentEntry.cloud.provider_key
            MODEL_REF     = $agentEntry.cloud.model_id
            OR_BASE_URL   = $agentEntry.cloud.base_url
            OR_API_KEY    = $agentApiKey
            OR_MODEL_ID   = $agentEntry.cloud.model_id
            OR_LABEL      = $agentEntry.label
            OR_CTX        = $agentCtx
            OR_OUTPUT     = $agentOutCap
            OR_COST_IN    = $agentEntry.cloud.cost.input
            OR_COST_OUT   = $agentEntry.cloud.cost.output
            OR_COST_CACHE = $agentEntry.cloud.cost.cache_read
            OR_ATTACHMENT = $agentAttachment
            OR_INPUT_MODALITIES = $agentInputModalities
            PLUGIN_LIST   = $pluginList
            ROLE_INSTRUCTIONS = ", `"$SELFJ\\opencode-home\\MANGO-agent.md`""
        }
        # The window's script: mango-team.js launches it with `cmd /c start` when the manager
        # calls launch_agent. The first message (--prompt) makes the session start and write
        # the link: from there the manager can talk to it. The ports are FIXED like the dev's and
        # the manager's, so there is nothing to negotiate at runtime.
        $priming = "You are AGENT $i of the team. You have no memory of other conversations. Tell the manager you are ready with the ask_manager tool (one line only), then wait for its instructions."
        # The agent's stderr goes to a file: a runtime panic (Bun) dies with the window and without
        # this no trace is left. stdout and stdin stay on the console, so the TUI does not break.
        New-Item -ItemType Directory -Force -Path "$RUNTIME\logs" | Out-Null
        $script = @"
`$env:OPENCODE_CONFIG_DIR = '$adir'
`$env:MANGO_HOME = '$SELF'
`$env:MANGO_TEAM_ROLE = 'agent'
`$env:MANGO_AGENT_ID = '$i'
`$env:MANGO_IMAGE_MODELS = '$(if ($agentImage) { $agentEntry.cloud.model_id } else { "" })'
# The PID of THIS window: close_agent (mango-team.js) closes the tree starting from here.
Set-Content -Path '$AGENT_DIR\agent-$i.pid' -Value `$PID -Encoding ascii
`$log = '$RUNTIME\logs\agent-$i.log'
Add-Content -Path `$log -Value "=== start `$(Get-Date -Format o) ===" -Encoding utf8
Write-Host ''
Write-Host '  $(T "AGENTE" "AGENT") $i - $($agentEntry.label) (OpenRouter)' -ForegroundColor Cyan
Write-Host '  $(T "In attesa del manager. Puoi anche scrivergli qui direttamente." "Waiting for the manager. You can also write to it here directly.")' -ForegroundColor DarkGray
Write-Host ''
& '$OCEXE' --port $port --hostname 127.0.0.1 --auto --prompt "$priming" 2>> `$log
Add-Content -Path `$log -Value "=== exit `$(Get-Date -Format o) code `$LASTEXITCODE ===" -Encoding utf8
"@
        Set-Content -Path "$AGENT_DIR\agent-$i.ps1" -Value $script -Encoding utf8
    }
    # The manager needs these for launch_agent/ask_agent/list_agents/close_agent (mango-team.js).
    $env:MANGO_AGENT_MAX   = "$AGENT_MAX"
    $env:MANGO_AGENT_LABEL = "$($agentEntry.label) on OpenRouter"
    $env:MANGO_AGENT_DIR   = $AGENT_DIR
    $env:MANGO_AGENT_PORTS = ($AGENT_PORTS -join ",")

    # The links are reset at start: the processes rewrite them on their first turn.
    Remove-Item "$RUNTIME\team-link.json", "$RUNTIME\team-link-manager.json" -ErrorAction SilentlyContinue
    Remove-Item "$RUNTIME\team-link-agent-*.json" -ErrorAction SilentlyContinue
    Remove-Item "$AGENT_DIR\agent-*.pid" -ErrorAction SilentlyContinue

    # FIXED and EXPLICIT PORTS: MEASURED (2026-09-14) that in a normal TUI (`opencode --auto`,
    # without --port) the opencode server opens NO socket - neither Get-NetTCPConnection nor
    # netstat see anything on the PID, so the plugin's 'serverUrl' points to a port nobody
    # listens on and ask_dev dies with "Unable to connect". Passing --port (even 0, the OS picks
    # one) makes it really listen: here two known ports are fixed instead of a random 0, so
    # there is no need even to read serverUrl to know where the dev is.
    # Dev 1 on 4090 (as always): it is the only dev, so no other ports for it. 4092-4095 belong
    # to the agents.
    $DEV_PORT = 4090
    $MGR_PORT  = 4091

    # DEV in a separate window, with MANGO_TEAM_ROLE=dev: the plugin (mango-team.js in the dev
    # role) writes its link (team-link.json) at every turn, so the manager knows which session
    # to talk to now (the port is fixed).
    # The manager, in this window, writes team-link-manager.json: that is how the dev finds it
    # when it calls ask_manager.
    # The --prompt "[START] ..." makes the session (hence the link) start without the user having
    # to type "ready" in every window, and meanwhile puts the system prompt in cache: the first
    # real task does not pay the ~20k-token prefill. The plugin recognizes it and does not treat
    # it as a task (no end-of-turn reminder).
    $port = $DEV_PORT
    $tag  = "DEV"
    $boot = "[START] You are the $tag of the team. Do nothing now: reply only with the word ready and wait for instructions from the manager."
    $devCmd = "`$env:OPENCODE_CONFIG_DIR='$OCHOME'; `$env:MANGO_HOME='$SELF'; `$env:MANGO_TEAM_ROLE='dev'; " +
        "Write-Host ''; Write-Host '  $tag - $($M.Label)' -ForegroundColor Green; " +
        "Write-Host '  $(T "Si collega da solo al manager. Da qui puoi anche lavorare/verificare/discutere direttamente." "It connects to the manager by itself. From here you can also work/verify/discuss directly.")' -ForegroundColor DarkGray; " +
        "Write-Host ''; & '$OCEXE' --port $port --hostname 127.0.0.1 --auto --prompt '$boot'"
    Start-Process powershell -ArgumentList @("-NoExit", "-Command", $devCmd)
    Write-Host (T "$d   $($tag.ToLower()) aperto in una finestra separata ($($M.Label), porta $port)$r" "$d   $($tag.ToLower()) opened in a separate window ($($M.Label), port $port)$r")

    $env:OPENCODE_CONFIG_DIR = $OCHOME_MGR
    $env:MANGO_TEAM_ROLE     = "manager"
    $env:MANGO_IMAGE_MODELS  = if ($mgrImage) { $mgrEntry.cloud.model_id } else { "" }
    Write-Host (T "$d   manager: $y$($mgrEntry.label)$r $d qui in questa finestra$r" "$d   manager: $y$($mgrEntry.label)$r $d here in this window$r")
    Write-Host ""
}

# --- isolation ----------------------------------------------------------------------------
# OPENCODE_CONFIG_DIR moves opencode's WHOLE home in here: config, plugins, agents, commands.
# The user's "normal" opencode (~\.config\opencode) stays untouched and sees neither our
# skills nor our plugin.
# OPENCODE_DISABLE_PROJECT_CONFIG is NOT used anymore. It was there to stop an opencode.json
# inside any repo from rewriting our knobs (model, permissions, context), and the assumption
# was that project instructions would still be read because they are content, not
# configuration. MEASURED, and it is false: that flag also turns off the project's AGENTS.md
# and CLAUDE.md. Capturing the real request to the model, with the flag on the system prompt
# was 19432 characters and the repo's CLAUDE.md was not there; off, 22645 with
# "Instructions from: ...\CLAUDE.md" inside.
# The trade-off: a repo with an opencode.json of its own can change the settings. Reading the
# project rules still wins - without them the model works blind.
if (-not $Team) { $env:OPENCODE_CONFIG_DIR = $OCHOME; $env:MANGO_TEAM_ROLE = "" }
$env:MANGO_HOME                     = $SELF   # read by the plugins for the config folder and for -Team

# --- -Web: Mango Code in the browser -------------------------------------------------------
# A single agent server (`opencode serve`) that also serves the web UI built into the binary
# (the same as the terminal's). Same config generated above (provider on the local engine,
# fully autonomous permissions: the web UI has no --auto, only the config decides).
# Offline: the UI is inside the binary (the server never proxies it from app.opencode.ai);
# the switches below turn off models.dev, updates, sharing and LSP downloads.
# The connections the agent opens when it uses web search or fetch stay allowed.
# It does not open the browser and sends no prompt: it prints the address and stays in the
# foreground (Ctrl+C).
if ($Web) {
    $WORK = if ($Dir) { $Dir } else { (Get-Location).Path }
    if (-not (Test-Path $WORK -PathType Container)) { Write-Host (T "mango-code | cartella inesistente: $WORK" "mango-code | folder does not exist: $WORK") -ForegroundColor Red; exit 1 }
    $WORK = (Resolve-Path $WORK).Path
    $WEB_PORT = 4096
    if (Get-NetTCPConnection -LocalPort $WEB_PORT -State Listen -ErrorAction SilentlyContinue) {
        Write-Host (T "mango-code | la porta $WEB_PORT e' gia' occupata (un altro server web acceso?)." "mango-code | port $WEB_PORT is already in use (another web server running?).") -ForegroundColor Red
        exit 1
    }
    # No password: the server listens on 127.0.0.1 only and accepts requests only from local
    # pages (CORS without *.opencode.ai). With the password the browser asked for user and
    # password at every page reload.
    Remove-Item Env:OPENCODE_SERVER_PASSWORD, Env:OPENCODE_SERVER_USERNAME -ErrorAction SilentlyContinue
    $env:OPENCODE_DISABLE_AUTOUPDATE   = "1"
    $env:OPENCODE_DISABLE_MODELS_FETCH = "1"
    $env:OPENCODE_DISABLE_SHARE        = "1"
    $env:OPENCODE_DISABLE_LSP_DOWNLOAD = "1"
    # Two additions to the config, for the web UI only (the TUI gets them from --auto and does
    # not want them):
    # - doom_loop allow: it is the only permission that stays "ask" with the template's
    #   permissions, and in the browser it would stop the agent waiting for a click (fully
    #   autonomous);
    # - enabled_providers: the model selector shows only the running model, not the catalog of
    #   cloud providers that opencode carries inside.
    $env:OPENCODE_CONFIG_CONTENT = "{`"enabled_providers`": [`"$provider`"], `"permission`": {`"doom_loop`": `"allow`"}}"
    Write-Host (T "$d   web: cartella di lavoro $y$WORK$r" "$d   web: working folder $y$WORK$r")
    Write-Host (T "$d   apri nel browser:$r" "$d   open in the browser:$r")
    # project=: the web UI opens the working dir as a project by itself.
    # Native path, with Windows backslashes: the server stores sessions and projects that way, and with / slashes
    # the page lost the session at the first refresh ("Unable to retrieve the session").
    $proj = [uri]::EscapeDataString($WORK)
    Write-Host "     $o`http://127.0.0.1:$WEB_PORT/?project=$proj$r"
    # Dictation: the microphone button records in the browser and sends the audio to the web server
    # (POST /mango/voice/transcribe), which forwards it to this local service. The model is
    # loaded in the background: the page is usable right away, the first clip waits for the load.
    Remove-Item Env:MANGO_VOICE_URL -ErrorAction SilentlyContinue
    if (-not $NoVoice) {
        $VOICE_PORT = 4097
        if (Get-NetTCPConnection -LocalPort $VOICE_PORT -State Listen -ErrorAction SilentlyContinue) {
            Write-Host (T "$y   voce: la porta $VOICE_PORT e' occupata, il pulsante del microfono restera' spento.$r" "$y   voice: port $VOICE_PORT is in use, the microphone button will stay off.$r")
        } else {
            $VOICE_PROC = Start-Process -FilePath "python" -ArgumentList @("$SELF\mango-voice.py", "--serve", "--port", "$VOICE_PORT", "--parent", "$PID") `
                -WorkingDirectory $SELF -WindowStyle Hidden -PassThru -RedirectStandardError "$RUNTIME\logs\voice-serve.log"
            $env:MANGO_VOICE_URL = "http://127.0.0.1:$VOICE_PORT"
            Write-Host (T "$d   voce: pulsante del microfono nella pagina (trascrizione locale, porta $VOICE_PORT)$r" "$d   voice: microphone button in the page (local transcription, port $VOICE_PORT)$r")
        }
    }
    Write-Host (T "$d   per spegnere: Ctrl+C in questa finestra. Il motore resta acceso.$r" "$d   to stop: Ctrl+C in this window. The engine stays running.$r")
    Write-Host ""
    Push-Location $WORK
    try { & $OCEXE serve --hostname 127.0.0.1 --port $WEB_PORT } finally { Pop-Location; Stop-MangoVoice }
    exit $LASTEXITCODE
}

# Argument mapping: mango-code's one-shot is `-p "..."`, in opencode it is
# `opencode run "..."`. It is translated here.
$args2 = @($AgentArgs | Where-Object { $_ })
$oargs = @()
if ($args2.Count -gt 0 -and ($args2[0] -eq "-p" -or $args2[0] -eq "--print")) {
    $oargs = @("run") + $args2[1..($args2.Count-1)]
} elseif ($args2.Count -gt 0 -and $args2[0] -notlike "-*") {
    # a bare prompt without -p: same thing, one-shot
    $oargs = @("run") + $args2
} else {
    $oargs = $args2
}
# --auto: automatically approves everything that is not explicitly denied in opencode.json.
# The "deny" entries written in the config stay deny: full autonomy is declared item by item,
# it is not a single switch.
# The POSITION matters, and was measured: `opencode --auto run "..."` does not start, it just
# prints the help - the flag goes AFTER the subcommand (`opencode run --auto "..."`). In the TUI,
# where there is no subcommand, it goes first as usual.
if ($oargs.Count -gt 0 -and $oargs[0] -eq "run") {
    $oargs = @("run", "--auto") + @($oargs[1..($oargs.Count-1)])
} else {
    $oargs = @("--auto") + $oargs
}
# -Team needs a REAL port (see above for why): without it, this instance (the manager) would
# listen to nothing and the dev, when it calls ask_manager, would find nobody. The dev really
# uses it: `ask_dev` goes one way, `ask_manager` the other, both via promptAsync on the other
# process's socket.
if ($Team) { $oargs = @("--port", "$MGR_PORT", "--hostname", "127.0.0.1") + $oargs }

try { & $OCEXE @oargs } finally { Stop-MangoVoice }
exit $LASTEXITCODE
