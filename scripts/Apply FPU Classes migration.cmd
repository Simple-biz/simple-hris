@echo off
setlocal enabledelayedexpansion
title FPU Classes - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   FPU CLASSES - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates the fpu_classes table (HR -^> MESA -^> FPU Classes)
echo   and adds review columns to the existing fpu_enrollments table
echo   (class_id, status, start_date_used, reviewed_by/at, notes,
echo   completed_on). The one legacy sign-up row is kept untouched.
echo.
echo   It does NOT touch payroll, dispatch, paystubs, rates, MESA
echo   accounts or the MESA ledger.
echo.
echo   DATABASE_URL in .env.local points at PRODUCTION.
echo.
echo  ---------------------------------------------------------------
echo   STEP 1 of 2 - REHEARSAL
echo.
echo   The migration runs inside a transaction that is always rolled
echo   back, so the database is left exactly as it is now. This proves
echo   it works before anything is kept.
echo  ---------------------------------------------------------------
echo.
pause

call node --import tsx scripts/apply-fpu-classes-migration.mts
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
echo   This writes fpu_classes and the new fpu_enrollments columns to
echo   the production database. It is not reversible from here.
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

call node --import tsx scripts/apply-fpu-classes-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. FPU classes are live.
  echo.
  echo   Open HR -^> MESA -^> FPU Classes and click "+ New class" to open
  echo   the first enrollment window. Employees see it under
  echo   MESA -^> FPU Class once the window opens.
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
