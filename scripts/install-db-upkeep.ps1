<#
.SYNOPSIS
  Backs up the dashboard's user database every night.

.DESCRIPTION
  Adds a Task Scheduler task, "NDHD database upkeep", for your user only. At
  03:00 it runs scripts\db_upkeep.py, which writes a backup to backups\ and
  clears out old records. If the PC is off then, it runs at the next chance.
  Its output goes to logs\db-upkeep.log.

  No administrator rights needed. Running it again replaces the task. -Remove
  deletes it. The backups themselves stay.

.EXAMPLE
  .\scripts\install-db-upkeep.ps1
.EXAMPLE
  .\scripts\install-db-upkeep.ps1 -Remove
#>
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = 'NDHD database upkeep'

if ($Remove) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed: nightly database upkeep is off." -ForegroundColor Green
    exit 0
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw "No .venv found. Set it up first: docs\RUNNING.md, step 1.1." }
$command = "New-Item -ItemType Directory -Force logs | Out-Null; & '$python' scripts\db_upkeep.py *>> logs\db-upkeep.log"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Backs up the NDHD user database and clears old records (scripts\db_upkeep.py).' -Force | Out-Null
Write-Host "Done: the database is backed up nightly at 03:00, into backups\." -ForegroundColor Green
Write-Host "Log: $root\logs\db-upkeep.log.   Undo: .\scripts\install-db-upkeep.ps1 -Remove"
