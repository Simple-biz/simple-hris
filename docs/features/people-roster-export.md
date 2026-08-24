# People → Roster: the Export menu (PDF / XLSX / CSV)

The **Export** dropdown in the People tab's toolbar, next to the department
filter and search. Downloads **the roster currently in view** — the active
search, department filter, OT-only toggle and the selected pay week or custom
date range all apply — in three formats.

Module: [`src/lib/people/people-roster-export.ts`](../../src/lib/people/people-roster-export.ts).
UI: the `ExportMenu` component inside
[`PeopleTab.tsx`](../../src/components/people/PeopleTab.tsx). Modelled on the
sibling [`hr-global-master-list-export.md`](./hr-global-master-list-export.md),
and the source that `transfers-export.ts` was in turn modelled on.

Fully **client-side** — the rows are already loaded in the tab, so there is no
server round-trip and no second query that could disagree with the screen.

- **CSV** — UTF-8 BOM (so Excel renders `₱`) + RFC-4180 escaping, behind a short
  provenance preamble (period, filter, export timestamp, scope counts).
- **XLSX** — SheetJS. Title/summary banner rows, per-column widths, an
  autofilter over the header, hours kept numeric. The community build emits no
  cell fills or font colours, so the sheet's "theme" is structural only.
- **PDF** — built from scratch with pdf-lib (no template read at runtime, so it
  deploys cleanly on Vercel), themed to the **CEO dashboard**: warm orange→rose
  gradient, amber accents. Ten columns on portrait US Letter.

## The three artifacts share ONE column list — except the PDF

CSV and XLSX are both generated from `FLAT_COLUMNS`, so a column added to one is
in the other by construction. Each entry carries **its own Excel width**; there
is deliberately no parallel width array, because a missing entry there shifts
every later column's width silently.

The PDF has its **own, narrower** set — portrait Letter holds ten columns, not
sixteen — so it drops the emails, currency, OT rate, start date and location. Its
header row is pinned by test, because it is the artifact that can silently lose a
column name (see below).

## The two banking columns (added 2026-08-24, Kane)

| CSV / XLSX header | PDF header | What it is |
|---|---|---|
| `Account No. (last 4)` | `Last 4` | Last four digits of the receiving bank account, masked `···1234` |
| `Bank Info Updated` | `Bank Updated` | When this person's payout details last changed |

### Last 4, and only last 4 — masked on the SERVER

The full account number **never reaches the browser**. `people-roster.ts` masks
it before the row goes on the wire, so the export module receives `···1234` and
has nothing to leak. This follows Kane's 2026-08-12 ruling for the cycle
close-out report (`cycle-close-report-export.ts`) — a payee row carries bank name
plus account last-4 and nothing more. The rule itself was lifted into
[`mask-account.ts`](../../src/lib/payroll/mask-account.ts) — dependency-free, so
sharing it does not pull SheetJS into the `/api/people` server bundle, and
`cycle-close-report-export.ts` re-exports it so its own API and tests are
unchanged. Two masking functions is how two files end up disagreeing about what
"masked" means.

Last-4 is also exactly what the People **Banking** pane shows by default
(`people-banking.ts` `maskNumber`). `/api/people` is gated to
`RATE_VISIBLE_ROLES` (admin / accounting / ceo), the same tier as the Bank
changes feed, so this column adds **no new exposure tier**. The audited
`reveal-banking` endpoint remains the only path to a full number, and the export
never touches it.

### The account shown is the one Payment Dispatch would actually pay

Resolved by **`resolvePreferredAccountNumber`** (in `payout-completeness.ts`,
beside the other dispatch-parity helpers), which is **slot-aware**: when
`preferred_bank_slot = 'alternative'` the alternative account wins, with the same
cross-slot fallback PD's queue row uses. Reading `account_number` directly would
be wrong for the **8 people** on the alternative slot whose alt number differs —
and for two of them it would print nothing at all, since only their alt slot is
filled. That is the drift class the 2026-08-10 People-vs-Dispatch audit closed;
see [`bank-preferred-routing.md`](./bank-preferred-routing.md) and
`scripts/audit-people-vs-dispatch-banks.mjs`.

There is deliberately **no legacy rates-sheet fallback**: Payment Dispatch
backfills wallet *emails* from that row, never account numbers.

**A wallet-rail payee's account is still printed.** Someone routed on Kolan or
HiGlobe can carry a bank account on file that no payment goes to. The column is
named for what it holds — the bank account — and the adjacent **Payout Method**
column is what says where the money goes. Blanking it was considered and
rejected: it would make "no account on file" and "account on file, wallet-routed"
indistinguishable in a file Accounting reconciles against.

Blank (`-`) means no bank account in either slot.

### "Bank Info Updated" comes from `bank_update_history`, not the stamp

`fetchLatestBankChangeAtByEmail()` folds the newest `created_at` per work email
out of `bank_update_history`, and the roster looks it up through the person's
whole **alias set** (the save route keys the row on whichever address it was
given).

That table — not `employee_ids.bank_last_self_updated_at` — because the stamp is
written by only three of the **six** routes that change payout details (it misses
the People-tab admin edit, the Mark Paid override, and the contractor profile),
while all six call `insertBankUpdateHistory`. Measured against production
2026-08-24: all **740** stamped people also have a history row and the stamp is
**never newer** than it, so history is a strict superset — one source, no
coalescing. Live coverage: **933** people carry a date, **825** carry an account.

The read is **paged** (`selectAllPaged`). At 1,334 rows a bare select stops at
PostgREST's 1000-row cap and the tail reads as *"nobody past row 1000 ever
changed their bank"* — a silent wrong answer, not an error.

A failure of that read is **non-fatal but not silent**: the roster still returns
its rows and `/api/people` carries a warning string that the People tab renders
above the table, because an empty map makes every row read "never changed".

Blank (`-`) means no change on record. Seed and repair **scripts** write
`employee_ids` directly without a history row, so a bank set by one of those
(the NPD/PH-freelancer seeds, the clobber restore) shows blank.

## Fixed in the same change: the PDF ate long column headers

`drawHeader` wrapped each header to its column width and then drew **only line
0**, so any header too wide for its column lost the rest with nothing on the page
to indicate it had. `Last 4` first shipped as nothing at all this way. The header
band now renders every wrapped line and grows to the tallest one, and a test pins
every header label as present in the generated PDF.

The PDF column widths are budgeted from **measured** Helvetica 8.5pt metrics —
header and widest realistic value, plus 12pt of cell padding — not from guesses.
Two calls worth keeping:

- **Name keeps the 98pt it had before these columns landed.** The master list
  stores `Cuevas, Mary Rose "Penelope"`-shaped names at 158–168pt, so **76% of
  the roster already wrapped** in that column; paying for the new columns out of
  Name would have taken that to 96% and given the longest tenth a third line. The
  21pt came out of columns that were over-provisioned (`#`, `ID`, `Rate`,
  `Payout`) instead.
- **`Bank Updated` is deliberately wider than its column and wraps to two
  lines** — that costs 11pt once per page in the header band, where buying a
  one-line header would have cost a point off every row. Its *values* still fit
  on one line.

The account column is headed `Last 4` in the PDF (`Acct (last 4)` needs 54.5pt of
a 39pt column) while the CSV and XLSX, which have the room, spell it
`Account No. (last 4)`.

## Tests

[`people-roster-export.test.ts`](../../src/lib/people/people-roster-export.test.ts) —
13 cases. The load-bearing ones:

- no artifact contains a full account number (CSV, XLSX **and** the PDF)
- the CSV and XLSX header rows are the same list in the same order
- every column supplies its own Excel width
- every PDF header renders in full (`Bank Updated` as its two wrapped halves)
- the slot-aware resolver: primary, alternative, cross-slot backfill, and a
  wallet payee resolving to nothing rather than to a guess

The PDF assertions decompress the content streams and decode pdf-lib's hex string
literals first. Grepping the raw bytes passes *any* assertion about text being
absent, which would have quietly neutered the no-leak test.

## Known gap

The **Payout Method** column prints the stored processor id capitalised, so a
Kolan payee reads **"Hurupay"**. Per
[`hurupay-kolan-rebrand`](../../memory/) the old name is correct only on
*historical ledger records*; a live roster snapshot should say **Kolan**
(`PROCESSOR_OPTIONS` already maps `hurupay → 'Kolan'`). Out of scope on
2026-08-24 and left for Kane to call.
