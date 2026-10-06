# Arriola ghost-row stamp (audit item 364)

**Goal:** take Mark Arriola's name-in-email ghost master row (`global_master_list` 327a7857) off the
active roster. The real person (5dba371f, `marka@`) left 2026-07-16.

**Architecture:** one guarded Node script, read-only by default, `--apply` to stamp, `--revert` to undo.
It copies `scripts/reconcile-gml-active-only.mts` (the actor string, the `.is('off_boarded_at', null)`
guard) and `scripts/backfill-offboard-stamps.mts` (backup in `docs/audits/backups/`, the hours guard
refuses `--apply`).

## Task 1: the script

- [x] `scripts/stamp-arriola-ghost-row.mts`: backup first, six guards, the one-row UPDATE, `--revert`
- [x] Plan-mode run against production (read-only); every guard passes

## Task 2: the record

- [x] `docs/features/gml-roster-source-of-truth.md`: the § *Name-in-email ghost rows* rule
- [x] `docs/features/INDEX.md`: roster row Memory cell gets `[[arriola-lead-gen-master-row-name-as-email]]`
- [x] Item 364 in `docs/audits/audit-2026-09-29-session-log.md` names the script and PENDING `--apply`
- [x] Memory `arriola-lead-gen-master-row-name-as-email` updated

## Left out

- The 09-20 ₱750 bonus on the ghost key: a money ruling for Kane (`NEEDS`).
- Offboarding queue row cf57ab93: HR clicks **Dismiss**.
