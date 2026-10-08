# New Hire Checklist ← hiring-database sync — implementation plan

Session `1e5dbda7`, 2026-10-08. Kane: *"HR - NewHire Checklist - we will now be polling data that is
available from that Database now I want this in Real Time … I want a new column for us where we can
know the timestamp. Lets make sure data being pulled from that database is saved in our own database as
well. Now for the UI we will still have the Manual Option but find a way that we can prioritize the
Polling of data each time there is"*.

The brief (posted in chat) is the contract. Its CHOSEN lines 1–9 are restated as rules in
`docs/features/new-hire-source-sync.md`. NEEDS 1, the source table name, is left as an honest seam:
`HRIS_HIRES_TABLE` has no default.

## Task 1 — SQL + apply script
- [x] `references/sql/create/2026-10-08_hr_new_hire_source_rows.sql`: `hr_new_hire_source_rows` (one row per
      source hire: mapped values, `content_hash`, `first_pulled_at`, `last_changed_at`, placement state,
      `applied_values`, `checklist_row_id` ON DELETE SET NULL, `placed_at`). RLS on, no policies.
      `hr_new_hire_checklist` gains `origin` ('manual'|'synced', default manual), `source_key` (unique when set)
      and `received_at`.
- [x] `scripts/apply-hr-new-hire-source-sync-migration.mts`: `--dry` (default) / `--apply` / `--verify`, with
      positive and negative controls (copied from `apply-orphanage-oms-hours-migration.mts`).

## Task 2 — pure modules + tests
- [x] `src/lib/hr/hires-source-config.ts` (+test): env → config; identifiers regex-checked and refused by name;
      `HRIS_HIRES_TABLE` has NO default.
- [x] `src/lib/hr/hires-source-map.ts` (+test): source row → mapped values; interview → Manila calendar date
      (Kane's two examples pinned); target week = the Sunday after the interview week; content hash;
      `decidePlacement` (place / link / hold with a reason); `mergeSourceIntoRow` (fill blanks, update only
      untouched cells).

## Task 3 — server
- [x] `src/lib/hr/hires-source-read.ts`: paged read of the source, stable order on the id column, 20k cap +
      `truncated`.
- [x] `src/lib/supabase/hr-new-hire-source-db.ts`: probe (count exact, no head), our copy (upsert the changed
      rows), the checklist index for de-dupe, insert of a synced checklist row (23505 → linked), merge update.
- [x] `src/lib/hr/hires-source-sync.ts`: one sync pass. It Broadcasts `changed` to each touched week's room.
- [x] `app/api/hr/new-hire-checklist/source-sync/route.ts`: GET status (elevated), POST `{action:'sync'}` /
      `{action:'place', source_key, period_start}` (feature edit). Audit only when something changed.

## Task 4 — UI
- [x] `src/components/hr/use-hires-source-sync.ts`: on mount, every 30 s while visible, Sync now; single-flight;
      the client stops waiting at 45 s (a first sync's bulk write outlasts the OMS-style 15 s; the server carries on).
- [x] `HrNewHireChecklist.tsx`: sync strip (status, Sync now, held list + "Add to this week"), the Received column
      with a Synced/Manual tag; refetch the week when a sync changed it.

## Task 5 — verify + document
- [x] `npm run lint` (tsc), the new tests, and `npm test` for the touched areas.
- [x] Feature doc, INDEX row, memory + MEMORY.md pointer, Open items row (NEEDS 1 + migration PENDING),
      `.env.example` block. One commit by explicit path. Never push.
