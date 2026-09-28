# People → Payroll: every week, with the bonuses

The **Payroll** tab of one person's record. It appears in two places: the People popup (Accounting and the
CEO: People → View) and the Search Bar's person page (`people-bank-search.md` §4). Both render
the same component. Each pay week is **headlined by what the week paid**, with its bonuses
itemised.

Built 2026-09-28 for Kane: *"I did also notice that the Payroll tab did not include the
bonuses"*. Before that, the tab printed `disbursement_records.amount_php`, which is **regular + OT
pay and nothing else** (`ceo-assistant.md` § get_employee_pay, `pay-reconciliation.ts`). A ₱5,000
Attendance Incentive week and a ₱25,000 KPI week both read as their hourly pay. Measured on
gyd@'s 2026-08-23 week: the tab said **₱25,625.00**, and the statement she was sent says **₱64,525.00**
(Attendance Incentive ₱5,000 + Adjustment ₱25,000 + Orphanage ₱9,000 − MESA ₱100). The Overview
hero (2026-07-30) and Penny's payroll report (2026-09-17) each had the same salary-only-as-a-total
defect. Assume it exists anywhere a total is read from `disbursement_records`.

## Key files

| Piece | File |
| --- | --- |
| The precedence, pure (no pay arithmetic, only quoting) | `src/lib/people/payroll-history.ts` (+ `.test.ts`) |
| The reads (records · statements · dispatch log), fail-closed | `getPeoplePayWeeks` in `src/lib/people/people-banking.ts` |
| The route | `app/api/people/[email]/payroll/route.ts` |
| The list, the Statement view, the fetch hook | `PayrollHistoryList` · `usePersonPayWeeks` in `src/components/people/person-record-panels.tsx` |
| Hosts | `PersonDetailDialog` (`PeopleTab.tsx`) · `PersonPage` (`PeopleBankSearch.tsx`) |

## 1. Where each week's figure comes from

One row per pay week, newest first. The row's source is decided in this order, and the row says
which one it used:

| Source | When | Headline | Bonus |
| --- | --- | --- | --- |
| **Statement** | A staged statement exists for the person's work email and that week | the statement's **Net pay** (`totalPayPhp`) | itemised: Tech Allowance · Attendance Incentive · KPI / Performance Bonus · Adjustment, **the statement's own labels** |
| **Dispatch** | No statement, but paid `payment_dispatches` rows exist for the week | what those rows sent (`amount_php`, summed) | the frozen `system_bonus_php` **total**, marked *not itemised* |
| **Hourly only** | Only the weekly record | the record's `amount_php`, **captioned "Hourly pay only"** | **not on record** (`null`), never ₱0 |
| Special | A legacy `kind: 'special'` record (0 in production, 2026-09-28) | its amount | none. Kept as its own row, never merged into a week |

**The statement is the authority** because it is what the worker was emailed and can download.
It is chosen by the rule every statement viewer follows (`paystub-dispatch.md` § Paystub
freshness): a **paid** week renders its staged payload untouched (mark-paid froze it as-paid), and
an **unpaid** week has any newer wizard-snapshot figures merged over it. The code reuses
`freshStagedViewWith`, `paidAtByFileFrom`, `SHOW_UNPAID_STAGED_PAYSTUBS` and `dedupeOneRowPerWeek`
from the paystub assembly; none of that logic is restated here. Statements match on the
**work email only**, because personal addresses are shared and recycled.

**Never the wizard's final-pay snapshot directly.** Penny's `get_employee_pay` itemises from
`app_settings["payroll.wizard.final_pay.<file>"]`, and each of those rows is **~1.6 MB** (2,235 people,
0.6–1.2 s each, measured 2026-09-28). Thirty of them per popup open is not a tab. The staged
statement carries the same lines per person in one ~0.7 s query.

**Never `system_bonus_label`.** The dispatch's label names only its PAB/Tech part (measured:
₱157,805 labelled "PAB ₱5,000", `ceo-assistant.md`). The Dispatch row shows the total and says it
is not itemised. The label is not carried to the browser at all.

## 2. The rules the row keeps

- **Bonus total = Tech + Attendance + KPI/Performance + Adjustment**, which is `payment-dispatch.md` §4.2.3's
  Bonus Total and the statement's own `bonuses_total` (checked on gyd@'s 07-26 and 08-23 weeks).
- **A negative Adjustment is always shown**, in rose with a minus sign. Nothing is gated on `> 0`,
  because hiding a withholding is what `payment-dispatch.md:644` forbids.
- **A ₱0 bonus is only printed where a statement computed it** (*"No bonuses this week"*). A week
  without a statement says the bonus is not on record, because a ₱0 there would be a claim
  nobody made.
- **Two records of one payment that disagree are both named.** When the statement's Net pay and
  the paid dispatch total differ by more than a cent, the row prints both. Silently preferring
  either one would publish a figure nobody can trace.
- **Weeks join on their START DATE, never on the filename.** One week arrives under several files
  (`api_sync` vs `daily_report`, `" 4.csv"` re-uploads).
- **Hours** come from the record, else from the statement (`mfHours + mfOtHours`).
- **Status** is `paid` once a paid dispatch or the record says so, else the record's own status.
  Known inherited defect: the 2026-06-21…07-05 records read `pending` for weeks that were paid
  (`diagnostics-performance-tabs.md`), and those weeks predate the dispatch log.

## 3. The window

The newest **30** weekly records bound the list, as before. A statement or paid dispatch for a
week with no record is added only when it is **newer than the oldest record shown**. This covers the
newest cycle, which is dispatched before its record is seeded, without growing a tail the records
cut. Paged 5 per page with the true total.

Coverage measured 2026-09-28: statements from about **2026-07-05**, the dispatch log from about
**2026-05-24**, records from **2026-03-01**. Weeks before the dispatch log can only show hourly pay.
That is a limit of what was recorded, not something this tab can repair.

## 4. The Statement view

A statement row has a **Statement** button that opens the full statement (`PayStubStatement`, the
renderer the worker's own modal and the emailed copy use) over the figures already fetched. There is
no second read. It does **not** open `PayStubModal`: that modal reads `/api/accounting/paystub`,
which is gated on the `accounting.payment_dispatch` feature grant. That grant defaults to **hidden**
(`feature-permissions.ts`), so the CEO, who sees People, would get a 403.

## 5. Reads, gate, and failure

`GET /api/people/[email]/payroll`, gated by `requireRateVisibilitySession` (admin / accounting /
ceo), the same as the rest of People. It makes four reads in parallel: the weekly records (alias-aware, as
before), the person's staged statements, their dispatch log (paged past 1,000), and the COP decorator.
It makes two more only when an unpaid statement exists: that week's snapshot and the catalog rate
claims that gate the merge. Measured end to end: **1.3–2.4 s** for three real people.

**Every read fails closed.** A failed statement or dispatch read answers 500 with the reason, and
the tab shows it as an error. It never shows the hourly-only list, because that list presented as
"the pay history" is the defect this exists to fix. The popup used to show *"No payroll records
yet."* when its fetch failed. A failed read is now an error in both hosts.

**It is fetched on the Payroll tab's first visit**, not with the banking read. The pay history
used to ride on `GET /api/people/[email]`, and the popup, the Search Bar and the Payroll Wizard's
preview all wait on that route. It was moved out on 2026-09-28 so the audited banking flow never
waits on statement assembly. The host holds the result and the page index, so a tab switch never
re-reads.

## Deploy notes

**No migration**, no env vars, no n8n import. `GET /api/people/[email]` no longer returns
`history`. Its only readers were this tab and nothing else: the Search Bar and the Payroll Wizard read
`banking` only.
