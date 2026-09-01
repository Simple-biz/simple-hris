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

Four, all on the Overview, all plain-JSON or raw-payload:

| Key | Source | Note |
|---|---|---|
| `masterRow` | `GET /api/employees?email=` | name / emails / department — drives the greeting, the HSL check and the dept key |
| `rateHistory` | `GET /api/employee-rate-history?email=` | RAW rows; parsed for the PAB day badge |
| `paidPaystubWeeks` | `GET /api/employee/paystub` (weeks mode) | week LIST, not the derived `Set` |
| `specialTransfers` | `GET /api/people/special-transfers?email=` | the one-off transfers strip |

**Every key in `EMPLOYEE_CACHE_KEYS` is wired to a live call site.** An unused key is
an invitation to cache something under a shape it was not written for; if a dataset
stops being cached, delete its key with the call site.

### Adding another dataset

1. Add a key to `EMPLOYEE_CACHE_KEYS`.
2. Swap that call site's `useState(initial)` for `useEmployeeCachedState(KEY, initial)`.
3. **Leave the fetch effect alone.** That is what keeps stale-while-revalidate true by
   construction — there is no way for a call site to accidentally skip its fetch.
4. If the state holds a `Date` / `Set` / `Map`, cache the raw payload instead (above).

## Not done

- **Only the Overview is wired.** Profile, My Hours, MESA, Leaves, Team and KPI Results
  still reload cold. The recipe above is all they need; each is its own review.
- **No server-side caching.** Every route keeps `cache: 'no-store'`; this is a
  client-side paint optimisation and changes no route's freshness.
- **The heavy pay row itself is not cached** — `refreshDashboard`'s `row`/`columns`
  fan-out is the single biggest reload cost and the most delicate money path. Caching
  it needs its own decision about what an "as of" label should say.
- **Not verified in a browser.** `tsc` is clean and 1741 tests pass, but the live
  reload behaviour was not clicked through (needs Google SSO + Supabase auth).
