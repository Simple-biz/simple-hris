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
  `HrNewHireChecklist.tsx`, `src/hooks/useHrOrientationAttendance.ts`, and since 2026-09-17
  `HrMesa.tsx` (MESA Eligible), `HrFpuEnrollments.tsx` (classes + per-class enrollments) and
  `FpuGroupsPanel.tsx` (groups + marks). Since 2026-10-01 also `HiringSourcesCard.tsx`,
  `HiringByRecruiterCard.tsx`, `ReferralsWeekSection.tsx` and `OffboardingWeeklyPulse.tsx`, plus
  four SHARED panels through `hrPaintCache`: `LeaveRequestsPanel.tsx`, `AnnouncementWall.tsx`,
  `SWall.tsx` and `NotificationsPanel.tsx`.
- `src/lib/dashboard-cache/paint-cache.ts` — the `PaintCache` type the shared panels take.
- Tests: `src/lib/hr/tab-cache.test.ts`.

### Every HR tab, checked on 2026-10-01

Kane: *"HR Dashboard - Check all tabs and see if we have cache in there I dont want it loading
everytime I check other tabs."* Every tab was read for its mount-time fetches. Seven surfaces
still loaded cold; they are wired now. **Two rules decide every row below.**

**The HR tabs take the window.** Each paints from its entry and skips the fetch inside 30s, like
everything above.

**The four SHARED panels paint, and always refetch.** Leaves, Announcements, S-Wall and
Notifications are mounted by several dashboards. They take an optional `paintCache` prop
(`{ store, key }`), and HR passes `hrPaintCache`. That adapter has **no freshness predicate**,
so these panels cannot skip. They seed the first paint and then revalidate silently on every
mount, which is the `HrScreening` shape. A test pins that the adapter exposes only
`get`/`has`/`set`. The reason differs per panel:

- **Announcements and S-Wall** see a new post only through Realtime or a refetch, and browser
  `postgres_changes` is documented dead here. A 30s skip could hide a post the viewer has just
  made.
- **Notifications** has to agree with the chime and the sidebar badge, which are live. A skip
  could hide the notification that just rang.
- **Leaves** comes along for consistency. A shared panel that can skip would carry HR's
  freshness policy into the Manager and Accounting mounts.

A host that passes no prop keeps the panel byte-for-byte uncached. Manager, Accounting, CEO,
Employee, Orphanage, QC and Payroll Clerk are unchanged.

| Tab | What was cold | Now |
| --- | --- | --- |
| Overview | the greeting name; Hiring sources; Hiring by recruiter; Referrals | per-viewer `hrViewerNameKey`; **per week** `hrHiringSourcesKey` / `hrHiringRecruitersKey` / `hrReferralsKey` (`null` = All time), so stepping between weeks does not evict |
| New Hire Checklist | the week list, the department, source and referrer lookups | `newHireChecklistPeriods`, `departments`, `masterListNames`; the source list **shares** `hrHiringSourcesKey(null)` with the Overview card, so one fetch serves both |
| Onboarding Form | the Workspace licence meter | `workspaceLicenseInfo`. Only a body with no `error` is cached. A set still re-reads it directly |
| Offboarding | Weekly pulse headcount: it skipped whenever ANY roster was cached | takes the window on `overviewRoster` |
| Leaves | the whole list (a skeleton every visit) | `paintCache`, key `hr:leaves:<viewer>` (the list is scoped by the signed-in viewer's department assignments) |
| Announcements | the whole feed | `paintCache`; the panel appends the scope |
| S-Wall | the feed and the CEO rail | `paintCache`; the panel appends the viewer (`my_reactions` is per viewer). Reactions are re-derived from the posts, never stored |
| Notifications | the list, and the skeleton also waited on the dispatch-lock read | `paintCache`; the panel appends view + viewer. A painted list no longer waits on the lock; the banner joins it when its answer lands |

**Left live on purpose.** None of these produces a skeleton over a painted tab:

- **The Leaves delete permission.** It decides who sees the trash button.
- **The dispatch-lock banner.** Lock state never paints from a cache.
- **The New Hire Checklist's US holiday calendar.** Its effect says it is NOT best-effort, and
  it has to agree with the lock route.
- **The Notifications offboarding-queue status.** It decides whether the action button shows.
- **GML last-seen.** It is presence, and a stale "active now" is a wrong answer, not a stale one.
- **Gift Tracker.** It is on the Orphanage store, and Orders' lock state is never cached
  (`orphanage-dashboard-cache.md`).
- **Every dialog-scoped fetch.**

**Two bugs closed on the way:**

- **The New Hire Checklist restamped its own entry on every mount.** Its mirror effect wrote the
  seeded state straight back, which re-opened the 30s window with no server answer behind it.
  A tab flipped back to inside every 30s therefore **never** revalidated. The mirror now writes
  only when a field actually changed (the rows by reference).
- **Notifications blanked its list on an HTTP error body.** It did `setItems(json.notifications
  ?? [])` with no `res.ok` check. An error body is now a failure that keeps the prior list,
  which is what its own `/* keep prior list */` intended. This one reaches every dashboard.

**Two rules for anything that mirrors state into a cache:**

- **Write only once a real answer is cached** (`store.has(key)`). Otherwise an empty list from
  before the first load lands gets stored, and the next visit paints "Nothing here yet" instead
  of a skeleton.
- **The Notifications cache records what the panel has PATCHed read.** The list on screen keeps
  those rows highlighted for the rest of the visit, as before. The copy the next visit paints
  marks them read, which matches what the server will answer.
- **The cached Notifications copy carries no rate block** (since the Manager pass, same day).
  `details.before` / `details.after` are stripped on every host, because a host store can
  mirror to `sessionStorage`. A painted rate card lacks its figures until the live list lands.

### MESA and FPU joined the store on 2026-09-17

Kane: *"make sure to add Caching so I dont have to hit database I switch tabs."* Three datasets
were converted or added:

| Key | Surface |
| --- | --- |
| `hr:mesa-eligible:v5` | HR → MESA → MESA Eligible |
| `hr:fpu-classes:v1` | the FPU class strip, its per-status counts and the roster map |
| `hr:fpu-enrollments:<classId>` | one entry per class (`hrFpuEnrollmentsKey`) |
| `hr:fpu-groups:<classId>` | groups, members and marks (`hrFpuGroupsKey`) |

**MESA Eligible was the bug this file describes, still live.** It held its rows in a module
variable behind `if (cached !== null) return;` — no stamp, so an HR session left open all day
never re-pulled the member list at all. It now takes the window like everything else, and its
revalidate is silent: a blip leaves the painted rows and raises no error card.

**The FPU keys are PER CLASS** because switching between two classes is the common move; one
shared key would make the second class evict the first and re-fetch on the way back, which is
what this store exists to stop. Pinned by a test.

**`migrated` is never cached — and one consumer had to be corrected to keep that true.** It gates
the New class button and the amber migration banner, so it DECIDES. `hr:fpu-classes:v1` seeds only
rows, counts and the roster map. `hr:fpu-groups:<classId>` stores the whole `groups/list` payload,
which *includes* `migrated`, so `FpuGroupsPanel` forces it back to `true` on the seed and lets only
the live answer raise that notice.

**A live channel is still not a licence to skip.** HR → MESA → FPU Classes holds a working
Realtime channel, unlike every tab this store was built for — but it is Broadcast
(`fpu-classes-sync`) and it is **torn down on unmount**, which is exactly when the cache is in
force. Everything announced while the tab was away is missed, so the 30s window governs there
too. Do not "optimise" that into an unconditional skip because the tab is live.

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

**Kane confirmed on 2026-09-09** that this doc stands rather than being folded into the
window — asked as a straight either/or against `hr-orientation-attendance.md`.

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

- **The 2026-10-01 sweep is not verified in a browser either.** `tsc` is clean and 5241/5243
  tests pass. The two failures are pre-existing, in files this change does not touch. The tab
  switches were not clicked through.
- **The other dashboards' copies of the four shared panels are still cold, except Manager.**
  Manager's Announcements, S-Wall and Notifications were wired on 2026-10-01 through
  `managerPaintCache`, and its Leaves tab is held for Kane (`manager-dashboard-cache.md`,
  session log item 304). The prop is there and any `TabCache` from `create-tab-cache.ts`
  satisfies `PaintCache`. Accounting and the rest are a separate change against each
  dashboard's own store.
- **Not verified in a browser.** `tsc` is clean and 2739/2741 tests pass (both failures
  pre-existing and unrelated), but the live tab-switch behaviour was not clicked through
  (needs Google SSO + Supabase auth).
- **The window is uniform.** 30s for every dataset; nothing yet argues for a per-dataset
  window, and adding one should come with a reason per key rather than a knob.
- **No poll.** The window bounds staleness at the moment of a **tab return**. A tab left
  open and untouched still does not refresh itself; that is the manual Refresh button's
  job, as before.
