# Gift Tracker — the tenure-gift fulfilment ledger

**HRIS is the ledger of record for who has and has not received a tenure gift, as
of 2026-09-11.** Before today it was not, and could not be: the only lifecycle on
`employee_gift_shipping_details` is *address review*, and `Approve` there has
never meant "gifted". The answer lived in a Google Sheet.

Shipped 2026-09-11 on Kane's ruling (brief options 1(b) · 2(b) · 3(a)).

## The question this exists to answer

> *"We need to get caught up on who has and hasn't received a gift so that the HR
> is correct."* — Carla, 2026-09-09

That question had **no column to read**. The Gift Tracker computed who was *due*
a gift from tenure arithmetic and stopped there; nobody had any affordance in
HRIS to record "I shipped this", so the tracker looked stale no matter how hard
the person maintaining the sheet was chased.

## Key files

| Piece | File |
| --- | --- |
| Migration | `references/sql/migrate/2026-09-11_gift_receipts.sql` |
| Migration runner | `scripts/apply-gift-receipts-migration.mts` |
| Sheet backfill | `scripts/backfill-gift-receipts.mts` |
| Submissions wipe | `scripts/drop-gift-shipping-submissions.mts` |
| State logic (shared) | `src/lib/gift-tracker/receipts.ts` + `receipts.test.ts` |
| Sheet parser | `src/lib/gift-tracker/receipt-import.ts` + `receipt-import.test.ts` |
| Data access | `src/lib/supabase/employee-gift-receipts.ts` |
| Route | `app/api/employee-gift-receipts/route.ts` |
| UI | `src/components/orphanage/GiftTracker.tsx` |
| Export columns | `src/lib/gift-tracker/shipping-export.ts` |

## A row is an assertion. No row means UNKNOWN.

This is the whole invariant, and every reader has to honour it.

| State | What it means | How it is stored |
| --- | --- | --- |
| `received` | Somebody stated the gift was given | row, `received = true` |
| `owed` | The milestone has come due **and** somebody stated it was not given | row, `received = false` |
| `not_due` | The milestone has not arrived | no row needed — derived |
| `unknown` | Nobody has stated anything about a milestone that HAS come due | **no row** |

`unknown` is load-bearing. **239 people on the active roster were absent from the
source sheet entirely.** Reading their absence as "not received" invents a
239-person backlog; reading it as "received" hides a real one. Neither is true,
so `GiftReceiptState` refuses to say either, and the UI labels it *Not recorded*
in neutral grey — never amber, which would read as a milder shade of owed rather
than as a different question.

`received` is `BOOLEAN NOT NULL` in the database for the same reason: if the
column were nullable, "nobody said" would be representable *both* as a row and as
an absence, and the two would immediately drift apart.

**Owed and not-recorded are never summed.** The roster cell, the stat tiles and
the export all carry them as separate counts, because one is a debt the company
knows about and the other is a question nobody has answered.

## The key is `work_email`, and that is not cosmetic

`employee_gift_shipping_details` is `UNIQUE (personal_email, milestone_index)`.
On the live roster **`personal_email` is not injective**:

- `russell@simple.biz` and `johnc@simple.biz` both carry `corpuzmachacon@gmail.com`;
- `greyg@simple.biz` has no personal email at all.

Putting fulfilment on the submissions table would have merged two people's gift
history into one row and given a third person nowhere to live. Work email is
unique across all 1,229 sheet rows and across the master list, and it is the
column the source file keys on. So fulfilment lives in **its own table**, keyed on
work email, joined to the roster the way `gift_tracker_notes` is.

`shipping-export.test.ts` pins this: a receipt keyed on someone's *personal*
email does not count, and two people sharing one personal email keep separate
histories.

## Due-ness has exactly one implementation

`isMilestoneDue` in `src/lib/gift-tracker/receipts.ts`, over `addMonths` /
`diffDays` from `gift-milestones.ts`. The importer, the route, the roster and the
export all call it. An imported `owed` and a displayed `owed` therefore cannot
diverge.

`milestoneLabel` moved **into `gift-milestones.ts`** in this change — it had been
living only in `shipping-export.ts`, and the ledger needed it too. The export
keeps a thin wrapper that owns the `None yet` display case and delegates for the
rest. Two spellings of "12-month" was not a risk worth taking.

`source_milestone_date` on the table records what the *sheet* claimed, as
evidence. It is named `source_*` precisely so it can never be mistaken for a
second date rule. **Which milestone is due is always recomputed.**

## The 2026-09-11 backfill

Source: `references/docs/Work Anniversary Gift Tracker - Copy of HRIS Active Ppl.csv`
(1,229 people × 8 milestone columns = 9,832 cells).

| | |
| --- | --- |
| Rows written | **1,434** |
| … recorded received | 842 |
| … recorded owed | **592** ← the backlog, first time it has ever been countable |
| Cells deliberately skipped | 8,398 |

### Why 8,398 cells were skipped

They are `No` against a milestone **years in the future**. That is the
spreadsheet's default fill, not a statement anybody made. Importing them would
have put almost the whole company on the owed list and made the number
meaningless.

The rule, enforced in `selectAssertions` and unit-tested:

- **`Yes` always imports** — a stated receipt is a fact whether or not the
  milestone has arrived. One cell in the file is exactly that
  (`rhysl@simple.biz`, 12-month, dated 2027-01-05); it imports and is flagged
  *Recorded early* rather than dropped.
- **`No` imports only when the milestone has already come due.**
- **Anything else imports nothing**, and is reported.

### Who resolved to what

| | |
| --- | --- |
| On the active roster | 1,121 |
| Offboarded (in `global_master_list`, not `active_employees`) | 95 |
| No master row at all | 13 |

**Off-roster people are imported, not dropped.** A person who left owed a gift is
exactly the blind spot this feature exists to close, and it mirrors the export's
standing rule that off-roster submitters are appended flagged. The 13 with no
master row have no authoritative start date, so only their `Yes` cells can be
judged — the report names each one rather than resolving it silently.

### Data defects carried forward, not silently fixed

- **Start-date divergence (2):** `masa@` sheet 2026-08-02 vs master 2026-09-07;
  `jant@` sheet 2026-08-09 vs master 2026-03-23. **The master list wins** — it
  owns `start_date`. Both are reported every run.
- **Gift-date divergence (3 cells):** the sheet says Mar 30 where HRIS says
  Mar 31 (month-end rollover on a Sep 30 start). HRIS math wins; the sheet's date
  is kept in `source_milestone_date`.
- **One early receipt** and **7 people with a `Yes` after a `No`** — imported as
  stated and reported. The importer does not straighten out somebody else's
  bookkeeping.

## Recording fulfilment from the app

Gift Tracker → Roster → expand a person. Each reached milestone carries
**Received · Not yet · Clear**.

Three buttons, not a two-state toggle, because there are three statements.
"Clear" withdraws the assertion and returns the milestone to `unknown` — *"we
should not have said anything"* and *"they did not get it"* are different claims,
and only the second one puts a named person on the owed list. Collapsing the
third into the absence of the other two would leave no way to undo a mistake
without asserting its opposite.

The local map updates **only after the server accepts the write**. An optimistic
flip would show a gift as delivered on a failed request, on the very screen HR
reads to decide whether to ship one.

## The employee's own view — and the label that was lying

`src/components/employee/GiftShippingCard.tsx` → **History** tab.

The timeline already printed a green **"Received"** chip. It meant
`status === 'approved'` on `employee_gift_shipping_details` — **the address was
confirmed**, which the code beside it says explicitly does not mean gifted. A
person whose address was locked in was told their gift had arrived.

Fixed 2026-09-11, and the two facts are now drawn apart everywhere on that
timeline:

| Chip | Source | Means |
| --- | --- | --- |
| **Address confirmed** (sky) | `employee_gift_shipping_details.status = 'approved'` | we have your delivery details locked in |
| **Gift received** (emerald) | `employee_gift_receipts.received = true` | it actually reached you |
| **Gift on the way** (amber) | `received = false` on a due milestone | we owe you this one |
| *(nothing)* | no receipt row | nobody has recorded it yet |

The node, the connector line and the heading colour all follow **fulfilment**
now; an approved address is sky, a step rather than an end. A milestone nobody
has recorded renders **no fulfilment chip at all** — silence is honest, and a
grey "not received" would not be.

The card reads `GET /api/employee-gift-receipts?work_email=…`, gated
self-or-staff by the same predicate `employee-gift-shipping` uses, so the two
gift surfaces cannot drift apart on who sees what. **The employee can never
write** — declaring your own gift received is a statement about the company's
obligation to you, so `PUT` and `DELETE` stay on `requireFeatureEdit`.

A failed receipts fetch is **deliberately silent**: the timeline still renders
and every milestone simply reads as unrecorded. It must never fail closed into
"not received", so the fallback is an empty map, never a map of falses.

**The shipping form's gate is untouched.** It still opens on pure tenure
arithmetic suppressed by an existing submission row. Wiring it to fulfilment
needs a ruling first — the export's `Current Milestone` and the employee's own
form must never disagree.

## Authorization and audit

`route-access.ts` gates pages, not APIs, so this route enforces its own:
`view` on `(hr, gift_tracker)` to read, `edit` for every write.

**The actor is the session, never the body** — `recorded_by` comes from the
resolved `AuthzOk`. Six gift/orphanage routes previously read an actor off the
request body, which is a forged identity.

`recorded_by` is `NOT NULL` with a non-blank CHECK. The PAB-exclusion table
shipped without an author column and 107 person-months are permanently
unattributable as a result; that is not being repeated here.

Audit family `gift_receipt.` (registered in `src/lib/audit/registry.ts`):

| Action | When |
| --- | --- |
| `gift_receipt.recorded` | a staff member states a gift was / was not given |
| `gift_receipt.withdrawn` | an assertion is removed — **details carry the deleted row**, because nothing else records it was ever made |
| `gift_receipt.imported` | the sheet backfill |

It is deliberately separate from `employee_gift_shipping.*`, which is address
review and still does not mean "gifted".

## The submissions were dropped

43 rows (42 pending, 1 approved) were deleted on the same day, per Kane's ruling
— the tracker starts fresh. `scripts/drop-gift-shipping-submissions.mts` writes
every row to disk **and reads the file back to verify it** before deleting
anything, then writes the full snapshot into `audit_log`
(`employee_gift_shipping.period_cleared`) *before* the delete, because the trail
write needs the rows while they still exist. A failed backup or a failed audit
write aborts.

What that cost, stated plainly: every export row now falls back to the
master-list home address (`Address Source` reads `Master list`, never
`Submitted`), off-roster submitters vanish from the appended block until people
submit again, and the one approved row's lock is gone. **No fulfilment was lost**
— it lives in a different table, which is the reason the delete was survivable.

Backup: `reports/gift-shipping-submissions-backup-*.json`.

## Deploy order

1. `node --import tsx scripts/apply-gift-receipts-migration.mts` — rehearses and rolls back.
2. Same with `--apply`.
3. `node --import tsx scripts/backfill-gift-receipts.mts` — report only.
4. Same with `--apply`.
5. `node --import tsx scripts/drop-gift-shipping-submissions.mts --apply`.
6. Deploy the code.

**The migration SQL carries no `BEGIN`/`COMMIT`.** The apply script owns the
transaction; a `COMMIT` inside the file ends it from within, so the rehearsal
commits to production and the script's own `ROLLBACK` has nothing left to undo.
This was found the hard way on 2026-09-11 — the first "dry run" created the table
for real. Every sibling migration under `references/sql/migrate/` omits them for
the same reason. The rollback is now proven: the table is absent after a dry run.

## What is still open

- **The employee shipping form has no idea about fulfilment.** Its milestone gate
  is still pure tenure arithmetic suppressed by the existence of a submission
  row. Wiring it to receipts needs a decision first — the export's
  `Current Milestone` and the employee's own form must never disagree.
- **A missed milestone still has no ask path.** Only the latest milestone is ever
  asked for; earlier ones freeze read-only. A catch-up needing an old address
  cannot use the form, so the 592 owed gifts have no address-collection route.
- **No delegated grant.** Every write needs `hr / gift_tracker` edit; there is no
  documented grant for the people helping with the catch-up.

Sibling: [gift-tracker-shipping-export.md](gift-tracker-shipping-export.md) — the
roster export, which now carries the fulfilment columns.
