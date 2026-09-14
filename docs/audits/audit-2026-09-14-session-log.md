# Audit / session log — 2026-09-14

**Rows 1–43 from earlier logs are not repeated here.** They live in the
[Sep 12 log](./audit-2026-09-12-session-log.md) § Open items and the
[Sep 10 log](./audit-2026-09-10-session-log.md), and were not re-verified today. Rows **70+**
are new.

| # | Session | When (ET) | Shipped |
|---|---|---|---|
| 1 | earlier | Sep 14 | QC officers derived from the **QC department** (`e5411cbf`), HSL Scheduling moved inside the department and now saves (`7cf94aa5`), My Team selection glide (`7f377005`) |
| 2 | `f00ffd56` | Sep 14 ~12:4x → | **QC start + offboarded scoring.** `hardening` doc-check, hard stop, four rulings from Kane, then three commits: the Sunday period lock (`b5178dd1`), the roster **as of the scored week** (`5c7fdf17`), and final-pay week-scoping (`736e9652`). Found **three false premises** and **ten phantom QC periods** |

---

## What this session did

Kane asked, from the [Sep 14 Carla meeting](../meetings/2026-09-14-carla-qc-start-and-offboarded-scoring.md),
that the KPI Calculator only let QC and managers score offboarded people **from last week** —
Carla verbatim: *"If I was offboarded today, I should be on the list next week, but then after
that I am gone. This is because they won't be having hours after that."*

The `hardening` doc-check found the request **already implemented for the happy path** and
unenforced everywhere else, and **hard-stopped on two contradictions**: the predicate's
documented fail-open posture, and what "for QC" meant. The meeting transcript resolved the
second in a direction neither option had proposed — *"for QC"* is the **deal**, and the ask is
to **widen** it, not to filter it.

A read-only probe then overturned three premises (below), which changed the shape of the work.
Kane ruled on all four decisions; all four are shipped.

| Q | Ruling |
|---|---|
| Phantom Monday periods | Fix the seed + refuse non-Sunday keys, ship a reconciliation report, **delete nothing** |
| Roster as of the scored week | **Confirmed** — build it |
| Manager calculators' fail-opens | **Removed**; doc + memory rewritten in the same commit |
| The already-dealt `2026-09-14` | **Leave it.** It is a phantom Monday key; QC scores `2026-09-06` |

---

## Open items (new this session)

| # | Item | State |
|---|---|---|
| **70** | **Carla's "324" was a FALSE PREMISE — and the real number is fine** | *"Ain't no way there's 324 people on this team … that 324 is just a mix of a bunch of people that were offboarded a while back."* **MEASURED: Lead Gen genuinely holds 325 active people.** The live period held **352 slots = 325 `active` + 27 `transferred`**; **zero** carried an offboard stamp and **all 352** were on `active_employees`. There was nothing to purge, and the count Carla distrusted was the correct one. The `transferred` status being reachable at all is new today (`e5411cbf`) — [[qc-transferred-status-unreachable]] measured 0 of 8,537 and is now superseded on that point: **27 of 352** on the live period. **No action. Recorded so the number is not "fixed" later.** |
| **71** | **The 1,600-row master list is the Google Sheet, not the HRIS** | Carla: *"we have 1,600 rows here, meaning we have 1,600 people."* `global_master_list` holds **2,695** rows, but `active_employees` — the view every surface reads — holds **1,316**, matching HR's ~1,300. **The HRIS number was already right.** Kane's suggestion in the meeting (export HR's GML and diff it against the Sheet) still stands as the way to reconcile the *Sheet*. **Open, low priority, not a code defect.** |
| **72** | **Ten phantom QC periods — CLOSED this session** | `GET /api/qc/assignments` **writes**: `ensureQcAssignmentsForPeriod` deals and upserts a whole week of slots for whatever `period_start` it is handed, and nothing checked the key was a pay-week Sunday. **Two** clients seeded a period from the local clock with a Monday-anchored helper and fetched before the week resolved — `QCApp.tsx` and, separately, the manager calculator's `QcOfficerLog`, which got a raw `weekStart` while every other write site on that screen was already gated on `weekResolved`. **MEASURED: 10 of 29 periods non-Sunday (~3,250 slots), 9 shadowing a real Sunday week** (`2026-09-07` Mon 404 members beside `2026-09-06` Sun 397 — **385 in both**), **0 holding scores**. `use-pay-weeks.ts:48` had already written the rule down: *"Sunday in, Sunday out."* **CLOSED** (`b5178dd1`) with three locks: a pure checker, the route refusing a non-Sunday key **before** the deal call (order pinned by a source-scan control), and neither client seeding from the clock. The 10 phantoms are **left in place** per Kane; `scripts/audit-qc-period-key-drift.mts` re-reads them and **exits 1 if one ever holds a score**. |
| **73** | **`2026-09-14` is an ORPHAN phantom — the current week was never legitimately dealt** | Its real Sunday, `2026-09-13`, does not exist in `qc_score_assignments` at all. The week QC should score right now is **`2026-09-06`**, which exists, is Sunday-keyed, and is frozen. **No action needed** — the Sunday lock means the next open of the dashboard deals the right key. Recorded because "the live period" and "the week to score" were briefly the same phrase for two different things. |
| **74** | **Alivia was ALREADY a scoring officer — the hypothetical was live** | Kane raised it as a what-if: *"if Alivia is added in there she too would have to score somebody and there would be nine or ten people who wouldn't be scored."* `aliviah@simple.biz` holds real slots on period **`2026-09-07`**. Closed going forward by officers deriving from the QC department ([[qc-officers-from-department]], shipped earlier today), and by the frozen-week rule for the period she already holds. **Recorded; no retroactive change** — consistent with Kane's *"he finishes the week he is in"*. |
| **75** | **Jerome holds slots on the live frozen week, and Carla expects nine officers** | `2026-09-06` was dealt to **ten** officers including `jeromer@`. Carla, in the meeting: *"It should only be nine people"*, and she is removing him. **The frozen-week rule means removing him from the QC department will NOT undeal `2026-09-06`** — which is Kane's own ruling (*"he finishes the week he is in and is not dealt the next one"*), not a defect. **Kane ruled: leave it.** Worth telling Carla explicitly, because she will otherwise see ten officers after making the change. |
| **76** | **QC scoring has effectively NEVER RUN** | `qc_kpi_submissions` holds **26 scores under a single period (`2026-06-14`)** against **8,567** assignment rows. This is what made today's deal correction cheap — there is almost no history to disturb — and it stops being true the moment the nine officers start. **Any further change to the deal's shape should land before Carla gives the go-ahead, not after.** |
| **77** | **The QC deal now reads the roster AS OF THE SCORED WEEK — CLOSED this session** | Carla: *"Every time someone gets transferred, we have to just add it externally. Same as if they were offboarded."* The deal drew from the **live** roster whatever week it dealt; at 50–75 offboards a week, anyone who left or moved between the week ending and an officer opening the dashboard vanished. **CLOSED** (`5c7fdf17`). Measured on the live week: **382 → 491 slots, +121 / −12** — the 121 being exactly the people being added by hand. Every rule fires on a **positive record, never an absence** (transfers go unfiled — [[markm-hsl-transfer-never-filed]]), a **midweek move is "there"** per Kane, and the window is bounded at both ends so a closed week is never rewritten (unbounded, opening the June 21 period would have dealt **240** new slots into it). |
| **78** | **KPI offboarded week-scoping tightened — CLOSED this session** | `offboardedRelevantToWeek` had `off >= weekStart` with **no upper bound** (a September leaver offered for every week back to June) and **two fail-open branches** — no date signal at all kept a person on **every week forever**, and any week below the hours-evidence floor returned the **whole 90-day list**. Its hours test also compared the NEWEST hours week with `>=`, so hours in W+1 vouched for W. **CLOSED** (`736e9652`): positive evidence only, bounded both ends at one payroll cycle, exact membership in a new `hours_week_starts`. Prod: week `2026-09-06` offers **110 of 450**; `2026-07-19` offers **19** where the floor fail-open returned all 450. **The module had zero tests** — which is how the fail-opens survived; it has twelve. |
| **79** | **Absent QC officer — UNBUILT and UNRULED** | Kane, in the meeting: *"what if a certain person from QC is absent like the whole week? They have people to score but they can't."* Carla: Jackie should jump in as manager, possibly super-admin, and *"I'll just talk with Jackie on how she would manage that."* **Nothing is built and no rule exists** — an absent officer's slots simply go unscored, and the frozen-week rule means they are not redistributed. **Owner: Carla → Jackie.** Needs a ruling before nine officers depend on it. |
| **80** | **Pending-hire promotion bug — NOT INVESTIGATED** | Carla found **four active people** missing from the inbox and findable only under Pending Hires, and fixed it by un-promoting to ready and re-promoting, after which CJ could transfer them. Kane: *"I'll see if it's a bug."* Their promotion date reads **8/31**. **Not looked at this session.** Kane's meeting next step "Investigate bug: analyze the transfer system for potential errors". |
| **81** | **Zero-hours Lead Gen people are still dealt** | Unchanged and still open (`qc-scoring.md` § Eligibility, [[hubstaff-zero-hours-gap]]): the only eligibility filter is employment start date, there is **no Hubstaff join**, and Lead Gen carries ~193/week "listed never scored". Carla's *"people with hours will be checked"* from Sep 9 is **unbuilt**. It is a **money ruling, not a cleanup**. Note today's work deliberately did **not** add an hours gate to the QC deal — doing so would have decided this open question as a side effect. |
| **82** | **NPD vs HRIS bonus totals never reconcile** | Carla: *"the reason it doesn't line up is because Alivia puts one number on the NPD and then we have another way of calculating on the HIS … it's one of those issues I really do not care about."* **Recorded, explicitly not actioned**, so it is not rediscovered as a defect. |
| **83** | **A truncated `grep \| head` produced a false claim mid-session** | The `hardening` brief stated `sanitizeOffboardDay` was "never wired to the offboarded list". It **is** — three call sites in `recently-offboarded.ts`; `head` had cut them off. Corrected in the same session and in [[offboarded-bonus-scoring]]. **Method note, recorded because the brief format invites exactly this**: a citation must come from a complete search, and `head` on a grep is not one. |

---

## Notes for the next session

- **Two new constants deliberately differ and must not be collapsed**: `CHURN_GRACE_DAYS = 14`
  (`src/lib/qc/roster-as-of-week.ts`) bounds *how late a deal may run and still notice a
  departure*; `FINAL_PAY_GRACE_DAYS = 7` (`src/lib/roster/offboarded-week-relevance.ts`) bounds
  *how long a week's pay stays in play*. A test caught 14 being wrong for the second.
- **Read-only verifiers added**: `scripts/audit-qc-period-key-drift.mts` and
  `scripts/verify-qc-roster-as-of-week.mts`. Both SELECT only and both **fail loudly** rather
  than reporting — the first if a phantom holds scores, the second if anyone is dropped without
  a dated transfer-in record.
- **`.next/dev/` was populated** during this session; no `next build` was run.
