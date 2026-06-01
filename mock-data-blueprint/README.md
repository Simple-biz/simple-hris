# Mock Data Blueprint — Simple HRIS

Generated: 2026-05-31  
Purpose: Complete blueprint for converting Simple HRIS into a portfolio-safe demo environment.

---

## What This Is

A full analysis of the Simple HRIS codebase — database schema, module inventory, privacy audit, and mock data generation plan — produced **before any code is modified**. Use this as the spec for a follow-up task that actually generates and inserts the mock data.

---

## Files in This Directory

| File | Description |
|------|-------------|
| `README.md` | This file |
| `repository-analysis.md` | Full tech stack, module inventory, external integrations, page routes |
| `database-map.md` | Every table with all columns, types, constraints, and status enums |
| `relationship-map.md` | Entity relationships, FK chain, generation order |
| `mock-data-plan.json` | Entities list, relationships, required counts, dependencies, generation order |
| `mock-schema-map.json` | Every table → mock file mapping with field-level replacement guidance |
| `mock-generation-rules.json` | Detailed field-by-field generation rules, Faker library recommendations |
| `privacy-audit-report.md` | Every location of real PII or credentials with severity and action items |

---

## Database Summary

| Metric | Count |
|--------|-------|
| Tables | 39 |
| Views | 2 |
| API Routes | 115 |
| SQL migration files | 77 |
| HRIS modules | 16 |
| Real employee records in seed files | ~789 + |
| Real home addresses | ~1025 |

---

## Critical Action Before Publishing

**There is a live Google Cloud service account private key at:**
```
references/global-master-list-hris-48ccf40267e0.json
```

**Do this NOW:**
1. Go to Google Cloud Console → IAM & Admin → Service Accounts
2. Find `global-master-list-hris@global-master-list-hris.iam.gserviceaccount.com`
3. Delete the key with fingerprint `48ccf40267e0`
4. Delete the JSON file from the repo
5. Purge it from git history: `git filter-repo --path references/global-master-list-hris-48ccf40267e0.json --invert-paths`

---

## Mock Data Generation Order

To avoid FK violations, generate tables in this sequence:

```
1. app_settings, gift_catalog, hubstaff_uploads, hsl_agent_uploads
2. global_master_list, hsl_team_members, hubstaff_hours
3. employee_hourly_rates, employee_rate_history, employee_ids
4. employee_roles, employee_feature_permissions, employee_skill_sets
5. employee_notifications, user_presence, department_managers
6. manager_team_wallpapers, hr_pending_employees, hr_onboarding_submissions
7. offboarded_sheet, fpu_enrollments, department_transfer_requests
8. payment_dispatches, disbursement_records
9. announcements, swall_posts, swall_reactions, swall_comments
10. leave_requests, pab_disputes
11. employee_gift_shipping_details, gift_tracker_notes, gift_payments
12. orphanage_budget_requests, orphanage_dispatches
13. contractor_profiles, contractor_invoices
14. hsl_bonus_period_status
```

---

## Key Design Decisions for Mock Data

1. **Email domain:** Use `@demo.biz` for work emails, `@example.com` for personal emails
2. **Names:** Use Filipino name pools from `mock-generation-rules.json` — Western-name generators produce unconvincing results
3. **Bank details:** 12-digit random account numbers only — never use real bank account formats
4. **Addresses:** City + Province + Philippines only — no street numbers, no barangay
5. **Rates:** PHP 200–600 regular; 1.5x OT — matches real pay scale structure
6. **Counts:** 60 employees gives enough data for all features to look populated without being overwhelming

---

## Next Steps (Phase 2 Task)

Once this blueprint is reviewed and approved:

1. Write `scripts/generate-mock-data.mjs` using `@faker-js/faker`
2. Generate JSON files into `mock-data-blueprint/mock-data/`
3. Convert JSON files to `references/seed_*.DEMO.sql` INSERT statements
4. Update `src/constants.ts` with fictional MOCK_USERS
5. Test against a fresh Supabase project to verify all FK constraints pass
6. Replace `.env.example` domain references
7. Final scan: `grep -r "simple.biz" . --include="*.sql" --include="*.ts" --include="*.tsx"`
