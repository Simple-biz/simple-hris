# Employee loading card — "Loading your Employee Dashboard"

The card that covers the employee shell from its cold mount until the Overview is really on screen.
It is the same `DashboardSwitchLoader` a dashboard switch paints (skeleton shell behind, a floating
orange card in front), with arrival copy: **LOADING YOUR / Employee Dashboard**, cycling
*Loading your workspace · Fetching your hours · Preparing your pay week · Almost ready*. Every
employee sees it each time the dashboard loads fresh. Shipped 2026-10-05
(`git log -- src/lib/employee/login-loader.ts`).

Kane, 2026-10-05: *"a loading employee dashboard Modal as the Employee Dashboard is loading similar
to switching tabs but this one is the first one when the person logs in"*. Before it, arriving at the
shell went straight to the Overview's inline skeleton, which clears on the essentials load while the
selected week's hours are still in flight.

## Key files

| Piece | File |
| --- | --- |
| Lift rule, ceiling, copy (pure) | `src/lib/employee/login-loader.ts` |
| Tests (rule + source scans of the wiring) | `src/lib/employee/login-loader.test.ts` |
| The overlay (portal, fade-out) | `src/components/employee/EmployeeLoginLoader.tsx` |
| Mount, latch, ceiling timer, Penny `quiet` | `src/components/employee/EmployeeApp.tsx` |
| The ready signal (`onFirstPaintReady`) | `src/components/employee/EmployeeDashboard.tsx` |
| The shared card (`eyebrow` / `statusMessages` props) | `src/components/common/DashboardSwitchLoader.tsx` |
| The hard-load fallback (same card before the shell exists) | `app/employee/page.tsx` (`EmployeeShellFallback`) |

## It shows on EVERY cold mount of the shell — never only on the sign-in baton

`EmployeeLoginLoader` is always mounted in `EmployeeApp` and the latch starts down
(`useState(false)`), so the card is up whenever the shell mounts: a fresh Google sign-in, opening the
site already signed in, a direct link, F5, or arriving from another dashboard. **Tab switches inside
the shell never show it** — the shell keeps every visited tab mounted and only swaps which one is
visible, so nothing remounts.

**Do not re-key it on `hris_post_login`.** It first shipped that way and Kane could not find it
(*"So where is the loading?"*, same day): someone already signed in reaches the dashboard via `/` →
`/employee` (`app/page.tsx`), which sets no baton, so almost nobody ever saw the card. The reason
given for the baton was also false: it claimed a refresh paints from the session cache
([employee-dashboard-cache](employee-dashboard-cache.md)) and the card would hide it, but the
Overview's `if (loading)` skeleton is **not** cache-seeded, so every cold mount starts on a skeleton
and the card hides nothing real. The baton still drives only the white veil, which continues the
sign-in video's closing fade and lifts to reveal the card.

On a hard load, `app/employee/page.tsx`'s Suspense fallback paints the same card (same copy) before
the shell exists, so the first paint is the card rather than a bare spinner. The fallback's card and
the shell's are two mounts, so the card's entry animation and progress bar restart once at the
hand-over.

Arriving from another dashboard reads *"Switching to Employee Dashboard"* (the ViewSwitcher's card
and the route's `loading.tsx`), then this card until the Overview is ready. The switch card covers
the route load; this one covers the data load.

## It lifts when the Overview is really on screen — not when `loading` clears

`EmployeeDashboard` calls `onFirstPaintReady` **once** when
`!loading && firstHoursSettled && !fileLoading`. `loading` alone is not enough: the essentials
effect clears it in the same render that hands `files[0]` to the selected-file effect, and that
effect only starts the week's hours load after paint — so lifting on `loading` drops the card onto
the skeleton it exists to cover. `firstHoursSettled` is one-way and set in exactly two places: the
selected-file effect's `finally`, and the essentials effect's `finally` when no week was selected
(no files, or the load failed).

- **A failed load counts as ready.** Its error belongs on the dashboard's own banner, not behind a
  spinning card.
- **It does not wait on the PAB month merge** (`pabMergeLoading`). That read has its own skeleton,
  shaped like the real grid so nothing reflows. Waiting on it would only lengthen the card.
- **The once is a ref**, not the effect's dependencies: the shell passes an inline arrow, so an
  effect keyed on the callback alone would re-fire on every shell render.

## It never traps anyone

`shouldLiftLoginLoader` lifts on **any** of four reasons; none of them holds the card over another:

1. the Overview reported (above);
2. `LOGIN_LOADER_MAX_MS` (15s) passed since the shell mounted — a hung fetch (armed on every mount);
3. the shell is on another tab (the Pages overlay hid Overview and the shell bounced);
4. Overview's page visibility is not `visible` (under construction renders the placeholder, which
   never reports).

**And it latches** (`loginLoaderLifted`): once lifted, it never comes back for that mount. Without the latch, a card
lifted by a bounce would drop back over the page the moment Overview became visible again before its
fetches finished. The lift is computed in the same render the reason appears (no extra frame of
card); the effect only makes it stick.

Raising the ceiling only lengthens the worst case of staring at a card; the test caps it at 15s.

## No minimum display time

The switch loader "unmounts the instant the real dashboard is ready", and a 520ms artificial switch
delay was deliberately removed on 2026-07-20 because switching felt slow (memory
`dashboard-switch-performance`). The card fades out over `LOGIN_LOADER_FADE_S` (0.35s) and that is
all. A test asserts the only timer involved is the ceiling.

## Layering

Portaled to `<body>` at `fixed inset-0 z-[100]` — the layer `ViewSwitcher` paints its switch card on
(`ViewSwitcher.tsx:173-180`), so a transformed shell ancestor cannot trap it, and everything that
already sits above the switch card sits above this one: the sign-in **white veil (z-[200])**, which
starts opaque and lifts to reveal the card instead of the skeleton; Carla's song toast (z-[200]); the
cobrowse chrome (z-[130]). The shell renders and fetches underneath the whole time — the card hides
work in progress; it never delays it.

## Penny stays quiet while it is up

The greeting balloon's five-second fuse is armed on the bubble's mount and can burn down under the
card. The card is therefore one more reason in the render-time guard — `quiet: activeTab !==
'dashboard' || loginLoaderUp` — exactly where [employee-penny-ai](employee-penny-ai.md) § *It stays
quiet when speaking would be wrong* says a new reason goes ("add it there, not to the timer"). Because
the guard is re-evaluated every render, a balloon suppressed under the card shows once the card lifts,
inside the ~22s auto-hide window.

## The shared card keeps its own copy

`DashboardSwitchLoader` gained optional `eyebrow` (default `'Switching to'`) and `statusMessages`
(default its original four lines). Every dashboard's `loading.tsx` and the ViewSwitcher pass neither,
so the switch renders exactly as before; a test walks `src/` and `app/` and fails if anything but
`EmployeeLoginLoader` and the `/employee` fallback overrides the eyebrow. Colors still come from `TONES.employee` — do not add
tone overrides here; [ui-standards § 14.6](../design/ui-standards.md) owns them and requires complete
literal class strings.

**What looks like a gap but is out of scope:** during any client navigation into `/employee` (from
`/login`, from `/`, from another dashboard) the route-level `app/employee/loading.tsx` may paint the
stock *"Switching to Employee Dashboard"* for a moment before the shell mounts. It is the shared route
loader every switch uses, and the ViewSwitcher's click card hands off to it as the same component
(ui-standards § 4.1). It was left alone.

## Deploy notes

**No migration.** No env vars, no n8n, no new fetch or route.
Verified by `tsc` (0 errors in `src/` + `app/`) and the employee, Penny and switch-loader suites —
**no browser click-through** (signing in needs Google SSO, unavailable in the building session).
Kane's live look (open or refresh `/employee`) is the remaining check: **PENDING**.
