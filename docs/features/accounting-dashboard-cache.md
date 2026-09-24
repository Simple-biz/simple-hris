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

Siblings: `employee-dashboard-cache.md`, `manager-dashboard-cache.md`, and
`hsl-kpi-calculator-2026-07.md` § *Tab-switch & reload cache*.

## One store, three dashboards

Eleven call sites across three shells read it, which is why it is neither the Accounting
store nor the CEO store but the shared one:

| Consumer | Datasets |
| --- | --- |
| `components/Overview.tsx` | `overviewPayouts`, `overviewPabMetrics` |
| `people/PeopleTab.tsx` | `peopleRoster` |
| `accounting/AccountingTransfers.tsx` | `transfers` |
| `accounting/AccountingDocuments.tsx` | `documentsQueue`, `documentsSignature`, `documentsView` |
| `accounting/BonusCatalog.tsx` | `ratesSummary`, `ratesFx`, `ratesView` |
| `accounting/PayrollWizardNotesFab.tsx` | notes rows, workers, uploads, readiness, offboarded |
| `payroll/AccountingMesa.tsx` | `mesaRequests`, `mesaNonMembers`, `mesaActiveMembers` |
| `payroll/PabDisputeQueue.tsx` | `pabDisputes`, `pabReasonCodes`, `timeAdjustmentIssues` (`bankPreferredRequests` was deleted 2026-09-24 with the Issues table's Bank Preferred rows) |
| `payroll-clerk/useDispatchQueue.ts` | `dispatchQueue` |
| `ceo/CeoOverviewKpis.tsx` | `ceo:overview-kpis`, `ceo:viewer-name:<email>` |
| `ceo/CeoFinancialReports.tsx` | the financial-report snapshot |

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
  live (`usePaymentsLive`).

**Banned:** any dataset carrying a per-person pay figure, or a queue other people act
on. There, a skipped fetch freezes one person's view of work somebody else has already
done — `manager-dashboard-cache.md`'s "stale-and-stop is how two managers approve the
same request twice", and `employee-dashboard-cache.md`'s reason, which is that
`upsertPaystubDispatchQueue` re-stages onto an already-PAID row with no post-pay detector
([[paystub-staged-snapshot-stale]]). `tab-cache.test.ts` greps the call sites for
`dispatchQueue`, `peopleRoster`, `transfers`, `pabDisputes`, `bankPreferredRequests`,
`ratesSummary`, `overviewPayouts`, `payrollReadiness`, `payrollNotesOffboarded` and
`documentsQueue`, so the boundary cannot be crossed by copy-paste.
`bankPreferredRequests` stays on that banned list although the key was deleted on
2026-09-24. A name on a ban list protects the boundary if the key ever returns, and
removing it would loosen a test.

**A flag can never outlive its data.** `clearTabCache` and `clearAllAccountingCache` both
clear `fetchedThisSession`. Without that, a purge would leave the flag reporting "already
pulled" for a dataset that no longer exists and the pane trusting it would stay
permanently empty.

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
of the rule*.

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
only renders when there is nothing to paint (`error && rows.length === 0`) — a failed
manual Refresh over a populated table raises a toast instead, because blanking the
queue on a network blip is worse than the blip.

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

Unlike `PeopleTab`, this tab has **no SSR/hydration seed mismatch**: `App.tsx` starts
`activeTab` at `'overview'`, so `BonusCatalog` never renders server-side.

Client paint only. No route changed, every fetch is still `cache: 'no-store'`, the
Realtime channel and the focus refetch are untouched, and no gate moved.

**A seventh read, deliberately outside the blob (2026-09-24).** `People`
(`GET /api/payment-catalog/roster`) joined `CATALOG_SOURCES` because the roster had
been frozen at page load and transfers never moved a headcount
(payment-catalog-departments.md §2). It is **not** mirrored into `ratesSummary`: the
seed is already on the page as `initialData.employees`, and ~1,200 names and emails
in sessionStorage buy nothing. The roster and its off-board set commit together or
not at all, the same pairing discipline as the CAS pairs above.

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
- **`PeopleTab` has a pre-existing SSR/hydration seed mismatch.** The `/accounting` route
  renders `AppShell` server-side, so `useState(getTabCache(...))` yields `[]` on the
  server and cached rows on the client. The envelope did not introduce this and does not
  worsen it (reads were already inert server-side), but the other two stores treat
  hydration safety as load-bearing and this one has no argument for it. Own review.
- **No server-side caching.** Every route keeps `cache: 'no-store'`; this is a
  client-side paint optimisation and changes no route's freshness.
- **Not verified in a browser.** `tsc` is clean and, as of the 2026-09-21 Payment
  Catalog pass, 4112/4114 tests pass (the two failures are pre-existing and unrelated —
  `dept-label-render` and `manager-time-adjustments-live`, both confirmed failing with
  the change stashed out), but the live sign-out / `?email=` / reload behaviour was not
  clicked through (needs Google SSO + Supabase auth). `next build` was **not** run on
  the Payment Catalog pass either: a `next dev` server was live on :3000 and the two
  share `.next/`.
