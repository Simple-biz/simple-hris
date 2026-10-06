# Payroll Wizard — HRIS vs NPD: Export CSV

**Brief:** in-session 2026-10-06. Kane: *"Payroll Wizard - Validation - Payroll Wizard vs HRIS - add
an export CSV please"*. Built under the 2026-09-26 blueprint rule: recommendations taken (CHOSEN
1–7), no NEEDS.

**Stack:** client-side only. A pure builder over the `HrisNpdComparison` already on screen, a Blob
download in the panel, `node --import tsx --test`. No route, no table, no migration.

**Precedent:** `src/lib/admin/cycle-processor-export.ts` (pure builder, notes block, formula
neutralising on text only, CRLF, totals as a row) and its download in
`src/components/admin/PayrollCyclePerformance.tsx` (BOM written as an escape).

## Task 1 — the pure module

- [ ] `src/lib/payroll/hris-npd-export.ts`
  - `hrisNpdExportBlockedReason(comparison)`: null when every row has a verdict, otherwise the
    reason per hold kind (the button's title).
  - `buildHrisNpdCsv({ comparison, parse, fxRate, periodLabel, npdSource, now })`: refuses while
    held. Notes block → header → every display row (`hrisNpdDisplayRows`, the search and chip
    never apply) → TOTAL row → counts → skipped NPD lines.
  - `hrisNpdExportFilename(periodLabel, now)`: `hris-vs-npd_<from>_to_<to>_<timestamp>.csv`.
  - Money from integer cents (`centsCell`), never through a float.
- [ ] `src/lib/payroll/hris-npd-export.test.ts`: every row is in the file whatever the filter;
  not-paid rows carry the reason and stay out of the totals; totals and counts equal the
  comparison's; the held refusal; formula neutralising on text and not on numbers; cents exact;
  refusals listed; feed vs paste source line; filename.

## Task 2 — the panel

- [ ] `src/components/payroll/HrisNpdComparison.tsx`: an **Export CSV** button in the output
  table's header bar, before Full screen, on the step and in the overlay. Disabled while held,
  with the reason as its title. Reads "Export CSV · all N" when the search or a chip narrows the
  table. The download writes a UTF-8 BOM (the notes carry ₱).

## Task 3 — rendered states

- [ ] `src/lib/payroll/hris-npd-render.test.ts`: the button is live on a judged output, disabled
  while loading / no FX, says "all N" when narrowed, and is in the full-screen mount too.

## Task 4 — verify + document

- [ ] Targeted tests, `npm test`, `npx tsc --noEmit`. `next build` only if no dev server is live.
- [ ] `docs/features/payroll-wizard-hris-vs-npd.md` § Export CSV + key files · INDEX row ·
  memory `payroll-wizard-hris-vs-npd` + MEMORY.md hook · Open items row in the newest session log.
- [ ] One commit, staged by explicit path. Never push.
