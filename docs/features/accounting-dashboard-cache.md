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

Nine call sites across three shells read it, which is why it is neither the Accounting
store nor the CEO store but the shared one:

| Consumer | Datasets |
| --- | --- |
| `components/Overview.tsx` | `overviewPayouts`, `overviewPabMetrics` |
| `people/PeopleTab.tsx` | `peopleRoster` |
| `accounting/AccountingTransfers.tsx` | `transfers` |
| `accounting/PayrollWizardNotesFab.tsx` | notes rows, workers, uploads, readiness, offboarded |
| `payroll/AccountingMesa.tsx` | `mesaRequests`, `mesaNonMembers`, `mesaActiveMembers` |
| `payroll/PabDisputeQueue.tsx` | `pabDisputes`, `pabReasonCodes`, `bankPreferredRequests` |
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
`ratesSummary`, `overviewPayouts`, `payrollReadiness` and `payrollNotesOffboarded`, so
the boundary cannot be crossed by copy-paste.

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
- **Not verified in a browser.** `tsc` is clean and 2739/2741 tests pass (the two
  failures are pre-existing and unrelated — `dept-label-render` and
  `manager-time-adjustments-live`), but the live sign-out / `?email=` / reload behaviour
  was not clicked through (needs Google SSO + Supabase auth).
