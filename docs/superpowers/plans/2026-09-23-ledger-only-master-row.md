# Ledger-only leaver → stamped master row — plan

Approved 2026-09-23 (Kane: "Raph only"). One-off, insert-only script that gives a leaver who
exists only on `offboarded_sheet` a `global_master_list` row, pre-stamped off-boarded, so the
Termination Letters tab stops refusing them with `no_master`. First and only target:
`raphs@simple.biz` (Sepnio, Raphael "Raph") — ledger ids 44601 (2026-01-23 NCNS) and 44737
(2026-03-02 Performance), zero master rows in any of the four email columns.

Decisions taken with the approval: Raph only (no batch); Department optional, printed as a
warning when absent; Start Date left NULL for the rep to fill on the tab's blank-only write-back
unless `--start-date` is passed; `last_seen_upload_id` / `first_seen_upload_id` NULL so the row
is never "on the current upload".

## Task 1 — the script

- [ ] `scripts/insert-ledger-only-master-row.mts`, `.mts` via tsx like `backfill-offboard-stamps.mts`
- [ ] Refuse: any master row carries the work or personal email in any of the 4 email columns
- [ ] Refuse: no ledger row for the work email, or its rows carry more than one personal email,
      or that personal email appears on the ledger under a different work email
- [ ] Refuse: latest ledger date fails `explicitMasterDay`; reason not on the departure allowlist
- [ ] Refuse: `--department` not an existing Department value; `--start-date` unparseable or on/after the departure
- [ ] Dry run feeds the proposed row through the tab's own `arbitrateTerminationFacts` and refuses unless it yields facts
- [ ] `--apply`: backup to `references/backups/` → INSERT → read back by id and by email
- [ ] Dry run against production, output checked

## Task 2 — record

- [ ] `docs/features/documents-tab.md` § Ledger-only leavers
- [ ] INDEX row for Termination Letters links the new memory
- [ ] memory `ledger-only-leaver-no-master-row` + MEMORY.md line
- [ ] Open items row in `docs/audits/audit-2026-09-23-session-log.md` (the ~2,532-address gap, the misleading refusal copy, the PENDING apply)
- [ ] One commit, explicit paths
