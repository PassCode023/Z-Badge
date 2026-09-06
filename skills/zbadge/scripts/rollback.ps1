# zbadge / rollback.ps1  (must run ELEVATED)
# Restores work\app.asar.unpatched (clean current-version baseline) and clears state.
$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$work      = Join-Path $skillRoot 'work'
$backup    = Join-Path $work 'app.asar.unpatched'
$cands = @($env:ZCODE_INSTALL_DIR, "$env:SystemDrive\Program Files\ZCode", 'D:\Program Files\ZCode', "$env:LOCALAPPDATA\Programs\ZCode") | Where-Object { $_ }
$target = $null
foreach ($c in $cands) { $p = Join-Path $c 'resources\app.asar'; if (Test-Path $p) { $target = $p; break } }
if (-not $target) { $target = Join-Path "$env:SystemDrive\Program Files\ZCode" 'resources\app.asar' }
$state     = Join-Path $work 'state.json'
$log       = Join-Path $work 'rollback.log'
"=== rollback start $(Get-Date -Format o) ===" | Out-File $log -Encoding ascii
try {
    if (-not (Test-Path $backup)) { throw "backup not found: $backup" }
    $srcHash = (Get-FileHash $backup -Algorithm SHA256).Hash
    Copy-Item $backup $target -Force
    $dstHash = (Get-FileHash $target -Algorithm SHA256).Hash
    if ($srcHash -ne $dstHash) { throw 'hash mismatch after restore' }
    if (Test-Path $state) { Remove-Item $state -Force }
    "RESULT: OK" | Out-File $log -Append -Encoding ascii
    exit 0
} catch {
    "RESULT: FAILED - $($_.Exception.Message)" | Out-File $log -Append -Encoding ascii
    exit 1
}
