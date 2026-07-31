# Accounting Overview — "Total Payout" = the full pay run

> **Status:** Shipped 2026-07-30 (`6907393` → hardened by `640e3af`). No migration.
> Supersedes the salary-only hero that had been in place since the Overview was built.

The Accounting Overview hero stat **Total payout** used to be *initial pay only* —
`Σ hours × rate` over the cycle, plus the hero's own PAB accrual. Everything the
Payroll Wizard's accounting layer adds (KPI/catalog bonuses, the Notes Adjustment,
orphanage pay, MESA, urgent one-offs) was invisible, so the hero trailed the wizard's
**Total Weekly Outflow** by ~₱2.6M on a live cycle. It now shows the whole pay run.

```
Total payout = salary (hours × rate)
             + PAB accrual            (hero-side, unchanged — see "Why PAB stays out")
             + extrasTotalPhp         (new — /api/accounting/payout-extras)
```

`extrasTotalPhp` = `tech + otherBonuses + adjustment + mesaDisbursement + orphanage
− mesaDeduction + urgentPaid`.

The subtitle switches to **"Full pay run — salary + bonuses + adjustments"** and a
compact breakdown line reads e.g.
`incl. ₱1.63M bonuses · ₱141K adjustments · ₱807K orphanage · −₱22K MESA · ₱5K urgent`.

Applies to **all three surfaces**: the SimpleView hero, the expanded KPI tile, and the
**published snapshot the CEO board mirrors**.

---

## 1 · Where the numbers come from

**File:** [`src/lib/payroll/payout-extras.ts`](../../src/lib/payroll/payout-extras.ts)
· **Route:** `GET /api/accounting/payout-extras?source_file=<csv>` (`requireRateVisibilitySession`
— admin / accounting / ceo; 400 on a missing or `__all__` source file).

The extras are **payroll's own numbers**, not a parallel calculation — that is the whole
design rule. Per-person precedence deliberately mirrors Payment Dispatch's
`paystub-fresh.ts` (minus its per-person rate-validity gates, which need Payment Catalog
claims and are overkill for a dashboard aggregate):

| Order | Source | Notes |
|---|---|---|
| 1 | the staged row in `paystub_dispatch_queue` (the lock) | the figures Dispatch pays from |
| 2 | overlaid by `app_settings` → `payroll.wizard.final_pay.<sourceFile>` | only when the snapshot is **newer than the row's lock** *and* carries the itemized bonus fields (snapshots written before 2026-07-18 don't) |
| 3 | before any lock exists — the snapshot alone | entries deduped by their **`workEmail`** identity; the finals map keys the SAME entry under work *and* personal email |
| 4 | neither → all zeros, `provenance: 'none'` | the hero renders plain salary exactly as it did before this module existed |

Because of step 2 the hero **moves with the wizard in near-real-time** (15s server-side
cache + the Overview's existing 30s poll), instead of only after a lock.

- **Excluded ("do-not-pay") rows count only once a paid employee dispatch exists** for
  them this cycle — the Excluded tab's "Pay now" settles them from their staged amounts,
  mirroring `listExcludedArrears`. They are never snapshot-merged.
- **Urgent money** = `Σ amount_php` of **paid** urgent dispatches in `urgentWeek` — the
  `urgent_<sun>_to_<sat>` bucket of the week **after** the CSV week, i.e. the week the
  cycle is actually dispatched in. Null when the filename has no parseable period end.
- `provenance` is `'wizard'` (the live snapshot won for ≥1 person) / `'staged'`
  (lock-time figures only) / `'none'`, and is surfaced in the UI so a reader can tell
  how fresh the figure is.

### Why PAB stays out of `extrasTotalPhp`

The hero already accrues PAB itself (`pabMetrics`) once the period closes, and the
**staged** PAB is only non-zero on the final PAB week — adding both would double-count
it. The staged PAB sum is still reported in `components.pabPhp` for transparency, and
`Overview.tsx` adds `pabBonusTotal` separately.

---

## 2 · Hardening rules baked in (from the 2026-07-30 adversarial review)

Ten confirmed findings were fixed before this shipped. Each is now a rule worth keeping:

1. **The CEO snapshot must not publish a salary-only total.** Publishing used to race
   the extras fetch and could overwrite the board with the deflated figure in the ~1s
   before extras loaded. Publish now **waits for extras to settle**.
2. **The snapshot read is STRICT** (`getAppSettingWithMetaStrict`). A transient DB error
   used to degrade to "no snapshot", which pre-lock silently zeroed the bonuses; the
   module now throws, the route returns 500, and the Overview **keeps its last good
   figure**.
3. **Don't stream full paystub payloads to every viewer.** The queue read is a
   `payload->pay_php` projection behind a TTL cache — it was ~2–4MB per viewer per
   refresh.
4. **Two people with byte-identical pay must not collapse.** Pre-lock snapshot entries
   carry a `workEmail` identity (content-signature fallback for pre-2026-07-30
   snapshots that lack the field).
5. **Cycle isolation.** `payoutExtrasForCycle` only uses extras whose `sourceFile`
   matches the active cycle, so switching the CSV selector can never bleed one week's
   extras into another's salary.

---

## 3 · Known gap (still open)

The **salary base is still sheet-only rates.** `totalPayout` sums hours × the rates
cache, so it does not apply the Payment Catalog compute-time overlay
([bonus-catalog.md §5](./bonus-catalog.md)). Against the Jul 19–25 cycle that is roughly
**₱213K of catalog drift**, and the ~17 people who are catalog-paid with **no** rates row
are invisible to the salary sum entirely (they still contribute their extras). Audit the
whole hero against live data with:

```
npx tsx scripts/tmp-audit-total-payout.mts
npx tsx scripts/tmp-verify-payout-extras.mts
```

---

## 4 · Files

| Path | Role |
|---|---|
| `src/lib/payroll/payout-extras.ts` | `computePayoutExtras(sourceFile)` → `PayoutExtras`; the precedence + PAB-exclusion rules live here |
| `app/api/accounting/payout-extras/route.ts` | rate-visible GET wrapper |
| `src/components/Overview.tsx` | `payoutExtras` state, `payoutExtrasForCycle` cycle guard, `displayTotalPayout`, the breakdown subtitle, and the publish-waits-for-extras ordering |
| `src/lib/supabase/app-settings.ts` | `getAppSettingWithMetaStrict` (the strict read added for rule 2) |
| `scripts/tmp-audit-total-payout.mts`, `scripts/tmp-verify-payout-extras.mts` | live-data verifiers |
