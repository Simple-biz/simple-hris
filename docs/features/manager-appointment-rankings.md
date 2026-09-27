# Manager appointments ranking — who on the team set the most appointments, and their tenure

Manager → My Team → **Lead Gen** (and any other department that scores appointments) →
**Appointments**, a view beside People. It ranks the selected department's **current roster**
by appointments set, **Weekly** or **Monthly**, shows each person's **tenure**, and badges every
week that is not yet finalized by Accounting. Built for the department's own managers. Shipped
2026-09-26 (session `f73e6c13`, audit item 229), from the brief whose rulings are in
[the plan](../superpowers/plans/2026-09-26-manager-appointment-rankings.md). Not pushed.

## Key files

| Piece | File |
| --- | --- |
| Every rule (pure, tested) | `src/lib/manager/appointment-rankings.ts` · `.test.ts` |
| The reads (fetch only; projection pinned) | `src/lib/supabase/appointment-rankings.ts` · `.test.ts` |
| Route + gate | `app/api/manager/appointment-rankings/route.ts` · guard test `src/lib/manager/appointment-rankings-route.test.ts` |
| The pane | `src/components/manager/AppointmentRankingsPane.tsx` |
| The pill, the fetch, the view state | `src/components/manager/ManagerApp.tsx` (`apptWeeks` … `appointmentsAvailable`) |

## Who may see it: My Team's scope, NOT the SP Rankings list

Kane, 2026-09-26: *"The my team tab lets you only see what Departments were assigned to you."*
The route mirrors `/api/manager/department-members` (the roster this view sits on), line for line:

- manager / admin / elevated roles only;
- a caller with `department_managers` rows is scoped to them via
  `departmentMatchesManagedAssignments` — **even when they also hold an elevated role**;
- only an elevated caller with **no** assignments may read any department.

It **never consults `canViewTeamRankings`**. That list governs the SP **Rankings** view, a
different surface with its own rulings (see [manager-my-team.md](./manager-my-team.md) §
*Rankings*). A guard test pins both facts, plus the order: assignments are checked before the
elevated fallback, and the read runs only after both. An out-of-scope department returns
`available: false`, not 403, so the pill simply does not appear.

## The count is the KPI Calculator's saved figure, by exact variable name

`bonus_catalog_applied.vars`: `Appts_Set` (Lead Gen `bonus_mq9yxlmsyj7avdmc`), else `Appts`
(the COP variant `bonus_mtddp1p5rf4hq1rw`). That table is what the Payroll Wizard pays from. QC's
staged `qc_kpi_submissions` is **not** read ([qc-scoring.md](./qc-scoring.md)).

**Exact names, never `/appt/i`.** client_va rows carry `Appt_Bonus` (1,254 on 2026-09-26), which is
not a count. A row with neither variable is not an appointment row and is skipped. A saved `0` is a
real zero. A negative or unreadable cell counts as 0.

**Which departments have the view is decided by the DATA** (Kane, Q6): any department whose rows
carry one of those variables. On 2026-09-26 that is Lead Gen and **Callback** (274 `Appts_Set`
rows). Callback appearing is intended. Never replace this with a department list.

## Never pesos

Managers never see pay on My Team ([manager-my-team.md](./manager-my-team.md):13-17), and
appointments × ₱250 **is** the Lead Gen pay. The applied read's projection is the constant
`APPOINTMENT_APPLIED_SELECT = 'period_start, period_end, employee_email, vars'`. The test pins the
string exactly, and fails on any `amount` or `*` in the module. **Do not add `amount` "just for a
total".** A widened SELECT ships pay even when the screen renders cleanly.

## Every week shows, each with a badge (drafts included)

Kane, Q3: *"Weekly even if it hasn't been sent to accounting but it will have a badge."* Unlike SP
Rankings, draft weeks are **not** hidden. The readers are the department's own managers, and they
can already open that week in the KPI Calculator. The badge is `weekBadge`, and **its order is the
rule**:

| # | Evidence | Badge |
|---|---|---|
| 1 | no appointment rows for the week | **Not scored yet** |
| 2 | the lock read failed | **Couldn't check status** |
| 3 | any Payroll Wizard lock file for the week is `locked:true` | **Finalized by Accounting** |
| 4 | older than the first lock record (none before 2026-06-07) | **No payroll record** (grey) |
| 5 | the status read failed | **Couldn't check status** |
| 6 | `hsl_bonus_period_status` is `ready` / `locked` | **With Accounting · not finalized** |
| 7 | otherwise | **Draft · not sent to Accounting** |

- **Finalized is the top state; there is no "Paid" badge** (Kane, Q3b). There is no per-week paid
  signal worth trusting. 06-14 → 07-05 are locked with **0** paid dispatch rows, the cycle close-out
  record starts 08-02 and is missing for 08-23, and the unscored 09-20 week already had a paid row
  (a one-off). Do not add "Paid" off `payment_dispatches` without a new ruling.
- **The lock beats the KPI status.** 2026-06-07 has a `draft` status row on a locked week. Payroll
  was cut from it, so it reads Finalized.
- **A failed read is never a guess.** The badge reads fail soft to `null`, which shows as "Couldn't
  check". The applied read failing is a hard error, because it IS the ranking.
- **Weeks join lock files by the PARSED date range** (`payWeekStartFromSourceFile`), never by
  filename. Live keys include `..._2026-08-30_to_2026-09-05 4.csv` and a second, unlocked
  `api_sync` file for 07-19 (memory `orphanage-source-file-drift-hides-a-week`). Any locked file
  finalizes the week.

**Looks like a bug, isn't:** 2026-07-05 reads **Draft**. Its KPI was never submitted and its wizard
lock says `locked:false`. The badge reports the records; it does not assume the week was paid.

**The stepper never skips a recent week.** It lists every week with rows, plus every week from the
newest scored week up to the current one (Sunday of today **in Manila**). An unscored recent week
therefore shows as "Not scored yet" instead of vanishing. The view opens on the current week, which
is normally Not scored, and offers a jump to the latest scored week. Old gaps where nothing was ever
scored (April 2026) are not listed.

## Monthly = the weeks whose Monday is in the month; no daily

A week belongs to the month of its **owning Monday** (`payrollWeekMonthOrdinal`,
`bonus-cadence.ts:44-65`), the rule every monthly payout uses. So 2026-05-31 → 06-06 is a **June**
week (Monday Jun 1), while 2026-08-30 → 09-05 stays in **August** (Monday Aug 31). Never add a
local date rule: two rules would put one week in two months. A month's badge counts its weeks that
are not final ("2 of 4 weeks not finalized").

**There is no Daily view** (Kane, Q2 → a). Every appointment count in the HRIS is weekly. Dividing
a week by seven would print invented numbers. Daily needs a per-day source first (the per-appointment
form feed Kane put on hold, `qc-scoring.md` § *Not built, deliberately*) and its own brief.

## The roster decides who is ranked

Ranking runs over `membersForRailKey(activeDept, …)`, the **same, unfiltered** list the People view
shows for the rail entry. The two views therefore cannot disagree about who is on the team.

- **Leavers are counted, never listed** (Kane, Q4): "N people scored in this period are no longer
  on the Lead Gen roster and not ranked."
- **No entry ≠ zero.** A roster person with no row in the period is counted ("N on the roster have
  no entry") and not ranked at 0 beside people who were scored 0.
- **Matching bridges all four emails.** Applied rows key personal-email-first, and the roster also
  carries work email plus two aliases. Claims are made tier by tier (personal → work → alt1 → alt2),
  so a stale alias on someone else's row cannot steal a person's count.
- **Duplicate master rows are one person**, merged on a shared **personal or work** email. **Aliases
  never merge**, because a stale alias would fuse two different people.
- **A person scored under two emails is summed.** Both rows were credited.
- **Ties share a position** (1, 1, 3). Many people tie on small counts, and different numbers for
  equal counts would be false. Sorting by Tenure reorders the rows; `#` stays the appointments rank.

## Tenure = the current stint

Kane, Q5. Tenure runs from the roster row's **Start Date**, which a rehire resets. For merged
duplicate rows it is the **latest** start. The column mixes `M/D/YY` (~1,160 active rows) and ISO
(82), so it is parsed only by `parseMasterStartDate` (`dispatch-bonuses.ts:625`). Never use
`new Date(str)`: the two-digit year is engine-dependent. Unreadable → "—", sorted last. Display:
`2y 3m` · `2y` · `4mo` · `12d` · `New`.

## Rendering

- The payload is **stamped with the label it was fetched for** (`apptFor`). A department switch
  shows the loading state instead of painting one team's weeks against another team's roster.
- Mode, period and sort live in **ManagerApp**, not the pane. My Team panes unmount on every view
  switch, and the manager should come back to where they were.
- Rows page at **25**. `TeamAvatar` loads each photo eagerly, and a 300-row week would fire 300
  requests at once.
- A row opens the same member dialog as the People view.

## Deploy notes

**No migration.** No env vars, no n8n, nothing for Kane to run. Reads only: `bonus_catalog_applied`,
`hsl_bonus_period_status`, `app_settings` (`payroll.dispatch_lock.%`). Committed locally. **Not
pushed; not deployed.**
