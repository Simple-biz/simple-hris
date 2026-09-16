@echo off
setlocal enabledelayedexpansion
title External API clients - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   EXTERNAL API CLIENTS - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates two tables behind Admin -^> API tokens -^>
echo   External access: external_api_clients (the per-system keys,
echo   stored only as a hash) and external_api_requests (one row per
echo   call to /api/external/v1/*, including denied ones).
echo.
echo   It does NOT touch the Global Master List, payroll, dispatch,
echo   paystubs, rates or any existing table.
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

call node --import tsx scripts/apply-external-api-clients-migration.mts
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
echo   This writes external_api_clients and external_api_requests to
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

call node --import tsx scripts/apply-external-api-clients-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. External access is live.
  echo.
  echo   Open Admin -^> API tokens -^> External access and click
  echo   "New client". The key is shown ONCE - copy it to your coworker
  echo   over a private channel. Revoke it from the same table any time.
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
