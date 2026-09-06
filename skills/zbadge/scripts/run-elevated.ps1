# zbadge / run-elevated.ps1
# Launches another .ps1 from this scripts\ dir elevated (UAC prompt) and waits.
# Usage: powershell -File run-elevated.ps1 apply.ps1
param([Parameter(Mandatory=$true)][string]$InnerScript)
$ErrorActionPreference = 'Stop'
$inner = Join-Path $PSScriptRoot $InnerScript
try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$inner
    Write-Output 'ELEVATED-RAN'
} catch {
    Write-Output ('UAC-DENIED-OR-FAILED: ' + $_.Exception.Message)
    exit 1
}
