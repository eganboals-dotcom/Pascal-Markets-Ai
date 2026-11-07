# Opens the Kalshi scanner dashboard in its own app window. Starts the local server hidden when it
# is not already running, and stops it again when the window closes if this script started it.
Set-Location (Join-Path $PSScriptRoot "..")
$url = "http://127.0.0.1:8787"
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
          "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1

function Test-Dashboard {
    try { (Invoke-WebRequest "$url/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
}

$server = $null
if (-not (Test-Dashboard)) {
    $server = Start-Process -FilePath "node" -ArgumentList "src/cli.js", "serve" -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 40 -and -not (Test-Dashboard); $i++) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Dashboard)) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show("The Pascal Markets server did not start. Check that Node.js 22.4 or newer is installed.", "Pascal Markets") | Out-Null
        if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
        exit 1
    }
}

if ($edge) {
    # A separate profile keeps this window in its own Edge process, so -Wait returns when it closes.
    $windowProfile = Join-Path (Get-Location) ".cache\dashboard-window"
    Start-Process -FilePath $edge -Wait -ArgumentList "--app=$url", "--user-data-dir=`"$windowProfile`"",
        "--window-size=1480,920", "--no-first-run", "--no-default-browser-check"
} else {
    Start-Process $url
    exit 0  # shortcut: without Edge the page opens in the default browser and the server keeps running
}

if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id }
