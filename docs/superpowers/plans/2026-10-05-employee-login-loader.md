# Employee — the sign-in loading card ("Loading your Employee Dashboard")

**Brief:** in-session 2026-10-05. Kane: *"Employee Dashboard - lets add a loading employee dashboard
Modal as the Employee Dashboard is loading similar to switching tabs but this one is the first one
when the person logs in"*. Built under the 2026-09-26 blueprint rule: recommendations taken
(CHOSEN 1–4), no NEEDS.

**What was found first:** the dashboard switch already paints `DashboardSwitchLoader` ("Switching to
<X> Dashboard", `ViewSwitcher.tsx:173-180` + every `loading.tsx`). The sign-in hand-off does not: the
login page sets the one-shot `hris_post_login` baton (`app/login/page.tsx:420`), `EmployeeApp` lifts a
white veil off the shell over 0.6s, and the person lands on the Overview's inline skeleton
(`EmployeeDashboard.tsx` `if (loading)`), which clears on the essentials load while the selected
week's hours are still in flight.

## Task 1 — the pure lift rule

- [x] `src/lib/employee/login-loader.ts` — `LOGIN_LOADER_MAX_MS`, `LOGIN_LOADER_EYEBROW`,
  `LOGIN_LOADER_STATUS_MESSAGES`, `shouldLiftLoginLoader({ overviewReady, activeTab,
  overviewVisibility, timedOut })`.
- [x] `src/lib/employee/login-loader.test.ts` — each lift reason alone, the hold case, copy says
  nothing about switching, and source scans pinning the wiring (baton-only mount, Penny `quiet`,
  one-shot ready signal, no minimum-dwell timer).

## Task 2 — the shared loader takes copy

- [x] `src/components/common/DashboardSwitchLoader.tsx` — optional `eyebrow` (default
  `'Switching to'`) and `statusMessages` (default the four existing lines). Every existing caller
  passes neither, so the switch renders exactly as before.

## Task 3 — the Overview says when it is on screen

- [x] `src/components/employee/EmployeeDashboard.tsx` — `onFirstPaintReady?: () => void`, fired once
  when `loading` is false AND the first hours load has settled (the selected-file effect's
  `finally`, or the essentials effect when no file was selected).

## Task 4 — the overlay

- [x] `src/components/employee/EmployeeLoginLoader.tsx` — portal to `<body>`, `fixed inset-0 z-[100]`
  (the ViewSwitcher layer), `AnimatePresence` fade-out 0.35s, `DashboardSwitchLoader view="employee"`
  with the login copy.

## Task 5 — the shell mounts it on the baton

- [x] `src/components/employee/EmployeeApp.tsx` — `overviewReady` + `loginLoaderTimedOut` state,
  15s cap timer, `loginLoaderUp` from `shouldLiftLoginLoader`, Penny greeting `quiet` while up.

## Task 6 — verify + document

- [x] `npx tsc --noEmit` · `node --import tsx --test src/lib/employee/login-loader.test.ts`
- [x] `docs/features/employee-login-loader.md` + INDEX row + memory `employee-login-loader`
