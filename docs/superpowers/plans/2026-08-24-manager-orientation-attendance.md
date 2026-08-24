# Weekly orientation attendance — Manager → My Team → New Hire Check List

Approved brief: a weekly "showed up / did not show up" summary on the New Hire Check List
inner tab, plus a new branded PDF export carrying that summary and the per-hire detail.

Kane's rulings (2026-08-24):

- **Q1 Export PDF** — build a new PDF beside the existing CSV / Excel buttons. Page 1 is
  the weekly table, page 2+ is the per-hire detail grouped by week. There is no PDF on
  My Team today; this is a new artifact, not an edit to one.
- **Q2 "Did not attend"** — anyone with **no `orientation_attended_at` stamp**. Status
  (`no_show` vs still open) is a sub-label, never the test.
- **Q3 History depth** — all weeks, no rolling window.
- **Q5 No-shows** — fix the dead No-shows section in the same commit so those people
  appear as cards, not just as a count.
- **Follow-up ruling** — *"The week should match from HR's New Hire Checklist"*. The
  week key is `hr_new_hire_checklist.period_start`, joined on `personal_email`. It is
  **not** derived from the hire's own dates.

## What the probes measured (read-only, prod, 2026-08-24)

| Fact | Number |
|---|---|
| `hr_pending_employees` rows | 974 (934 attended · 40 not) |
| `hr_new_hire_checklist` rows | **1,331 — already past the 1000-row cap** |
| Pending rows matching a checklist row on `personal_email` | 955 / 974 (98%) |
| Emails appearing on **more than one** checklist week | 52 (never twice in one week) |
| Pending rows with **no** checklist row | 19 (18 `onboarding_form`, 1 Bypass) |
| Pending rows with `start_date` set | **1 / 974** |
| Matched rows whose derived week ≠ HR week | **439 / 954 (46%)** |

The last two rows are the reason for the ruling: `batchKeyOf` buckets on
`start_date ?? created_at`, `start_date` is null almost everywhere, and `created_at` is
when HR *staged* the hire — usually the Friday or Saturday **before** their orientation
week. So nearly half the panel is labelled one week early today.

Two rows prove the stamp — not the status — must decide attendance:

- **id 1034** carries `no_show_at` with `status='ready'` (a reverted no-show).
- **id 717** carries **both** `no_show_at` and `orientation_attended_at`, `status='no_show'`.

## Tasks

### 1. The pure builder

- [ ] `src/lib/manager/orientation-weekly.ts` — framework-free, no I/O.
      `buildOrientationWeeks({ hires, checklistWeeksByEmail })` → buckets newest-first:
      `{ weekStart, label, onChecklist, total, attended, notAttended, noShow, stillOpen }`.
      - Attendance test is `Boolean(orientation_attended_at)`. Status is carried for the
        sub-label only.
      - Week key: `pickChecklistWeek(email, createdAt)` — single hit wins; multiple hits
        resolve to the `period_start` nearest the row's `created_at` week, **preferring
        at-or-after**, ties to the later week.
      - No checklist row → fall back to the `created_at` week and set
        `onChecklist: false`. Never silently folded into a real week.
      - **No name-matching tier.** It recovered 0 of the unmatched sample and
        `memory/hsl-gml-roster-merged` records that the plain-name fallback was dropped
        precisely because a guessing bridge is worse than a labelled gap.
- [ ] `src/lib/manager/orientation-weekly.test.ts` (`node:test`) pinning:
      - the attended **stamp** decides — fixtures modelled on ids 1034 and 717;
      - the multi-week tie-break, including a hire re-listed in a later week;
      - the labelled fallback keeps the person visible and flags the bucket;
      - a negative control: an empty checklist map buckets everyone as `onChecklist:false`
        rather than throwing or dropping rows.

### 2. Data layer

- [ ] `src/lib/supabase/hr-pending-employees.ts` → `listOrientationHistory(departments?)`.
      - `selectAllPaged` over `hr_pending_employees`, **all statuses**, stable `.order('id')`.
      - `selectAllPaged` over `hr_new_hire_checklist` for the `personal_email → period_start`
        map. **This table is at 1,331 rows: an un-paged read drops 331 hires today** and
        files them under the wrong week with no error.
      - Case-insensitive / trim-tolerant department scope, mirroring
        `listManagerPendingHires`.

### 3. Route

- [ ] `app/api/manager/orientation-history/route.ts` — `GET`, read-only.
      Gate copied verbatim from `app/api/manager/pending-hires/route.ts`: session →
      `manager|admin` → `hasElevatedRole` bypass → `listDepartmentsForManager` scope.
      Runs the same `stripRates` — `hr_pending_employees` carries `regular_rate` / `ot_rate`
      and managers must never receive them (`docs/features/manager-my-team.md:13`).

### 4. PDF

- [ ] `src/lib/manager/orientation-pdf.ts` — mirrors
      `src/lib/payment-catalog/catalog-export.ts`: pdf-lib built from scratch, navy/orange
      masthead, "Pulled from Simple-HRIS System", "Developed by AI/API Team" footer.
      Page 1 weekly table + totals row; page 2+ per-hire detail grouped by HR week.
      No money column anywhere. `formatDeptLabel` before printing any `hsl:*` key.

### 5. UI

- [ ] `src/components/manager/NewlyHiredPanel.tsx`
      - weekly summary block above the batch cards;
      - PDF button beside CSV / Excel, **disabled when the history fetch failed** — never
        print a report over a partial roster (`memory/payroll-exports-itemized`);
      - No-shows section reads the history rows (it can never render today);
      - `batchKeyOf` replaced by the HR week so the cards and the summary agree.
      - History feeds the summary, the No-shows section and the PDF **only** — the
        actionable card list keeps riding `/api/manager/pending-hires`, or the panel
        would render 974 cards instead of ~3.

### 6. Verify

- [ ] `npx tsx --test src/lib/manager/orientation-weekly.test.ts`
- [ ] typecheck / build — check for a live `next dev` first (shared `.next/`).

### 7. Document (same commit)

- [ ] `docs/features/manager-orientation-attendance.md`
- [ ] `docs/features/INDEX.md` row
- [ ] `memory/manager-orientation-weekly-attendance.md` + `MEMORY.md` pointer

## Out of scope (contract)

`app/api/manager/pending-hires/route.ts` · `listManagerPendingHires` · HR's own New Hire
Checklist tab and its writes · the Roster inner tab · promote · Mark attended · Did not
attend · every write path.
