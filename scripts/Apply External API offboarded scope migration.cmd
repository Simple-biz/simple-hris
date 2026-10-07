@echo off
setlocal enabledelayedexpansion
title External API offboarded scope - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   EXTERNAL API - OFFBOARDED LIST SCOPE
echo  ===============================================================
echo.
echo   This lets an Integrations key hold the new "Offboarded" dataset
echo   (the leavers list). It changes ONE rule on external_api_clients:
echo   the list of scopes a key may carry gains offboarded.read.
echo.
echo   It does NOT touch any row, any existing key, the Global Master
echo   List, offboarding, payroll or any other table. Every existing
echo   client keeps exactly the access it has.
echo.
echo   DATABASE_URL in .env.local points at PRODUCTION.
echo.
echo  ---------------------------------------------------------------
echo   STEP 1 of 2 - REHEARSAL (always rolled back)
echo  ---------------------------------------------------------------
echo.
pause

call node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts
set "REHEARSAL=%ERRORLEVEL%"

echo.
if not "%REHEARSAL%"=="0" (
  echo  ===============================================================
  echo   REHEARSAL FAILED - nothing was changed.
  echo.
  echo   Scroll up for the line marked MISS and send it to Claude.
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

call node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. Keys can now hold the Offboarded list.
  echo.
  echo   Admin -^> Webhooks ^& Integrations -^> Integrations: New client
  echo   (or Edit an existing one) and tick "Offboarded" under Datasets.
  echo  ===============================================================
) else (
  echo  ===============================================================
  echo   SOMETHING WENT WRONG during apply.
  echo.
  echo   Scroll up and send the failing line to Claude.
  echo  ===============================================================
)

echo.
pause
endlocal
