# mango-catalog.ps1 - the model catalog, as the terminal sees it. The profiles and the engine plan are chosen by
# mango-launch.exe, the app's logic (see mango-engine.ps1). Include it with
#   . "$PSScriptRoot\mango-catalog.ps1"
# Same rules as the app (app\crates\engine-cfg, mango-common\catalog.rs):
#   - mango-models.json is Mango Code's catalog; <data>\user-models.json (same format: {"models": {...}})
#     adds the user's models to it. A key already taken by the catalog is an error.
#   - list order: the catalog's local models in 'order', then the user's models by key, then the cloud ones.
# <data> is %LOCALAPPDATA%\MangoCode, or MANGO_DATA.

$DATA = if ($env:MANGO_DATA) { $env:MANGO_DATA } else { Join-Path $env:LOCALAPPDATA "MangoCode" }

# The Windows display language, Italian or English. Also for the agent's texts when no language is chosen: Bun only
# knows the regional format, which can differ.
$env:MANGO_SYSTEM_LANGUAGE = if ((Get-UICulture).TwoLetterISOLanguageName -eq "it") { "it" } else { "en" }

# The language of the messages: the one chosen in <data>\settings.json ("language": "it" or "en", shared with the
# app and the web UI), otherwise the Windows display language.
function Get-MangoLanguage {
    $f = Join-Path $DATA "settings.json"
    $chosen = if (Test-Path $f) { try { (Get-Content $f -Raw | ConvertFrom-Json).language } catch { $null } }
    if ($chosen -in "it", "en") { return $chosen }
    $env:MANGO_SYSTEM_LANGUAGE
}
$MANGO_LANG = Get-MangoLanguage

# A user-facing text in both languages: T "testo italiano" "English text".
function T([string]$It, [string]$En) { if ($MANGO_LANG -eq "it") { $It } else { $En } }

# Returns Cfg (the merged catalog), Keys (all the keys, in list order), Local (only the local ones, in the same
# order) and User (the keys that come from the user's file).
function Get-Catalog([string]$self) {
    $cfg = Get-Content "$self\mango-models.json" -Raw | ConvertFrom-Json
    $userKeys = @()
    $userFile = Join-Path $DATA "user-models.json"
    if (Test-Path $userFile) {
        try { $u = Get-Content $userFile -Raw | ConvertFrom-Json }
        catch { Write-Host (T "mango-code | il tuo elenco di modelli ($userFile) non e' valido: correggilo o toglilo." "mango-code | your model list ($userFile) is not valid: fix it or remove it.") -ForegroundColor Red; exit 1 }
        if (-not $u.models) { Write-Host (T "mango-code | il tuo elenco di modelli ($userFile) non ha 'models'." "mango-code | your model list ($userFile) has no 'models'.") -ForegroundColor Red; exit 1 }
        foreach ($p in $u.models.PSObject.Properties) {
            if ($cfg.models.PSObject.Properties[$p.Name]) {
                Write-Host (T "mango-code | nel tuo elenco di modelli ($userFile) '$($p.Name)' ha lo stesso nome di un modello di Mango Code: cambia la chiave." "mango-code | in your model list ($userFile) '$($p.Name)' has the same name as a Mango Code model: change the key.") -ForegroundColor Red
                exit 1
            }
            $cfg.models | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value
            $userKeys += $p.Name
        }
    }
    [string[]]$userKeys = $userKeys
    [Array]::Sort($userKeys, [StringComparer]::Ordinal)
    $localKeys = @($cfg.order) + @($userKeys | Where-Object { -not $cfg.models.$_.cloud })
    $cloudKeys = @($cfg.models.PSObject.Properties.Name | Where-Object { $localKeys -notcontains $_ })
    [pscustomobject]@{ Cfg = $cfg; Keys = @($localKeys + $cloudKeys); Local = $localKeys; User = $userKeys }
}
