# Payment Catalog — "Pay Processors" tab

**Date:** 2026-09-03 · **Approved:** Kane, same day.
Answers to the brief: **Q1** the tab is the **source of truth** for processors and will
soon feed Payment Dispatch (each processor = a dispatch bucket like Kolan / Wise) ·
**Q2** multi-peer is a plain flag, "can send to any bank" (Wise is the example), no bank
list · **Q3** logos as data URLs inside the registry row · **Q4** one `x1153` row ·
**Q5** Wepay is retired.

A catalog of every pay processor Accounting sends salaries from: label, logo, a
classification chip (**One-to-one** — the wallet rails Kolan / HiGlobe, where the
receiving wallet IS the send-from rail; **Multi-peer** — bank rails like Wise / Jeeves /
x1153 that can pay into any bank), active/retired, blurb, notes. Add and edit; no delete.

Precedent: the Department tab (`DepartmentsTab.tsx` + `lib/departments/registry{,-db}.ts`
+ `api/payment-catalog/departments/route.ts`) — an `app_settings` JSON registry, no
migration, GET behind the rate-visibility gate, writes behind `bonus_catalog` edit. Logo
rendering reuses `payroll-clerk/ProcessorLogo.tsx` (the 80×44 white plate).

Routing today still reads the compile-time `ProcessorId` union / `WALLET_RAILS`. Until the
Payment Dispatch integration lands, a wired row whose registry classification disagrees
with code shows a **drift** chip — the registry is what Kane wants, the code is what pays.

## Tasks

- [x] Plan doc (this file)
- [x] 1. `src/lib/payment-catalog/pay-processors.ts` — client-safe model: setting key,
      `PayProcessor` shape, `PayProcessorLogo` (public path | data URL), routing / status
      unions, `codeSeedProcessors()` (built from `PROCESSOR_OPTIONS` + `WALLET_RAILS` +
      `BANK_PREFERRED_OPTIONS`; Wepay retired; plated logo assets), `codeRoutingFor(id)`,
      `routingDrift(p)`, `mergeRegistryOverCode(stored)` (stored wins, seeds fill gaps,
      `wiredInCode` + `id` never come from the blob), `slugifyProcessorId`,
      `validatePayProcessorInput` (label, blurb, notes lengths; routing/status enums; logo
      MIME allowlist png/svg/webp/jpeg, ≤150 KB, base64 length cross-check; `public` logos
      only from the seed set), `applyPayProcessorPatch` (id / wiredInCode / createdBy /
      createdAt immutable). `pay-processors.test.ts` beside it, including "every seed logo
      exists in `public/` case-exactly".
- [x] 2. `src/lib/payment-catalog/pay-processors-db.ts` — `readPayProcessorRegistry()`
      (sanitize every row; THROWS on a failed read; corrupt JSON ⇒ empty, never persisted)
      and `mutatePayProcessorRegistry(fn)` — read-with-meta → merge → `casUpdateAppSetting`,
      retried on conflict (two admins editing two processors must not clobber each other).
- [x] 3. `app/api/payment-catalog/pay-processors/route.ts` — GET (`requireRateVisibilitySession`)
      returns `{ processors }` = merged registry over code seeds; POST create and PATCH edit
      (`requireFeatureEdit('accounting','bonus_catalog')`), both validated server-side, both
      audited (`pay_processor.create` / `pay_processor.update`, best-effort).
- [x] 4. `src/components/accounting/PayProcessorsTab.tsx` — header + "Add processor"; Active
      grid of cards (logo plate, label, classification chip with plain-words tooltip, drift
      chip, "Wired for dispatch" / "Not wired yet" badge, blurb); collapsed Retired section;
      one dialog for add + edit (label, blurb, classification radios with help text, logo
      drop/pick previewed on the real plate, status, notes) — height-capped per
      `dialog-content-no-height-cap`.
- [x] 5. `src/components/accounting/BonusCatalog.tsx` — `'pay-processors'` tab after
      Department (icon `Landmark`), fetch in `refetch`, `postgres_changes` filter on the one
      key, count badge = active processors.
- [x] 6. `npm test` + `npx tsc --noEmit` (dev server is live on :3000 — no `next build`).
- [x] 7. Docs: `docs/features/payment-catalog-pay-processors.md`, INDEX row (Rates & Payment
      Catalog family), memory `payment-catalog-pay-processors-tab` + MEMORY.md pointer. One
      commit with the code, staged by path.
