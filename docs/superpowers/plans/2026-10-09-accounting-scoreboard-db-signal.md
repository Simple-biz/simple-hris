# Accounting Scoreboard Overview: database signal — implementation plan

Session `24ba2a0d`, 2026-10-09, `blueprint`, no NEEDS. Kane: *"Overview Page - Lets add like a 3 bar signal and an MS
on our DATABASE connection 3rd bar in green should be blinking"*, then *"1 bar being red and 2 bar being orange"*.
Governing doc: [accounting-scoreboard.md](../../features/accounting-scoreboard.md) § Database signal on the Overview.
Written as the build ran, so each step is ticked as done.

**CHOSEN (overturnable in one message):** the Accounting Scoreboard's Overview (not Accounting → Overview) · the ms is
the server's round trip to the database, not the browser's · Admin → Diagnostics' lines (under 500 ms / 500–2000 ms /
over 2000 ms or no answer) · every 30 s only while the Overview is on screen and the tab visible · reduced motion = a
steady 3rd bar.

## Task 1: The lines (pure)

- [x] `src/lib/accounting-scoreboard/db-signal.ts`: `judgeDbPing`, `signalForFailedRoute`, the constants.
- [x] `db-signal.test.ts`: each band and its edges, a timeout prints no ms, whole ms, the lines pinned to
      `system-diagnostics.md`, the route reads any role and never writes.

## Task 2: The ping

- [x] `pingDatabase()` in `server.ts`: one row of `accounting_scoreboard_sections`, raced against 3 s, never throws.
- [x] `app/api/accounting-scoreboard/ping/route.ts`: `resolveAccess()`, 200 with the reading, `no-store`.
- [x] The real query answered on production, read-only: 360–540 ms from Kane's laptop.

## Task 3: The bars

- [x] `DbSignal.tsx`: 3 bars + *Database* + ms; green / orange / red; 30 s poll while visible, once on return; 8 s
      browser give-up; state announced on change only; tooltip with the sentence and the check time (ET).
- [x] The blink as one Web Animation (`BlinkingBar`): `motion`'s infinite keyframes did not run, measured.
- [x] Mounted at the top right of the Overview header; wraps under the heading on a phone.
- [x] Headless, synthetic answers: 35/35 (every state, light and dark, blink, no blink on orange, reduced motion,
      re-ping on return, 390 px). Full suite 6,626/6,626; `tsc` clean bar the 2 stale `.next/types` entries.

## Task 4: Record

- [x] `accounting-scoreboard.md` § Database signal + Key files + routes; INDEX row Key invariant; memory.
- [ ] Kane: push; a signed-in look at the Overview on production (expect green, tens of ms).
