# Payment Catalog → Pay Processors → Current Banks — the receiving banks, folded to their official names

An inner tab beside **Processors** ([payment-catalog-pay-processors.md](./payment-catalog-pay-processors.md))
listing every bank our payees actually gave us, folded from 129 free-text spellings to
one card per bank, with how many people are paid into it and a logo Accounting attaches
here. Built for Kane, 2026-09-03: *"all the workers that we pay in Payment Dispatch only
get unique banks like GoTyme and all that, one of each only"*, normalized to the
**official** name, showing **only the bank name**.

Shipped 2026-09-03 (commit in `git log -- src/lib/payment-catalog/banks.ts`).

## Key files

| Piece | File |
| --- | --- |
| Spelling key, official-bank table, fold, validation (client-safe) | `src/lib/payment-catalog/banks.ts` (+ `banks.test.ts`) |
| Storage — `app_settings` JSON behind compare-and-swap | `src/lib/payment-catalog/banks-db.ts` |
| API — GET folded list · POST/PATCH registry | `app/api/payment-catalog/banks/route.ts` |
| Tab UI — inner tablist, bank cards, logo dialog | `src/components/accounting/PayProcessorsTab.tsx` |
| Host — fetch, realtime filter | `src/components/accounting/BonusCatalog.tsx` |
| READ-ONLY audit of the live spellings | `scripts/audit-bank-spellings.mts` |
| Logo fetcher (dry run unless `--apply`) | `scripts/fetch-bank-logos.mts` |
| PNG decoder + white-plate legibility | `src/lib/images/decode-png.ts` |
| Shipped brand logos + provenance | `public/banks/*.png` · `public/banks/SOURCES.json` |

## 1. Why this surface exists at all

[bank-preferred-routing.md](./bank-preferred-routing.md) §10.1 **removed** bank names from
the People bank-changes KPI band and forbade putting them back, because
`employee_ids.bank_name` is free text. That ruling ends with the sentence this tab is
built on: *"If a bank-level view is wanted later it belongs on its own surface, after the
column is normalized."*

**This is that surface, and the §10.1 ban still stands where it was made.** Nothing here
feeds the People band, Payment Dispatch, or any rail calculation. A bank is still not the
unit anyone pays on — the rail is.

## 2. The normalization is DECLARED, never inferred

Measured on the live table 2026-09-03: **129 distinct spellings across 1,995 rows** — 17
ways of writing BPI, 17 of GoTyme, 20 of BDO. Two mechanisms fold them, in this order:

1. **`bankSpellingKey()` — a modest key.** Case, punctuation, `&` vs `and`, whitespace,
   and a **trailing** corporate suffix (Inc / Corp / Company / Ltd). It does **not** drop
   "Bank", country words, or branch names. `BDO Unibank, Inc.` and `Bdo Unibank Inc`
   collapse; `China Bank` and `China Bank Savings` do not.
2. **`OFFICIAL_BANKS` — an explicit table.** Every alias in it is a spelling that
   **actually exists in the data**, taken from the audit script. None is speculative.

A spelling neither claims stays its **own card**, marked *Unmapped*. **That is the correct
outcome, not a gap to close.** "Rizal Bank" (2 people) could be RCBC or Rizal Microbank;
guessing is exactly the invented equivalence §10.1 forbids. 10 spellings are unmapped
today and every one is deliberate.

### 2.1 Subsidiaries are not their parents

**BDO Network Bank ≠ BDO Unibank. China Bank Savings ≠ China Banking Corporation.
EastWest Rural Bank ≠ EastWest Bank. BPI Direct BanKo ≠ BPI. UnionDigital ≠ UnionBank.**
Each is a separately licensed institution with its own clearing details, so merging them
would tell Accounting money is somewhere it is not. `banks.test.ts` pins all five apart.
MariBank and SeaBank are likewise kept apart; if they are one entity, that is a merge
Accounting makes in the UI, on the record.

### 2.2 Nothing is written to `employee_ids`

The free-text column keeps all 129 spellings exactly as people typed them. This tab
decides only what to **display**. Rewriting the column would be a separate Node script
with an `--apply` gate and a SELECT backup first — and the registry's alias lists are
precisely the mapping such a script would consume.

## 3. Counting

- **Slot-aware.** A bank counts as **paid here** only when it sits on the slot the person
  is actually paid into (`preferred_bank_slot`); otherwise it counts as *on their other
  account*. Reading `bank_name` alone would credit a bank the money does not go to — the
  same bug class as the roster export's account column.
- **The same bank in both slots counts once**, compared on the **group**, not the
  spelling, or someone with `BPI` in one slot and `Bank of the Philippine Islands` in the
  other is counted twice on one card.
- The population is every `employee_ids` row with a bank on file — the Payment Dispatch
  payee set, leavers included. Orphanage workers, interns and vendors keep bank names in
  their own tables and are **not** here.

## 4. A person's name is not a bank

Eight rows have the account holder's name where the bank belongs. `looksLikePersonName`
flags them with a **Check this** chip: two to six words, none bank-ish, no digits.
Conservative on purpose — a single word ("FAIRWINDS", "Truist") is never flagged, and any
token containing *bank* / *banco* / *bangko* rules it out, so `Maybank Philippines` reads
as a bank.

**They are shown, not hidden.** On a surface claiming to list every bank on file, **a
filter never hides a row** — the same rule `dept-rail.ts` follows. Fix them on the
person's profile; this tab has no write path to anyone's bank details.

## 5. The response carries banks, never people

`employee_ids` also holds account numbers, SWIFT codes, routing numbers, addresses and
wallet emails. The route projects **three columns** (`bank_name`, `alt_bank_name`,
`preferred_bank_slot`) into the fold and returns **groups with counts** — no per-person
row exists in the payload at all. The projection is written out explicitly so a column
added to `EmployeeIdRow` later cannot start riding along, and `banks.test.ts` asserts the
group shape holds no account-shaped field. Kane asked for "only the bank name".

`getEmployeeIds()` pages past the PostgREST 1000-row cap — at 1,995 rows a bare select
would silently drop half the banks.

## 6. The registry

One `app_settings` row, `payment_catalog.banks.registry`, holding per-bank display name,
extra aliases, kind (bank/wallet), logo and notes. Same rules as the processors registry
beside it: **read THROWS on failure** (a transient error must never read as "no logos
yet", or the next save wipes every mapping), **compare-and-swap writes** with retry, and
**no deletion**. A save for a bank nobody banks with is refused — it would be unreachable.

Logos reuse the processor validator and plate: PNG/SVG/WebP/JPEG, ≤150 KB, inline data
URL, rendered only through `<img src>`. One `LogoField` component serves both dialogs, so
the client checks cannot drift from the server's.

## 7. The shipped brand logos

23 banks ship a real logo in **`public/banks/<key>.png`**, declared in `BANK_LOGO_SRC`
and served by `foldBankSpellings` when no saved logo overrides it. A bank absent from
that map shows a **monogram tile** — a normal outcome, not a gap.

`scripts/fetch-bank-logos.mts` fetches them from Wikimedia
(`Special:FilePath/<File>?width=480`, which resolves both English-Wikipedia-local and
Commons files and renders an SVG original to PNG). It is a dry run unless given
`--apply`, and it writes provenance to `public/banks/SOURCES.json` — a logo whose source
is not recorded cannot be re-fetched or re-checked.

Two rules govern that script, and both exist because the failure they prevent is silent:

1. **Every source is DECLARED, never searched.** A Commons search for "Security Bank
   logo" returns Bank of America's; a search for "Maribank" returns its parent Sea
   Group's. A wrong-bank logo is worse than none — it is a confident lie on a screen
   Accounting uses to reason about payouts. **MariBank (100 people, the third-biggest
   bank) deliberately has no logo** for exactly this reason, as do Metrobank, Security
   Bank, SeaBank and the small US rails.
2. **Every download is measured before it is written.** `ProcessorLogo` falls back to a
   monogram on a LOAD error but not on an INVISIBLE one, and the plate is `bg-white` in
   both themes, so white-inked artwork renders as an empty box nothing reports.
   `isLegibleOnWhite` (`src/lib/images/decode-png.ts`) rejects near-white ink, slivers
   and transparent files. **If a logo fails, replace the artwork — never relax the
   threshold.** `banks.test.ts` re-runs that same measurement over every shipped file,
   plus a case-exact existence check (Windows resolves the wrong case; Linux does not).

The decoder is dependency-free (node's own `zlib`; `sharp` is only a transitive Next
package) and handles 8-bit greyscale / RGB / **palette** / RGBA. Palette support is
load-bearing, not a nicety: Wikimedia renders Wise, Maya and Chinabank to palette PNGs,
and without it three real logos would have been dropped for a decoder limitation rather
than anything wrong with the artwork. `processor-logo-assets.test.ts` uses the same
module, so the processors' Kolan check and the banks' cannot drift.

**Bank logos and processor logos are separate asset lists.** `validateBankLogo` passes
`ALLOWED_BANK_PUBLIC_LOGO_SRCS`; the processor validator keeps its own default. A bank
row cannot reference `/Kolan.png`, and a processor row cannot reference `/banks/bpi.png`.

**Access.** GET is `requireRateVisibilitySession`; POST/PATCH is
`requireFeatureEdit('accounting','bonus_catalog')`. Writes audit `bank.create` /
`bank.update` on `payment_catalog_banks`.

## Deploy notes

**No migration.** No env vars, no n8n, no storage bucket. The `app_settings` row is
created on the first save. Re-run `node --import tsx scripts/audit-bank-spellings.mts`
after editing `OFFICIAL_BANKS`, and before assuming a spelling is covered. To add or
refresh a logo: put the exact Wikimedia `File:` name in `SOURCES` in
`scripts/fetch-bank-logos.mts`, run it **without** `--apply` to see the measurement,
then with `--apply`, and add the path to `BANK_LOGO_SRC`.
