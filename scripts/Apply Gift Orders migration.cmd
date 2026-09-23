@echo off
setlocal enabledelayedexpansion
title Gift Orders - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   GIFT ORDERS - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates two tables and two functions:
echo       gift_orders
echo       gift_order_lines
echo.
echo   It does NOT touch payroll, dispatch, paystubs, the gift
echo   submissions or the catalog. Nothing that already exists is altered.
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

call node --import tsx scripts/apply-gift-orders-migration.mts
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

rem set /p keeps whatever was typed verbatim, trailing spaces included, so
rem "APPLY " would silently fail the comparison and look like a refusal. Strip
rem every space before comparing -- a confirmation that quietly does nothing is
rem worse than no confirmation at all.
if defined CONFIRM set "CONFIRM=%CONFIRM: =%"
if defined CONFIRM set "CONFIRM=%CONFIRM:"=%"

if /i not "%CONFIRM%"=="APPLY" (
  echo.
  echo  ===============================================================
  echo   STOPPED - NOTHING WAS CHANGED. The tables were NOT created.
  echo.
  if defined CONFIRM (
    echo   You typed: "%CONFIRM%"  - it has to be the word APPLY.
  ) else (
    echo   Nothing was typed.
  )
  echo.
  echo   Run this file again and type  APPLY  at the prompt.
  echo  ===============================================================
  echo.
  pause
  exit /b 0
)

echo.
echo   Applying...
echo.

call node --import tsx scripts/apply-gift-orders-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. The two tables are live.
  echo.
  echo   HR - Gift Tracker - Orders can now lock orders and build
  echo   the invoice PDF. Tell Claude it landed so the deploy note
  echo   is marked done.
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
