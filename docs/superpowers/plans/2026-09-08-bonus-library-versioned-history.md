# Payment Catalog → Bonus Library → versioned change history

**Date:** 2026-09-08 · **Approved:** Kane, same day (brief rev 2).
Answers to the brief: **Q1** versions + effective dates are RECORDED and SHOWN; the KPI
Calculator keeps paying the LIVE definition ("Yes") · **Q2** assignment changes are
historied too · **Q3** the author picks the effective date on create AND on edit.

Every definition edit today is an in-place upsert on `bonus_catalog_bonuses`; nothing keeps
the prior value and no effective date exists. This adds a version number to every bonus, a
snapshot row per version with the date it takes effect, an event row per assignment change,
and a history section in the bonus detail modal.

Precedent: Pay Structures rate history in the same file (`RateHistoryPanel`, the
"Effective from" DatePicker, `syncRateHistory` writing history from the save route,
`create_employee_rate_history.sql` baseline backfill). Deliberate differences: the
history INSERT is awaited, a version is written only when a tracked field changed, and
each version carries a number.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `references/sql/create/2026-09-08_bonus_catalog_history.sql` — `version` +
      `effective_from` on `bonus_catalog_bonuses`; `bonus_catalog_bonus_history`
      (UNIQUE (bonus_id, version)); `bonus_catalog_assignment_history`; NOT EXISTS-guarded
      baseline backfill (v1 per bonus, one `added` event per assignment).
- [x] 2. `scripts/apply-bonus-history-migration.mjs` — `--verify` / apply, `pg` over
      `DATABASE_URL` (session pooler, see memory `migration-apply-needs-database-url`).
- [x] 3. `src/lib/bonus-catalog/history.ts` + `history.test.ts` — `diffBonusFields`,
      `diffAssignment`, `parseEffectiveDate`, row types.
- [x] 4. `src/lib/supabase/bonus-catalog-db.ts` — `upsertBonus` reads the previous row,
      bumps `version` only when a tracked field changed, writes the version row;
      `addAssignment` / `removeAssignment` write event rows; `listBonusHistory(bonusId)`
      via `selectAllPaged`. A missing history table never fails the save.
- [x] 5. `app/api/bonus-catalog/route.ts` — POST/DELETE accept `effectiveDate`
      (YYYY-MM-DD, else 400).
- [x] 6. `app/api/bonus-catalog/history/route.ts` — GET `?bonusId=`, same gate as the
      catalog GET; `{ versions, assignmentEvents, error }`.
- [x] 7. `src/components/accounting/BonusCatalog.tsx` — "Effective from" DatePicker in
      `BonusEditor` (create + edit) and in the Assignments department panel; version chip
      on the card + detail header; `BonusHistoryPanel` (versions + assignment events) in
      the detail modal's view mode, says "history unavailable" on a failed read.
- [x] 8. `tsc --noEmit` + `npm test` (dev server is live — no `next build`).
- [x] 9. Docs: `docs/features/bonus-catalog.md` §8, INDEX row 24 wikilink, memory
      `bonus-library-versioned-history` + MEMORY.md pointer. One commit.
