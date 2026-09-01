# People → Offboarded — search any leaver ever, pay them, fix their bank

A fourth mode on the People tab (Accounting AND CEO): a search-first view over the
**whole `offboarded_sheet` ledger** (~4,000 records). Search by name or work email,
see Name / Work Email / Personal Email / Start Date / off date per record, a bank
chip, a **Pay** button that files the existing one-off payment flow, and **Set/Edit
bank** via the shared SetBankDialog. Shipped 2026-09-01, commit `5a7c066b`, with the
companion change that moved one-off payment cards out of Payment Dispatch → Urgent
and into the recipient's **processor bucket**.

Approved brief 2026-09-01 (Kane): Q1 recycled emails = **warn-and-allow** ·
Q2 unrouted one-offs = **fileable, flagged, live under "All pending"** ·
bucket placement applies to **ALL** one-offs (roster-filed too) · CEO sees the tab.

## Key files
| Piece | File |
| --- | --- |
| Pure search + bank folding (tested) | `src/lib/people/offboarded-search.ts` (+`.test.ts`) |
| Search route | `app/api/people/offboarded/route.ts` |
| The tab | `src/components/people/PeopleOffboarded.tsx` (mounted by `PeopleTab.tsx` mode `offboarded`) |
| Shared bank editor | `src/components/accounting/SetBankDialog.tsx` (extracted from `PayrollWizardNotesFab.tsx`) |
| One-off cards in buckets | `src/components/payroll-clerk/OneOffPaymentsSection.tsx` (mounted via `ProcessorQueue`'s `renderExtras`) |
| One-off flag on the dispatch feed | `app/api/urgent-payments/dispatches/route.ts` (`is_one_off`) |

## The ledger row is the identity — never the work email
The search is ROW grain over `offboarded_sheet`: a recycled work email returns
**every** record that ever carried it (`jamesc@` = three different people), keyed by
the ledger row `id`. Start Date **cannot** disambiguate — measured 2026-09-01, only
690/4,045 rows carry one and 330 of the 338 duplicate-email groups have a sibling
without one; the NAME plus off date is what tells the humans apart. Search matches
name + work email only (Kane named those two); personal email displays but does not
match. Matching is server-side, capped at `OFFBOARDED_SEARCH_CAP` (50) with the true
total reported, and a query under 2 characters returns nothing — this is a search
tab, not a browse list.

## Bank status mirrors the Payroll Notes Offboarded tab — and the bank is per EMAIL
`foldBankStatus` reproduces `offboarded-payroll-candidates.ts` semantics exactly:
live `employee_ids` (+ legacy Bank Preferred fallback, the same pair the Urgent
one-off cards prefill from) → `ok`, and only a LIVE-resolved processor may **lock**
SetBankDialog's picker; offboard snapshot (`offboard.snapshot.<work_email>`) only →
`missing_has_snapshot`, whose processor rides `bankPrefill.processor` and pre-selects
WITHOUT locking (a locked picker skips writing `preferred_processor`, leaving the
person unpayable after a "successful" save); neither → `missing` ("No Bank" — the
majority: only 833 of 3,626 offboarded work emails still have a live row, 288 have a
snapshot). **`employee_ids` is one row per work email**, so sibling records on a
recycled email share ONE bank record — editing it edits it for the email, not the
stint. Saves go through `POST /api/update-employee-ids` (the 1:1-rule write path)
with `source: PEOPLE_TAB_SOURCE`; there is no second write path.

## Employee ID: live row wins — EXCEPT on a recycled email
The Employee ID column reads `employee_ids.employee_id` (a dedicated
two-column query, deliberately not added to `fetchPayoutIdsByEmail`'s shared
column list), falling back to the offboard snapshot's frozen copy. **On a row
whose work email now belongs to an ACTIVE person, the live row describes the
CURRENT holder — so the snapshot outranks it there**, and with no snapshot the
cell stays "—" rather than printing the wrong person's ID. Most of the ledger
shows "—" honestly: the majority of leavers have neither a surviving row nor a
snapshot.

## The tab's console treatment (2026-09-01, "futuristic — only this tab")
Scoped entirely to `PeopleOffboarded.tsx`: a mono status readout walks flavored
phase messages while a query is in flight ("Looking back through the offboarded
ledger…" → … → "Pulling up Employee IDs and bank details…" — roughly the
route's real stages, holding on the last line, never looping), a scan line runs
under the search field, and result rows stagger in. All motion sits on the
People tab's own accent (no new palette), works in both themes, and is disabled
under `prefers-reduced-motion` (the readout text remains). **The 300ms search
debounce is armed only inside the input's `onChange`** — never in an effect —
so a mount/remount can never fire a query; Enter searches immediately.

## Recycled work emails: WARN AND ALLOW, never block
305 offboarded work emails belong to someone on the ACTIVE roster today. For those
rows the route returns `activeHolder` (resolved live per search — never stored), and
an amber `ActiveHolderWarning` names the current holder on the row, inside PayDialog,
and inside SetBankDialog. It never blocks (Kane's call): a Pay filed on that email
prefills the current holder's payout details at dispatch, and a bank edit writes to
the record dispatch reads for them — the warning is what makes that a decision
instead of an accident. The active-roster read failing fails the SEARCH (500), never
silently drops the warning. Rows with no work email get a disabled Pay
(`/api/people/pay` requires `work_email`); Set bank falls back to the personal email
key like the FAB's dialog always has.

## One-off payments live in the PROCESSOR buckets now — but only the CARDS moved
Kane 2026-09-01: a filed one-off no longer queues under Urgent; its pending card
renders inside the bucket of the recipient's **server-resolved** rail (per-card
processor override still drives what Send records, but never bucket membership — a
card must not teleport between tabs mid-action). Unrouted recipients appear under
"All pending" only, flagged "No bank — set bank details". Dispatched one-offs render
as a flagged strip above the bucket's log views. MESA + orphanage budgets stay under
Urgent, and `UrgentPaymentsQueue` filters `is_one_off` rows out of its log so a
payment never shows in two places.

**What did NOT move — the invariants that look like bugs but aren't:**
- **The dispatch record keeps `cycle_id=NULL` + `cycle_source_file=urgent_<week>`.**
  Writing the weekly cycle's file name would count one-offs into the cycle close-out
  tally, break the sent/paid CSV identity tests (`Regular+OT + Bonus Total + … =
  Amount` has no meaning for a one-off), and collide with the paystub export's
  one-row-per-week dedupe. Placement is UI-only. `urgent-cycle.ts` stays the single
  source of truth.
- **One-off cards are NOT `QueueRow`s.** Merging them into `ProcessorQueue.rows`
  would leak them into the pending CSV export. They mount via the `renderExtras`
  render prop instead.
- **Dispatched one-offs are NOT in `paidRecords` / `PaidRecordsPanel`.** That
  panel's Undo (single and bulk) deletes the `payment_dispatches` row directly,
  which for a one-off strands the source request stamped dispatched-forever. One-off
  Undo goes through `POST /api/urgent-payments/dispatches/undo`
  (revive-before-delete) from its own card.
- **The weekly "Urgent · <week>" report buckets are unchanged** — `is_one_off` is a
  display split on one shared feed (`loadUrgentDispatchRows`), matched via the
  `urgent_payment_requests.dispatch_id` breadcrumb; a failed match degrades to
  `false` and the row shows under Urgent (the pre-split home), never vanishes.
- **PayrollDispatch's cycle progress / confetti math is untouched** — one-off rows
  never enter the `paid` state, only the display prop.

## Deploy notes
No migration. No new tables, no new notification types, no n8n changes. The n8n
import for slug `urgent_payment_notify` (urgent-payments.md) is still its own
outstanding step, unrelated to this change.
