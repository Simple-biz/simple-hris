# HR dashboard tab cache — the freshness window

The HR shell animates between tabs with a keyed `motion.div`, so every tab fully
unmounts on switch and re-runs its mount fetches when you come back. `src/lib/hr/tab-cache.ts`
exists so a return visit paints instantly instead of re-flashing a skeleton.

Until 2026-09-09 a warm entry suppressed the mount fetch **unconditionally**. This
documents why that was wrong and what replaced it.

Key files:

- `src/lib/hr/tab-cache.ts` — the store (in-memory Map, deliberately not persisted).
- Consumers: `HrApp.tsx` (Overview), `HrGlobalMasterList.tsx`, `HrOnboarding.tsx`,
  `HrOnboardingForm.tsx`, `HrOffboarding.tsx`, `HrTransfers.tsx`, `HrScreening.tsx`,
  `HrNewHireChecklist.tsx`, `src/hooks/useHrOrientationAttendance.ts`.
- Tests: `src/lib/hr/tab-cache.test.ts`.

## The bug was the justification

The store's own docstring said freshness "within a session is maintained by each tab's
existing Realtime subscription and post-mutation refetches". Both halves failed:

- **Ten of the twelve datasets have no subscription at all.** Only `pendingEmployees`
  (`HrOnboarding`) and `onboardingSubmissions` (`HrOnboardingForm`) ever open a channel —
  and the second one's channel is on pay structures, not on the submissions.
- **Browser `postgres_changes` is documented dead in this project.**
  [[supabase-realtime-anon-rls-dead]]: the tables carry RLS with no anon policy, so a
  channel reports `SUBSCRIBED` and then never delivers a row event. Per that memory the
  fix is **never** "add the table to the publication" — that is a security decision, not
  a side effect.

So an HR session left open all day never re-pulled the global master list, the offboarding
queue, the leaver list, the screening board, the transfer trail or the Overview headcount
on a tab return. Only F5 or a manual Refresh moved them.

## Paint and skip are different questions

| Predicate | Answers | Used for |
| --- | --- | --- |
| `hasHrTabCache(key)` | is there something to **paint**? | whether a skeleton is needed |
| `isHrTabCacheFresh(key)` | may the fetch be **skipped**? | whether to hit the server |

Collapsing these back into one predicate is the regression this file exists to prevent.
A warm-but-stale entry still paints — the rows stay on screen, no skeleton — and the
consumer revalidates behind them.

`FRESH_WINDOW_MS` is **30s**, matching the Payroll Notes panes' documented window
(`payroll-wizard-notes.md` § *No reload on the way back*). Flipping between HR tabs costs
nothing; anything older revalidates.

A re-write restamps the entry, so a Refresh or a post-mutation refetch re-opens the
window rather than leaving a stale copy behind it.

## Every revalidate is silent

A background revalidate must not undo the thing the cache is for. Each converted consumer
took a `{ silent }` option, and on the silent path it:

- does **not** raise its loading flag (no skeleton over rows already painted), and
- does **not** blank rows or show an error card when the request blips — only a foreground
  load reports and clears.

The pattern per call site is:

```ts
if (isHrTabCacheFresh(KEY)) return;
void fetchX({ silent: hasHrTabCache(KEY) });
```

`HrGlobalMasterList` already had a `'quiet'` mode and `HrNewHireChecklist` already had
`{ silent: true }`, so those reuse what was there.

`HrScreening` needed **no change**: its effect already fetches on every mount and uses
`hasHrTabCache` only to pick between the `initial` and `quiet` spinner modes — which is
exactly the "is there something to paint" question.

## Not persisted, and why that is load-bearing

This store is an in-memory `Map` with **no identity stamp**, unlike
`src/lib/accounting/tab-cache.ts`. That is only safe because it cannot outlive the page:
signing out navigates and drops the module.

**Do not mirror it to `sessionStorage` without adding the identity envelope first** — a
mirror without a stamp would leak one HR user's roster to the next person on that browser
tab, which is precisely the hole `accounting-dashboard-cache.md` had to close. A test
greps this module for `sessionStorage`/`localStorage` so a well-meaning "make it survive
reloads" change fails loudly.

## The one dataset that keeps its once-per-session skip

`orientationAttendance` (`useHrOrientationAttendance.ts`) still fetches once per page
session and does not consult the window. That is a documented decision, not an oversight:
`hr-orientation-attendance.md:108-126` specifies "the tab fetches **once per page
session**", makes the panel's Refresh button the freshness path, and says outright that a
cached payload running a few minutes behind the always-live **Listed** count "is
intentional, not drift". Folding it into the window means changing that doc first.

Its failure behaviour is also deliberate and must not be softened into a silent
revalidate: a failed read **clears** state and renders no numbers, because the only
fallback available is the hire's own dates — the 46%-wrong grouping the feature exists to
replace (`hr-orientation-attendance.md` § *Failure refuses to render*).

## Not done

- **Not verified in a browser.** `tsc` is clean and 2739/2741 tests pass (both failures
  pre-existing and unrelated), but the live tab-switch behaviour was not clicked through
  (needs Google SSO + Supabase auth).
- **The window is uniform.** 30s for every dataset; nothing yet argues for a per-dataset
  window, and adding one should come with a reason per key rather than a knob.
- **No poll.** The window bounds staleness at the moment of a **tab return**. A tab left
  open and untouched still does not refresh itself; that is the manual Refresh button's
  job, as before.
