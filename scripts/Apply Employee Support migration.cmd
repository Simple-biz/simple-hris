@echo off
setlocal enabledelayedexpansion
title Employee Support - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   EMPLOYEE SUPPORT - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates two tables:
echo       employee_support_tickets
echo       employee_support_messages
echo.
echo   It does NOT touch payroll, dispatch, paystubs, rates or the
echo   existing tickets board. Nothing that already exists is altered.
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

call node --import tsx scripts/apply-employee-support-migration.mts
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
echo   This writes the two tables to the production database. It is
echo   not reversible from here.
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

call node --import tsx scripts/apply-employee-support-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. The two tables are live.
  echo.
  echo   There is no screen to look at yet - the Employee Support
  echo   button and the /tickets section are still being built. This
  echo   step just means they will work when they land.
  echo  ===============================================================
) else (
  echo  ===============================================================
  echo   SOMETHING WENT WRONG during apply.
  echo.
  echo   Scroll up and send the failing line to Claude. Some tables may
  echo   have been created - do not re-run until it has been checked.
  echo  ===============================================================
)

echo.
pause
endlocal
