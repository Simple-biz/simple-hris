# Diagnostics service maps — one live health map per dashboard

Admin → Diagnostics gained two more service maps on **2026-09-18**: the same probe response,
drawn three ways. **System** keeps every node; **HR** draws the hire path (New Hire Checklist →
staging → roster, plus the two teardown routes); **Accounting** draws the money path (hours and
rates → wizard → dispatched → week declared closed). Five tabs now sit in three dashboard
groups. Admin-only, inheriting the Diagnostics gate — Kane, 2026-09-18: *"Admin should bypass
everything and should monitor everything that should be the absolute rule."*

Built because the onboarding and offboarding webhook nodes Kane asked to see *already existed*
and nobody could find them: they were two cards among twenty-one on one canvas, and the
governing doc's Probes table never listed them. Ship commit: see `git log` for
`feat(diagnostics)` on 2026-09-18.

## Key files

| Piece | File |
| --- | --- |
| Scope membership, filters, scoped status maths (pure) + tests | [`src/lib/admin/diagnostics-scopes.ts`](../../src/lib/admin/diagnostics-scopes.ts) · `.test.ts` |
| The map, rendered per scope | [`src/components/SystemDiagnostics.tsx`](../../src/components/SystemDiagnostics.tsx) → `ServiceMapView({ scope })` |
| Tab shell + the ONE poller | [`src/components/SystemDiagnostics.tsx`](../../src/components/SystemDiagnostics.tsx) → default export |
| Layout templates (system + per scope) | [`src/components/SystemDiagnostics.tsx`](../../src/components/SystemDiagnostics.tsx) → `NODE_POSITIONS`, `SCOPE_POSITIONS` |
| The three new probes | [`src/lib/admin/diagnostics-probes.ts`](../../src/lib/admin/diagnostics-probes.ts) → `probeNewHireChecklist`, `probePaymentDispatch`, `probeCycleCloseout` |
| Route (unchanged gate, 24 nodes) | [`app/api/admin/diagnostics/route.ts`](../../app/api/admin/diagnostics/route.ts) |
| What each node means, and the security contract every probe inherits | [system-diagnostics.md](./system-diagnostics.md) |
| The performance tabs beside these maps | [diagnostics-performance-tabs.md](./diagnostics-performance-tabs.md) |

## What each map draws

The scope tables live in [`src/lib/admin/diagnostics-scopes.ts`](../../src/lib/admin/diagnostics-scopes.ts).
All 24 nodes are on the **System** map (`nodeIds: null` — see below). The two pipeline maps draw
these subsets:

### HR — the hire path (5 nodes)

| Node | Probe reads | Goes amber when |
|---|---|---|
| `new-hire-checklist` | `hr_new_hire_checklist` count · newest `period_start` · that week's `hr_new_hire_checklist_periods` lock row | the newest week has hires, is still `open`, and its Sunday is >7d past — nobody on it was emailed |
| `hr-onboarding` | pending `hr_onboarding_submissions` · `hr_pending_employees` in `pending_work_email`/`ready` · hires stuck >7d | a hire is stuck awaiting a work email >7d, or a table is missing |
| `hr-offboarding` | `hr.employee.offboarded` count (30d) · last 20 `hr.employee.webhook_fired.%` rows · total off-boarded on `global_master_list` | any recent webhook fire recorded `webhook_fired: false` |
| `master-list` | `count(*)` on the `active_employees` view | `critical` at 0, `warning` under 50 |
| `google-sheet-sync` | recency of `csv.master.sync` / `csv.rates.sync` in `audit_log` | `warning` past 7d, `critical` past 30d |

### Accounting — the money path (7 nodes)

| Node | Probe reads | Goes amber when |
|---|---|---|
| `rates` | `count(*)` on `employee_hourly_rates` | count is 0 |
| `mesa` | `mesa_ledger` event count · open `mesa_accounts` (best-effort) | the ledger is empty or missing |
| `payroll-wizard` | *composite* — worst of `hubstaff-csv`, `master-list`, `disbursement-records` | **always at least `warning`** (documented floor — CSV/date-column mismatches stay subtle) |
| `hubstaff-csv` | latest `hubstaff_uploads` row + age | past 7d (and still `warning` past 14d) |
| `disbursement-records` | `count(*)` on `disbursement_records` | the read errors |
| `payment-dispatch` | total + paid counts on `payment_dispatches` · age of the newest row | the newest dispatch is >14d old |
| `cycle-closeout` | count of live `dispatch.cycle_closeout.%` keys · newest `updated_at` | **never** — no staleness threshold, by design |

**Excluded from the Accounting map on purpose**, and still on the System map: `payroll-notes`,
`time-adjust`, `tickets`, `rate-history`. They are side surfaces — a stall in one does not mean
money stopped moving, and putting them here would make "is the money path healthy?" unanswerable
at a glance, which is the only question this map is for (Kane: *"core stuff like if everything is
working fine"*).

**No separate orientation node.** The orientation email *is* the checklist Lock-in, so its health
belongs on `new-hire-checklist`; attendance measurement is the HR Pipeline tab's job.

## The edges each map keeps

`filterEdgesToScope` keeps an edge only when **both** endpoints are in scope, so each map's graph
is a closed subgraph of the full `EDGES` list:

| Map | Edges drawn |
|---|---|
| **HR** | `new-hire-checklist → hr-onboarding` · `hr-onboarding → master-list` · `hr-offboarding → master-list` · `hr-offboarding → google-sheet-sync` · `google-sheet-sync → master-list` |
| **Accounting** | `rates → payroll-wizard` · `mesa → payroll-wizard` · `payroll-wizard → hubstaff-csv` · `payroll-wizard → disbursement-records` · `payroll-wizard → payment-dispatch` · `payment-dispatch → cycle-closeout` · `disbursement-records → cycle-closeout` |

Edges to `admin-shell`, `supabase-client`, `audit-log` and the rest are dropped on the pipeline
maps because those nodes are not drawn there — that is the filter working, not an omission. The
`relationshipFor()` classifier is unchanged and needed no new category: the new edges all classify
as `flow` (data moving), except `admin-shell → new-hire-checklist`, which is a `mount`.

## A scoped map reports only on what it draws

This is the load-bearing rule, and every other rule here serves it. `ServiceMapView` reads
`scopedNodes` / `scopedAlerts` / `scopedEdgeList` — **never `data.nodes` directly**. So the
nodes, the edges, the alerts list, the four summary counts and the "Overall" badge are all over
the subset.

An HR map wearing a **critical** badge earned by `pg-pool` would be a lie about the hire path,
and the reader's next move — telling HR their pipeline is down — would be wrong. A test pins it:
the same two nodes produce `critical` for the system scope and `healthy` for HR.

Two consequences that look like omissions and are not:

- **`Employees Onboarded` is on the system map only.** It is a whole-roster adoption ratio. On
  the HR map it would read as a claim about the hire path.
- **The alerts list says "on this pipeline"** when scoped. The count next to it is the scoped
  count; the system map still lists every alert in the system.

## The system map is never a hand-maintained list

`SERVICE_MAP_SCOPES.system.nodeIds` is `null`, and `filterNodesToScope` returns the array
**unchanged** (same reference) for it. A curated list there would mean a node added to the route
silently vanishing from the one map that promises to show everything — the opposite of Kane's
rule. A test asserts it stays `null`.

## Adding a node: four places, or it is invisible

`system-diagnostics.md` § Extending covers the probe, the position and the edge. Since
2026-09-18 there is a fourth:

1. the probe in `diagnostics-probes.ts`
2. the `node(...)` row in the route
3. `NODE_POSITIONS` (+ `EDGES`) in the component, **and** the node in `buildMockDiagnostics`
4. **`ALL_DIAGNOSTIC_NODE_IDS` in `diagnostics-scopes.ts`**, plus the scope it belongs to

Steps 2, 3 and 4 are enforced by **source scans**, not by convention: the test parses the
`const nodes: DiagnosticNode[] = [ … ]` block out of both the route and the component and
asserts both sets equal `ALL_DIAGNOSTIC_NODE_IDS`. This exists because all three failure modes
are silent —

- a scope id matching no real node **renders one fewer card, with no error**;
- a node in the route but in no scope is absent from every pipeline map while the system map
  still looks right;
- a node missing from `buildMockDiagnostics` is missing at first paint and on probe failure
  (`buildUnknownBaseline` derives from it), so the map is short a card and then **pops** when
  the fetch lands.

The scan is deliberately scoped to that array rather than the whole file: both files carry
unrelated `'…'` unions and `id:` keys, and a whole-file regex would pass for the wrong reason.

## One poller, however many maps

The feed lives in the **shell**, not in `ServiceMapView`. Panes are mounted-once-then-hidden, so
three maps each owning a 30s interval would be **3 × 24 service-role probes against production
every thirty seconds, forever**. One fetch feeds every mounted map, and each map's Refresh
button drives that same fetch.

The live-feed property is unchanged: the shell **is** the Diagnostics tab, so navigating away
unmounts it and the timer stops — still no background polling. 30s is still deliberately faster
than the performance tabs' 120s (a health feed must surface a mid-session outage on its own; a
records tab moves once a week).

**Do not give a map its own fetch.** If a future map needs data this response does not carry,
add it to the response.

## Each scope owns its layout and its drag key

`SCOPE_POSITIONS` holds one curated grid per scope, and each scope has its own `localStorage`
key. Both matter:

- The HR nodes sit in four different columns of the system grid. Inheriting those coordinates
  would strand five cards across 1,400px of empty canvas, so scoped maps get their own tight
  360×280 grid (same spacing, so a 284px card still cannot overlap its neighbour).
- Sharing one key would make dragging the HR map **rewrite the system map's saved arrangement**,
  and `Reset Layout` on one map would throw away the other's. `resetLayout` clears only its own
  scope's key. A test pins that the three keys are distinct.

**The system map's key stays `system-diagnostics-positions-v2`.** Renaming it silently resets
every admin's saved layout; a test pins the literal.

Layout lives in the component, not in `diagnostics-scopes.ts`, so there is one home for it —
next to the template the system map has always used.

## The three new probes

All three inherit `system-diagnostics.md` § Security verbatim: counts, ages and error codes
only — no PII, no SQL text, no stack traces. **Counts come back via `head: true` and recency via
`order().limit(1)`, so no probe fetches rows** and the 1,000-row PostgREST cap is unreachable by
construction. `hr_new_hire_checklist` is already past it at 1,479 rows.

### `new-hire-checklist` — the node that did not exist

`probeHrOnboarding` reads `hr_onboarding_submissions` and `hr_pending_employees`: the **staging**
tables a listed hire still has to reach. It never touched `hr_new_hire_checklist`, so HR's
intake grid and its Lock-in had **no health coverage at all** before 2026-09-18.

The two are separate nodes on purpose. Live, 1,479 listed against 1,049 staged — different
populations, and the ~430-person gap between them is the largest single loss in the hiring
funnel ([diagnostics-performance-tabs.md](./diagnostics-performance-tabs.md) § "The HR rate is
over STAGED"). One node covering both would hide exactly what the map exists to show. The edge
`new-hire-checklist → hr-onboarding` **is** that hand-off.

Its one amber condition: the newest week has hires, is still `open`, and its Sunday is **more
than 7 days past** — meaning that week's Lock-in never ran and **nobody on it was emailed**
([new-hire-checklist.md](./new-hire-checklist.md) § Lock-in webhook). Deliberately narrow:

- **A week with no lock row is `open`, not an error** — that is the documented default from
  `getHrChecklistPeriod`, so absence is a state here.
- **If the lock row cannot be READ, the amber branch does not fire.** An unreadable lock state
  is not evidence of an unlocked week; it says so in `details` instead.
- **A failed read of the newest week is never reported as "no hiring weeks on file."** That
  would be a lie about HR's record, which is the failure class this whole map exists to catch.
- **No warning floor.** A pipeline that is working reads `healthy`. The `payroll-wizard` node's
  floor is a documented exception, not a pattern — copying it here would add a permanent entry
  to the alerts list that nobody can clear, and an alerts list that is never empty is ignored.

### `payment-dispatch` — counts, never a rate

`payment_dispatches` is the live source of paid figures for Pay Stubs, Penny and the CEO
payments feed. This node reports total rows, paid rows and the age of the newest one. Older than
**14 days ⇒ warning**: payroll is weekly, so two missed weeks means pay ran somewhere other than
this system — which really happened, for four consecutive weeks in Jun–Jul 2026, and no screen
announced it at the time (`diagnostics-performance-tabs.md` § `not_run`).

**It must never grow a percentage.** The table cannot see a payable person who was never
dispatched, so any rate over it sits at 97–99% by construction and flatters every week. Rates
belong to the Payroll Cycles tab, over a close-out's payable denominator, and nowhere else.

### `cycle-closeout` — and why it has no staleness warning

Counts the live declarations under `dispatch.cycle_closeout.`. The prefix is **imported** from
`cycle-closeout.ts`, never retyped: a reopen archives the record under
`dispatch.cycle_reopened.` — a *different* prefix — and a drifted literal here would start
counting archived declarations as live ones.

**There is deliberately no age threshold.** Closing a week is a human cadence, not a system
function — live, 22 of 27 cycles pre-date the feature existing — so a staleness rule would sit
permanently amber and train admins to ignore the map. *Which* cycles are unclosed is a question
the Payroll Cycles tab already answers; a second implementation of "is this week declared?"
could only disagree with the first.

## The new edges are dependencies, not decoration

Seven edges were added so the scoped maps are connected graphs rather than rows of loose cards.
Each is a real relationship, and they show on the system map too:

| Edge | Why it is true |
| --- | --- |
| `admin-shell → new-hire-checklist` | the shell hosts the tab |
| `new-hire-checklist → hr-onboarding` | listed → staged, the hand-off where ~430 people are lost |
| `rates → payroll-wizard` | the wizard prices hours at the rate |
| `mesa → payroll-wizard` | MESA rides final pay — the payroll's own identity is `… − MESA Deduction + MESA Disbursement = Amount` |
| `payroll-wizard → payment-dispatch` | the wizard stages what gets dispatched |
| `payment-dispatch → cycle-closeout` | a close-out declares over the dispatch log |
| `disbursement-records → cycle-closeout` | the close-out's `records_outstanding` cross-check reads the ledger |

`filterEdgesToScope` requires **both** endpoints in scope. An edge kept because only its source
survived points at a node that was never drawn, React Flow drops it silently, and the map
quietly loses a relationship — so both ends are checked before the renderer sees it.

## The tab strip groups by dashboard

Kane, 2026-09-18: *"Group them by Dashboards."* Three groups, five tabs:

| Group | Tabs |
| --- | --- |
| **System** | Service Map |
| **HR** | Service Map · HR Pipeline |
| **Accounting** | Service Map · Payroll Cycles |

- **The two tabs that shipped 2026-09-04 keep their ids AND their labels** (`hr`, `cycles`,
  "HR Pipeline", "Payroll Cycles"). `diagnostics-performance-tabs.md` names them; renaming would
  desync the doc for no gain. A test pins the ids.
- **Three tabs read "Service Map."** The group heading carries the difference visually, so each
  button also takes a full `aria-label` ("HR service map"). The group headings are `aria-hidden`
  because a `role="tablist"` may only contain tabs — the grouping is presentational and the
  accessible names carry the whole meaning. A test asserts the three aria-labels are distinct.
- The strip is the single source of tab identity: `DIAGNOSTICS_TAB_GROUPS` in
  `diagnostics-scopes.ts`.

## Adding a new scope (a CEO or Manager map, say)

The shape is deliberately cheap to extend, and nothing about it requires a new endpoint:

1. Add the id to `ServiceMapScopeId` and an entry to `SERVICE_MAP_SCOPES` — dashboard group, tab
   label, `ariaLabel`, title, blurb, the node id list, and **a fresh `storageKey`** (never reuse
   another scope's).
2. Add a curated grid to `SCOPE_POSITIONS` in the component.
3. Add the tab to `DIAGNOSTICS_TAB_GROUPS`, in its dashboard's group.
4. Add the tab id to the `DiagnosticsTab` union and a pane in the shell —
   `<ServiceMapView scope={SERVICE_MAP_SCOPES.yours} {...feed} />`.

The existing tests then cover it for free: subset-of-canonical, distinct storage keys, unique tab
ids, distinct aria-labels for same-labelled tabs, one group per dashboard. **Do not add a fetch**
— pass `{...feed}` like the others.

Two constraints worth knowing before you draw a new map:

- **Every node you list must already be probed.** A scope cannot invent a node; if the pipeline
  you want to draw has no probe, that is the real work (and `system-diagnostics.md` § Extending
  plus § "Adding a node" above is the checklist).
- **A scope with one node is a card, not a map.** The value is in the edges — if the nodes you
  want have no relationships between them in `EDGES`, the map will render as a row of loose cards
  and a KPI strip would serve better.

## Failure modes, and what each one looks like on screen

Every entry here is something that produces **no error** — which is why they are tested rather
than left to review:

| What went wrong | What you see | Caught by |
|---|---|---|
| Scope lists an id no node has | one fewer card; no console error, no banner | `every scope is a subset of the canonical node list` |
| Node added to the route, not to a scope | absent from every pipeline map; System map looks correct | `the canonical list is exactly what the route emits` (source scan) |
| Node missing from `buildMockDiagnostics` | map is short a card at first paint and on probe failure, then **pops** when the fetch lands | `the component mock covers every node the route emits` (source scan) |
| System scope given a hand-maintained list | a new node silently missing from the map that promises everything | `the system scope is not a hand-maintained list` |
| Counts computed over `data.nodes` | HR map claims a `critical` that is really `pg-pool` | `a scoped verdict ignores failures the map does not draw` |
| Edge kept with one endpoint out of scope | React Flow drops it; the map quietly loses a relationship | `filterEdgesToScope needs BOTH endpoints in scope` |
| Two scopes sharing a storage key | dragging one map rearranges another; Reset Layout wipes both | `each scope persists its layout under its own key` |
| System storage key renamed | every admin's saved layout silently resets | `the system map keeps the key its drag positions already live under` |
| A map given its own poller | 3 × 24 service-role probes per 30s against production, forever | **not** test-covered — see the note below |
| `unknown` treated as healthy | "we could not read it" renders as "it is fine" | `overallStatusOf: worst wins, and healthy needs unanimity` |

**The poller is the one rule here with no test.** It is a structural property of where the fetch
lives, and a unit test cannot see a component's network behaviour. It is enforced by review and
by `ServiceMapView` having **no fetch code at all** — it takes `data` as a prop. If you find
yourself adding `useEffect(() => fetch(...))` to a map, that is the mistake.

## The tests, and what each is for

`src/lib/admin/diagnostics-scopes.test.ts` — 19 tests, `npx tsx --test src/lib/admin/diagnostics-scopes.test.ts`.

Grouped by what they protect:

- **Registration parity (3)** — the two source scans plus the subset check. These are the ones
  that fail when someone adds a node and forgets a step.
- **Scope shape (4)** — system stays `null`; the pipeline maps are non-empty and genuinely
  smaller than the whole; HR keeps listed and staged separate; Accounting holds the money path
  and excludes the four side surfaces.
- **Storage keys (2)** — all distinct, and the system key is pinned to its exact literal.
- **Tab strip (3)** — unique ids, three distinct aria-labels behind the three identical "Service
  Map" labels, the 2026-09-04 ids preserved, one group per dashboard in order.
- **Status maths (3)** — the precedence, the scoped-verdict property, and that counts account for
  every node exactly once.
- **Filters (4)** — null-scope identity (same reference back), both-endpoints edges, alert
  scoping.

The source scans parse the `const nodes: DiagnosticNode[] = [ … ]` block out of the route and the
component and assert **exact set equality** with `ALL_DIAGNOSTIC_NODE_IDS`. They will also fail
loudly if either file stops declaring that array in that shape — the assertion message says so,
because a blind scan that silently matches nothing is worse than no scan.

## Out of scope (parked)

- **Pipeline health on the HR and Accounting dashboards themselves.** Proposed in the first draft
  of this brief as widgets on those shells' Overview tabs. Kane's ruling (*"Admin should bypass
  everything and should monitor everything that should be the absolute rule"*) **deleted them**
  rather than widening any permission, so HR and Accounting still cannot see their own pipeline
  health. Reopening this means re-answering the RBAC question — these probes' `details` and
  `suggestedChecks` name tables, audit actions and n8n slugs, and are written for an admin
  audience. Do not resurrect the widgets without asking.
- **A CEO or Manager map.** No probes exist for those pipelines; see § "Adding a new scope".
- **Historical health.** Still a snapshot, still no time-series store — inherited from
  `system-diagnostics.md` § Out of scope. A scoped map would make per-pipeline trends genuinely
  useful, but it needs a `diagnostic_snapshots` table and a worker.
- **Supabase Realtime push.** Unchanged: the anon client cannot receive `postgres_changes` under
  RLS, and the 30s poll is deliberately on a different path from the subscription an outage would
  take down.

## Aggregates only — this route family still returns no PII

Unchanged and re-verified. The gate is still `requireElevatedSession()` + the admin role check
(`system-diagnostics.md:215`), and nothing rendered outside the Admin shell: the first draft of
this brief proposed HR-shell and Accounting-shell widgets, and Kane's ruling ("admin should
monitor everything") **removed** them rather than widening any permission. No HR or Accounting
session gained read access to anything.

## Deploy notes

**No migration.** No DDL, no new table, no column, no n8n import, no env var, nothing for Kane to
run. The three new probes read tables and `app_settings` keys that already exist:
`hr_new_hire_checklist`, `hr_new_hire_checklist_periods`, `payment_dispatches`, and the
`dispatch.cycle_closeout.%` keys.

**Verification, honestly:** `tsc --noEmit` clean; 19 new unit tests green; full suite 3,823 of
3,826 pass. The three failures are **pre-existing and unrelated** — `dept-label-render`
(`ManagerApp.tsx:1859`), `coe-request-paths` (COE signing render) and
`manager-time-adjustments-live` (Overview gallery hours). Every file those tests assert about is
unmodified at HEAD; they are logged as Open items.

**Not clicked through in a browser.** `next build` was **not** run — a dev server was live on
:3000 and they share `.next/`. The probes have not been executed against production; their
thresholds are reasoned from documented live figures, not measured on this date. First admin to
open the three tabs should confirm the new nodes read `healthy` rather than "could not read",
which is what a wrong column name would look like.
