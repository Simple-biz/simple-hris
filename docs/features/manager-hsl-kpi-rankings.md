# Manager HSL KPI Rankings — each scored HSL sub-team ranked by its KPI Calculator bonus

Manager → My Team → **HSL — <sub-team>** → **Rankings**: the HSL family's roster ranked by the
**bonus their KPI Calculator card scored** (`hsl_bonus_entries.calculated_bonus`, what the Payroll
Wizard pays), averaged per day worked, per week or per month, over **Last 4 weeks · Last 3 months ·
All time**, with the row's **View** modal. What is shown is **KPI item counts only**: the stored
amounts decide the order on the server and never reach the browser. It is for the sub-team's
managers. Shipped 2026-09-28 (session `77e1ce37`), from Kane's *"My Team - HR, QC, and some others
that have KPI Bonus dont have the rankings and the view modal performance please add them"*; Q2 →
"B" = HSL (Open items 249). Plan:
[2026-09-28-manager-hsl-kpi-rankings.md](../superpowers/plans/2026-09-28-manager-hsl-kpi-rankings.md).
It is the HSL sibling of the Payment Catalog board ([manager-pm-rankings.md](./manager-pm-rankings.md)),
and it uses **the same route, payload, pane and `computeLeaderboard`**. Every rule there holds here
unless this doc says otherwise. Not pushed.

## Key files

| Piece | File |
| --- | --- |
| What each `kpi_data` key is, and HSL rows → weeks (**server-only**, pure, tested) | `src/lib/manager/hsl-kpi-money-order.ts` (`classifyHslKpiKey`, `buildHslKpiData`) · `.test.ts` |
| The reads (probe, paged weekly read, Library defs, badge inputs, family roster, days) | `src/lib/supabase/hsl-kpi-rankings.ts` · `.test.ts` |
| Rail key → branch (client-safe; the route and ManagerApp both use it) | `hslBranchFromRailKey` in `src/lib/manager/deliverable-rankings.ts` |
| Route: `department=hsl:<key>` branches to the HSL read, behind the same gate | `app/api/manager/deliverable-rankings/route.ts` · guard `src/lib/manager/appointment-rankings-route.test.ts` |
| The order, shared with the Payment Catalog board (`MoneyWeekRow.total`, `allOnly`) | `buildMoneyOrder` / `toClientPayload` in `src/lib/manager/deliverable-money-order.ts` |
| The pane (`allOnly`: no KPI picker, the HSL notes) | `src/components/manager/DeliverableLeaderboardPane.tsx` |
| The rail key param, the family roster, the pane mount | `src/components/manager/ManagerApp.tsx` (`hslBranch`, `delivDept`, `delivMembers`) |
| Rule labels for keys a branch no longer scores | `hslRuleForKey` / `HSL_RETIRED_RULES` in `src/lib/hsl-bonus/retired-rules.ts` (DISPLAY-ONLY, unchanged) |

## The order is the stored bonus, "All bonuses" only

- **One HSL row is one person-week with ONE amount.** `calculated_bonus` folds every code rule and
  every Library bonus on the card together ([catalog-bonus.ts](../../src/lib/hsl-bonus/catalog-bonus.ts)).
  No KPI has an amount of its own. Kane's rule is that the order is the bonus
  ([manager-pm-rankings.md](./manager-pm-rankings.md) § *The order is the bonus*), so a single KPI
  **cannot** be ranked on HSL. The payload says `allOnly: true`. The board shows **no KPI picker**, and
  a note says why (*"Each HSL score is one bonus for all of its KPIs, so the board ranks the whole
  bonus"*). The KPIs appear only as the breakdown under each name.
- **Looks like a bug, isn't: there is no KPI dropdown.** Adding one needs a per-KPI order. Ordering a
  KPI by its count would contradict the rule above; ordering it by recomputed pesos would reprice
  history (branches changed rules, e.g. Callback before 2026-07-21). Either is a new ruling.
- The server calls `buildMoneyOrder` with **no metrics** (`metrics: []`), so the only positions it
  computes and sends are "All". A test pins both calls.
- **No amount crosses the wire.** Like the catalog board, the response is `toClientPayload`'s counts and
  positions. A test serializes it from **sentinel** amounts and fails on any of them, on a rate, or on
  the words `amount`, `money`, `formula`, `calculated` or `total`. `hsl-kpi-money-order.ts` is
  server-only: the source scan in `deliverable-money-order.test.ts` fails if a component or page
  imports it.
- **The shown averages are not in rank order, by design.** Fewer, dearer items outrank more, cheaper
  ones, exactly as on PM Team. The header says *"Ranked by bonus earned · amounts hidden"*.
- **Every saved row is an entry.** A row with an amount but no KPI item (its pay came from a checkbox)
  still ranks on All, and a saved 0 ranks last.

## Which sub-teams get a board (data, never a list)

A sub-team gets a board when **its own branch** (`hsl_bonus_entries.department` = the sub-team key)
has **weekly** rows carrying **at least one KPI item**. Measured through the real read, read-only,
2026-09-28:

| Sub-team | Result | Why |
| --- | --- | --- |
| Intake Specialist | 178 ranked (all time), 6 KPIs, 150 KB (daily 202 KB) | retired code + Library "Intake" + Apple & Franz's individual bonus |
| Filing Specialist | 105 ranked, 8 KPIs, **3 order-only** | Library `Filed_Cases * IF(…)`, `(BBB + Referral_Leads) * 250` fail the count check |
| Case Managers | 65 ranked, 7 KPIs | retired per-unit code rules |
| Attestation | 61 ranked, 3 KPIs | the code *Attested Cases* and its Library successor are ONE item |
| Medical Records | 57 ranked, 3 KPIs, *RFC* **order-only** | RFC is typed pesos (`manual`, then `+(RFC)`) |
| Callback Team | 42 ranked, 4 KPIs | |
| Post-Hearing Prep | 36 ranked, 4 KPIs | |
| Care Team | 4 ranked, *Church Attendees* | |
| SSD Medical Records | none | rows store only `sub_team`: the team inputs are never persisted |
| Managers Weekly (`hsl_managers`) | none | bespoke per-manager checklists and bands, no team KPI |
| Collections · Healthcare Team Lead | none | MONTHLY branches |
| Simple Texting · Mail Sorting | none | placement-only: scored under Callback / Post-Hearing |
| Executive Guest Services · Executive Assistants · Healthcare Specialist | none | no scores (`noKpi`) |
| **HSL (the parent)** | none | its sub-teams pay on different scales, so a family board would rank the pay scale |

- A board appears for a sub-team the day its branch has a weekly row with a KPI item, with no code
  change. That includes an accountant-created data branch, which keys its Library variables the
  same way.
- **Weekly rows only.** A monthly period is not a week's KPI. Every branch above that has a board has
  only weekly rows (measured). A monthly board would be its own build.

## Who is ranked: the whole HSL family

- **A branch's scorers sit on many sub-teams.** Of the last 13 weeks' scorers, Medical Records had
  **47 of 64** placed in SSD Medical Records, Callback **13 of 49** in Simple Texting, and Filing **18
  of 137** in Attestation (measured 2026-09-28). Ranking only the sub-team's own placement would drop
  most of Medical Records' board. So the roster is **every active HSL-family person**: server
  `departmentMatchesManagedAssignments(e.department, [railKey])`, which collapses every `hsl:*`, and
  client `membersForRailKey(HSL_PARENT_KEY, …)`. They are the same set, so "couldn't be placed" should
  read 0.
- **People placed outside HSL are not ranked** (Lead Gen or Client VA people doing HSL work: 11 on
  Intake), and neither are leavers. The board counts them in its existing note (*"N people scored in
  this window are no longer on the HSL roster"*); `deptName` is "HSL".
- **That is exactly the gate's scope.** `authorizeManagedDepartment('hsl:<key>')` matches any HSL
  grant through the same family collapse, the same as `/api/manager/department-members`.

## What is shown (`classifyHslKpiKey`)

| `kpi_data` key | Is | Why |
| --- | --- | --- |
| a code rule, `per_unit` or `tiered` (live, else retired) | **shown** count | its value is items |
| a code rule, `manual` | **order-only** | the typed value IS pesos (Medical Records' RFC ₱350 would read as "350 items") |
| a code rule, `flat` / `team_split` / `team_pool` | not a KPI | a checkbox or a team share |
| `catalog:<id>:<Var>` | **shown** when `isCountVariable(formula, Var)`, else **order-only** | the catalog boards' rule, UNCHANGED, fails closed on an unreadable or fixed bonus |
| `catalog:<id>` | not a KPI | the bonus's on/off flag |
| anything else (`sub_team`, `__name__`, Managers' bands) | not a KPI | no rule explains it |

- **A KPI is keyed by its NAME.** The same item scored before and after a Library cutover reads as one
  (Attestation's *Attested Cases*). Differently named ones stay apart (Intake's *Signed Rep Docs* and
  *Signups*), because equivalence is never guessed. This is display only; the order is the stored
  amount either way. A merged KPI is shown only if every key behind it is a count.
- **Filing shows mostly PPL, on purpose.** Its Library formula writes `Filed_Cases * IF(…)` and
  `(BBB + Referral_Leads) * 250`. The count check reads only `Var * <number>`, so those fail closed to
  order-only. `isCountVariable` was **not** widened. Widening it would change the Payment Catalog
  boards too, and QC's pinned test. The note gives the real reason (*"scored in ways that don't read
  as items × a rate"*). It never says "entered as an amount", which is false for Filing's BBB.
- Labels are the rule's own (`hslRuleForKey`) or the Library variable's (`catalogInputLabel`); a bonus
  id never reaches a human.

## Addressed by the rail key

- My Team names a sub-team **"HSL — Intake Specialist"** (`formatDeptLabel`), and that string
  normalizes to **no department**. Sent as a department, it matches no grant, and every non-elevated
  manager would read `out_of_scope`. The KPI read is therefore sent the **rail key** (`hsl:<key>`,
  ManagerApp's `delivDept`). `hslBranchFromRailKey` accepts only `hsl:[a-z0-9_]+` and nothing else, so
  the parent, a display label or a path never reaches the HSL read.
- The SP and appointment reads still send the display label for an HSL sub-team, which reads nothing.
  That is harmless because HSL has neither.

## Loading

- Same as the catalog board: cached per department under the same `dept:` keys, revalidated on every
  visit. The weekly payload for Intake is ~150 KB and ~4.8 s cold (2,306 rows).
- `?basis=daily` reads Hubstaff days for the **whole HSL family** (the days read collapses `hsl:*` as
  well), then keeps only people who scored on this branch. Intake: 3,061 day rows, ~5.3 s.
- The View modal needs nothing new. It uses the board's weeks and the server's per-week order on
  "All" ([manager-rankings-history.md](./manager-rankings-history.md)). Checked on a throwaway fixture
  page, 2026-09-28.

## Deploy notes

**No migration.** No env vars, no n8n, nothing for Kane to run. Reads only: `hsl_bonus_entries`
(`period_start, period_end, period_type, employee_email, kpi_data, calculated_bonus`, server-side),
`bonus_catalog_bonuses` (`id, kind, formula`, never `amount`), `hsl_bonus_period_status`,
`app_settings` (`payroll.dispatch_lock.%`), `active_employees`, `hubstaff_hours`. Committed locally.
**Not pushed; not deployed; not clicked through with a real manager session.**
