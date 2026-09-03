# Payment Catalog → Pay Processors → "Current Banks" inner tab

**Date:** 2026-09-03 · **Approved:** Kane, same day.
Answers to the brief: **Q1** population = the workers we pay in Payment Dispatch
(`employee_ids`), **one card per unique bank** — "only get unique banks like GoTyme and
all that, one of each only" · **Q2** count every row with a bank on file · **Q3**
**normalize to the OFFICIAL bank name — "then that's what we will be using"** · **Q4**
the card shows **only the bank name**, no people list.

An inner tab beside Processors listing every receiving bank our payees actually banked
with, folded to its official name, with a headcount and a logo Accounting attaches here.

`bank-preferred-routing.md` §10.1 killed bank names on the People KPI band and said a
bank-level view "belongs on its own surface, after the column is normalized". **This is
that surface.** The `employee_ids.bank_name` column is NOT written here — the normalization
is a declared alias map in the registry, which a later `--apply` script can consume.

Precedent: the Pay Processors registry shipped hours ago — same `app_settings` JSON, same
compare-and-swap writes, same logo validator and plate. Read side copies
`app/api/people/route.ts` → `getEmployeeIds()` under `requireRateVisibilitySession`.

## Tasks

- [x] Plan doc (this file)
- [x] 0. `scripts/audit-bank-spellings.mts` — READ-ONLY: every distinct `bank_name` /
      `alt_bank_name` spelling with counts, and what the fold does to each. Run it BEFORE
      writing the alias table so no equivalence is invented, and keep it as the verifier
      that the table still covers the live data.
- [x] 1. `src/lib/payment-catalog/banks.ts` — `bankSpellingKey()` (case/punctuation/
      whitespace fold only), `OFFICIAL_BANKS` (declared official name + alias keys, built
      from the audit output — never fuzzy), `officialBankFor(spelling)`,
      `foldBankSpellings(rows)` → one group per official bank with preferred/alt counts and
      the raw spellings it absorbed, `mergeBanksOverRegistry`, `validateBankInput`,
      `applyBankPatch`. `banks.test.ts` beside it.
- [x] 2. `src/lib/payment-catalog/banks-db.ts` — `app_settings` key
      `payment_catalog.banks.registry`; sanitize, THROW on failed read, CAS write + retry.
- [x] 3. `app/api/payment-catalog/banks/route.ts` — GET (`requireRateVisibilitySession`)
      folds `getEmployeeIds()` projecting ONLY `bank_name` / `alt_bank_name` /
      `preferred_bank_slot`; POST/PATCH (`requireFeatureEdit('accounting','bonus_catalog')`),
      audited `bank.create` / `bank.update`.
- [x] 4. `src/components/accounting/PayProcessorsTab.tsx` — inner tablist
      (Processors | Current Banks), bank cards, logo dialog reusing the processor validator.
- [x] 5. `src/components/accounting/BonusCatalog.tsx` — fetch, one-key realtime, pass down.
- [x] 6. `npm test` + `npx tsc --noEmit` (dev server live — no `next build`).
- [x] 7. Docs: `docs/features/payment-catalog-current-banks.md`, INDEX row, memory
      `payment-catalog-current-banks` + MEMORY.md pointer. One commit, staged by path.
