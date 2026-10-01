# Payroll Wizard — HRIS vs NPD: Save output

**Brief:** in-session 2026-10-01. Kane: *"Payroll Wizard - Validation Step - HRIS vs NPD - Give me an
SQL Migration for this one so I can save the output for the current week"*. Built under the
2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–8), no NEEDS.

**Stack:** Next.js app router, Supabase service role behind the `payroll_wizard` feature gate, one
plpgsql RPC for the atomic save, `node --import tsx --test`.

## Task 1 — the data layer

- [ ] `references/sql/create/2026-10-01_payroll_wizard_npd_comparisons.sql`
  - `payroll_wizard_npd_comparisons` — one row per SAVE: `source_file` (the wizard's week key),
    `version` (1, 2, … per week, unique), `saved_by/at`, `tolerance_cents` 0–99, `fx_rate` > 0,
    the four counts, `row_count` = their sum, `left_out_count`, `refusal_count`, the two totals in
    cents, `paste_text` verbatim, `refusals` / `left_out` jsonb arrays, `content_sha256`.
  - `payroll_wizard_npd_comparison_rows` — one row per output row: `row_no`, `work_email`, `name`,
    `status` (NOT NULL, the four verdicts), `hris_cents` / `npd_cents` / `delta_cents`, `hris_php`,
    row counts, `npd_lines int[]`, `implied_npd_rate`. CHECKs tie the nulls to the status and
    `delta = npd − hris`.
  - `payroll_wizard_save_npd_comparison(p_source_file, p_saved_by, p_content_sha256, p_snapshot)` —
    advisory lock per week; identical content to the latest version returns it (`unchanged`);
    otherwise inserts header + rows as the next version and verifies counts, totals and every
    verdict against the tolerance before returning. `search_path = ''`, EXECUTE revoked.
  - UPDATE refused on both tables by trigger (a saved output never changes).
  - RLS on, zero policies, privileges revoked from anon/authenticated, not in realtime.
- [ ] `scripts/apply-payroll-wizard-npd-comparisons-migration.mts` — dry by default, `--apply`,
  `--verify`; object checks + positive control + negative controls.

## Task 2 — the pure module

- [ ] `src/lib/payroll/hris-npd-snapshot.ts` — `buildHrisNpdSnapshot` (refuses while held),
  `validateHrisNpdSnapshot` (server: shape, caps, verdict vs tolerance, counts, totals, and the NPD
  side re-derived from the stored paste), `canonicalSnapshotJson`, `snapshotToRpcPayload`.
- [ ] `src/lib/payroll/hris-npd-snapshot.test.ts` — round trip, every refusal, source guards on
  the route (edit gate on POST, `saved_by` from the session) and the SQL (column ↔ payload keys).

## Task 3 — route + audit

- [ ] `src/lib/supabase/hris-npd-snapshot-db.ts` — `readLatestHrisNpdSave` (header only),
  `saveHrisNpdSnapshot` (RPC; missing objects → "not set up yet").
- [ ] `app/api/payroll-wizard/npd-comparison/route.ts` — GET (`payroll_wizard` view) latest save
  for `?sourceFile=`; POST (`payroll_wizard` edit) validate → sha256 → RPC →
  `accounting.payroll_wizard.npd_comparison.saved`. Missing tables → 503.
- [ ] `src/lib/audit/registry.ts` — widen the `accounting.payroll_wizard.` entry's note.

## Task 4 — UI

- [ ] `HrisNpdComparison.tsx` — a Save bar at the top of the Output: Save output, the last save
  (version, who, when, counts), disabled with the reason while held / replay / no week / saving.
- [ ] `PayrollWizard.tsx` — `npdSave` state stamped with the week; GET on week change; POST on
  click; rides in `hrisNpdPanelProps` so the step and full screen agree.

## Task 5 — docs

- [ ] `payroll-wizard-hris-vs-npd.md` § Saving the output (replaces § Nothing is saved) + Deploy notes.
- [ ] INDEX row, `api-reference.md`, memory update + MEMORY.md, session log item.
