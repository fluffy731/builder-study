#!/usr/bin/env bash
# Creates the DB-U registration folder tree inside OneDrive (macOS/Linux).
# Usage: ./make-onedrive-folders.sh "/Users/you/Library/CloudStorage/OneDrive-Personal"
set -euo pipefail
BASE="${1:?Pass your OneDrive folder path as the first argument}"
ROOT="$BASE/DB-U-Registration"
for d in 00_Admin-Tracker 01_Identity-Eligibility 02_Qualifications 03_Experience-Evidence \
  03_Experience-Evidence/P1 03_Experience-Evidence/P2 03_Experience-Evidence/P3 03_Experience-Evidence/P4 \
  04_Technical-Referee 05_Insurance-Financial 06_Business-Setup 07_Application-Submission \
  08_Exam-Assessment 09_Correspondence 10_Post-Registration 99_Archive; do
  mkdir -p "$ROOT/$d"
done
echo "Created: $ROOT"
echo "Next: move 01_Identity-Eligibility and 05_Insurance-Financial into OneDrive Personal Vault."
