# Lead Gen paste → Compare → Override (+ Undo) in the Manager KPI Calculator

**Date:** 2026-09-10 · **Approved:** Kane, same day ("Lets build"), after the revised brief.
Rulings folded in: **Q2** Undo = revert to pre-Override state, in memory, this session ·
**Q3** locked week ⇒ Override disabled, reopen via the existing path · **Q4** "wrong" =
QC count ≠ pasted count, in appointments, no pesos · **Q5** join on WORK email; unmatched
rows are refused, never created · **Q6** existing gate (`manager/hsl_bonus` edit +
`department_managers` scope), Undo same person.

Production probe (read-only, 2026-09-10): the Lead Gen bonus is `bonus_mq9yxlmsyj7avdmc`,
kind **formula**, `=IF(Appts_Set>=10, Appts_Set*500, Appts_Set*250)` ⇒ variable **`Appts_Set`**.
`reinelr@` is excluded from it and holds his own `Lead Gen (COP)` bonus
(`bonus_mtddp1p5rf4hq1rw`, `=Appts*14000`, variable **`Appts`**) — so the variable is resolved
**per member**, never assumed. `qc_kpi_submissions` for Lead Gen: 24 rows, one week
(2026-06-14), all `scored_by = perryb@`. `bonus_catalog_applied` for Lead Gen: 5,820 rows.

Jackie's paste is TAB-separated, no header: `work email ⇥ "Surname, Given "Nick"" ⇥ count`.
Column 2 carries commas and quotes, so nothing CSV-shaped may touch it.

Precedent: Payroll Wizard step 3 orphanage paste (`PayrollWizard.tsx:8311-8434`). Copied:
per-line refusals with line numbers, dedupe on the RESOLVED person, the work → master →
alternates bridge. Deliberately NOT copied: the inline untested parser, its comma fallback
(shreds `Cahig, Marc`), and its silent-₱0 on a misaligned row.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `src/lib/qc/paste.ts` + `paste.test.ts` — pure. Tab-only split; exactly 3 cells or
      refuse; col 1 must contain `@`, lowercased + trimmed; col 3 a non-negative INTEGER
      (`"1,200"` refused, not coerced); one header row skipped when col 1 has no `@`;
      CRLF + blank lines tolerated (line numbers still count them); col 2 kept for display
      only; duplicate email within the paste refused on the second occurrence.
- [x] 2. `src/lib/qc/compare.ts` + `compare.test.ts` — pure. Inputs: parsed rows; members
      `{ canonical, emails[], name, workEmail }`; QC rows `{ employee_email, bonus_id, vars,
      scored_by }`; per-member `{ bonusId, varName }`. Output: buckets MATCH · MISMATCH
      (qc, pasted, scoredBy) · PASTE_ONLY (no QC row) · QC_ONLY (not in paste); refusals
      UNMATCHED · AMBIGUOUS (one work email → two canonicals) · NO_BONUS. Fixture pins the
      live keys `Appts_Set` / `Appts` the way `team-rankings.test.ts` pins its keys.
- [x] 3. `DeptBonusCalculator.tsx` — `DeptAppliedPayload.rows[]` gains `scored_by?: string |
      null` (the GET already returns it; the client type was dropping it).
- [x] 4. `DeptBonusCalculator.tsx` — Compare panel inside the Lead Gen card, manager mode,
      QC dept only, hidden when `readOnly`. Paste textarea → parse → Compare (re-fetches
      `/api/qc/submissions?dept&period_start`; the seed only fires on a cold week) → bucketed
      table with scored_by on every mismatch → **Override** applies pasted counts to
      MISMATCH + PASTE_ONLY rows ONLY, via the existing `setVar` (clears `seeded`, sets
      `dirty`), on THAT member's applicable bonus variable; touches nobody else; the existing
      whole-dept autosave persists it. **Undo** restores the `members` slice snapshotted
      immediately before Override, through the same state path. One
      `logAudit({ action: 'qc.compare_override_applied', … })` on Override.
- [x] 5. `tsc --noEmit` + `npm test` (dev server is live on :3000 — no `next build`).
- [x] 6. Docs: `docs/features/qc-scoring.md` §Compare/Override; INDEX row 24a invariant +
      wikilink; memory `qc-paste-compare-override` + MEMORY.md pointer; fix the stale
      `src/lib/bonus-catalog/types.ts:5-6` comment (catalog is tables, not an app_settings
      blob — `BONUS_CATALOG_KEY` has no consumers). One commit.

## Invariants this must not break

- `saveDept` always posts the FULL dept-week and `saveDeptPeriodApplied` deletes every row
  not in the keep-set ⇒ Override mutates `state` only and never assembles `rows[]`.
- `bonus_catalog_applied.employee_email` is stored VERBATIM and is in the conflict target ⇒
  Override writes to the member's EXISTING state entry, never a string from the paste.
- Applied/QC rows key PERSONAL-first; the paste is WORK email ⇒ bridge via the master row's
  email set; a work email resolving to two members is REFUSED.
- Every mutator clears `seeded` with `dirty` ⇒ Override goes through `setVar`.
- Draft-only: `readOnly = weekPending || status !== 'draft'`; `saveDept` refuses `!weekResolved`.
- No new server read (Compare reuses the existing GET), so no new paging obligation — but
  `listQcSubmissions` is unpaged today; one dept-week stays well under 1,000.
