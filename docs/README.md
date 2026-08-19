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
| [system-architecture.md](./reference/system-architecture.md) | Stack, repo structure, routing model (ten dashboard views + `/payroll-clerk`), auth/RBAC, upstream Sheets + n8n, design system, key decisions, retired behavior |
| [components.md](./reference/components.md) | Every UI component across all dashboards (Dashboard Map, Auth/RBAC routing, per-dashboard reference, shared components) |
| [api-reference.md](./reference/api-reference.md) | REST API endpoints: methods, request/response shapes, tables, service-role requirements |
| [data-sources.md](./reference/data-sources.md) | Supabase tables/views, data flow, CSV dedup, email normalization, PAB column resolution |
| [business-logic.md](./reference/business-logic.md) | Payroll formulas, overtime, PAB rules, bonus schedules, dispute system, data-integrity policies |

## features/ -- subsystem docs

| Doc | Covers |
|---|---|
| [payment-dispatch.md](./features/payment-dispatch.md) | Payment Dispatch feature: queues, processors, disbursement records; **§12** covers the 2026-07-22 routing-precedence, Mark Paid bank-override, logo and focus-mode-removal changes, the sub-₱7k Wise reroute (§12.3.1), the **100%-paid confetti email** (§12.7), **COP payees** (§12.8), and the **"why isn't this person in the queue" triage list** (§12.9) |
| [accounting-total-payout.md](./features/accounting-total-payout.md) | Accounting Overview **Total payout** hero = the **full pay run** since 2026-07-30: salary + PAB + `extrasTotalPhp` (KPI/catalog bonuses, Notes adjustments, orphanage, MESA, paid urgent of the dispatch week) from payroll's own staged/live figures via `/api/accounting/payout-extras`; why PAB stays hero-side; the 5 hardening rules from the adversarial review; **open gap** — salary base is still sheet-only rates (~₱213K catalog drift) |
| [cop-country-payees.md](./features/cop-country-payees.md) | Colombian payees ride the **PHP** rails (the COP tab never sees them) but show/copy native **`$COP`** on queue rows, Mark Paid (bare-integer copy) and paystubs. Marker comes from the hire's **submitted** onboarding `country` **only** — never `invite_country` (documented misclicks). Display-only: no routing/amount/record change |
| [bank-preferred-routing.md](./features/bank-preferred-routing.md) | **Bank Preferred** = send-from rail (`employee_ids.bank_preferred`), separate from Disbursement/receiving acct; wins dispatch precedence; Accounting **approval gate** (`bank_preferred_change_requests` → Issues tab); **WIRES lock** (wires/null/legacy can never move to hurupay/higlobe); Mark Paid pencil bank-override; **§7 (2026-07-25)**: Wise on employee pickers w/ wire fields, 27-person PH-freelancer Wise seed, the 28 clobbered No-Bank submissions (restore OPEN). 2 notification migrations PENDING |
| [urgent-payments.md](./features/urgent-payments.md) | Urgent Payments tab: MESA disbursements + orphanage budget requests + People-tab one-offs; per-recipient processor; the `urgent_` `cycle_source_file` marker (never `cycle_id`); weekly Sun–Sat report buckets; **2026-07-30** — the bucket **persists all week** with Pending/Paid/Not-paid views, per-source **Undo** (MESA recovers via its audit event; revive-before-delete), and the **urgent-filed n8n alert** to carla/claire/lennyt |
| [paystub-dispatch.md](./features/paystub-dispatch.md) | Paystub generation + dispatch; **paystub freshness** (`paystub-fresh.ts` merges the wizard `final_pay` snapshot over the staged payload; mark-paid reconciles vs money + freezes as-paid); **2026-07-30** — HSL **Weekend Hours** carve-out (weekend hrs can be regular OR OT), **mid-week proration** on the statement (Prorated chip + `₱old → ₱new` + per-rate basis) with the catalog-consistency and HSL-transfer-week rules, the native **COP** line, and the Dispatch step's **Rate snapshots** toggle |
| [payroll-wizard-final-pay.md](./features/payroll-wizard-final-pay.md) | Initial Calculation → Final pay: formula, Adj. (signed delta) + Orphanage columns, Sun→Sat pay weeks + cross-upload merge, MESA flag; **2026-07-25**: every master-list dept visible (smm_freelancer split, `hsl:*`→HSL, derived-slug tabs, roster card), week-gated Time Adjustments, HSL table UX; **2026-07-29**: HSL rows shown in step-2 table + department filter/labels |
| [payroll-readiness.md](./features/payroll-readiness.md) | Payroll Wizard **Readiness** dashboard (in the Notes FAB): per-dept KPI submissions over every master-list dept (auto-Ready when no catalog bonus; "Excluded" via the Configuration tab), No-Pay-Rate + Bank-Info lists with inline **Set rate / Set bank** fixers (audit-tagged sources), onboarding exceptions; blocker-weighted 50/25/25 score — missing bank **on this week's payroll** pins the dimension and grades `blocked`; `degraded[]` partial-data banner; CLI verifier runs the real fn. No migration |
| [payroll-wizard-configuration-tab.md](./features/payroll-wizard-configuration-tab.md) | Payroll Wizard step-1 **Configuration** tab: per-dept "Pay this week" switch scoped to one pay week (`payroll.wizard.dept_pay_paused.<sourceFile>`; hides the dept from wizard/Notes/Readiness) + per-dept Overtime switch (reuses `ot_dept_<key>`); label double-fire fix; no migration |
| [payment-catalog-departments.md](./features/payment-catalog-departments.md) | Payment Catalog **Department** tab: Create-a-Department wizard (sub-depts, ≥1 manager, rate, streamed staged creation); self-contained `app_settings` registry — **no** master-list/Sheet writes, no migration; how in-app departments reach manager KPI surfaces, dropdowns, rate resolution, the Payroll Wizard, and Readiness |
| [hubstaff-weekly-auto-sync.md](./features/hubstaff-weekly-auto-sync.md) | Weekly Hubstaff auto-sync: n8n Schedule Trigger (midnight ET, DST-aware — deliberately not vercel.json) hits Bearer-`CRON_SECRET` `/api/cron/sync-hubstaff-week`; shared `runHubstaffWeeklySync` = the wizard's pipeline (hours batch, `payroll.available`, MESA deposits). Import + activate the workflow JSON |
| [bonus-calculator.md](./features/bonus-calculator.md) | Department + HSL bonus calculators |
| [bonus-catalog.md](./features/bonus-catalog.md) | Payment Catalog: reusable custom bonuses (flat or Excel-formula engine) + Pay Structures, now **authoritative for hourly rates** via a compute-time overlay (`src/lib/payroll/resolve-rate.ts`, priority individual → sheet → dept base) |
| [csv-imports.md](./features/csv-imports.md) | CSV ingest + Google Sheet sync (Admin tab, endpoints, env, schema); Hubstaff ingest blocklist + week-delete cascade (2026-07-25) |
| [rbac-feature-permissions.md](./features/rbac-feature-permissions.md) | Role grants + per-tab Hidden/View/Edit overlay; Admin-provisioned, enforced across all views + API; force-logout/session reset |
| [accounting-cobrowse.md](./features/accounting-cobrowse.md) | Live "Observe" screen mirroring in Accounting (rrweb over Realtime), built on the collab layer |
| [orphanage-dispute-flow.md](./features/orphanage-dispute-flow.md) | Orphanage-visit / PAB dispute flow |
| [orphanage-pab-coverage.md](./features/orphanage-pab-coverage.md) | **TEMPORARY** orphanage → PAB auto-coverage: Orphanage-step hours forgive short weekdays (`worked + hours ≥ 7h`) in the hours' file week **+ the week before** (results arrive one run after the visit); no dispute needed; single source of truth `orphanage-pab-coverage.ts` feeding all 6 eligibility surfaces; frozen-snapshot upgrade rule; removal checklist |
| [third-party-vendors.md](./features/third-party-vendors.md) | Orphanage 3rd Party Vendors tab: vendor directory (dual banking) + SIMPLE-branded invoice builder with PAID watermark; deliberately separate from Payment Dispatch (own tables, no n8n) |
| [delete-authorization.md](./features/delete-authorization.md) | Who can delete what, and the audit trail |
| [system-diagnostics.md](./features/system-diagnostics.md) | Admin diagnostics service map + probes; live auto re-probe feed for watching the DB during an outage |
| [mesa.md](./features/mesa.md) | MESA savings program: `mesa_requests` (opt-in/out/disbursement/return) + backfilled `mesa_ledger`; contribution displays across HR/Accounting/Employee dashboards; Wizard ₱100 deduction flag; per-stint `mesa_accounts` (`YY-MM-#####`); Global Master List source-of-truth gating; weekly Hubstaff-upload ledger deposits + **week-delete cascade** and the date-only TZ fix (2026-07-25) |
| [tickets-board.md](./features/tickets-board.md) | `/tickets` HRIS Updates Kanban: dedicated `tickets` role, owner-only assignment (kaner@), movers, comments + `ticket_events` history, archive/restore, n8n assignee email, black+red console theme |
| [payroll-wizard-notes.md](./features/payroll-wizard-notes.md) | Payroll Wizard floating Notes checklist ("Adjustments and Notes" FAB — also hosts the **Readiness** pane, see payroll-readiness.md): Date/Clerk/Done/Worker/**Adjustment**/Notes, pay-period `week_start` stamping + period selector, realtime, CEO-tool readable. Adjustment/week_start migration PENDING |
| [hr-global-master-list-export.md](./features/hr-global-master-list-export.md) | HR Global Master List: client-side PDF/XLSX/CSV export (CEO-themed PDF), per-card View detail dialog, Sync-deprecation warning dialog |
| [accounting-mesa-export.md](./features/accounting-mesa-export.md) | Accounting MESA: per-tab PDF/XLSX/CSV export (CEO-themed, spec-driven `mesa-export.ts`); Active Members export carries the per-stint account-number caveat (opt-out closes the account, history retained) |
| [offboarding-automation.md](./features/offboarding-automation.md) | Manager multi-select → HR one-by-one offboard queue; RBAC snapshot/restore; n8n `manager-offboard-notify` (count-only email to alissar@) + multi-employee `employee.offboarded` teardown payload; Weekly Pulse KPI cards (weekly offboards + attrition) |
| [time-adjustment-requests.md](./features/time-adjustment-requests.md) | Employee time adjustment requests: wizard, evidence upload, Accounting review, pay wiring |
| [identity-resolution.md](./features/identity-resolution.md) | Master-authoritative identity + Department; alternate-work-email bridging for hours/rate matching across Rates & Profiles, Payroll Wizard, manager + employee dashboards |
| [manager-my-team.md](./features/manager-my-team.md) | Manager portal → My Team: roster, rates/pay hidden on every surface, Recognition-medal card, attendance-only Hours tab (HSL rule via `department` prop) |
| [department-transfers.md](./features/department-transfers.md) | Department Transfers v2: manager-driven pull-in + source-manager consent, Google-Sheet write-back, past-dated transfers, Payroll-Wizard mid-week rate proration, and the Manager / HR (read-only) / Accounting (rate-linked) Transfers tabs; **2026-07-24**: apply reconciles by TARGET dept (`planDepartmentApply`, stuck-backlog fix), Manager tab KPI+charts redesign, Accounting KPI cards + search + CSV/XLSX/PDF export |
| [new-hire-checklist.md](./features/new-hire-checklist.md) | HR New Hire Checklist: modal-only, read-only grid with atomic per-row writes, optimistic-concurrency edits (409 reconcile), and `useChecklistRoom` soft row-locks + change broadcasts |
| [onboarding-ip-assignment.md](./features/onboarding-ip-assignment.md) | IP Assignment / Talent Release / Copyright Waiver as the first public onboarding step; signed PDF via pdf-lib stored in `hr-onboarding-files`; HR IP Assignment tab; `/onboarding/preview` no-save preview mode (migration #73 PENDING) |
| [onboarding-pay-plans.md](./features/onboarding-pay-plans.md) | HR uploads one pay-plan PDF per (Department, Country); the matched plan rides the onboarding **invite** email (in-email card + attachment + `pay_plan`) via a Country picker stored as `invite_country`. Migration #80 (two files) PENDING |
| [onboarding-gmail-surname.md](./features/onboarding-gmail-surname.md) | Read-only auto-derived `@simple.biz` surname slice (collision-aware via `loadTakenWorkEmails`), sent to the workspace-account webhook in place of the legal surname for privacy. Migration #81 PENDING |
| [onboarding-calltools-username.md](./features/onboarding-calltools-username.md) | Lead Gen hires type their own Nickname; CallTools username auto-mints server-side as `<Nick> <F>. <surname slice>.` ("Mikey J. T." → "Mikey J. TH." on collision), hidden from the hire (preview-only field + "Test as Lead Gen" switch); sent to n8n via the `call_tools_creation` webhook (with pay rates, Lead Gen only) when the manager marks attendance. Migration `add_calltools_username_to_onboarding.sql` PENDING |
| [ceo-assistant.md](./features/ceo-assistant.md) | Floating Claude (Sonnet) chat widget on the CEO dashboard with read-only payroll tools over `disbursement_records`, admin-managed API key, audit logging. **Admin "Penny AI"** (`/api/admin/penny-chat` + `src/lib/anthropic/admin-tools.ts`, 2026-07-29) reuses this UI with audit/diagnostics/ops tools on top — **not yet documented**, see [audit-2026-07-30-session-log.md](./audits/audit-2026-07-30-session-log.md) |
| [employee-penny-ai.md](./features/employee-penny-ai.md) | **Employee Penny AI** (2026-08-19) — Overview-only chat bubble on **Claude Haiku 4.5**, **10 questions per Asia/Manila day** metered in `penny_employee_usage`. Third mount of the shared `CeoChatBubble`, not a fork. The access control is that **no employee tool takes an identity argument** (the route pins one email via `authorizeEmailAccess`; two tests enforce it), and it **reports figures rather than recomputing them** — pay via the CEO pay tool with the email pinned, rate/bonuses via the COE resolver. Warns as the count falls, then greys out; never vanishes. Migration **PENDING**: `scripts/apply-penny-employee-usage.mjs --apply` |
| [login-carla-song.md](./features/login-carla-song.md) | One-person sign-in easter egg (`carla@simple.biz`): 30s clip after the login intro with a mutable now-playing toast; the run is persisted **per tab** so it survives full page loads and resumes at the right offset. Untracked full track + alternate cuts must stay out of the repo |
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
| [audit-2026-07-30-session-log.md](./audits/audit-2026-07-30-session-log.md) — log of the 20 most recent Claude sessions (all of Jul 30, ~40 commits `7e6f9e5`→`fc25241`): mid-week proration on the paystub ×3 rules, the **PostgREST 1000-row sweep** (16 readers, live damage), Total Payout = full pay run, the shared-email KPI merge, the 13-person stale-Sheet transfer clobber, COP payees, two pending n8n automations, Payment Catalog Summary; plus **open deploy steps** and known documentation debt |
| [audit-2026-07-26-session-log.md](./audits/audit-2026-07-26-session-log.md) — log of the ~44 Claude sessions Jul 23 (evening)–Jul 26: the Readiness dashboard arc (fixers → audit sources → percents → hard-blocker recalibration), Payment Catalog Department tab (self-contained), wizard shows every dept + Configuration tab, Wise/bank-data trilogy incl. the 28 clobbered No-Bank submissions (restore OPEN), transfers unstuck + redesigned, Hubstaff auto-sync + MESA delete cascade; open deploy steps |
| [audit-2026-07-23-session-log.md](./audits/audit-2026-07-23-session-log.md) — log of the 20 most recent Claude sessions (Jul 21–23): Bank Preferred dropdown → approval gate → WIRES lock, Mark Paid bank-override, Payment Dispatch logos + focus-mode removal, MESA non-member deduction fix, HSL Case Managers; plus the Jul 22 Vercel Production-build stall + open deploy steps |
| [audit-2026-07-17-session-log.md](./audits/audit-2026-07-17-session-log.md) — log of the 20 most recent Claude sessions (Jul 15–17): MESA overhaul, tickets hardening, PAB payout-week fixes, GML export + open deploy steps |
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
