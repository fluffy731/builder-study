# Creates the DB-U registration folder tree inside OneDrive (Windows PowerShell).
# Usage: .\make-onedrive-folders.ps1            (uses $env:OneDrive)
#        .\make-onedrive-folders.ps1 -Base "D:\OneDrive"
param([string]$Base = $env:OneDrive)
if (-not $Base) { Write-Error "OneDrive path not found. Pass -Base."; exit 1 }
$root = Join-Path $Base "DB-U-Registration"
$dirs = @(
 "00_Admin-Tracker","01_Identity-Eligibility","02_Qualifications","03_Experience-Evidence",
 "03_Experience-Evidence\P1","03_Experience-Evidence\P2","03_Experience-Evidence\P3","03_Experience-Evidence\P4",
 "04_Technical-Referee","05_Insurance-Financial","06_Business-Setup","07_Application-Submission",
 "08_Exam-Assessment","09_Correspondence","10_Post-Registration","99_Archive")
foreach ($d in $dirs) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
Write-Host "Created: $root"
Write-Host "Next: move 01_Identity-Eligibility and 05_Insurance-Financial into OneDrive Personal Vault."
