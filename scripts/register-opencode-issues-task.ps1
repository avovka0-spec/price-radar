param(
  [string]$TaskName = "OpenCodeTelegramIssues",
  [string]$RepoDir = "D:\Prog_dev\ai\price-radar",
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = "Stop"
$node = (Get-Command node -ErrorAction Stop).Source
$vbs = Join-Path $RepoDir "scripts\run-hidden.vbs"
if (!(Test-Path $vbs)) { throw "Missing $vbs" }

# Use wscript + VBS launcher to avoid console window flash. Do NOT use conhost --headless:
# on some systems it can cause monitor flicker/display reset.
$arg = "//nologo `"$vbs`" `"`"$node`" scripts\opencode-issues-watcher.mjs`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $arg -WorkingDirectory $RepoDir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "ЦенРадар/OpenCode: приём telegram-task Issues и запуск opencode (без мигания окна)" -Force | Out-Null

Write-Host "Task '$TaskName' registered/updated."
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName,LastRunTime,NextRunTime,LastTaskResult
