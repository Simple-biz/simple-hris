# Simple HRIS Documentation

Documentation for the Simple HRIS app, organized by purpose. **New here?** Start with
[reference/llm-context.md](./reference/llm-context.md) for the big picture, then
[reference/system-architecture.md](./reference/system-architecture.md).

```
docs/
  reference/             core technical reference (stack, components, APIs, data, rules)
  features/              per-subsystem feature docs
  design/                UI/UX standards
  implementation-plans/  design proposals + build plans
  meetings/              meeting notes
  audits/                dated change audits
  notes/                 misc working notes
```

## reference/ -- core technical reference

| Doc | Covers |
|---|---|
| [llm-context.md](./reference/llm-context.md) | Read-first overview + quick facts + documentation index |
| [system-architecture.md](./reference/system-architecture.md) | Stack, repo structure, routing model (8 role dashboards), auth/RBAC, design system, key decisions |
| [components.md](./reference/components.md) | Every UI component across all dashboards (Dashboard Map, Auth/RBAC routing, per-dashboard reference, shared components) |
| [api-reference.md](./reference/api-reference.md) | REST API endpoints: methods, request/response shapes, tables, service-role requirements |
| [data-sources.md](./reference/data-sources.md) | Supabase tables/views, data flow, CSV dedup, email normalization, PAB column resolution |
| [business-logic.md](./reference/business-logic.md) | Payroll formulas, overtime, PAB rules, bonus schedules, dispute system, data-integrity policies |

## features/ -- subsystem docs

| Doc | Covers |
|---|---|
| [payment-dispatch.md](./features/payment-dispatch.md) | Payment Dispatch feature: queues, processors, disbursement records |
| [urgent-payments.md](./features/urgent-payments.md) | Urgent Payments tab: MESA disbursements + orphanage budget requests; per-recipient processor; weekly Sun–Sat report buckets |
| [paystub-dispatch.md](./features/paystub-dispatch.md) | Paystub generation + dispatch |
| [payroll-wizard-final-pay.md](./features/payroll-wizard-final-pay.md) | Initial Calculation → Final pay: formula, Adj. (signed delta) + Orphanage columns, Sun→Sat pay weeks + cross-upload merge, MESA flag |
| [bonus-calculator.md](./features/bonus-calculator.md) | Department + HSL bonus calculators |
| [bonus-catalog.md](./features/bonus-catalog.md) | Payment Catalog: reusable custom bonuses (flat or Excel-formula engine) + Pay Structures, now **authoritative for hourly rates** via a compute-time overlay (`src/lib/payroll/resolve-rate.ts`, priority individual → sheet → dept base) |
| [csv-imports.md](./features/csv-imports.md) | CSV ingest + Google Sheet sync (Admin tab, endpoints, env, schema) |
| [rbac-feature-permissions.md](./features/rbac-feature-permissions.md) | Role grants + per-tab Hidden/View/Edit overlay; Admin-provisioned, enforced across all views + API; force-logout/session reset |
| [accounting-cobrowse.md](./features/accounting-cobrowse.md) | Live "Observe" screen mirroring in Accounting (rrweb over Realtime), built on the collab layer |
| [orphanage-dispute-flow.md](./features/orphanage-dispute-flow.md) | Orphanage-visit / PAB dispute flow |
| [third-party-vendors.md](./features/third-party-vendors.md) | Orphanage 3rd Party Vendors tab: vendor directory (dual banking) + SIMPLE-branded invoice builder with PAID watermark; deliberately separate from Payment Dispatch (own tables, no n8n) |
| [delete-authorization.md](./features/delete-authorization.md) | Who can delete what, and the audit trail |
| [system-diagnostics.md](./features/system-diagnostics.md) | Admin diagnostics service map + probes; live auto re-probe feed for watching the DB during an outage |
| [mesa.md](./features/mesa.md) | MESA savings program: `mesa_requests` (opt-in/out/disbursement/return) + backfilled `mesa_ledger`; contribution displays across HR/Accounting/Employee dashboards; Wizard ₱100 deduction flag |
| [offboarding-automation.md](./features/offboarding-automation.md) | Manager multi-select → HR one-by-one offboard queue; RBAC snapshot/restore; n8n `manager-offboard-notify` (count-only email to alissar@) + multi-employee `employee.offboarded` teardown payload |
| [time-adjustment-requests.md](./features/time-adjustment-requests.md) | Employee time adjustment requests: wizard, evidence upload, Accounting review, pay wiring |
| [identity-resolution.md](./features/identity-resolution.md) | Master-authoritative identity + Department; alternate-work-email bridging for hours/rate matching across Rates & Profiles, Payroll Wizard, manager + employee dashboards |
| [manager-my-team.md](./features/manager-my-team.md) | Manager portal → My Team: roster, rates/pay hidden on every surface, Recognition-medal card, attendance-only Hours tab (HSL rule via `department` prop) |
| [department-transfers.md](./features/department-transfers.md) | Department Transfers v2: manager-driven pull-in + source-manager consent, Google-Sheet write-back, past-dated transfers, Payroll-Wizard mid-week rate proration, and the Manager / HR (read-only) / Accounting (rate-linked) Transfers tabs |
| [new-hire-checklist.md](./features/new-hire-checklist.md) | HR New Hire Checklist: modal-only, read-only grid with atomic per-row writes, optimistic-concurrency edits (409 reconcile), and `useChecklistRoom` soft row-locks + change broadcasts |
| [onboarding-ip-assignment.md](./features/onboarding-ip-assignment.md) | IP Assignment / Talent Release / Copyright Waiver as the first public onboarding step; signed PDF via pdf-lib stored in `hr-onboarding-files`; HR IP Assignment tab; `/onboarding/preview` no-save preview mode (migration #73 PENDING) |
| [onboarding-pay-plans.md](./features/onboarding-pay-plans.md) | HR uploads one pay-plan PDF per (Department, Country); the matched plan rides the onboarding **invite** email (in-email card + attachment + `pay_plan`) via a Country picker stored as `invite_country`. Migration #80 (two files) PENDING |
| [onboarding-gmail-surname.md](./features/onboarding-gmail-surname.md) | Read-only auto-derived `@simple.biz` surname slice (collision-aware via `loadTakenWorkEmails`), sent to the workspace-account webhook in place of the legal surname for privacy. Migration #81 PENDING |
| [onboarding-calltools-username.md](./features/onboarding-calltools-username.md) | Lead Gen hires type their own Nickname; CallTools username auto-mints server-side as `<Nick> <F>. <surname slice>.` ("Mikey J. T." → "Mikey J. TH." on collision), hidden from the hire (preview-only field + "Test as Lead Gen" switch); sent to n8n via the `orientation_attended` webhook when the manager marks attendance. Migration `add_calltools_username_to_onboarding.sql` PENDING |
| [ceo-assistant.md](./features/ceo-assistant.md) | Floating Claude (Sonnet) chat widget on the CEO dashboard with read-only payroll tools over `disbursement_records`, admin-managed API key, audit logging |
| [admin-api-keys.md](./features/admin-api-keys.md) | Admin "API tokens" tab for the Anthropic key; DB value overrides env, masked-only display, `requireAdminSession` gate, and the `secret.*` admin-only tier in `/api/app-settings` |
| [paystub.html](./features/paystub.html) | Paystub HTML template |

## design/ -- UI/UX standards

| Doc | Covers |
|---|---|
| [ui-standards.md](./design/ui-standards.md) | Component conventions, visual language |
| [responsive-design.md](./design/responsive-design.md) | Breakpoints, safe areas, mobile testing notes |

## implementation-plans/ -- design proposals + build plans

| Doc |
|---|
| [implementation-plan-rbac.md](./implementation-plans/implementation-plan-rbac.md) |
| [implementation-plan-roles-2026-05-08.md](./implementation-plans/implementation-plan-roles-2026-05-08.md) |
| [implementation-plan-hr-dashboard.md](./implementation-plans/implementation-plan-hr-dashboard.md) |
| [implementation-plan-employee-dashboard.md](./implementation-plans/implementation-plan-employee-dashboard.md) |
| [implementation-plan-orphanage-visit-pab.md](./implementation-plans/implementation-plan-orphanage-visit-pab.md) |
| [implementation-plan-google-sso.md](./implementation-plans/implementation-plan-google-sso.md) |
| [implementation-plan-paystub-email.md](./implementation-plans/implementation-plan-paystub-email.md) |

## meetings/ -- meeting notes

| Doc |
|---|
| [meeting-with-carla-2026-06-16.md](./meetings/meeting-with-carla-2026-06-16.md) |
| [meeting-2026-05-20-carla-kentshin-teal.md](./meetings/meeting-2026-05-20-carla-kentshin-teal.md) |
| [meeting-antigravity-2026-05-13.md](./meetings/meeting-antigravity-2026-05-13.md) |
| [meeting-with-carla-2026-05-07.md](./meetings/meeting-with-carla-2026-05-07.md) |
| [meeting-with-carla-2026-05-05.md](./meetings/meeting-with-carla-2026-05-05.md) |
| [meeting-with-carla-2026-04-29.md](./meetings/meeting-with-carla-2026-04-29.md) |
| [meeting-with-carla-undated.md](./meetings/meeting-with-carla-undated.md) |

## audits/ -- dated change audits

| Doc |
|---|
| [audit-2026-07-10-session-log.md](./audits/audit-2026-07-10-session-log.md) — log of the 20 most recent Claude sessions (Jul 8–10) |
| [audit-2026-07-07-session-log.md](./audits/audit-2026-07-07-session-log.md) — log of the 20 most recent Claude sessions (Jul 6–7) |
| [audit-2026-06-16.md](./audits/audit-2026-06-16.md) |
| [audit-2026-05-07.md](./audits/audit-2026-05-07.md) |
| [audit-2026-04-25.md](./audits/audit-2026-04-25.md) |
| [audit-2026-04-21.md](./audits/audit-2026-04-21.md) |

## notes/ -- misc working notes

| Doc |
|---|
| [problem.md](./notes/problem.md) |
| [notebooklm-skill.md](./notes/notebooklm-skill.md) |
| [hubstaff-sunday-overlap.md](./notes/hubstaff-sunday-overlap.md) |
| [pab-period-parity-2026-06-12.md](./notes/pab-period-parity-2026-06-12.md) |
