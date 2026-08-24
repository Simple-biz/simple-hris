# Orientation attendance — the weekly "who showed up" tally on My Team

Manager Dashboard → **My Team → New Hire Check List** carries a weekly tally of who
showed up for orientation and who did not, plus an **Export PDF** that ships that tally
with the named people behind every number. It answers one question per hiring week —
*how many of the people HR sent us actually turned up?* — and it answers it without
touching a single pay figure.

Shipped 2026-08-24, commit `06f7f669`. Kane's ask: *"we should have a place where we can
see weekly the number of people who showed up in Orientation and the ones that were not"*,
followed by *"the week should match from HR's New Hire Checklist"*.

## Key files

| Piece | File |
| --- | --- |
| The model (pure, tested) | [orientation-weekly.ts](src/lib/manager/orientation-weekly.ts) |
| Its test | [orientation-weekly.test.ts](src/lib/manager/orientation-weekly.test.ts) |
| The PDF | [orientation-pdf.ts](src/lib/manager/orientation-pdf.ts) |
| The history read | [route.ts](app/api/manager/orientation-history/route.ts) |
| Hire rows, paged | `listOrientationHistory` in [hr-pending-employees.ts](src/lib/supabase/hr-pending-employees.ts) |
| Checklist weeks, paged | `listChecklistWeeksByEmail` in [hr-new-hire-checklist.ts](src/lib/supabase/hr-new-hire-checklist.ts) |
| The panel | [NewlyHiredPanel.tsx](src/components/manager/NewlyHiredPanel.tsx) |

## "Did not attend" means the stamp is missing — never what `status` says

A hire attended **iff `orientation_attended_at` is set**. `status` is a sub-label saying
*why* someone didn't: `no_show` (already offboarded) vs anything else (**awaiting** —
nobody has marked them either way).

This is not a stylistic choice. Two live rows break every status-based rule:

- **id 717** carries `orientation_attended_at` **and** `no_show_at`, with `status='no_show'`.
  It is an attendance, and the tally counts it as one.
- **id 1034** carries `no_show_at` with `status='ready'` and no attended stamp — a no-show
  the manager reverted. It is **awaiting**, not a no-show.

Counting off `no_show_at`, or off `status`, mis-files both. `hasAttended()` is the only
test, and `attendanceRate` is `attended / total` — an unmarked hire counts **against** the
week, because "was not marked attended" is exactly what Kane asked to see.

## The week is HR's checklist week, joined on personal email

The bucket key is **`hr_new_hire_checklist.period_start`**, matched on `personal_email`.
It is *not* derived from the hire's own dates, and the reason is measurable.

`hr_pending_employees` carries no link back to the checklist, and its `start_date` is
**null on 973 of 974 live rows**. So the panel's old `start_date ?? created_at` key always
degraded to `created_at` — *when HR staged the hire*, typically the Friday or Saturday
**before** the week they orient. Measured 2026-08-24: that filed **439 of 954 matched
hires (46%) one week early**. Jul 12 read 169 hires under the old key and 102 under HR's.

> **The panel's batch labels and the tally read the same key.** `batchKeyOf` takes the
> checklist map and returns `period_start`. If you ever give the cards one week key and the
> summary another, both become untrustworthy — that is worse than either being wrong alone.

### Resolving an email that appears in several weeks

52 emails appear under more than one `period_start` (re-lists / re-hires), and **none twice
within one week**. `pickChecklistWeek` therefore resolves deterministically: the week
**nearest** the hire's `created_at` week, **preferring at-or-after** (HR lists a hire shortly
before the week they orient), ties to the **later** week (a re-list supersedes what it
repeats).

### Hires on no checklist row keep their own bucket

19 hires match no checklist row at all — 18 came through the onboarding form with an email
the checklist doesn't carry, 1 was a Bypass onboard. They fall back to their staged week and
are flagged **"Not on HR's checklist"** in both the table and the PDF.

> **Never fold them into a real HR week, and never drop them.** This is a headcount report:
> a person who cannot be placed must still be *counted*, and visibly labelled so the number
> stays honest. `totals.unmatched` is what the footnote prints.

**There is deliberately no name-matching tier.** It was measured against the unmatched rows
and recovered nothing, and [hsl-gml-roster-merged](../../MEMORY.md) records that the
plain-name bridge was dropped for exactly this reason: a guessing join is worse than a
labelled gap.

## Two reads, on purpose

| Read | Answers | Feeds |
| --- | --- | --- |
| `/api/manager/pending-hires` | "what can I action right now" | the actionable hire cards |
| `/api/manager/orientation-history` | "who showed up and who didn't" | the tally, the No-shows list, the PDF |

The history route is **not** a widening of the actionable one. That route filters to
`status in (pending_work_email, ready)` plus recent Bypass rows, which as of 2026-08-24 is
**3 of the 40 people never marked attended** — `promoted` hires (they attended; that's why
they were promoted) and every `no_show` row are filtered out before the client sees them.

> **This is also why the panel's "No-shows" section never rendered before today.** It read
> `rows.filter(r => r.status === 'no_show')` from a payload that could never contain one. It
> was dead UI for its entire life. It now reads the history.

> **History must never feed the actionable card list.** It holds 975 rows; the actionable
> list holds ~3. Wire them together and the tab renders a thousand cards.

## Everything here is paged, and one table is already over the cap

`hr_new_hire_checklist` holds **1,334 rows**. PostgREST truncates at `db.max-rows = 1000`
**with no error, even when an explicit `.range()` is given** — so the `.range(0, 9999)`
style used elsewhere in that file returns 1,000 rows and would silently file ~334 hires
under the wrong week. Both reads use `selectAllPaged` with a stable `.order('id')`.

`hr_pending_employees` is at 975 rows growing ~60/week and crosses the cap within weeks.

## The manager sees no money, anywhere

`hr_pending_employees` rows carry `regular_rate` / `ot_rate`. The route runs the same
`stripRates` as `/api/manager/pending-hires`, and the PDF has **no money column at all**.
See [manager-my-team.md](./manager-my-team.md) — rates were stripped from every My Team
surface and must not come back through a report.

The route also **projects the checklist map down to the emails it is returning**. The
checklist covers every department; without that projection a Lead Gen manager would receive
the personal email of every hire in the company.

## Failure is visible, never silently degraded

A history failure clears the state, renders an error card with a Retry, and **disables the
PDF button**. There is no fallback to the hire's own dates — that is precisely the 46%-wrong
key this replaced, and an export that quietly prints wrong weeks is worse than no export
(the same rule as the Overview CSV in [accounting-total-payout.md](./accounting-total-payout.md)).

A history failure also cannot blank the actionable list, and vice versa: the two reads have
separate state and separate error branches. The tab's "No newly hired employees" empty
state now requires **both** to be empty, or a manager with an idle week would lose the
report.

## What each export carries

| Export | Scope |
| --- | --- |
| CSV / Excel | the **current view** — respects search + batch, unchanged behaviour |
| **PDF** | the **whole history** for the manager's scope, regardless of filters |

The PDF is a report, and a report narrowed by whatever is in the search box is not one.
Page 1 is the weekly table with a totals row; page 2+ lists the people per week, **did-not-
attend first**. It mirrors the Payment Catalog export
([catalog-export.ts](src/lib/payment-catalog/catalog-export.ts)) so the two read as one
family — same navy/orange palette, masthead and footer.

> Now that the No-shows section renders, those people also appear in the CSV and Excel
> exports, which already build from `visibleActive + visibleNoShow`. That is the fix
> landing, not a regression.

## Deploy notes

**No migration.** No new column, no new table, no DDL, no webhook, no n8n import, no cron,
no env var. Both reads are read-only against `hr_pending_employees` and
`hr_new_hire_checklist`.

Verified against production on 2026-08-24 by running the shipped `buildOrientationWeeks`
over the live tables: 975 hires bucketed into 12 HR weeks + 19 off-checklist people,
934 attended / 41 not, every hire in exactly one bucket, and rows 717 and 1034 classified
as ATTENDED and AWAITING respectively.

## Related

- [manager-my-team.md](./manager-my-team.md) — the surrounding tab, and the no-comp rule.
- [new-hire-checklist.md](./new-hire-checklist.md) — where `period_start` comes from.
- [offboarding-automation.md](./offboarding-automation.md) — what "Did not attend" fires.
