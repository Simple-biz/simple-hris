@echo off
setlocal enabledelayedexpansion
title Employee Support Live Chat - database migration

cd /d "%~dp0.."

echo.
echo  ===============================================================
echo   EMPLOYEE SUPPORT - LIVE CHAT - DATABASE MIGRATION
echo  ===============================================================
echo.
echo   This creates three tables:
echo       employee_support_chat_sessions
echo       employee_support_chat_messages
echo       employee_support_chat_agents
echo.
echo   It also adds the TICKET side triage columns to the existing
echo   employee_support_tickets table (priority, triaged_at, triaged_by)
echo.
echo   And it widens two existing CHECK lists:
echo       employee_roles.role            + employee_support
echo       employee_notifications.type    + support_chat.replied
echo                                      + support_chat.became_ticket
echo                                      + support.replied
echo                                      + support.answered
echo.
echo   The widens only ever ADD values - each one reads the live
echo   constraint first and unions onto it, so nothing can be dropped.
echo.
echo   It does NOT touch payroll, dispatch, paystubs, rates or the
echo   existing tickets board.
echo.
echo  ---------------------------------------------------------------
echo   BEFORE YOU START - TWO THINGS
echo  ---------------------------------------------------------------
echo.
echo   1. The Employee Support TICKET migration has to have run first.
echo      Chat points at its table. If it has not, this stops and
echo      tells you, and nothing is changed.
echo.
echo   2. The two widened lists were REBUILT FROM THE REPO, not read
echo      from the database. They are written so they can only ever
echo      ADD to what is already there - each one reads the live list
echo      and adds to it, so nothing can be dropped - but the
echo      rehearsal below will print a NOTICE line if what is live
echo      differs from what was expected. Read those lines.
echo.
echo   3. While this runs, notifications and role changes briefly
echo      queue up behind it - seconds, not minutes. Do not run it in
echo      the middle of a payroll notification burst.
echo.
echo   DATABASE_URL in .env.local points at PRODUCTION.
echo.
echo  ---------------------------------------------------------------
echo   STEP 1 of 2 - REHEARSAL
echo.
echo   Everything runs inside ONE transaction that is always rolled
echo   back, so the database is left exactly as it is now. This proves
echo   all three files work together before anything is kept.
echo  ---------------------------------------------------------------
echo.
pause

call node --import tsx scripts/apply-employee-support-chat-migration.mts
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
echo   Before you go on: scroll up and read any line that starts with
echo   NOTICE. Those come from the two list widens and are the only
echo   place the live database gets to disagree with what the repo
echo   believed. A NOTICE is not a failure - it is information.
echo.
echo   STEP 2 of 2 - APPLY FOR REAL
echo.
echo   This writes the three tables and the two widened lists to the
echo   production database. It is not reversible from here.
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
  echo   STOPPED - NOTHING WAS CHANGED. No tables were created and no
  echo   list was widened.
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

call node --import tsx scripts/apply-employee-support-chat-migration.mts --apply
set "APPLIED=%ERRORLEVEL%"

echo.
if "%APPLIED%"=="0" (
  echo  ===============================================================
  echo   DONE. The three tables are live and both lists are widened.
  echo.
  echo   TWO THINGS STILL HAVE TO HAPPEN BY HAND:
  echo.
  echo     1. Grant the new employee_support role to Carla, Claire,
  echo        Ainsley, Grace and Alivia in Admin - Roles. Until those
  echo        grants exist the support tabs are empty for everyone.
  echo.
  echo     2. The n8n hooks are still pending.
  echo.
  echo   There is no screen to look at yet if the chat components have
  echo   not shipped. This step just means they will work when they do.
  echo  ===============================================================
) else (
  echo  ===============================================================
  echo   SOMETHING WENT WRONG during apply.
  echo.
  echo   Everything ran inside one transaction, so a failure during
  echo   the writing itself changed nothing. A failure AFTER that
  echo   line - in the checks - means the tables are there and one of
  echo   them is not what it should be.
  echo.
  echo   Scroll up and send the failing line to Claude. Do not re-run
  echo   until it has been checked.
  echo  ===============================================================
)

echo.
pause
endlocal
