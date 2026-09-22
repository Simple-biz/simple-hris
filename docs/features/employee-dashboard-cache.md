# Employee dashboard — reload cache

Kane, 2026-08-31: *"if I refresh its also saved properly into PC until they close the
browser or tab"*. The employee portal now keeps its already-loaded datasets across a
page reload and drops them when the tab closes.

Key files:

- `src/lib/employee/tab-cache.ts` — the store (memory Map + `sessionStorage` mirror).
- `src/hooks/useEmployeeCachedState.ts` — the `useState` drop-in call sites use.
- `src/components/employee/EmployeeApp.tsx` — binds the cache to the resolved viewer.
- `src/components/employee/EmployeeSidebar.tsx` — purges it on sign-out.
- `src/components/employee/EmployeeDashboard.tsx` — the four wired Overview datasets.
- `src/lib/employee/rate-row-cache.ts` — the projection that keeps payment routing out of
  storage; its key lists are partitioned at compile time (+ `.test.ts`).
- `src/lib/employee/rate-history.ts` — the ONE rate-history parser, shared by the Overview
  and My Hours (+ `.test.ts`).
- `EmployeeKpiResults.tsx` · `EmployeeLeaves.tsx` · `EmployeeTeam.tsx` · `EmployeeMesa.tsx` ·
  `EmployeeMyHours.tsx` — the five tabs wired 2026-09-22.
- Tests: `src/lib/employee/tab-cache.test.ts`.

## What was actually slow

Not tab switching. The employee shell renders `Array.from(mountedTabs)` and merely
**hides** the inactive tabs, so a visited tab keeps its React state and its fetches
never re-run. The expensive event is a **reload**: state dies, and the Overview alone
re-runs ~22 `cache: 'no-store'` fetches before it can paint a single peso.

So the cache is scoped to that one event, and to nothing else.

## Lifetime — `sessionStorage`, never `localStorage`

| Event | Cache |
|---|---|
| Tab switch | kept (state was never lost anyway) |
| F5 / reload / back-nav | **kept** — the point of the feature |
| Close the browser tab | gone |
| Quit the browser | gone |
| Sign out | gone — purged explicitly |
| A different person signs in on that tab | gone — purged on identity bind |
| Entry older than 12h | gone — treated as absent and evicted |

`localStorage` **must not** be used here. It outlives the browser, which would leave
one person's pay figures on a shared machine indefinitely. `sessionStorage` is
per-tab and dies with it, which is exactly the lifetime that was asked for.

## The rule that makes this safe on a money surface

> **A cached value paints. It never decides.**

Call sites seed their state from the cache so the screen is instant, then run their
existing unconditional fetch and overwrite it. Stale-while-revalidate, always.

There is deliberately **no "already fetched, skip it" flag** in this module. The
Accounting equivalent (`src/lib/accounting/tab-cache.ts`) ships one
(`hasFetchedThisSession`); copying it here would be a bug.
`upsertPaystubDispatchQueue` re-stages `payload` / `amount_php` / `amount_usd` onto an
**already-PAID** row with no post-pay detector — see
[[paystub-staged-snapshot-stale]] — so a pay figure can change underneath a cached
copy with nothing to announce it. Stale-then-corrected is fine. Stale-and-stop is how
someone reads last week's number as this week's.

A `no-skip-flag` test pins the absence of any such export so it cannot return by
copy-paste. `readEmployeeCacheStamp(key)` exposes the write time for an "as of" label.

## Identity is part of every entry

Every value is stamped with the identity it was fetched for. Reads reject any other
stamp, the cache is **inert until `bindEmployeeCacheIdentity` is called**, and binding
a different identity **purges everything first**.

This is load-bearing, not defensive decoration. `EmployeeApp` resolves identity from
the authenticated session but honors `?email=` for elevated viewers previewing another
employee's portal, and writes the result to `sessionStorage` in the **same tab**
(`EmployeeApp.tsx:252-258`). Without the stamp, an admin previewing Jane and then
landing on their own portal would repaint Jane's pay from cache — defeating the
"a stale or spoofed email can never surface another person's data" property that
identity block exists to guarantee.

Binding happens in the same effect that sets `employeeEmail`, which is also what gates
`renderContent` — so identity is bound before any tab can mount and read.

Sign-out calls `clearAllEmployeeCache()` directly rather than waiting for the next
bind, because the next person on that tab should never have the bytes on disk at all.
The purge enumerates the `emp-cache:` prefix, so keys left by an older deploy go too.

## Hydration

Seeding runs in a `useState` initialiser that reads `sessionStorage`, which is safe
here for the same reason `usePennyGreetingChips` is: **no consumer exists during
hydration.** `EmployeeApp.renderContent` returns `null` until `employeeEmail` is set,
and that is set inside an effect — so every employee tab mounts strictly after the
first client paint and is never part of the server HTML. Do not lift a cached read
above that gate.

## Shapes that do not survive `JSON.stringify`

The mirror is JSON. A `Date` comes back as a string; a `Set` or `Map` serialises to
`{}`. Caching a derived shape that contains one is a **silent** corruption — an empty
`Set` reads as "no paid weeks" and quietly disables the Paystubs button after every
reload; a stringified `Date` makes `row.effectiveFrom.getTime()` throw on the first
render after a refresh.

So: **cache the raw API payload and derive the render shape with `useMemo`.** Both
affected Overview datasets do this — `paidPaystubWeekList` (raw `string[]` → `Set`) and
`rateHistoryRows` (raw rows → `parseRateHistoryRows`, which is module-scope and pure so
the seed path and the fetch path cannot diverge).

## Wired datasets

Eight on the Overview and Profile, listed here; the other five tabs joined on 2026-09-22
and are tabled further down. All plain-JSON or raw-payload:

| Key | Source | Note |
|---|---|---|
| `masterRow` | `GET /api/employees?email=` | Overview · name / emails / department — drives the greeting, the HSL check and the dept key |
| `rateHistory` | `GET /api/employee-rate-history?email=` | Overview · RAW rows; parsed for the PAB day badge |
| `paidPaystubWeeks` | `GET /api/employee/paystub` (weeks mode) | Overview · week LIST, not the derived `Set` |
| `specialTransfers` | `GET /api/people/special-transfers?email=` | Overview · the one-off transfers strip |
| `profileMaster` | `GET /api/employees?email=` + `/api/employee-master-record` | Profile · the FULL master row (address fields merged in) — a different shape from `masterRow`, hence its own key |
| `profileRate` | `GET /api/employee-hourly-rates?email=` | Profile → Compensation → **Rates** · the resolved rate row, **NARROWED by `toCachedEmployeeRate`** — the live row also carries payment routing (see below) |
| `profileSkillSet` | `GET /api/employee-skill-sets?email=` | Profile · the normalised skill-set fields |
| `paystubSummary` | `GET /api/employee/paystub?summary=1` | Profile → Compensation → **Pay Stubs** · RAW summary rows; the list paints from them while the live fetch runs. **Fetched on the SECTION, not the tab** (see below) |

### What the Profile deliberately does NOT cache (2026-09-03, restated 2026-09-12)

The **bank / payout row** (`GET /api/employee-ids?email=`) carries account numbers and
is never written to storage. Consequence: when the rest of the Profile paints from
cache, the payout view alone waits for the live row behind its own `bankInfoLoaded`
flag and shows a skeleton — never the empty "add your payout details" form flashing over
saved details. The whole-page `ProfileSkeleton` now shows only when nothing is cached
(`loading` seeds from `master === null`); with a cached identity the page paints at once
and refreshes in place.

**Since the 2026-09-12 tab merge that uncached row lives INSIDE a merged tab.** Payment is
no longer its own chip — it is the **Payout** section of Compensation, sitting beside Rates
and Pay Stubs, which both paint from this store instantly
([employee-profile.md](./employee-profile.md) §3). Three consequences are load-bearing, and
each is pinned by `src/lib/employee/profile-cache-conformance.test.ts`:

- **Five states, not one, must stay off this store**: `bankInfo`, `payout`,
  `walletRailEffective`, `bankPreferred` and `pendingBankPreferred`. The test fails if any of
  them is ever bound to `useEmployeeCachedState`. "Cache the Profile" is now an instruction
  that reaches five plain `useState` calls sitting in the same state block as four cached
  ones.
- **The readiness states stay separate.** `bankInfoLoaded` is NOT folded into the tab's
  visibility or into the page-level `loading`. Folding it in would make Rates and Pay Stubs —
  both instant from cache — wait on the one uncacheable call in the wave.
- **The pay-stub fetch gates on the SECTION, never the tab.** Gated on the tab, every
  employee who opened Compensation to check a bank detail would fire
  `/api/employee/paystub?summary=1`, and under `SHOW_UNPAID_STAGED_PAYSTUBS` that route runs
  per-week recovery — so the wasted call is expensive, not merely wasted.

The merge added no key and changed nothing this store persists, so **`SCHEMA_VERSION` was
correctly not bumped**.

The Profile's identity fetch is also **one wave** now: `/api/employee-master-record` and
`/api/bank-preferred-requests` used to wait for the first four calls and then for each
other (three serial hops behind one skeleton). They have no data dependency on the
others, so all six run in one `Promise.all`; the two optional ones resolve to `null` on
a network failure so a missing badge can never fail the profile.

**Every key in `EMPLOYEE_CACHE_KEYS` is wired to a live call site.** An unused key is
an invitation to cache something under a shape it was not written for; if a dataset
stops being cached, delete its key with the call site.

### The rate row is NARROWED before it can be stored (2026-09-22)

`profileRate` cached the **whole** `EmployeeHourlyRateRow` from 2026-09-03. That row is
not only a rate: it also carries the person's payment **routing** — `bank_preferred`,
`hurupay_email`, `higlobe_email`, `higlobe_account_name`, `phone_number`,
`full_address`, `city`, `province_state` and the open `mesa_account_number`.

So the paragraph above — *"the bank/payout row is never cached: account numbers stay out
of storage"* — was true of the row the Payment pane fetches and **false of the one beside
it**. Every signed-in employee's own home address, phone number and wallet addresses sat
in `sessionStorage` under `employee:profile-rate` until the tab closed. The store's tests
pin **key spellings** — no key may be named after a bank — and a routing field riding
inside a rate row is precisely the shape a key-spelling test cannot see.

`src/lib/employee/rate-row-cache.ts` is now the only way in. It projects the row down to
pay identity and MESA membership, and **the two key lists are partitioned at compile
time**: every key of `EmployeeHourlyRateRow` must appear in exactly one of them, so adding
a routing column upstream and forgetting this file is a **type error**, not a quiet leak.
That is the guarantee the key-spelling tests could not give. Verified by removing
`hurupay_email` from the classification and watching `tsc` fail.

Both call sites use it: Profile (`employee:profile-rate`) and My Hours
(`employee:my-hours-rate`). Neither ever read a routing field — the projection changed no
rendered value.

### One rate-history parser, not three (2026-09-22)

`parseRateHistoryRows` was module-scope in `EmployeeDashboard.tsx` and separately
re-implemented inside `EmployeeMyHours.tsx`'s fetch callback. Two parsers behind one cache
key defeats the reason the RAW rows are what get cached. Both now import
`src/lib/employee/rate-history.ts`.

Consolidating it surfaced a latent fault in both copies: `parseRateText` used a bare
`parseFloat`, which stops at the first unusable character and returns what it got —
`parseFloat("8:20:29")` is **8** and `parseFloat("175abc")` is **175**. That is item 167's
failure class with a worse ending, because `Number()` at least produced a visible `NaN`
while this hands back a plausible rate. The parser now requires the WHOLE string to be a
number and returns `null` otherwise, which the callers already render as "no rate on
file". No real rate is rejected — stored rates are plain decimal strings. Pinned by
`rate-history.test.ts`.

### Adding another dataset

1. Add a key to `EMPLOYEE_CACHE_KEYS`.
2. Swap that call site's `useState(initial)` for `useEmployeeCachedState(KEY, initial)`.
3. **Leave the fetch effect alone.** That is what keeps stale-while-revalidate true by
   construction — there is no way for a call site to accidentally skip its fetch.
4. If the state holds a `Date` / `Set` / `Map`, cache the raw payload instead (above).

## The other five tabs joined (2026-09-22)

Kane: *"if Im from accounting dashboard and went to the manager dashboard I shouldnt have
to refetch data again."* A dashboard switch is `router.push` (`ViewSwitcher.tsx:97-99`), a
client-side navigation — so this store already survived one, and what reloaded cold was
the tabs that were never wired. Those five are now wired, on the same terms as the rest:
seed the paint, always refetch, derive the spinner.

| Tab | Keys | Note |
|---|---|---|
| KPI Results | `kpiResults` | RAW published periods. The full-height error card now renders only when there is nothing to paint; a failed refresh over painted periods becomes a header strip instead of blanking the tab |
| Leaves | `leaveRequests` | RAW own-request rows. A failed load blanks ONLY when nothing was painted — the toast still reports every failure |
| Team | `teamRoster`, `teamRankings`, `teamSkillSets` | **presence is lifted OFF the cached rows**, below |
| MESA | `mesaMembership`, `mesaRequests`, `mesaBalance`, `mesaLedger` | membership is cached as RAW fields and `isMember` is DERIVED — the live shape's `null` arm means "still loading", and a cached loading arm paints as a settled fact |
| My Hours | `myHoursStartDate`, `myHoursMerged`, `myHoursRate`, `rateHistory`, `memberPay:<YYYY-MM>` | the three dominant fetches; see below |

**Team: `lastSeenAt` moved off the row rather than being cached with it.** The roster rows
carry a per-person presence stamp, and `manager-dashboard-cache.md` is explicit that a
liveness signal repainted from a 12-hour-old copy is a *wrong* answer. Deleting it was not
an option either: it is the newest of the person's WORK and PERSONAL stamps, so it is the
only value covering someone who only ever signs in under a personal address — the seven
USEE people — and dropping it would have read as "never signed in". It now lives in
`rosterPresence`, plain state keyed by profile id, which dies with the page. `lastSeenFor`
prefers the live 60s poll, then that floor. The `Teammate` type no longer has the field at
all, so the cached rows **cannot** carry presence.

**My Hours caches the RAW `merge_all` payload, not the merged row.** Resolving canonical
weekday columns to ISO dates needs the source FILENAME, which only the raw payload still
carries, so `deriveMergedHours` is module-scope and pure and both the seeded and the
fetched path go through it. The start date is stored as its raw ISO string and the `Date`
is derived, for the usual reason. `memberPay` is keyed **per month** — unlike the Manager
Overview's pay week, which is paint-only and labelled on screen, this figure sits beside a
month the viewer chose, so another month's value would be a wrong answer rather than a
stale one; its `settled` flag is therefore per month too.

## Not done

- **My Hours is partially wired.** The three dominant fetches are cached; the month-scoped
  reads that sit behind them are not — PAB disputes, time adjustments, orphanage visits,
  the US-holiday map, PAB overrides and the tech-week overrides. Four of those six hold a
  `Map`, so each needs its raw payload cached and its map derived, and all six re-key on
  the displayed month. Cheap, but it is its own review.
- **No server-side caching of this kind.** Every route keeps `cache: 'no-store'`; this is
  a client-side paint optimisation and changes no route's freshness. (The employee
  paystub route separately memoizes whole-company ENGINE runs for weeks with no snapshot
  — a different thing, bounded by upload batch and a 5-minute TTL; see
  `paystub-dispatch.md` → "Recovered-week snapshots".)
- **The heavy pay row itself is not cached** — `refreshDashboard`'s `row`/`columns`
  fan-out is the single biggest reload cost and the most delicate money path. Caching
  it needs its own decision about what an "as of" label should say.
- **Not verified in a browser.** `tsc` is clean and 1741 tests pass, but the live
  reload behaviour was not clicked through (needs Google SSO + Supabase auth).
