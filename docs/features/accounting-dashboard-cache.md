# Accounting / CEO / Payroll-Clerk tab cache

The oldest of the four client caches, and until 2026-09-09 the only one with no
identity stamp, no schema version, no age ceiling and no sign-out purge — the three
newer stores were written against rules this one was missing, and both of their docs
name it as the counter-example. This documents what it actually guarantees now.

Key files:

- `src/lib/accounting/tab-cache.ts` — the store (memory Map + `sessionStorage` mirror).
- `src/App.tsx`, `src/components/ceo/CeoApp.tsx`,
  `src/components/payroll-clerk/PayrollClerkApp.tsx` — bind the cache to the viewer.
- `src/components/Sidebar.tsx`, `ceo/CeoSidebar.tsx`,
  `payroll-clerk/PayrollClerkSidebar.tsx` — purge it on sign-out.
- Tests: `src/lib/accounting/tab-cache.test.ts`.
- `src/lib/people/people-cache.ts` (+ `.test.ts`) — the People tab's only way in or out of the
  store (§ *People: the whole tab paints*).

Siblings: `employee-dashboard-cache.md`, `manager-dashboard-cache.md`, and
`hsl-kpi-calculator-2026-07.md` § *Tab-switch & reload cache*.

## One store, three dashboards

Fifteen call sites across three shells read it, which is why it is neither the Accounting
store nor the CEO store but the shared one:

| Consumer | Datasets |
| --- | --- |
| `components/Overview.tsx` | `overviewPayouts`, `overviewPabMetrics` |
| `accounting/PayrollCycleGreetingModal.tsx` (the shell's "Hi Kane" modal, 2026-09-26) | `payrollReadiness(null)` — the live week, same entry and helpers as the FAB; `cycleGreetingShown` — a **UI flag** (`true` once opened this session), here rather than in raw sessionStorage because this store's purge-on-sign-out / viewer-swap / 12h lifetime IS "once per browser session" |
| `accounting/PayrollNotesSetupCard.tsx` (the Overview's Payroll Notes card, 2026-09-26) | `payrollReadiness` — the SAME per-week entry as the FAB, via `payroll/readiness-cache.ts`; seeded in a layout effect (hydration-safe), revalidated unless under 30s old, never skip-flagged |
| `people/PeopleTab.tsx` (via `lib/people/people-cache.ts`) | `peopleRoster` — the default week's rows, summary, week and warning as ONE entry; `peopleWeeks` (the pay-week selector); `peopleStats` (Statistics, each point's leaders cut to the tooltip's five) |
| `people/PeopleBankChanges.tsx` (via `lib/people/people-cache.ts`) | `peopleBankChanges` — the newest 80 masked payout edits |
| `accounting/AccountingTransfers.tsx` | `transfers` |
| `accounting/AccountingDocuments.tsx` | `documentsQueue`, `documentsSignature`, `documentsView` |
| `accounting/BonusCatalog.tsx` | `ratesSummary`, `ratesFx`, `ratesView` |
| `accounting/PayrollWizardNotesFab.tsx` | notes rows, workers, uploads, readiness (via `payroll/readiness-cache.ts`, shared with the Overview card), offboarded |
| `payroll/AccountingMesa.tsx` | `mesaRequests`, `mesaNonMembers`, `mesaActiveMembers` |
| `payroll/PabDisputeQueue.tsx` | `pabDisputes`, `pabReasonCodes`, `timeAdjustmentIssues` (`bankPreferredRequests` was deleted 2026-09-24 with the Issues table's Bank Preferred rows) |
| `payroll-clerk/useDispatchQueue.ts` | `dispatchQueue` |
| `ceo/CeoOverviewKpis.tsx` | `ceo:overview-kpis`, `ceo:viewer-name:<email>` |
| `hooks/usePaymentsLive.ts` (the CEO Overview's "Payments to send", 2026-10-02) | `ceoPaymentsLive` — the counters only, never the per-person `recent` feed |
| `ceo/CeoFinancialReports.tsx` | the financial-report snapshot |
| `npd/useNpdSheet.ts` · `npd/NpdDashboard.tsx` · `npd/NpdGoogleSheetSync.tsx` (NPD, 2026-10-02) | `npdSheet(tab, week)` + `npdSheetIndex`, `npdWeeks`, `npdSyncWeek`, `npdView` (UI selection) |

## Lifetime

| Event | Cache |
|---|---|
| Tab switch | **kept** — the shell unmounts the tab, so this is the main case |
| F5 / reload / back-nav | **kept** — the `sessionStorage` mirror |
| Close the browser tab | gone |
| Quit the browser | gone |
| Sign out | gone — purged explicitly (new 2026-09-09) |
| A different viewer binds on that tab | gone — purged on bind (new 2026-09-09) |
| Entry older than 12h | gone — treated as absent and evicted (new 2026-09-09) |
| Entry written by a different schema version | gone — treated as absent (new 2026-09-09) |

`localStorage` **must not** be used, for the same reason as the other three stores: it
outlives the browser, and this cache holds a company roster, a dispatch queue and
payout totals.

### What sign-out actually fixed

`signOut({ callbackUrl: '/login' })` navigates **in the same tab**, and `sessionStorage`
survives a same-tab navigation. All three sidebars removed only `SESSION_EMAIL_KEY`, so
`acct-cache:people:list`, `acct-cache:dispatch:queue`, `acct-cache:overview:payouts`,
`acct-cache:rates:summary` and `ceo:overview-kpis` were still on disk for whoever signed
in next on that tab, and would repaint before revalidation. Bounded by role — the next
person needed the same role to reach the shell that reads them — but on a shared machine
that is a cross-account paint, and the rule the other stores state is that the next
person should never have the bytes on disk at all.

Each sidebar now removes the session email **first** and then calls
`clearAllAccountingCache()`. The order matters: a read racing the purge would otherwise
self-bind (below) and re-adopt the identity being dropped.

## Identity — and why this store SELF-BINDS

Every entry is stamped with the viewer it was written for, and reads reject any other
stamp. All three shells honour an `?email=` override and write it to the **same**
`sessionStorage` key in the **same** tab, so without the stamp an elevated viewer
previewing as someone else and then returning to their own dashboard repaints the other
identity's data.

The divergence from the Employee and Manager stores is worth understanding before
touching it.

`EmployeeApp.renderContent` returns `null` until identity resolves, so that store can be
strictly **inert until bound**. `ManagerApp` renders its tabs before the viewer resolves,
so that store folds boundness into the cache key and reseeds on the bind render. Neither
option is available here: these three shells render immediately **and** their consumers
seed through plain `useState(getTabCache(...))` initialisers rather than a hook, so an
inert-until-bound store would miss on every reload and never look again — which is
`manager-dashboard-cache.md`'s "getting it wrong makes the feature silently do nothing",
reached by a different road.

So a read with no bound identity performs a **synchronous self-bind** from
`SESSION_EMAIL_STORAGE_KEY`, the same key the shells resolve from (written at login by
`app/login/page.tsx`). That value is available before the first render on a reload, which
is exactly the case the mirror exists for.

Two consequences to keep straight:

- **A self-bind only ADOPTS an identity; it never purges.** Dropping another viewer's
  bytes is `bindAccountingCacheIdentity`'s job, which every shell calls from an effect.
- **The bind reconciles the on-disk marker on every call**, not only when the bound
  identity changes — because a self-bind can leave the marker naming a previous viewer.
  Those bytes were already unreadable (the stamp check fails closed), but the rule is
  that they are gone, not merely inaccessible.

`bindAccountingCacheIdentity(null)` is **ignored, not treated as a sign-out.** All three
shells start with `viewerEmail === null` and fill it from an effect, so purging on a falsy
bind would wipe the cache on the first render of every page load.

On the server `storage()` returns `null`, so reads are inert and every consumer's
initialiser produces its `initial` — unchanged from before the envelope existed.

## The skip-flag policy

This store is the only one of the four that keeps a skip-fetch flag
(`hasFetchedThisSession`). The other three ban it and pin the ban with a `no-skip-flag`
test. That is not an inconsistency to tidy up — it is a boundary, and it is where the
policy lives.

**Kane confirmed this boundary on 2026-09-09**, asked directly whether to retire the
flag everywhere (which is what a `no-skip-flag` test would require) or keep it and police
where it may be used. They chose keep-and-police. So the asymmetry with the other three
stores is a ratified decision, not an oversight and not a cleanup waiting to happen — do
not "tidy up the inconsistency" by deleting the export.

**Allowed:** lookup lists and heavy aggregate snapshots.

- Worker suggestions and the Hubstaff upload list — `payroll-wizard-notes.md:120`
  specifies these as "fetched once per page session".
- The CEO Overview KPI snapshot and the financial reports — company aggregates that
  re-pull on every reload, with the live "payments to send" counter separate and always
  live (`usePaymentsLive`). Since 2026-10-02 the snapshot skips only when there is a
  cached copy **to paint** (`hasFetchedThisSession(key) && kpis != null`); a flag with
  nothing behind it fetches. **OPEN (item 329):** this snapshot is not purely aggregate —
  `lastCycle.workers[]` carries each unpaid person's `amountUsd`, which the banned list
  below would otherwise cover. Not changed; waiting on Kane.

**Banned:** any dataset carrying a per-person pay figure, or a queue other people act
on. There, a skipped fetch freezes one person's view of work somebody else has already
done — `manager-dashboard-cache.md`'s "stale-and-stop is how two managers approve the
same request twice", and `employee-dashboard-cache.md`'s reason, which is that
`upsertPaystubDispatchQueue` re-stages onto an already-PAID row with no post-pay detector
([[paystub-staged-snapshot-stale]]). `tab-cache.test.ts` greps the call sites for
`dispatchQueue`, `peopleRoster`, `transfers`, `pabDisputes`, `bankPreferredRequests`,
`ratesSummary`, `overviewPayouts`, `payrollReadiness`, `payrollNotesOffboarded`,
`documentsQueue`, the NPD keys, `ceoPaymentsLive`, `peopleStats` and `peopleBankChanges`, so
the boundary cannot be crossed by copy-paste.
`bankPreferredRequests` stays on that banned list although the key was deleted on
2026-09-24. A name on a ban list protects the boundary if the key ever returns, and
removing it would loosen a test.

**A flag can never outlive its data.** `clearTabCache` and `clearAllAccountingCache` both
clear `fetchedThisSession`, and so does an entry aging out of **memory** (2026-10-02 — that
branch used to drop the entry and keep the flag; with no `sessionStorage` at all, as in a
privacy mode, nothing else cleared it). Without that, a purge would leave the flag
reporting "already pulled" for a dataset that no longer exists and the pane trusting it
would stay permanently empty. Pinned in `tab-cache.test.ts` (*an entry that ages out of
memory clears its skip flag*).

### Transfers lost its skip (2026-09-09)

`AccountingTransfers` was the one banned-category call site actually using the flag. It
now seeds from the cache and **always** refetches on mount, silently when there are
cached rows to paint. Its `useLiveRefresh` 60s poll was not a substitute: the poll starts
counting from that mount, so a skipped mount fetch left an auditor acting on an
up-to-60s-old queue with nothing in flight.

Its spinner is now derived rather than stored — `!settled && rows.length === 0`, with
`settled` never seeded and never reset — because a spinner that re-asserts on every mount
repaints the skeleton over rows already on screen. An explicit **Refresh** keeps its own
`refreshing` flag. Same recipe as `manager-dashboard-cache.md` § *Loading flags are part
of the rule*. Since 2026-10-05 the Refresh click also opens the refresh modal over the rows
([table-refresh-progress.md](./table-refresh-progress.md)). It does not clear the error card
before its answer lands, and the poll and realtime reloads stay silent.

### Documents joined, with a UI selection (2026-09-16)

`AccountingDocuments` was the last heavy Accounting tab with no cache at all: leaving
the tab unmounted it, and returning re-ran the queue fetch behind a five-row skeleton
with the KPI cards blank — Kane: *"it seems to disappear when I switch tabs."*

It takes three keys, and they are three different categories:

- **`documentsQueue`** — the signing queue. A **shared approval queue**, so it is in the
  banned list above and in `tab-cache.test.ts`: seeded for the paint, but the mount
  fetch **always** runs (silently when there are cached rows). Two people hold
  `accounting/documents` edit, and a skipped refetch is how the second one signs a
  request the first already rejected. The 60s `useLiveRefresh` poll is the same
  backstop-not-substitute it is for Transfers.
- **`documentsSignature`** — the viewer's own saved signature row. Not a queue and not a
  pay figure: only the viewer changes it, from this same tab. It is still
  seed-and-revalidate rather than skip-flagged, because `signatureLoaded` gates the
  one-time auto-capture prompt and **that flag is never seeded** — "does this rep have a
  signature" has to be answered by the server, or a cached `null` pops the capture
  dialog on a tab switch.
- **`documentsView`** — the first **UI selection** in this store: the status pill, the
  search text and the Queue ⇄ Termination Letters sub-tab. No row data. The envelope
  guarantees identity, version and age but not the shape inside, so `readCachedView`
  re-validates every field against the same `FILTERS` / `DOC_TABS` lists the pills
  render from; an unrecognised value falls back to the default rather than being
  trusted into an unrenderable filter.

Two render rules came with it, the same recipe as Transfers: the spinner is derived
(`!settled && rows.length === 0`, `settled` never seeded and never reset) and the
**Refresh** button keeps its own `refreshing` flag; and the full-height error card now
only renders when there is nothing to paint (`error && rows.length === 0`). Before
2026-10-05 a failed manual Refresh over a populated table raised a toast instead, because
blanking the queue on a network blip is worse than the blip. Since 2026-10-05 the Refresh
click reports that failure in the refresh modal, which stays open with the reason and Try
again ([table-refresh-progress.md](./table-refresh-progress.md)), so the click raises no
toast. A silent poll that fails still sets the same error state.

This is a client paint only. No route changed, every fetch is still `cache: 'no-store'`,
and no gate moved — `requireFeatureAccess` / `requireFeatureEdit` decide as before.

### Payment Catalog joined, and wired the key that was already reserved (2026-09-21)

`BonusCatalog.tsx` was the other heavy Accounting tab with no cache at all. Kane:
*"Payment Catalog - Add caching in there it loads all the time lol."* Leaving the tab
unmounted it, and returning re-ran all six `CATALOG_SOURCES` reads behind the
"Loading catalog..." card with the whole eight-tab surface blank.

`ratesSummary` had been **declared since 2026-09-09 with no consumer** — reserved when
the envelope shipped, listed in the banned list, never wired. It is now the key it was
reserved to be.

Three keys, and the categories are the ones this doc already draws:

- **`ratesSummary`** — the six payloads as ONE entry. The Payment Catalog is the
  **rate source of truth**, so it is squarely in the banned category above: the seed
  paints, the mount `refetch()` **always** runs, and no skip flag may ever gate it. It
  was already in `tab-cache.test.ts`'s banned list, which is why wiring it needed no
  new entry there.

  One key rather than six is deliberate and is a **correctness** choice, not a
  convenience: two of the six carry **CAS revisions that may never be separated from
  the rows they describe** — the department registry moves with its `revision` and
  `managers`, `builtinSubs` moves with `builtinSubsRevision`. Across separate keys the
  store's own per-key age eviction could drop the rows and keep the token, and a stale
  revision beside a fresh registry is how a save clobbers a teammate's edit instead of
  earning its 409. `catalog-cache.test.ts` pins both pairings in both directions.
- **`ratesFx`** — the USD-anchored rates, its own fetch and its own failure mode, so
  its own key. Validated as finite and positive on read; anything else keeps
  `officialFxRates()`. These only sort the Bonus Library by PHP-equivalent — they never
  convert a payout, which still happens at apply time in the KPI Calculator.
- **`ratesView`** — which of the eight tabs the viewer left on. UI selection only, same
  category as `documentsView`, re-validated against `CATALOG_TAB_IDS` on read so a tab
  retired by a future deploy cannot come back out of a still-open browser tab as an
  unrenderable selection.

The readers live in `src/lib/payment-catalog/catalog-cache.ts` — a pure module rather
than private helpers inside a 6,200-line component, because the pairing rules above are
the kind of invariant that has to be testable. `parse*` is split from `read*` so the
rules can be exercised without a storage mock.

The same two render rules came with it: `loading` is now **derived**
(`!settled && nothing-to-paint`, `settled` never seeded and never reset) rather than a
stored `useState(true)`, and `refreshing` keeps its own flag for the Retry button. The
"nothing to paint" test deliberately **excludes `banks`** — it is the one read that is
legitimately empty for a viewer whose payees have no bank cells, so it cannot stand for
"the catalog arrived".

A partial failure caches exactly what is on screen: `refetch` builds its cache value
from the same guards as the state commits, so a read that did not land carries its
previous value into the cache just as it keeps it on the tab. The mirror is written from
**server truth only** — the optimistic local edits (`upsertBonus` and friends) do not
touch it, because they reconcile by calling `refetch` and a write that may still be
refused does not belong on disk.

This tab has **no SSR/hydration seed mismatch**: `App.tsx` starts `activeTab` at
`'overview'`, so `BonusCatalog` never renders server-side. (This line used to say "unlike
`PeopleTab`". The same argument covers `PeopleTab`, measured 2026-10-06; see *Not done*.)

Client paint only. No route changed, every fetch is still `cache: 'no-store'`, the
Realtime channel and the focus refetch are untouched, and no gate moved.

**A seventh read, deliberately outside the blob (2026-09-24).** `People`
(`GET /api/payment-catalog/roster`) joined `CATALOG_SOURCES` because the roster had
been frozen at page load and transfers never moved a headcount
(payment-catalog-departments.md §2). It is **not** mirrored into `ratesSummary`: the
seed is already on the page as `initialData.employees`, and ~1,200 names and emails
in sessionStorage buy nothing. The roster and its off-board set commit together or
not at all, the same pairing discipline as the CAS pairs above.

### NPD joined, as a picture only (2026-10-02)

Kane: *"Make sure to add caching on this please so we dont have to load the data everytime lol"*.
NPD had been kept out deliberately (`npd-dashboard.md`, CHOSEN 7): it is an **editable** sheet, and a
stale paint invites typing over an old copy. Kane overturned the choice; the reason became a rule.

- **`npdSheet(tab, week)`**, one sheet per entry, and **`npdSheetIndex`**: at most four sheets, most
  recently used, because one sheet is a few hundred kB of this store's shared quota. Per-person pay,
  so the banned category (no skip flag; listed in `tab-cache.test.ts`). **The seed is read-only**:
  `useNpdSheet` paints it but leaves the session's version and saved rows unset, so nothing can be
  typed, saved, locked or synced onto it until the live read lands. A failed live read keeps the copy
  on screen, still read-only, under an amber *Not refreshed* pill, never green and never empty.
- Written from **server truth only**, by ONE function (`writeNpdSheetCache`, `src/components/npd/npd-sheet-loader.ts`):
  a finished read, a confirmed save, a confirmed lock. Since 2026-10-05 the finished read is written by
  the loader itself, so a read of a tab nobody is looking at (the read-ahead of the other tab, or a
  visit switched away from) is kept too, and only for the viewer it was started for. Test-pinned: one
  call in the loader, two in the hook, and nothing else in NPD writes a sheet. Re-validated on read in
  `src/lib/npd/npd-cache.ts`, because the envelope does not guarantee shape. Every open still reads
  live; an open may JOIN a read in flight, never adopt a finished one.
- **`npdWeeks`** (the week menu) and **`npdSyncWeek`** (the wizard's week and each tab's *Last
  synced*): paint, then always re-read.
- **`npdView`**: the week NPD was left on. A UI selection like `documentsView`, re-checked as a real
  Sunday on read, so returning lands on the sheet the cache holds.

### CEO Overview: the frame paints, the values load (2026-10-02)

Kane: *"CEO - Overview - Enhance this dashboard to have the loading states like Accounting -
Overview as well so it doesnt show too much skeleton for too long add cache"*. The KPI
snapshot was already cached, but `CeoOverviewKpis` **early-returned a full-page skeleton**
while `/api/ceo/overview-kpis` ran (the roster, the live pay engine and the reports in one
read), so on a cold load the whole page, including "Payments to send", which has its own
faster feed, waited on the slowest query. And "Payments to send" had **no cache at all**,
so it flashed a skeleton on every tab switch and every reload.

The rules now:

- **No full-page skeleton.** The real cards always render. Shimmer bars appear only
  inside a card, for a value that is not known yet.
- **The hero loads the way Accounting's does, through the same components.** Amber
  *Dashboard · syncing* pill (faster ECG sweep), the `hero-loading-border` class on the
  card, the payout as `RollingPayout` reels spinning in place of the number
  (`src/components/accounting/rolling-payout.tsx`, moved out of `Overview.tsx` so both
  dashboards render one component, the `hero-stat-row.tsx` precedent), and `—` in the
  `HeroStatRow` tiles. The greeting never waits on the read.
- **`loading` is derived:** `!settled && kpis == null`, with `settled` never seeded and
  never reset, so a revalidation behind cached numbers cannot bring the loading state back.
- **A failed read with nothing cached is `—`, never a made-up `0`.** The hero keeps its
  frame under a rose *offline* pill, the Unpaid card reads `—` / *Not available right now*,
  Headcount reads *Headcount isn't available right now*. *No active pay cycle to summarize
  yet* is shown only when a **loaded** snapshot has no `systemOverview`. Before, a failed
  cold read showed that line plus `0` unpaid and `0` headcount as facts. A missing total
  is a dash, never a reel left spinning.
- **The reconciliation drill-down opens only once its rows exist.** While loading, an
  empty modal would read as "Accounting hasn't published this cycle".
- **"Payments to send" paints from `ceoPaymentsLive`.** `usePaymentsLive` seeds from it
  (`seedFromCache`) and always refetches: a count over the dispatch queue other people
  work, so it is in the banned list and never skip-flagged. What is cached is built by an
  allow-list (`src/lib/ceo/payments-live-cache.ts`): the cycle, its label,
  total / paid / remaining, and per-department progress. **The per-person `recent` feed
  (names, emails, the amount each person was paid) is never cached**, and a seeded state
  never sets `recentHydrated`, because the live modal's "newly paid" diff keys off that
  flag. Writes happen only when real counters arrive (a good fetch or an Accounting
  broadcast bumps `cacheRev`). A mount never writes the seed back, so it never restamps
  it as fresh. The parser rejects the whole entry on any malformed field.
- **A failed payments read keeps the last good counters.** The hook used to replace them
  with `json.total ?? 0` on any error body, painting "0 left of 0" as a fact. With a
  cached paint underneath, that would have wiped a good card on one failed revalidation.

Left live on purpose: the dispatch lock behind the *Live / Idle* badge (a stale
"Accounting is processing live" is a wrong answer, not a stale one, like presence) and the
`CeoApp` role check (a guard; its spinner runs before any tab mounts and fails closed).

Client paint only. No route changed, every fetch is still `cache: 'no-store'`, no gate
moved. Verified by `tsc` and the full suite (5,662 / 5,662). **Not clicked through signed
in** (Google SSO), and `next build` was not run because a `next dev` server was live on
:3000.

### People: the whole tab paints (2026-10-06)

Kane: *"Accounting - People - Cache store the data in cache"*. Since 2026-09-09 People had
cached its roster **rows** and nothing else. On every return the four week KPI cards read
`0` / `$0.00` until the read landed, the week selector said *Current week*, and Statistics and
Bank changes each sat on a skeleton. Same tab on the CEO shell.

Every People read and write goes through **`src/lib/people/people-cache.ts`**. A test fails if
any file under `src/components/people/` touches `setTabCache` / `getTabCache` /
`TAB_CACHE_KEYS` directly. The rules, all in that module and its tests:

- **`peopleRoster` is ONE entry: rows + summary + the week they are + a good read's
  warning.** The cards print "N of {rows.length}" and the period label names the rows' week,
  so they may never come from two reads. Per-key age eviction could split them, the same
  correctness argument as the Payment Catalog's CAS pairs. The key moved from `people:list`
  (bare rows) to **`people:roster:v2`**, so the old shape is orphaned, never read back as an
  entry. Still only the **default single week** is cached, never a custom range or a chosen
  week (unchanged). A profile save patches the cached rows and keeps their summary and week.
  With nothing cached it writes nothing, because a save has no summary to pair with.
- **A failed read is never cached.** `/api/people` answers 200 with `error` and **no rows** when
  the roster read itself failed. Before this change that empty roster was written to the cache
  as if it were true. Now the last good copy stays. With rows, `error` is a warning (bank
  change history unavailable) and is cached beside them, so the paint repeats the banner.
  The week list caches only a non-empty `r.ok` answer without `error`. Statistics and Bank
  changes cache only a successful read.
- **The selector paints the week the cached rows ARE** (`period` seeded from the entry's
  `sourceFile`). `defaultFileRef` stays unset until the live week list says which week is
  current, so no cache write can happen on a guess.
- **A summary not known yet is `—`, never `0`.** The two OT cards print a dash while
  `summary` is null (a cold load, or a failed read), the rule the CEO Overview set
  (§ *CEO Overview*). The export menu still passes `0` and was not changed.
- **Statistics keeps each point's top five leaders, nothing else is cut.** The live
  `/api/people/stats` answer was **measured at 3.2M characters** on 2026-10-06 (daily 76
  points 1.42M, weekly 26 points 1.15M, monthly 7 points 0.54M, leaderboard 0.12M), almost
  all of it the full OT leaderboard repeated inside every point. sessionStorage has roughly
  5M characters per origin, shared with the roster (**0.96M for 1,261 rows**, measured the
  same day), NPD and every other tab. A point's leaders are read ONLY by the chart tooltip,
  through `.slice(0, STATS_TOOLTIP_LEADERS)`. The cache trims to that same constant
  (**0.43M**). A test pins that the tooltip uses the constant and no literal. The live state
  keeps the full answer. The cross-week leaderboard (`otLeaders`, all 1,040) and every
  department series are kept whole. This is the store's second allow-listed copy after
  `ceoPaymentsLive`. Step 5 below ("cache the raw payload") still holds for everything else.
- **A failed Statistics read keeps the chart.** It used to replace the series with empty
  arrays. Now the series stays and a banner above it says it is the last copy loaded. With
  nothing on screen, the error card shows as before.
- **Bank changes paints the last feed with its own write time.** "synced … ago" is seeded
  from the entry's stamp (`readTabCacheStamp`), so the line is true for the paint. The
  spinner is derived (`!settled && rows.length === 0`). **`hydratedRef` is never seeded**:
  a cached copy is not a live read, so the first live read after it flashes nothing, the
  `recentHydrated` rule from `usePaymentsLive`. The rows are masked at write time
  (`mask-field.ts`: account, routing and phone numbers keep their last 4, payout emails
  their first letter and domain). They also carry the editor's IP address, kept because
  the detail dialog shows it. That is the same level as the roster's own addresses, phones
  and last-4s already held here.
- **Banned category, all of it.** Statistics carries per-person OT pay and Bank changes is a
  live feed. Both were added to `tab-cache.test.ts`'s banned list. The roster was already
  on it. Every mount still re-reads everything.

**Left cold on purpose:** which People sub-tab you were on (`people-bank-search.md:5`: *"Roster
is still the tab People opens on"*), the Offboarded search (search-first, nothing loads on
entry), the Search Bar's and the popup's person reads (they carry the payout record, never
cached), and the Statistics per-week leaderboard drill (on demand, per week).

Client paint only. No route changed, every fetch is still `cache: 'no-store'`, no gate moved,
and the Realtime pulse, the 30 s poll and the focus refetch on Bank changes are untouched.
Verified by `tsc`, 17 new tests in `people-cache.test.ts` (with a mutation check: deleting
the failed-read guard fails two of them) and the full suite (5,965 / 5,965). **Not clicked
through signed in** (Google SSO). `next build` not run.

## Adding another dataset

1. Add a key to `TAB_CACHE_KEYS`. Keys do **not** carry the viewer's email — the identity
   stamp does that isolation. A key only needs the parameters that select a genuinely
   different dataset for the same viewer (a week, a status filter).
2. Seed the call site's `useState` from `getTabCache(KEY)`.
3. **Leave the fetch effect running.** If you think you want the skip flag, re-read the
   policy above and add the key to the test's banned list if it is money or a queue.
4. Derive the spinner (`!settled && nothing-to-paint`) rather than storing it.
5. Cache the **raw** API payload. The mirror is JSON: a `Date` returns as a string and a
   `Set`/`Map` serialises to `{}`. Derive the render shape with `useMemo` through a
   module-scope pure function so the seeded and fetched paths cannot diverge.

## Not done

- **This is the fourth copy of the same ~250 lines.** `employee/tab-cache.ts`,
  `manager/tab-cache.ts`, `manager/kpi-cache.ts` and this one now share an
  identity/version/age envelope with different prefixes and key sets. Extracting a shared
  factory is the obvious follow-up and is still open — it was not done here because all
  four are shipped and tested, and migrating them is its own review.
  (`manager-dashboard-cache.md` § *Not done* has said this since 2026-09-01.)
- **`PeopleTab`'s SSR/hydration seed mismatch: measured unreachable, 2026-10-06.** This
  bullet used to say: the `/accounting` route renders `AppShell` server-side, so the seed
  yields `[]` on the server and cached rows on the client. But `PeopleTab` is mounted only by
  `App.tsx` and `CeoApp.tsx`, and **both start `activeTab` at `'overview'`** (`App.tsx:73`,
  `CeoApp.tsx:42`), switching tabs only from an effect or a click. So `PeopleTab` never
  renders on the server, which is the same argument this doc already accepts for
  `BonusCatalog`. The mismatch returns if either shell ever starts on (or server-renders) the
  People tab, for example a deep link resolved during render. Then the seed must move
  into a layout effect, the `PayrollNotesSetupCard` recipe.
- **No server-side caching.** Every route keeps `cache: 'no-store'`; this is a
  client-side paint optimisation and changes no route's freshness.
- **Not verified in a browser.** `tsc` is clean and, as of the 2026-09-21 Payment
  Catalog pass, 4112/4114 tests pass (the two failures are pre-existing and unrelated —
  `dept-label-render` and `manager-time-adjustments-live`, both confirmed failing with
  the change stashed out), but the live sign-out / `?email=` / reload behaviour was not
  clicked through (needs Google SSO + Supabase auth). `next build` was **not** run on
  the Payment Catalog pass either: a `next dev` server was live on :3000 and the two
  share `.next/`.
