# Plan — Download the month/week processor breakdown as CSV

2026-09-11. Kane asked twice (*"within the modal we can see a download pdf or csv in there"*,
then *"where is the export download in here per modweek?"*). I had hard-stopped on Q1–Q3; the
second ask is the go-ahead, taken with the three recommended defaults stated back to him.

## Decisions taken (my recommendations, unopposed)

- **Q1 — CSV, not PDF.** ~40 lines against a well-worn precedent, and it opens in Sheets where
  the numbers can be re-sorted and checked. A PDF would be a picture of a table nobody can
  interrogate. PDF stays available later if the file ever needs to go to someone outside the
  tool.
- **Q2 — the download follows the week filter**, with the scope in the filename. A file that
  silently disagrees with the screen that produced it is a trap.
- **Q3 — the legend ships IN the file**, as comment rows above the table. Those three
  sentences are the only thing stopping a reader computing a fake per-rail success rate from
  the bare columns — which is the one thing every surface here refuses to draw.

## Tasks

- [ ] 1. `src/lib/admin/cycle-processor-export.ts` + `.test.ts` — pure: scope in, CSV text out.
      No fetch, no DOM, no Supabase.
- [ ] 2. `src/components/admin/PayrollCyclePerformance.tsx` — a Download CSV button in the
      modal, wired to the current scope.
- [ ] 3. Docs: § in `diagnostics-performance-tabs.md`, INDEX row, memory. One commit.

## The rules this carries

1. **The file is exactly what the screen shows.** Same rows, same totals, same scope, footed by
   the same `summariseProcessorRows`. The filename names the scope
   (`…_2026-08_Aug-9-15.csv` vs `…_2026-08_all-weeks.csv`).
2. **The caveats ship with the numbers.** Header rows carry: payments are dispatch rows not
   people; threshold is a deliberate hold; nothing records whose fault a Problem was; and the
   explicit statement that **no per-processor rate exists** because the two sides of the table
   are different units.
3. **No rate column, ever** — in the file as on the screen. A CSV is exactly where someone
   would add one.
4. **Formula injection is neutralised** on every text cell (`neutralize`, the precedent's
   rule): a processor label is registry free-text and a leading `=`/`+`/`-`/`@` executes in
   Excel. Numeric cells are builder-controlled and are never neutralised — a negative amount
   legitimately starts with `-`.
5. **No PII to mask**, unlike every other export in this repo: the modal's data is counts,
   money and processor ids. Worth stating so nobody later "adds the names for context".
6. **CRLF line endings + RFC 4180 quoting**, matching `cycle-close-report-export.ts`.
