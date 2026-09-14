# Sep 14, 2026 — Carla, Kane, Alivia (+ Jackie, first 45s)

**12:23 EDT, ~21 min.** The meeting that started QC for real. Carla needed two gaps closed
before telling nine officers to begin; Kane closed both the same day.

Related: the [Sep 9 Carla/Jackie meeting](./2026-09-09-carla-jackie-employee-surface-and-qc.md),
whose Wave 1 had a hard deadline of **today**.

---

## Decisions

| # | Decision | Owner |
|---|---|---|
| 1 | **QC officers are the QC DEPARTMENT, not an access grant.** Anyone with dashboard access was being dealt slots, so adding Alivia would have made her score peers while ten people went unscored. Membership is the department, full stop | shipped earlier today |
| 2 | **Offboarded and transferred people must be dealt automatically** for the week they were in the department — no more Add External Member, one person at a time | Kane — shipped |
| 3 | **Jerome comes off the lead-receptionist bonus.** He was absent the whole week | Alivia — sheet edit |
| 4 | **A dealt week stays frozen.** Removing an officer now does not re-deal the week they are in | standing rule, upheld |

Carla's rule, verbatim, and the anchor for everything below:

> *"If they were in Legion during the time that we're scoring, then they need to be in there so
> that they don't have to use the add external member button."*

> *"If I was offboarded today, I should be on the list next week, but then after that I am gone.
> This is because they won't be having hours after that."*

---

## Findings — measured, not inferred

Three of the meeting's premises did not survive a read-only probe of production.

### 1. The "324" is real. Nobody in it is offboarded.

Carla: *"Ain't no way there's 324 people on this team … that 324 is just a mix of a bunch of
people that were offboarded a while back."*

**Lead Gen genuinely holds 325 active people.** The live period held 352 slots — 325 `active`
plus 27 `transferred`. **Zero** carried an offboard stamp and **all 352** were on
`active_employees`. There was nothing to purge. The number Carla distrusted was the correct one.

### 2. The 1,600-row master list is the Google Sheet, not the HRIS.

`global_master_list` holds 2,695 rows, but `active_employees` — the view every surface reads —
holds **1,316**, which matches HR's ~1,300. The HRIS number was already right.

### 3. Ten phantom QC weeks existed, and the cause was a clock.

`GET /api/qc/assignments` **writes**: it deals and upserts a whole week of slots for whatever
`period_start` it is handed, and nothing checked that the key was a pay-week Sunday. Two clients
seeded a period from the local clock with a Monday-anchored helper and fetched before the real
week resolved. **10 of 29 periods were non-Sunday** (~3,250 slot rows), **9 shadowing a real
Sunday week** — `2026-09-07` Mon (404 members) beside `2026-09-06` Sun (397), **385 in both**.

None held scores. They are left in place; `scripts/audit-qc-period-key-drift.mts` re-reads them
and fails if one ever does.

### 4. Alivia was already a scoring officer.

Kane described it as hypothetical — *"if Alivia is added in there she too would have to score
somebody"*. She held real slots on period `2026-09-07`. Decision 1 closes it going forward.

### 5. QC scoring has effectively never run.

`qc_kpi_submissions` holds **26 scores under one period (`2026-06-14`)** against 8,567
assignment rows. This is why the deal could be corrected cheaply today — and why it gets
expensive the moment the nine officers start.

---

## What shipped

| Commit | |
|---|---|
| `b5178dd1` | The period key must be a Sunday, enforced at the route **before** the deal (that call writes), plus neither client seeding from the clock. An unresolved week is now terminal rather than a permanent skeleton |
| `5c7fdf17` | The deal reads the roster **as of the scored week**. Live week `2026-09-06`: **382 → 491 slots, +121 / −12**. Those 121 are exactly the people Carla and Jackie were adding by hand |
| `736e9652` | An offboarded person is scoreable for their final pay week **and no others** — both fail-open branches removed, hours tested by exact week membership |

Every rule added fires on a **positive record, never on an absence**: transfers go unfiled here
and syncs clobber departments, so a missing record always means *keep*.

---

## Open — carried to the session log

1. **Absent QC officer.** *"What if Perry is absent the whole week?"* Carla: Jackie jumps in as
   manager; possibly super-admin. **Unbuilt and unruled** — Carla to consult Jackie.
2. **Pending-hire promotion bug.** Four active people were invisible in the inbox and only
   findable under Pending Hires; Carla fixed it by un-promoting and re-promoting. **Not
   investigated.**
3. **Jerome holds slots on the live frozen week.** Carla expects nine officers; `2026-09-06`
   was dealt to ten, including him. Per decision 4 this stands — he finishes the week he is in.
4. **Zero-hours Lead Gen people** are still dealt (`qc-scoring.md` § Eligibility). Carla's
   *"people with hours will be checked"* remains **unbuilt**, and it is a money ruling.
5. **NPD vs HRIS bonus totals never reconcile.** Carla: two different calculations, *"one of
   those issues I really do not care about"* — recorded, not actioned.

## Context for what comes next

Hiring **100 people a week** until Jackie's team reaches 250, for ~3 months, offboarding
**50–75 a week**. That churn rate is precisely why the deal had to stop reading today's roster:
the gap between a week ending and an officer opening the dashboard is now worth ~121 people.
