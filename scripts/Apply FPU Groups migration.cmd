@echo off
setlocal enabledelayedexpansion
title FPU Groups and Attendance - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   FPU GROUPS AND ATTENDANCE - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates three tables:
echo       fpu_class_groups         - the groups of a class
echo       fpu_group_members        - who is in which group
echo       fpu_session_attendance   - one present/absent mark per week
echo.
echo   and adds columns to two existing tables:
echo       fpu_classes      - class_closed_on / class_closed_by
echo       fpu_enrollments  - the "failed" outcome and HR's override
echo.
echo   It does NOT touch payroll, dispatch, paystubs, rates, MESA
echo   accounts or the MESA ledger. Nobody's membership changes.
echo.
echo   This is a DIFFERENT migration from "Apply FPU Classes" - that
echo   one is already done and is not re-run here.
echo.
echo   DATABASE_URL in .env.local points at PRODUCTION.
echo.
echo  ---------------------------------------------------------------
echo   STEP 1 of 2 - REHEARSAL
echo.
echo   The migration runs inside a transaction that is always rolled
echo   back, so the database is left exactly as it is now. This proves
echo   it works, and that every rule it adds actually bites, before
echo   anything is kept.
echo  ---------------------------------------------------------------
echo.
pause

call node --import tsx scripts/apply-fpu-groups-migration.mts
set "REHEARSAL=%ERRORLEVEL%"

echo.
if not "%REHEARSAL%"=="0" (
  echo  ===============================================================
  echo   REHEARSAL FAILED - nothing was changed.
  echo.
  echo   Scroll up for the line marked FAIL or MISS and send it to
  echo   Claude. Do not run this again until it is fixed.
  echo  ===============================================================
  echo.
  pause
  exit /b 1
)

echo  ===============================================================
echo   REHEARSAL PASSED. Nothing has been saved yet.
echo  ===============================================================
echo.
echo   STEP 2 of 2 - APPLY FOR REAL
echo.
echo   This writes the three tables and the new columns to the
echo   production database. It is not reversible from here.
echo.
echo   Type  APPLY  and press Enter to go ahead.
echo   Press Enter on its own to stop and change nothing.
echo.

set "CONFIRM="
set /p "CONFIRM=Your answer: "

if /i not "%CONFIRM%"=="APPLY" (
  echo.
  echo   Stopped. Nothing was changed.
  echo.
  pause
  exit /b 0
)

echo.
echo   Applying...
echo.

call node --import tsx scripts/apply-fpu-groups-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. Groups and attendance are live.
  echo.
  echo   Open HR -^> MESA -^> FPU Classes, pick a class whose enrollment
  echo   is closed, and the Groups panel will ask how many people per
  echo   group. Employees see their group under MESA -^> FPU Class.
  echo  ===============================================================
) else (
  echo  ===============================================================
  echo   SOMETHING WENT WRONG during apply.
  echo.
  echo   Scroll up and send the failing line to Claude. Some objects may
  echo   have been created - do not re-run until it has been checked.
  echo  ===============================================================
)

echo.
pause
endlocal
