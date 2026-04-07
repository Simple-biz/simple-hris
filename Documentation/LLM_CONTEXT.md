# Project Context for LLMs

Simple HRIS is a **payroll processing tool** for a Philippines-based outsourcing company. Its primary workflow (called the "Friday Path") takes a weekly Hubstaff hours CSV export, computes base pay with overtime, applies per-department bonus rules, validates against a master employee list, and produces a final payout ledger.

Read the documents in this folder **before** making changes to the codebase. They capture business rules and architectural decisions that are not obvious from the code alone.

---

## Documentation Index

| File | What it covers |
|---|---|
| [SYSTEM_ARCHITECTURE.md](./SYSTEM_ARCHITECTURE.md) | Tech stack, repository structure, routing model, Supabase client strategy, design system (colors, typography, animations), environment variables, key architectural decisions |
| [DATA_SOURCES.md](./DATA_SOURCES.md) | All Supabase tables (schema + queries), all API routes, direct pg Pool usage, full data flow diagram (including client-side CSV re-parse path), CSV upload dedup, email normalization |
| [COMPONENTS.md](./COMPONENTS.md) | Every UI component — what it renders, why it is designed that way, all internal logic (Overview stats, PayrollWizard all 5 steps, Rates add/edit/delete, Sidebar, shadcn primitives) |
| [BUSINESS_LOGIC.md](./BUSINESS_LOGIC.md) | All business rules: payroll formulas, overtime threshold, perfect attendance detection (data source, weekday detection, UI indicators), department auto-assignment, per-department bonus schedules, master list coverage, CSV upload rules (two-pass column mapping + client-side re-parse), data integrity policies |
| [IMPLEMENTATION_PLAN_RBAC.md](./IMPLEMENTATION_PLAN_RBAC.md) | Planned RBAC system: 6 roles, full permission matrix, Supabase Auth integration, API route guards, UI gating, RLS policies, audit logging, 5-phase implementation plan |

---

## Quick Facts

- **Currency**: Philippine Peso (₱), `en-PH` locale
- **Overtime threshold**: 40 hours/week
- **Hours arithmetic**: Integer seconds (avoids float errors)
- **Employee identity key**: Email address (normalized: trimmed + lowercased)
- **Employee IDs (YYMM-NNNN)**: Derived display-only, never persisted
- **Dual-table writes**: Add/delete employee always touches both `employee_hourly_rates` and `global_master_list`
- **Column names have spaces**: PostgREST quoted identifiers (`"Work Email"`, `"Total worked"`, etc.)
- **Date columns can mismatch**: DB may have ISO (`"2026-03-24"`) while CSV has `"Mon 3/24"`. The upload code does date-aware mapping; the client also re-parses the CSV as a fallback.
- **PA detection requires daily data**: If daily columns are null in Supabase (column-name mismatch from old upload), a warning banner in Step 3 tells the user to re-upload.
- **Step 5 (Dispatch)**: Currently a placeholder — no payment API is called
- **Hogan Cycle toggle**: Flag only — no filtering logic implemented yet
- **Lead Gen department**: No bonuses, explicitly excluded by policy
- **No auth currently**: User is hardcoded as "Fran M / Senior Admin". RBAC plan exists in `IMPLEMENTATION_PLAN_RBAC.md`.

---

## Key Files

| Path | Purpose |
|---|---|
| `src/App.tsx` | Root SPA shell, `activeTab` state |
| `src/components/PayrollWizard.tsx` | Core feature, 2,987 lines, 5-step wizard |
| `src/components/Rates.tsx` | Profile viewer + CRUD |
| `src/components/Overview.tsx` | Dashboard |
| `src/lib/supabase/employee-rate-profiles.ts` | Multi-table profile merge engine |
| `src/lib/supabase/employees.ts` | Master list query + employee ID generation |
| `src/lib/supabase/hubstaff-hours-db.ts` | CSV upload + full table replace |
| `src/lib/payroll/compare-to-master.ts` | Coverage stats |
| `src/types.ts` | Shared TypeScript types |
| `src/index.css` | Design tokens, color variables, global styles |
| `.env.example` | All environment variables documented |
