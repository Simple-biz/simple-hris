# Plan — Payroll Cycles: per-cycle success trend chart

2026-09-11. Approved brief (Q1–Q4 answered by Kane). Kane's ask: *"Lets add a histogram please
where we can see weekly each cycle how successful it is per pay cycle as we progress"*, then
*"Only the cycles where we actually started using HRIS even though we havent closed it ... the
other weeks can be marked as NO HRIS Yet or something"*.

## Decisions taken

- **Q1 — the chart starts where HRIS started paying, not where close-outs started.** The
  window opens at the earliest `periodEnd` of any cycle with `paid != null` (live:
  **2026-05-24**). Earlier weeks collapse into one **"No HRIS yet"** block. This is
  deliberately **not** the existing `pre_closeout` boundary (2026-08-08) — that answers
  "did close-outs exist yet", a different question, and conflating the two would mislabel
  eleven weeks.
- **Q2 — (a) two strips: success rate, and people paid.** The rate strip has only 3 of 15
  weeks filled, so it cannot carry a progress story alone. People-paid has a number for every
  HRIS week and holds the actual arc. Still-owed rides in the tooltip (it exists for the 3
  closed weeks only).
- **Q3 — above the month cards.** Reading order: KPI → trend → months → per-cycle table.
- **Q4 — one collapsed "No HRIS yet" block**, not 12 empty slots, which would double the
  chart's width and squeeze the 15 weeks that carry data.

## What the prod probe established (read-only, 2026-09-11)

Union of `payment_dispatches` (10,106 rows) and `disbursement_records` (22,290 rows), grouped
by period:

| Pay week | Ledger | HRIS dispatch | Reading |
| --- | --- | --- | --- |
| Mar 1 → May 17 (11 wks) | 640–763 paid | **none** | paid, but not through HRIS |
| May 17 → 24 | 798 paid | none | still no HRIS |
| **May 24 → 31** | 803 | **803** | **HRIS starts** |
| May 31 → Jun 7 · Jun 7 → 14 | 811 · 848 | 811 · 848 | running |
| Jun 14 → 21 | 880 paid | none | paid outside HRIS |
| Jun 21 → 27 · Jun 28 → Jul 4 · Jul 5 → 11 | 935 · 972 · 1,009 **all pending** | none | **the four-week stop** |
| **Jul 12 → 18** | **330 paid, 723 pending** | **330** | **the restart Kane remembered** |
| Jul 19 → Sep 5 | ~1,007–1,056 | yes | steady |

Kane's recollection was right with one correction: the ~300 week was the **restart**, not the
first week.

## Tasks

- [ ] 1. `src/lib/admin/cycle-performance.ts` — `selectTrendCycles()`: pure, returns points
      **oldest-first** with a four-state classification, the HRIS-start date, the collapsed
      pre-HRIS count, and the people-paid axis max. `+ .test.ts`.
- [ ] 2. `src/components/admin/performance-ui.tsx` — `CycleTrendChart`: two stacked tracks
      sharing one x, the collapsed lead-in block, per-column hover tooltip, state legend,
      validated orange steps.
- [ ] 3. `src/components/admin/PayrollCyclePerformance.tsx` — render it above the month cards.
- [ ] 4. Docs: new § in `docs/features/diagnostics-performance-tabs.md`, INDEX row, memory
      `cycle-success-trend-chart` + MEMORY.md pointer. Typecheck (a `next dev` is live on
      :3000, so no `next build`). One commit, staged by explicit path.

## The rules this surface carries

1. **Four states, because three would merge two different facts.** `closed` (a rate, draw a
   column) · `no_denominator` (paid is known, no rate) · `not_run` (`paid == null` inside the
   HRIS era — the Jun 21 → Jul 11 stop) · the collapsed pre-HRIS block. Merging `not_run` into
   `no_denominator` would make the four-week stop invisible, and it is the most informative
   thing in the series.
2. **A `rate === null` week never gets a column of height 0.** A zero-height bar reads as 0%,
   which is the exact lie that already bit this tab once (`paid: 0` announced ~700 people
   unpaid in fully-paid weeks). Hatched empty track, no column, pinned by a test.
3. **`paid == null` and `paid === 0` must stay visually distinct.** "Not run through HRIS" and
   "ran and paid nobody" are different facts; three weeks of the former would read as a
   catastrophe as the latter.
4. **The rate axis is always 0–100%.** Truncating it to make 98.25 vs 98.86 legible turns a
   0.6-point spread into a cliff. Two strips, each with its own single axis — never two scales
   on one plot.
5. **Colour is measured, not chosen.** `#f97316` is 2.73:1 on the light surface (below the 3:1
   floor), so the chart uses **orange-600 light / orange-500 dark**, both of which pass. The
   no-data grey is intentionally below the chroma floor because it marks *absence*, not a
   series, so it carries a **45° hatch** as its real encoding. Contrast relief = selective
   direct labels plus the per-cycle table directly below.
6. **Columns, not a line.** A line across an unmeasured week either interpolates a rate nobody
   declared or shatters into loose dots. Columns cannot interpolate.
7. **Motion:** heights animate from 0 on the next frame inside a fixed-height track, staggered
   and capped; `motion-reduce:` disables all of it; every number `tabular-nums`.
