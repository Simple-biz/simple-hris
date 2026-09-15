# Add missing as externals — plan

Approved 2026-09-14 (Kane: *"These people are added externally so lets just add that button where
we can add them into the thing as externals so this should have the total properly"*; then *"if one
of those people doesnt appear on the global master list then they should be marked as problems"*).
Brief in the Sep 14 session log, row 99 (numbered 97 until the 2026-09-15 renumbering). Q1 answered by that message (button, not the as-of-week
table). Q2 taken as recommended (QC-scored at ₱0 and not on the sheet are skipped, counted). Q3
taken as recommended (an active transfer's row shows where they are now, from the live roster,
display only).

## Tasks

- [x] `src/lib/qc/missing-people.ts` — pure: sheet ∪ QC first pass − table, resolved through the
      caller's `KnownPerson`s (pay key decided by the caller per source); sheet count wins; QC ₱0
      skipped and counted; unknown / ambiguous / duplicate-person / no-bonus are PROBLEMS by name.
- [x] `src/lib/qc/missing-people.test.ts` — node:test, eleven cases pinning the three keys.
- [x] `src/lib/qc/compare.ts` — `off_table` and `unmatched` wording point at the button;
      `compare.test.ts` still passes (Offboarded chip still named).
- [x] `src/lib/audit/registry.ts` — `qc.missing_added` in the QC family note.
- [x] `src/components/manager/DeptBonusCalculator.tsx`
  - [x] `CompareRun` carries `qcRows`.
  - [x] `deptScoringVar(deptKey)` — the dept's common formula bonus + appt variable.
  - [x] `addMissingPeople(deptKey)`: active master list first (personal-first key), then the
        week-scoped Offboarded list (`offboardedAddEmail(c, true)`), active wins on overlap; per
        person `addExternalMember` + `setVar`; one audit row; toast; result line + PROBLEMS list;
        `undoAddMissing`; Compare re-runs with `share: false`.
  - [x] Button in the Compare action row: `Add N missing as externals`; draft weeks only.
  - [x] Row chip for an active transfer: `Transferred → <dept>`.
- [x] Typecheck (dev server live — no `next build`).
- [x] Docs: `qc-scoring.md` § Add missing as externals · INDEX row 24 · memory
      `qc-add-missing-externals-button` + MEMORY.md pointer · session log row 99 (was 97) → SHIPPED.
- [x] One commit, explicit paths.
