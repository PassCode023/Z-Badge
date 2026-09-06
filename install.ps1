# zbadge installer (non-elevated): copies both skills into the user skills dir.
# After this, restart ZCode and tell your agent: 安装 zbadge
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'skills'
$dst = Join-Path $env:USERPROFILE '.agents\skills'
New-Item -ItemType Directory -Force -Path $dst | Out-Null
foreach ($s in 'zbadge', 'model-speed') {
    robocopy (Join-Path $src $s) (Join-Path $dst $s) /MIR /XD work node_modules /NFL /NDL /NJH /NJS | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Output "COPY-FAILED: $s (robocopy exit $LASTEXITCODE)"; exit 1 }
}
Write-Output "OK: skills copied to $dst"
Write-Output 'Next: fully quit ZCode (tray too), start it, then tell your agent: 安装 zbadge'
