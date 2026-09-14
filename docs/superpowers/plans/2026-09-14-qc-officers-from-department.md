# QC officers come from the QC department, and a midweek transfer stays scorable

Approved by Kane 2026-09-14. Brief posted in-session; Q1 (backfill) answered **forward
only**, Q1-prior (Jerome) answered **finish this week, drop next**, Q3 **as is**.

## Why

Two defects and one policy change, all on the Lead Gen KPI money path.

1. **The officer list is an admin grant that has drifted.** `employee_roles.role='qc'`
   holds 10 people; the QC department holds 9. The odd one out is `jeromer@simple.biz`,
   who moved to **Callback Team** and is still dealt **34 Lead Gen slots this week**.
   Kane: *"I dont want the admin provisions to be the source of the QC Pickers I just
   want the people under the QC Department to assist the LEADGEN manager."*
2. **`roster_status='transferred'` is dead code** — 0 of 8,537 rows. The roster read is
   pre-narrowed to `QC_DEPT_SET`, so a Lead Gen → HSL transfer records as `removed` with
   a null `current_department`, indistinguishable from quitting.
3. **The officer's count excludes the people Kane wants scored.** `summarizeOfficers`
   skips every non-`active` slot, so the headline says 34 while the list holds 36.

## Invariants that do not move

- The **seeded-random deal** and its **not-alphabetical regression test** — Carla's
  buddy-risk control (`qc-scoring.md:59,88`). Untouched.
- **Sticky snapshot**: a slot is never deleted (`qc-scoring.md:91`).
- **Diff-only writes**; a no-op read must not churn Realtime.
- **Leavers and transfers stay scorable.** `myRows` carries no status filter
  (`assignments/route.ts:67`) and must never gain one. `removed` means *not on the master
  list*, never *not scorable*.
- `QC_DEPT_KEYS` stays `['lead_gen']`. Widening it would enrol a department into QC
  scoring — a scoring decision, not a bug fix.

## Tasks

- [ ] 1. `src/lib/qc/officers.ts` — pure. `QC_OFFICER_DEPT_KEY = 'qc'`;
      `officersFromRoster(roster)`; `freezeOfficers(existingOfficers, liveOfficers)`;
      `currentDeptByEmail(roster)`; `classifySlot(isLive, currentDept)`.
- [ ] 2. `src/lib/qc/officers.test.ts` — the Jerome case, the churn case, the
      quit-vs-transfer split, the empty-roster fail-closed case.
- [ ] 3. `src/lib/supabase/qc-db.ts` — read the FULL active roster once; derive the
      scored slots and the current-department map from it; officer source; freeze;
      reachable `transferred`.
- [ ] 4. `summarizeOfficers` counts every slot an officer must score.
- [ ] 5. Verify the roster read pages (`selectAllPaged`) — 1,320 rows vs the 1000 cap.
- [ ] 6. Docs: `qc-scoring.md` § officers / § transfer memory / § counts, INDEX row,
      memory entry.
- [ ] 7. The "Transferred to &lt;Department&gt;" sticker — assessed separately once the
      data is real; it cannot be built before `current_department` is populated.

## Forward only

Existing rows are not re-classified. The 1,032 historical `removed` rows keep their
value; only slots written from this deploy onward can carry `transferred`. No migration,
no backfill script.

## Deploy notes

**No migration.** Migration #89 is already applied in production (measured 2026-09-14 —
`roster_status` and `current_department` both readable). The stale `qc` role rows are
left in place, unused by the deal; removing them is a separate audited decision.

**Behaviour change to announce:** from the next deal, officers are whoever is in the QC
department. Jerome keeps this week's 34 slots and is not dealt next week.
