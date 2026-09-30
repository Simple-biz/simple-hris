# Payroll Wizard — Validation step "HRIS vs NPD" tab

**Brief:** in-session 2026-09-30. Kane: *"Payroll Wizard - Validation Step - Lets add a new tab in
here labeled as "HRIS vs NPD" where there are only 1 column for each - where we can compare their
Dollar Values - against their work emails … If they are a match then that row will be green along
with the Match column that has a check mark and X mark if other wise and red row color … There might
be people that are in NPD that aren't in HRIS or Vice Versa lets make sure not to delete any rows and
just label the match column as - Not in HRIS or NPD on whoever is missing"*. Built under the
2026-09-26 blueprint rule: recommendations taken (CHOSEN 1–10), no NEEDS.

**Stack:** Next.js app router (client only here), `motion/react`, `node --import tsx --test`.
**No route, no table, no `app_settings` key** — the paste lives in the wizard's React state.

## Task 1 — the pure module

- [ ] `src/lib/payroll/hris-npd-compare.ts`
  - `parseNpdPaste(text)` → `{ rows, refusals, headerSkipped, amountColumn }`. TAB-separated;
    whitespace split only for a line with no tab. The key is the first email-looking cell; the
    dollar figure is the paste's **rightmost non-empty column**, fixed for every line, so a blank
    USD cell is refused instead of read from its neighbour. `$`, `USD`, `US$`, commas, trailing `$`,
    `-` and `( )` tolerated; `₱` / `PHP` / anything non-numeric refused. One header line skipped.
  - `usdFromPhpAsStaged(php, fx)` — the staged `amount_usd` expression, verbatim.
  - `compareHrisNpd({ hrisRows, npdRows, fxRate, hrisState, unavailableSources, aliasesFor,
    pausedEmails })` → `{ rows, counts, totals, hold }`. Rows = the union of both sides, never a
    drop. HRIS rows grouped by normalized email (staged cents summed); NPD lines grouped by the HRIS
    row they reach (exact, then master bridge; 2+ reached = ambiguous), unmatched by their own email.
    Verdicts only when `hrisState === 'settled'` and `fxRate > 0`.
  - `filterHrisNpdRows(rows, { needle, status })` — display only.
  - `HRIS_SOURCE_LABELS: Record<PayStubSourceKey, string>` for the unavailable banner.
- [ ] `src/lib/payroll/hris-npd-compare.test.ts` — parse shapes (Kane's sample, header, wide
  selection, trailing empty columns, blank USD, ₱ refused, CRLF line numbers, no tab); compare
  buckets; union never drops; repeats add; bridge + ambiguity; paused note; the three holds;
  duplicate HRIS rows summed as staged; the cent rule; totals ignore the filter; a source guard
  that `PayrollWizard.tsx` still stages `amount_usd` with the same expression.

## Task 2 — the panel

- [ ] `src/components/payroll/HrisNpdComparison.tsx` — paste card (textarea, parse counts,
  refusals list, Clear), the rate line, the hold banner, filter chips + search, the four-column
  table (memoized rows, sticky head, emerald / rose rows, hue-matched ink), column-totals footer.

## Task 3 — wizard wiring

- [ ] `src/components/PayrollWizard.tsx`
  - `VALIDATION_SECTIONS` beside `ADDITIONS_SECTIONS`; `validationSection` + `validationSectionDir`
    state; `npdPaste = { sourceFile, text }` (a paste belongs to one week by construction).
  - memos after `validationRedFlagCount`: `npdHrisRows`, `npdPausedEmails`, `hrisNpdUsdState`,
    `npdPasteParse`, `hrisNpdComparison`.
  - step 7: the strip under the summary cards; the section swap wraps ONLY the department rail +
    Final Pay table (+ its full-screen portal). Header, cards, holidays and Validation Checks stay.

## Task 4 — verify

- [ ] `npx tsc --noEmit` · `npm test` (compare against the pre-existing failures) · dev server check
  before any `next build`.

## Task 5 — record

- [ ] `docs/features/payroll-wizard-hris-vs-npd.md` · `docs/features/INDEX.md` row ·
  `docs/README.md` row · `docs/reference/components.md` row · pointer lines in
  `payroll-wizard-manual-validation.md` and `payroll-wizard-final-pay.md` §2026-08-18 · memory
  `payroll-wizard-hris-vs-npd` + `MEMORY.md` · session log item 292 · one commit by path.
