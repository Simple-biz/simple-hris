# Orphanage step — "Orphanage Management System" tab (pull approved hours on request)

**Approved brief:** in-session 2026-09-16. Kane's answers: Q1 = Supabase, Q2 = OMS keys
weeks Sunday–Saturday exactly like the pay period ("this week is 13-19"), Q3 = rows
become available only once OMS APPROVES them, Q4 = recommendation (TEST every mount,
session-only), Q5 = recommendation (LIVE = the paste's full lock-in, blob + record).

Q1 changes the transport from the brief: OMS is Supabase, so the read goes through
`@supabase/supabase-js` with a project URL + key (the shape Kane already configures for
this app) instead of a raw `pg` connection string. Same scope, different env names.

**Stack:** Next.js app router, client components, `@supabase/supabase-js` (server-only
client), `selectAllPaged`, `motion/react`, `node --import tsx --test`.

## Task 1 — one resolver for paste AND pull

- [ ] `src/lib/payroll/orphanage-rows.ts`
  - `tokenizeOrphanagePaste(text)` — the paste's tab/comma split, header skip, 3-column
    check, lifted verbatim from `orphanagePasteParse`.
  - `resolveOrphanageHourRows(rows, ctx)` — the match + price loop lifted verbatim:
    direct email → master-list bridge → duplicate refusal → rate fallback → dept OT
    switch → `priceOrphanageHours`. The ONLY path an orphanage hour prices through.
- [ ] `src/lib/payroll/orphanage-rows.test.ts` — a pasted line and an OMS row for the same
  person price identically; header skipped; duplicate refused; master bridge; OT off.

## Task 2 — OMS config (env), validated

- [ ] `src/lib/oms/oms-config.ts` — `readOmsConfig(env)`: URL + key + table + column
  names, identifiers regex-checked, typed "not configured" reason naming the VARIABLE,
  never a value. Server-only names (no `NEXT_PUBLIC_`).
- [ ] `src/lib/oms/oms-config.test.ts`

## Task 3 — OMS reader

- [ ] `src/lib/oms/oms-hours.ts` — `omsWeekStatus(cfg, weekStart)` (approved count +
  latest stamp; `count:'exact'` WITHOUT `head:true` — see
  [[postgrest-head-true-hides-missing-table]]) and `pullOmsApprovedHours(cfg, weekStart)`
  (`selectAllPaged`, stable order, `MAX_ROWS` + `truncated` flag, approved rows only).

## Task 4 — route

- [ ] `app/api/orphanage-pay/oms/route.ts` — `GET ?mode=status|pull&week_start=` gated
  `requireFeatureAccess('accounting','payroll_wizard','view')`; JSON on every branch;
  503 `configured:false` when env is missing; 502 when OMS is unreachable.

## Task 5 — UI

- [ ] `src/components/payroll/OrphanageOmsLiveConfirmDialog.tsx` — LIVE warning in the
  `OrphanageClearConfirmDialog` vocabulary, never `window.confirm`.
- [ ] `src/components/payroll/OrphanageOmsPanel.tsx` — TEST/LIVE `Switch` (default TEST,
  session-only), ready indicator (status ping on tab open + after each pull), **Load
  Orphanage Hours** (the only thing that fetches rows), matched/skipped preview with
  reg/OT split + amount, staggered rows, LIVE lock-in through the confirm dialog.
- [ ] `src/components/PayrollWizard.tsx` — `ORPHANAGE_SECTIONS` strip copied from the
  step-4 `additions-section-indicator` (own state, derived active, directional slide);
  paste parser rewired onto Task 1; `lockInOrphanagePaste` generalised to
  `lockInResolvedOrphanageRows(ok, source)`; OMS LIVE audited
  `wizard.orphanage_oms_locked_in`.
- [ ] `src/lib/audit/registry.ts` — note gains `orphanage_oms_locked_in`.
- [ ] `.env.example` — OMS block.

## Task 6 — document, same commit

- [ ] `docs/features/orphanage-oms-pull.md` · `orphanage-pay-step.md` cross-link ·
  INDEX row 39 · `docs/reference/api-reference.md` + `components.md` rows ·
  memory `orphanage-oms-pull` + `MEMORY.md` pointer.

## Task 7 — Save to the HRIS (approved 2026-09-16, both recommendations: append-only · raw + resolved)

- [x] `references/sql/create/2026-09-16_orphanage_oms_hours.sql` — RLS on, 4 CHECKs, normalising trigger
- [x] `scripts/apply-orphanage-oms-hours-migration.mts` — dry/apply/verify, constraint controls
- [x] `src/lib/oms/oms-save.ts` (+ test) — payload builder + route validation
- [x] `src/lib/supabase/orphanage-oms-hours-db.ts` — probe · batched insert · latest per week (paged)
- [x] `app/api/orphanage-pay/oms/saves/route.ts` — GET view · POST edit · audit `wizard.orphanage_oms_saved`
- [x] panel Save button + "Last saved" + "saving now changes N" · hook `save` / `loadLatestSave`
- [ ] **Kane runs** `--apply` (PENDING)
