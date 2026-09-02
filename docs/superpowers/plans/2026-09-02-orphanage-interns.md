# Orphanage Interns — profiles · mini wizard · Payroll Wizard Interns view · dispatch

**Date:** 2026-09-02 · **Approved:** Kane, same day ("Start the build!") on the brief in
`docs/implementation-plans/implementation-plan-orphanage-interns.md` §13. Decisions taken in that
thread and binding here: Q1 PAB = 5 paid hours every Sun–Sat week of Simple's PAB period, ₱1,000,
payout week only; Q4 = interns come on their OWN Hubstaff report (same columns), uploaded in the mini
wizard, never into `hubstaff_hours`; no Employee Dashboard / sign-in; every personal-data and bank
change happens on the Orphanage dashboard only; the mini wizard renders like the Payroll Wizard in the
Orphanage pink. Q2 (50% split mechanics) is still open → `shareMode` config gate blocks lock-in until
Accounting sets it.

**Spec:** the implementation plan above. **Precedents:** `orphanage_worker_payments` + `OrphanageQueue`,
`ThirdPartyVendorsPanel`, `orphanage-pay-pricing.ts`, `orphanage_pay`, `apply-termination-docs-migration.mts`,
`orphanage_budget_requests` → decide → `orphanage_dispatches`.

## Global constraints

- Commit to `main`, stage by explicit path, never push. `.env.local` = production; no writes without Kane.
- `npm run lint` (`tsc --noEmit`) and `npm test` (`node --import tsx --test`) green before each commit.
- Every list read pages (`selectAllPaged`). Money in PHP, 2dp; hours 2dp for pay.
- `PayrollWizard.tsx`, `payment_dispatches`, `paystub_dispatch_queue`, the additions blob,
  `disbursement_records`, MESA, `global_master_list`, `employee_hourly_rates`, the Payment Catalog and
  `POST /api/hubstaff-hours` are `out:` scope — never edited.

## Tasks

- [x] 1. **Segmentation, both doors.** `src/lib/interns/intern-email.ts` (`isInternEmail`,
      `INTERN_EMAIL_DOMAIN`) + `intern-email.test.ts`; `src/lib/interns/intern-hours-rows.ts`
      (`partitionInternRows` → `{ payroll, interns }`, pure) + test; `hubstaff-hours-db.ts`
      `rowsToPayrollRows` drops interns, new `countInternRows`; `app/api/hubstaff-hours/route.ts:361`
      uses `rowsToPayrollRows` and every GET branch returns `internRowsDropped`.
- [x] 2. **Migration + apply script.** `references/sql/migrate/2026-09-02_orphanage_interns.sql`
      (tables: `orphanage_interns`, `orphanage_intern_rates`, `orphanage_intern_hours`,
      `orphanage_intern_hours_uploads`, `orphanage_intern_pay`; ALTER `orphanage_dispatches`
      + `orphanages`) · `scripts/apply-orphanage-interns-migration.mts` (dry default, `--apply`,
      `--verify`, positive + negative controls). Kane runs `--apply`.
- [x] 3. **Pure libs (TDD).** `src/lib/interns/intern-week-pay.ts` (`priceInternWeek`,
      `splitInternGross`, `INTERN_DEFAULTS`) · `intern-pab.ts` (`internPabVerdict`,
      `INTERN_PAB_MIN_WEEKLY_HOURS`) · `intern-config.ts` (`parseInternConfig`, `INTERN_CONFIG_KEY`) ·
      `intern-types.ts` (client-safe row types). Tests beside each.
- [x] 4. **Data layer.** `src/lib/supabase/orphanage-interns-db.ts` (profiles + rates, paged) ·
      `orphanage-intern-hours-db.ts` (upload/replace per file, list uploads, rows by file) ·
      `orphanage-intern-pay-db.ts` (upsert week, list by file/status, decide, delete submitted, paid guard).
- [x] 5. **Profiles API + RBAC + tab.** `app/api/orphanage-interns/route.ts`, `[id]/route.ts`,
      `[id]/rates/route.ts` (orphanage `interns` gate; masked list) · `FEATURE_CATALOG.orphanage` +
      `view-tabs.ts` + `OrphanageApp.tsx` (`interns` tab) · `src/components/orphanage/interns/InternsTab.tsx`
      (Profiles | Pay week panes) · `InternsProfilesPanel.tsx` · `InternDialog.tsx` · `InternRateDialog.tsx`.
- [x] 6. **Hours upload + mini wizard.** `app/api/orphanage-interns/hours/route.ts` (POST multipart,
      GET batches) · `pay-weeks/preview/route.ts` · `pay-weeks/route.ts` (POST submit, DELETE withdraw) ·
      `src/lib/interns/intern-week-server.ts` (shared server pricer used by preview, submit, and Accounting) ·
      `src/components/orphanage/interns/InternsWizard.tsx` (rail, KPI strip, table, PAB, review, lock-in dialog).
- [x] 7. **Accounting Interns view.** `pay-weeks/decide/route.ts` (accept/reject/reopen; paid guard) ·
      `pay-weeks/config/route.ts` (GET/POST `shareMode`) · `pay-weeks/inbox/route.ts` (submitted +
      accepted weeks, re-priced) · `src/components/accounting/interns/InternsPayrollView.tsx` ·
      `App.tsx` Simple | Interns toggle (persisted with `wizardVisited`).
- [x] 8. **Dispatch.** `orphanage-dispatches.ts` types + `intern_pay` / `intern_orphanage_share` pending
      branch · `app/api/orphanage-dispatches/route.ts` allow-list + `intern_pay_id` · `OrphanageQueue.tsx`
      Interns section (read-only bank) · `OrphanageMarkPaidDialog.tsx` bank fields read-only for intern items.
- [x] 9. **Docs.** `docs/features/orphanage-interns.md` · INDEX row · memory `orphanage-interns` +
      `MEMORY.md` line · implementation plan status → Built. Typecheck + tests. Commit.
