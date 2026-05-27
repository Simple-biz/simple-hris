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
| [paystub-dispatch.md](./features/paystub-dispatch.md) | Paystub generation + dispatch |
| [bonus-calculator.md](./features/bonus-calculator.md) | Department + HSL bonus calculators |
| [csv-imports.md](./features/csv-imports.md) | CSV ingest + Google Sheet sync (Admin tab, endpoints, env, schema) |
| [orphanage-dispute-flow.md](./features/orphanage-dispute-flow.md) | Orphanage-visit / PAB dispute flow |
| [delete-authorization.md](./features/delete-authorization.md) | Who can delete what, and the audit trail |
| [system-diagnostics.md](./features/system-diagnostics.md) | Admin diagnostics service map + probes |
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
| [meeting-2026-05-20-carla-kentshin-teal.md](./meetings/meeting-2026-05-20-carla-kentshin-teal.md) |
| [meeting-antigravity-2026-05-13.md](./meetings/meeting-antigravity-2026-05-13.md) |
| [meeting-with-carla-2026-05-07.md](./meetings/meeting-with-carla-2026-05-07.md) |
| [meeting-with-carla-2026-05-05.md](./meetings/meeting-with-carla-2026-05-05.md) |
| [meeting-with-carla-2026-04-29.md](./meetings/meeting-with-carla-2026-04-29.md) |
| [meeting-with-carla-undated.md](./meetings/meeting-with-carla-undated.md) |

## audits/ -- dated change audits

| Doc |
|---|
| [audit-2026-05-07.md](./audits/audit-2026-05-07.md) |
| [audit-2026-04-25.md](./audits/audit-2026-04-25.md) |
| [audit-2026-04-21.md](./audits/audit-2026-04-21.md) |

## notes/ -- misc working notes

| Doc |
|---|
| [problem.md](./notes/problem.md) |
| [notebooklm-skill.md](./notes/notebooklm-skill.md) |
