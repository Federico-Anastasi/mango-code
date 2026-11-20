param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Directory,
    [string]$Session = ""
)

# Sends a message to the agent with the same routes as the web UI: creates the session if there is none and
# uses prompt_async (does not wait for the reply). Useful when keyboard automation is not
# reliable; the UI stays the real one, and renders everything the server does.
# The agent's address is the one in service.json: its port is not always 4096.
$data = if ($env:MANGO_DATA) { $env:MANGO_DATA } else { Join-Path $env:LOCALAPPDATA "MangoCode" }
$agent = (Get-Content (Join-Path $data "service.json") -Raw | ConvertFrom-Json).agent
$dir = [uri]::EscapeDataString($Directory)
if (-not $Session) {
    $r = Invoke-WebRequest -Uri "$agent/session?directory=$dir" -Method POST -Body '{"title":"test"}' -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20
    $Session = ($r.Content | ConvertFrom-Json).id
}
$body = @{ parts = @(@{ type = "text"; text = $Text }) } | ConvertTo-Json -Depth 6 -Compress
$r2 = Invoke-WebRequest -Uri "$agent/session/$Session/prompt_async?directory=$dir" -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20
Write-Output ("session={0} status={1}" -f $Session, $r2.StatusCode)
