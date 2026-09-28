# Manager HSL KPI Rankings + View — implementation plan

Session `77e1ce37`, 2026-09-28. Kane: *"My Team - HR, QC, and some others that have KPI Bonus dont
have the rankings and the view modal performance please add them"*, Q2 → "B" (HSL). The brief is in
the session transcript. Governing docs: `docs/features/manager-pm-rankings.md` (order = bonus, no peso
on the wire) and `docs/features/manager-rankings-history.md` (the View modal).

**Goal:** each scored HSL sub-team on Manager → My Team gets the KPI leaderboard and its View modal.
The order is `hsl_bonus_entries.calculated_bonus`, ranked on the server; the board shows KPI item
counts only; "All bonuses" only.

## Task 1 — pure HSL builder (server-only)

- [x] `src/lib/manager/hsl-kpi-money-order.ts`: `classifyHslKpiKey` (code key → `hslRuleForKey`;
      `catalog:<id>:<Var>` → `isCountVariable`), `buildHslKpiData` (weekly rows → `KpiData` with a
      row `total` = `calculated_bonus`). `hslBranchFromRailKey` went to the client-safe
      `deliverable-rankings.ts` instead, because ManagerApp needs it and may not import this module.
- [x] Tests: key classes; weekly only; the order is the total, not the items; no entry ≠ 0; booleans
      and the on-flag are never KPIs; a branch with no KPI item is unavailable (SSD, Managers Weekly);
      the family roster ranks a scorer placed on another sub-team; the payload carries no peso.

## Task 2 — shared money order

- [x] `deliverable-money-order.ts`: `MoneyWeekRow.total?` — the ALL order reads it when set; the PM
      path never sets it (unchanged). `toClientPayload` carries `allOnly` only when true.
- [x] Extend the server-only source scan to the new module.

## Task 3 — the read

- [x] `src/lib/supabase/hsl-kpi-rankings.ts`: probe → paged weekly read (projection pinned) → Library
      defs for the ids in `kpi_data` → badge inputs → the HSL family roster. Daily: the days read,
      narrowed to the emails of roster people who scored on the branch.
- [x] Test: the projection string; every return is `toClientPayload(` / `empty(`.

## Task 4 — route

- [x] `deliverable-rankings/route.ts`: `hslBranchFromRailKey(department)` → the HSL read, after the
      same `authorizeManagedDepartment(department)`. Add both reads to `appointment-rankings-route.test.ts`.

## Task 5 — UI

- [x] `ManagerApp.tsx`: an HSL sub-team sends its RAIL key (`hsl:<sub>`; the formatted label
      normalizes to nothing), and the pane's `members` is the HSL family roster, `deptName` "HSL".
- [x] `DeliverableLeaderboardPane.tsx`: `allOnly` → metric pinned to All, no picker.

## Task 6 — verify + document

- [x] Real read against live data, read-only, for every branch: availability, ranked counts, payload
      size, no `calculated_bonus` / formula / rate in the JSON.
- [x] `docs/features/manager-hsl-kpi-rankings.md`, INDEX + README rows, sibling docs, memory, Open
      items 249; one commit by explicit path.
