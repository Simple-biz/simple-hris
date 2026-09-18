# Diagnostics scoped service maps — HR and Accounting, grouped by dashboard

**Approved brief:** in-session 2026-09-18. Kane's rulings, in order:

- *"Admin - Diagnostics should have separate Service Maps for the HR Pipeline like the webhooks
  for onboarding and offboarding"*
- *"New Hire Checklist - Global MASTER List and all that but if there are specific pipelines that
  we should be aware of we should be able to see the health status on this"* / *"We should do
  similar with Accounting Dashboard"*
- Q1 (audience / RBAC): *"Admin should bypass everything and should monitor everything that
  should be the absolute rule"* ⇒ **admin-only, nothing renders outside Admin**, so there is no
  RBAC boundary to widen. The HR-shell and Accounting-shell widgets in the first draft of the
  brief are **dropped**.
- Q2 (which pipelines): *"Core stuff like if everything is working fine"* ⇒ the money path and
  the hire path, not every adjacent surface.
- Q3 (where): *"it should be here in Admin - Diagnostics add a new tab"*
- Q1 (accounting node set): *"Yeah go"* ⇒ the proposed money path, side surfaces excluded.
- Q2 (tab labels): *"Group them by Dashboards"* ⇒ the tab strip groups by dashboard, not a flat
  strip of five.

**Precedent:** `ServiceMapView` in `src/components/SystemDiagnostics.tsx` (scoped, not rebuilt) ·
the 2026-09-04 tab split in `docs/features/diagnostics-performance-tabs.md:9-12` (HR and
Accounting separated because one blended view is wrong in both directions) ·
`docs/features/system-diagnostics.md` § Extending steps 1-3 (a new node needs a probe, a
`NODE_POSITIONS` entry and an edge).

**Two findings that shaped the scope**, both verified against source before any code:

1. `system-diagnostics.md` § Probes documents **16** nodes; the route returns **21**.
   Undocumented and live: `app-settings`, `google-sheet-sync`, `rate-history`, `hr-onboarding`,
   `hr-offboarding`. The onboarding/offboarding webhook nodes Kane asked for already existed —
   buried in the one combined map and absent from the doc, which is why they read as missing.
2. Nothing probes the New Hire Checklist. `probeHrOnboarding` reads `hr_onboarding_submissions`
   and `hr_pending_employees` — the **staging** tables. `hr_new_hire_checklist` and its week
   locks have no node, which is the 430-person "Never staged" gap
   (`diagnostics-performance-tabs.md:453-457`) with zero health coverage. Same hole on the
   accounting side for `payment_dispatches` and the close-out declarations.

## Task 1 — no SQL

- [x] **No migration.** Every new probe reads a table or `app_settings` key that already exists:
  `hr_new_hire_checklist`, `hr_new_hire_checklist_periods`, `payment_dispatches`, and the
  `dispatch.cycle_closeout.%` keys. No DDL, no n8n import, no env var, nothing for Kane to run.

## Task 2 — pure module + tests

- [x] `src/lib/admin/diagnostics-scopes.ts` — the ONE membership table. No imports, so the test
  needs no env and no React.
  - `ALL_DIAGNOSTIC_NODE_IDS` — the canonical 24.
  - `SERVICE_MAP_SCOPES` — `system` (every node) · `hr` (5) · `accounting` (7), each with its
    dashboard group, title, blurb and its own `localStorage` positions key.
  - `filterNodesToScope` / `filterEdgesToScope` — an edge whose endpoint is out of scope is
    DROPPED, or React Flow renders a dangling edge.
  - `overallStatusOf` / `countsByStatus` — scoped, so an HR map never reports a `pg-pool`
    critical it does not show. One implementation; the route and the mock builder each had
    their own copy of this precedence.
- [x] `src/lib/admin/diagnostics-scopes.test.ts`
  - every scope id ⊆ `ALL_DIAGNOSTIC_NODE_IDS` (a typo renders an EMPTY map with no error)
  - **source scan** over `app/api/admin/diagnostics/route.ts`: the ids the route actually emits
    equal `ALL_DIAGNOSTIC_NODE_IDS` — so adding a node to the route and forgetting the scope
    table fails the suite instead of silently missing from every map
  - scoped status precedence: critical > warning > unknown > all-healthy
  - a scoped edge list never references a node outside its scope

## Task 3 — three probes

- [x] `src/lib/admin/diagnostics-probes.ts`
  - `probeNewHireChecklist()` — listed rows (head+count), the newest `period_start`, and that
    week's lock row. **A week with no lock row defaults to `open`** (`hr-new-hire-checklist.ts:800`),
    so absence is handled explicitly. Warning only when the newest week has rows, is still
    `open`, and its Sunday is >7d past — that week's orientation email never fired. No warning
    floor otherwise.
  - `probePaymentDispatch()` — total + paid counts, newest `created_at` age. >14d ⇒ warning
    (payroll is weekly; two missed weeks is a real stall).
  - `probeCycleCloseout()` — live declarations only: `like('key', CYCLE_CLOSEOUT_PREFIX + '%')`,
    imported from `cycle-closeout.ts` rather than retyped. Reopen archives under
    `dispatch.cycle_reopened.`, a DIFFERENT prefix, so archived records cannot inflate the count.
  - All three: counts and ages only, `trimError`, no PII, no SQL text — inherited from
    `system-diagnostics.md` § Security. **Counts via `head:true`, newest via
    `order().limit(1)`** — no probe returns rows, so the 1000-row PostgREST cap is unreachable
    by construction (`hr_new_hire_checklist` is 1,479 rows live).

## Task 4 — the route

- [x] `app/api/admin/diagnostics/route.ts` — three `withProbeTimeout(...)` entries, three
  `node(...)` rows, three ids added to the `DiagnosticCategory`-ish union. Gate untouched
  (`requireElevatedSession()` + admin).

## Task 5 — the component

- [x] `src/components/SystemDiagnostics.tsx`
  - 3 new `DiagnosticCategory` values + their `CATEGORY_LABEL` and `CATEGORY_ICON` entries
  - 3 new nodes in `buildMockDiagnostics` — `buildUnknownBaseline` derives from it, so a node
    missing here renders a scoped map that is short a card at first paint and pops when the
    fetch lands
  - `NODE_POSITIONS` + `EDGES` entries for the new nodes (§ Extending). New edges:
    `admin-shell → new-hire-checklist`, `new-hire-checklist → hr-onboarding` (listed → staged,
    the funnel hand-off), `rates → payroll-wizard`, `mesa → payroll-wizard`,
    `payroll-wizard → payment-dispatch`, `payment-dispatch → cycle-closeout`,
    `disbursement-records → cycle-closeout`
  - **lift the fetch + the 30s interval into the shell** — ONE poller for every map. Three
    independently-polling maps would be 3× 24 service-role probes per 30s against production.
    The shell IS the Diagnostics tab, so "polls only while on screen" is preserved exactly.
  - `ServiceMapView({ scope })` — filters nodes, edges and alerts to the scope, uses the scope's
    own positions template and its own `localStorage` key so dragging the HR map cannot rewrite
    the main map's saved layout. `Reset Layout` clears only that scope's key.
  - the 5th summary card (`Employees Onboarded`, a whole-roster metric) stays on the **system**
    map only — a scoped map shows only what it scopes.
- [x] tab strip grouped by dashboard, one `role="tablist"` with decorative group labels:
  `System → Service Map` · `HR → Service Map · HR Pipeline` · `Accounting → Service Map ·
  Payroll Cycles`. Three tabs share the visible label "Service Map", so each carries a full
  `aria-label` ("HR Service Map"). Existing tab **ids and labels are not renamed** — `map`,
  `hr`, `cycles` keep theirs so the shipped docs stay true.

## Task 6 — verify

- [x] `npm test` (node:test over `src/**/*.test.ts`)
- [x] `npm run lint` (`tsc --noEmit`)
- [x] **No `next build`** — a dev server is live on :3000 and they share `.next/`.

## Task 7 — document, same commit

- [x] `docs/features/diagnostics-service-maps.md` — the governing doc
- [x] `docs/features/INDEX.md` — new row with the key invariant
- [x] `docs/features/system-diagnostics.md` — Probes table corrected to the real 24, plus a
  pointer to the new doc
- [x] memory entry + `MEMORY.md` pointer + the `[[wikilink]]` in the INDEX row
- [x] commit by explicit path, direct to `main`, never push
