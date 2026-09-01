# Manager dashboard — tab-switch & reload cache

Kane, 2026-09-01: *"Manager Dashboard — add proper caching in here please, I don't
have to load back when switching tabs or refresh."* The Manager shell now keeps its
already-loaded datasets across a tab switch and a page reload, and drops them when the
tab closes.

Key files:

- `src/lib/manager/tab-cache.ts` — the store (memory Map + `sessionStorage` mirror).
- `src/hooks/useManagerCachedState.ts` — `useManagerCacheIdentity` + the `useState`
  drop-in call sites use.
- `src/components/manager/ManagerApp.tsx` — binds the cache; the shell + Overview +
  My Team datasets.
- `src/lib/manager/use-bonus-scoring-queue.ts` — the Overview "Bonuses to score" panel.
- `src/components/manager/ManagerTransfers.tsx`, `ManagerBonusHistory.tsx` — the two
  other tabs with their own mount fetches.
- `src/components/manager/ManagerSidebar.tsx` — purges it on sign-out.
- Tests: `src/lib/manager/tab-cache.test.ts`, `src/lib/manager/bonus-scoring-items.test.ts`.

The KPI Calculator tab has its **own** store, `src/lib/manager/kpi-cache.ts` — see
`hsl-kpi-calculator-2026-07.md` § *Tab-switch & reload cache*. Two stores, because
that one is keyed by `(surface, department, payroll week)` and holds scored money.

## What was actually slow

Both events, unlike the Employee portal.

`ManagerApp` renders its content pane inside an `AnimatePresence mode="wait"` keyed on
`activeTab` (`ManagerApp.tsx:402-404`), so **every tab unmounts when you leave it** and
every fetch it owns re-runs from cold when you come back. The Employee shell renders
`Array.from(mountedTabs)` and merely *hides* the inactive ones, which is why
`employee-dashboard-cache.md` is scoped to reloads alone and this one is not.

> **The unmount stays.** It is what flushes the KPI Calculator's pending autosave —
> `memory/kpi-calculator-autosave`, *"Pending writes flush on tab-hide / `pagehide` /
> unmount"*. The fix is to cache the paint, never to keep the tabs mounted.

Per round trip, before:

| Surface | Cost per visit |
|---|---|
| Overview | 1 greeting lookup + the pay-week resolve + 4 scoring summaries |
| My Team | offboarding queue + resignations + skill sets (+ presence) |
| Transfers | 3 (`incoming`, `outgoing`, `done`) |
| Bonus History | 3 summaries |
| Shell (**on every tab switch, whatever you switch to**) | time adjustments + leave requests |

Listed as still-open in `memory/dashboard-switch-performance` — *"/manager re-fetches on
every tab switch"*.

## Lifetime — `sessionStorage`, never `localStorage`

| Event | Cache |
|---|---|
| Tab switch | **kept** — the tab really did unmount; this is the new part |
| F5 / reload / back-nav | **kept** |
| Close the browser tab | gone |
| Quit the browser | gone |
| Sign out | gone — purged explicitly |
| A different person signs in on that tab | gone — purged on identity bind |
| Entry older than 12h | gone — treated as absent and evicted |

`localStorage` **must not** be used here, for the same reason as the Employee portal: it
outlives the browser, and this cache holds a manager's roster and approval queue.

## The rule

> **A cached value paints. It never decides.**

Call sites seed their state from the cache so the screen is instant, then run their
existing unconditional fetch and overwrite it. Stale-while-revalidate, always.

There is deliberately **no "already fetched, skip it" flag**. The Accounting equivalent
(`src/lib/accounting/tab-cache.ts`) ships one; copying it here would be a bug. A
manager's roster, approval queue and transfer requests are all changed by *other
people*, so a skipped fetch freezes one manager's view of a queue somebody else has
since emptied. Stale-then-corrected is fine. Stale-and-stop is how two managers approve
the same request twice. A `no-skip-flag` test greps the module's own exports.

### Loading flags are part of the rule

Caching state is not enough on its own: a spinner that re-asserts itself on every mount
repaints the skeleton over data that is already on screen. The shell's approvals effect
did exactly that — it re-ran on **every** tab switch (`[activeTab]`) and opened with
`setRequestsLoading(true)`, so returning to the Overview flashed the skeleton over
unchanged rows.

So every wired surface derives its spinner instead of storing it:

```ts
const loading = !settled && <nothing to paint>;
```

`settled` means "the fetch has answered at least once in this page load", and it is
never reset. **The skeleton is for having nothing to show, not for having a request in
flight.** An in-flight *refresh* keeps its own separate flag where one existed
(`ManagerTransfers.refreshing`, which spins the Refresh button and nothing else).

## Identity is part of every entry

Every value is stamped with the viewer it was fetched for. Reads reject any other stamp,
the cache is **inert until `bindManagerCacheIdentity` runs**, and binding a different
viewer **purges everything first** — `ManagerApp` honours a `?email=` override in the
same tab (`ManagerApp.tsx:134-146`), and two managers share machines.

Sign-out calls `clearAllManagerCache()` directly rather than waiting for the next bind,
because the next person on that tab should never have the bytes on disk at all. The
purge enumerates the `mgr-tab:` prefix, so keys left by an older deploy go too.

### Why boundness is folded into the cache key

This is the one place the Manager shell genuinely differs from the Employee portal, and
getting it wrong makes the feature silently do nothing.

`EmployeeApp.renderContent` returns `null` until the viewer resolves, so no employee tab
exists before identity is bound and a plain `useState` initialiser is always safe.
**`ManagerApp` renders its tabs immediately** and resolves `viewerEmail` in an effect. On
the first render the cache is therefore still inert — so a `useState` initialiser would
miss and never look again, and binding during that render is impossible because there is
no email yet.

`useManagerCachedState` therefore treats the effective key as `null` while the cache is
unbound. The render in which binding happens is a key *change*, which reseeds through
React's documented adjust-state-during-render path — before paint, not a frame later.

That also makes hydration safe **by construction**: during SSR and the first client
render nothing is bound, both produce `initial`, and no `sessionStorage` value can
differ between them. (The Employee portal argues this from "no consumer exists during
hydration"; that argument is not available here.)

## Shapes that do not survive `JSON.stringify`

The mirror is JSON. A `Date` comes back as a string; a `Set` or `Map` serialises to `{}`.

So: **cache the raw API payload and derive the render shape with `useMemo`**, through a
module-scope pure function that the fetch path calls too — so the seeded and fetched
paths cannot diverge. Five derivations were extracted for exactly this:

| Function | Derives |
|---|---|
| `rosterGateOf` (`ManagerApp.tsx`) | the `ManagerTeamGate` union from the roster payload |
| `deriveOffboardBadges` | per-email offboarding status + the returned-request note |
| `derivePendingResignations` | pending resignations keyed by every known email |
| `deriveSkillSetMap` | skill sets by normalized work email |
| `buildBonusScoringItems` (`use-bonus-scoring-queue.ts`) | the Overview scoring states |
| `buildBonusHistoryRows` (`ManagerBonusHistory.tsx`) | the history table |

`buildBonusScoringItems` is the one worth guarding: it mirrors Payroll Readiness
(`buildKpiReadiness`) so the manager's Overview and the accountant's Readiness tab never
disagree about who is still pending. It now has its own tests
(`bonus-scoring-items.test.ts`), including the two rules whose *failure direction* is the
point — an unreadable catalog must not clear departments off the list, and a monthly
branch keys on the 1st of the month, not the pay week.

Caching a **gate** would be the same class of bug as caching a `Set`: `ManagerTeamGate`
has `loading` and `error` arms, and a reload must never paint either as a settled fact.
That is why the roster payload is the cached unit and the gate is derived.

## Wired datasets

| Key | Source | Note |
|---|---|---|
| `teamRoster` | `GET /api/manager/department-members` | RAW; `teamMembers` **and** `teamGate` derive from it |
| `timeAdjustmentRows` | `GET /api/manager/time-adjustments` | the pending rows only — see *Not cached* |
| `pendingApprovalCount` | ↑, and the tab's own `onCountChange` | its own key: the two are deliberately different numbers |
| `pendingLeaveCount` | `GET /api/leave-requests?scope=all` | the COUNT, not the list — see *Not cached* |
| `viewerName` | `GET /api/employees?email=` | the Overview greeting |
| `scoringSummaries` | 3 summary routes | RAW, **with the pay week inside the value** |
| `bonusCatalog` | `GET /api/bonus-catalog` | shared by the Overview panel and the Departments calculator |
| `offboardingQueue` | `GET /api/offboarding-queue` | RAW rows |
| `resignations` | `GET /api/resignation-requests?scope=all` | RAW rows |
| `skillSets` | `GET /api/employee-skill-sets` | RAW rows; shared profile only, never pay |
| `transfers` | 3 × `GET /api/department-transfers` | one unit — a decided request moves between scopes in one load |
| `bonusHistory` | 3 summary routes | RAW |

**Every key in `MANAGER_CACHE_KEYS` is wired to a live call site.** An unused key is an
invitation to cache something under a shape it was not written for.

### The scoring panel's week is paint-only

`scoringSummaries` stores the pay week **inside** the value rather than in the key. The
week comes from `usePayWeeks`, which is a fetch of its own, so keying on its answer would
mean a skeleton on every Overview visit no matter what is cached.

This is safe because the panel *labels* the week it is showing (`fmtPayWeek`), so a
cached week is self-declaring on screen rather than silently passing as this week; when
the live resolve lands on a different week the seeded paint is replaced by that week's
load. Nothing downstream keys a write on it — `weekUnresolved` still reports the **live**
resolve only, the calculators resolve their own week, and this panel merely deep-links a
department. Same shape as the KPI store's `presumedWeek`.

### Adding another dataset

1. Add a key to `MANAGER_CACHE_KEYS`.
2. Swap that call site's `useState(initial)` for `useManagerCachedState(KEY, initial)`.
3. **Leave the fetch effect alone.** That is what keeps stale-while-revalidate true by
   construction — there is no way for a call site to accidentally skip its fetch.
4. Derive the spinner (`!settled && nothing-to-paint`) rather than storing it.
5. If the state holds a `Date` / `Set` / `Map` — or is a discriminated union with a
   `loading` arm — cache the raw payload and derive it instead.

## Not cached, on purpose

- **Presence / "last seen"** (`/api/presence/last-seen`). A liveness signal repainted
  from a 12-hour-old copy is a *wrong* answer, not a stale one — "active now" is the
  entire content of the value. It re-fetches cold.
- **Signed evidence URLs** on time-adjustment rows. They expire; a cached one paints a
  broken image where an uncached one paints nothing. The rows are cached, the
  `signedUrls` map is not.
- **The company-wide leave-request list.** `?scope=all` returns every request in the
  company and the shell reads one number off it, so caching the list would spend the
  whole `sessionStorage` budget on rows nothing reads. The badge **count** is cached
  instead — and because the cached value *is* the state there, no second derivation
  exists to drift.
- **Anything carrying a pay rate.** Managers see no compensation on any My Team surface
  (`manager-my-team.md`); nothing cached here may become the back door that
  reintroduces one. A test asserts no key is spelled after presence or a signed URL.

A read that fails is also not cached over: a failed roster fetch **drops** the cached
roster rather than leaving a previous team on screen under an error banner.

## Not done

- **The store is now the fourth copy.** `src/lib/employee/tab-cache.ts`,
  `src/lib/accounting/tab-cache.ts`, `src/lib/manager/kpi-cache.ts` and this one are the
  same ~250 lines of identity/age/quota logic with a different prefix and key set.
  Extracting a shared factory is the obvious follow-up; it was not done here because
  three of the four are shipped and tested and migrating them is its own review.
- **The KPI Calculator tab is a separate store**, deliberately (`kpi-cache.ts`).
- **No server-side caching.** Every route keeps `cache: 'no-store'`; this is a
  client-side paint optimisation and changes no route's freshness.
- **`usePayWeeks` still costs one round trip** on every Overview mount — it is shared
  with the QC Overview, so short-circuiting it is a wider change than this one.
- **Leaves, Scheduling, Announcements, S-Wall, Notifications and Orientation** still
  mount cold. The recipe above is all they need; each is its own review.
- **Not verified in a browser.** `tsc` is clean and 2188 tests pass, but the live
  tab-switch behaviour was not clicked through (needs Google SSO + Supabase auth).
