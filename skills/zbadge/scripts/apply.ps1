# zbadge / apply.ps1  (must run ELEVATED)
# Copies work\app-patched.asar over the installed app.asar, verifies SHA256,
# records work\state.json. ASCII-only.
$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$work      = Join-Path $skillRoot 'work'
$patched   = Join-Path $work 'app-patched.asar'
$cands = @($env:ZCODE_INSTALL_DIR, "$env:SystemDrive\Program Files\ZCode", 'D:\Program Files\ZCode', "$env:LOCALAPPDATA\Programs\ZCode") | Where-Object { $_ }
$target = $null
foreach ($c in $cands) { $p = Join-Path $c 'resources\app.asar'; if (Test-Path $p) { $target = $p; break } }
if (-not $target) { $target = Join-Path "$env:SystemDrive\Program Files\ZCode" 'resources\app.asar' }
$state     = Join-Path $work 'state.json'
$log       = Join-Path $work 'apply.log'
"=== apply start $(Get-Date -Format o) ===" | Out-File $log -Encoding ascii
try {
    if (-not (Test-Path $patched)) { throw "patched asar not found: $patched" }
    if (-not (Test-Path $target))  { throw "target not found: $target" }
    $srcHash = (Get-FileHash $patched -Algorithm SHA256).Hash
    Copy-Item $patched $target -Force
    $dstHash = (Get-FileHash $target -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw 'hash mismatch after copy' }
    ('{"installedSha256":"' + $dstHash.ToLower() + '","patchedAt":"' + (Get-Date -Format o) + '"}') |
        Out-File $state -Encoding ascii -NoNewline
    "RESULT: OK" | Out-File $log -Append -Encoding ascii
    exit 0
} catch {
    "RESULT: FAILED - $($_.Exception.Message)" | Out-File $log -Append -Encoding ascii
    exit 1
}
