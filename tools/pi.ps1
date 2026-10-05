# Run something on a Pi beside the TV, from Windows, and bring the reports back.
#
#   $env:HEARTH_PI = "pi@192.168.1.50"          # once per shell; or pass -Pi
#   $env:HEARTH_TV = "titanos-mt9620"           # names the report file; or pass -Tv
#   .\tools\pi.ps1                              # sync tools/, run tools/pi-first-report.sh
#   .\tools\pi.ps1 "node tools/verify-cec.mjs"  # any command, in the repo, with Node on PATH
#
# Needs key-based ssh to the Pi. A non-interactive ssh reads no .profile, so
# Node's directory is put on PATH here — the same thing a service unit will
# have to do.
param(
  [string]$Command = "bash tools/pi-first-report.sh",
  [string]$Pi = $env:HEARTH_PI,
  [string]$PiRepo = "~/hearth",
  [string]$Tv = $(if ($env:HEARTH_TV) { $env:HEARTH_TV } else { "tv" })
)
$ErrorActionPreference = "Stop"
if (-not $Pi) { throw "Set `$env:HEARTH_PI = 'user@host' or pass -Pi user@host." }
$Local = Split-Path -Parent $PSScriptRoot

Write-Host "== push tools/ to $Pi" -ForegroundColor Cyan
scp -q "$Local\tools\pi-first-report.sh" "${Pi}:$PiRepo/tools/"

Write-Host "== run on the Pi: $Command" -ForegroundColor Cyan
ssh -t $Pi "export HEARTH_TV=$Tv PATH=`$HOME/.local/node/bin:`$HOME/.local/bin:`$PATH; cd $PiRepo && $Command"

Write-Host "== pull reports back" -ForegroundColor Cyan
scp -q "${Pi}:$PiRepo/docs/platform/reports/pi*.md" "$Local\docs\platform\reports\" 2>$null
scp -q "${Pi}:$PiRepo/docs/platform/reports/pi*.log" "$Local\docs\platform\reports\" 2>$null
Get-ChildItem "$Local\docs\platform\reports\pi*" | Select-Object Name, Length, LastWriteTime
