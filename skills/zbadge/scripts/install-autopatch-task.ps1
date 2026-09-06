# zbadge / install-autopatch-task.ps1  (must run ELEVATED)
# Registers the hidden auto-repatch scheduled task (logon + every 10 min, Highest, no UAC).
# P0 加固:任务入口是 ~/.zcode/zbadge/ 下的 trampoline(独立于技能目录),
# 技能目录被删时 trampoline 自动注销任务,不会产生任何弹窗。
$ErrorActionPreference = 'Stop'
$taskName = 'ZbadgeAutoPatch'
$skillRoot = Split-Path -Parent $PSScriptRoot
$work = Join-Path $skillRoot 'work'
$log = Join-Path $work 'task-install.log'
"=== task install start $(Get-Date -Format o) ===" | Out-File $log -Encoding ascii
try {
    $runner = Join-Path $env:USERPROFILE '.zcode\zbadge\trampoline.vbs'
    if (-not (Test-Path $runner)) {
    # first run: generate trampoline OUTSIDE the skill dir (DL-037: self-deregisters if skill deleted)
    $skillJs = Join-Path $skillRoot 'scripts\auto-repatch.js'
    $disabled = Join-Path $skillRoot 'DISABLED'
    $nl = [Environment]::NewLine
    $vbs = (@(
        'Option Explicit',
        'Dim fso, sh, skillJs',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'Set sh = CreateObject("WScript.Shell")',
        ('skillJs = "' + $skillJs + '"'),
        'If Not fso.FileExists(skillJs) Then',
        ('  sh.Run "cmd /c schtasks /Delete /TN ' + $taskName + ' /F", 0, False'),
        '  WScript.Quit 0',
        'End If',
        ('If fso.FileExists("' + $disabled + '") Then WScript.Quit 0'),
        'sh.Run "node """ & skillJs & """", 0, False'
    ) -join $nl) + $nl
    $dir = Split-Path -Parent $runner
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    [IO.File]::WriteAllText($runner, $vbs, [Text.Encoding]::ASCII)
  }
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $runner + '"')
    $tLogon = New-ScheduledTaskTrigger -AtLogOn
    $tCycle = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
        -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $tLogon, $tCycle `
        -Settings $settings -Principal $principal -Force | Out-Null
    $info = (Get-ScheduledTask -TaskName $taskName).State
    "RESULT: OK - task=$taskName state=$info" | Out-File $log -Append -Encoding ascii
    Write-Output "TASK-INSTALLED state=$info"
    exit 0
} catch {
    "RESULT: FAILED - $($_.Exception.Message)" | Out-File $log -Append -Encoding ascii
    Write-Output ('TASK-INSTALL-FAILED: ' + $_.Exception.Message)
    exit 1
}
