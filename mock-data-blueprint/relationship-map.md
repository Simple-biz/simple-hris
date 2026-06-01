# Relationship Map — Simple HRIS

## Identity Key Convention

This system uses **email as the universal identity key** — not surrogate UUIDs.  
- `work_email` (lowercase) links most tables to each other.  
- `personal_email` links gift/onboarding tables to the master list.  
- Foreign key integrity is largely **application-enforced**, not database-enforced (to allow partial imports and flexible Supabase queries).

---

## Core Identity Chain

```
global_master_list ["Work Email"]
       │
       ├──► employee_hourly_rates ["Work Email"]       (current rate cache)
       ├──► employee_rate_history [employee_email]     (rate history log)
       ├──► employee_ids [work_email]                  (self-service payment details)
       ├──► employee_roles [work_email]                (role grants)
       ├──► employee_feature_permissions [work_email]  (tab-level access)
       ├──► employee_skill_sets [work_email]           (skills/profile)
       ├──► employee_notifications [recipient_email]   (in-app alerts)
       ├──► department_managers [manager_email]        (manager assignment)
       ├──► user_presence [email]                      (last-seen heartbeat)
       ├──► leave_requests [employee_email]            (leave history)
       ├──► swall_posts [author_email]                 (social posts)
       ├──► payment_dispatches [recipient_email]       (payroll log)
       ├──► disbursement_records [recipient_email]     (payroll analytics)
       ├──► fpu_enrollments [email]                    (FPU signups)
       │
       └──► global_master_list ["Personal Email"]
                   │
                   ├──► employee_gift_shipping_details [personal_email]
                   ├──► gift_tracker_notes [personal_email]
                   └──► offboarded_sheet [personal_email]
```

---

## Payroll Processing Chain

```
hubstaff_uploads [id]
       │
       ├──► hubstaff_hours [upload_id]          (raw time records)
       ├──► payment_dispatches [cycle_id]        (dispatch log)
       └──► disbursement_records [upload_id]     (analytics records)
                   │
                   └──► payment_dispatches [dispatch_id]  (linked after pay)
```

---

## HR Pipeline Chain

```
hr_pending_employees [id]
       │
       ├──► hr_onboarding_submissions [token]    (onboarding form)
       │             (linked via add_onboarding_pending_link migration)
       └──► global_master_list [promoted_to_master_id]   (after promotion)
```

---

## Orphanage Program Chain

```
orphanage_budget_requests [id]
       │
       └──► orphanage_dispatches [budget_request_id]   (payment dispatch)

employee_gift_shipping_details [id]
       │
       └──► orphanage_dispatches [gift_shipping_id]    (gift dispatch)

pab_disputes
       │
       └──► (references employee_email, dispute_date, source_file)
```

---

## HSL Bonus Chain

```
hsl_agent_uploads [id]
       │
       └──► hsl_team_members [upload_id]        (current roster)
                   │
                   └──► hsl_bonus_period_status [dept_key]
```

---

## Social Feed Chain

```
swall_posts [id]
       │
       ├──► swall_reactions [post_id]   ON DELETE CASCADE
       └──► swall_comments [post_id]    ON DELETE CASCADE
```

---

## Contractor Chain

```
contractor_profiles [contractor_email]
       │
       └──► contractor_invoices [contractor_email]   (invoice history)
```

---

## Department Chain

```
global_master_list ["Department"]
       │
       ├──► department_managers [department]          (manager assignment)
       ├──► department_transfer_requests [from/to_department]
       ├──► announcements [department]                (dept-scoped announcements)
       ├──► leave_requests [department]
       ├──► hr_pending_employees [department]
       ├──► manager_team_wallpapers [department PK]
       └──► employee_feature_permissions [view_key]   (indirectly, scope)
```

---

## Explicit Foreign Keys (Database-Enforced)

| Table | Column | References | On Delete |
|-------|--------|-----------|-----------|
| payment_dispatches | cycle_id | hubstaff_uploads(id) | SET NULL |
| disbursement_records | upload_id | hubstaff_uploads(id) | SET NULL |
| disbursement_records | dispatch_id | payment_dispatches(id) | SET NULL |
| orphanage_dispatches | budget_request_id | orphanage_budget_requests(id) | SET NULL |
| orphanage_dispatches | gift_shipping_id | employee_gift_shipping_details(id) | SET NULL |
| hr_pending_employees | promoted_to_master_id | global_master_list(id) | SET NULL |
| hsl_team_members | upload_id | hsl_agent_uploads(id) | SET NULL |
| swall_reactions | post_id | swall_posts(id) | CASCADE |
| swall_comments | post_id | swall_posts(id) | CASCADE |

---

## Entity Relationship Summary

```
┌─────────────────────────────────────────────────────────┐
│                    IDENTITY CORE                         │
│  global_master_list ◄──► employee_hourly_rates          │
│         │                employee_rate_history           │
│         │                employee_ids                    │
│         │                employee_roles                  │
│         │                employee_feature_permissions    │
│         │                employee_skill_sets             │
│         │                employee_notifications          │
└─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│                   PAYROLL CYCLE                          │
│  hubstaff_uploads ──► hubstaff_hours                    │
│       │               payment_dispatches                 │
│       └────────────► disbursement_records               │
└─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│                HR PIPELINE                              │
│  hr_pending_employees ──► hr_onboarding_submissions     │
│       └──────────────────► global_master_list           │
└─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────┐
│             ENGAGEMENT & PROGRAMS                        │
│  swall_posts ──► swall_reactions/comments               │
│  announcements                                          │
│  leave_requests                                         │
│  pab_disputes                                           │
│  orphanage_budget_requests ──► orphanage_dispatches     │
│  employee_gift_shipping ────► orphanage_dispatches      │
│  gift_catalog / gift_payments / gift_tracker_notes      │
│  fpu_enrollments                                        │
│  hsl_team_members ──► hsl_bonus_period_status          │
│  contractor_profiles ──► contractor_invoices            │
└─────────────────────────────────────────────────────────┘
```

---

## Generation Order (Dependency-Safe)

When populating a demo database, tables must be created in this order:

**Round 1 — No dependencies:**
1. `app_settings`
2. `gift_catalog`
3. `hubstaff_uploads`
4. `hsl_agent_uploads`
5. `master_list_uploads`

**Round 2 — Core entities (depend only on Round 1):**
6. `global_master_list`
7. `hsl_team_members`
8. `hubstaff_hours`

**Round 3 — Employee extensions (depend on global_master_list):**
9. `employee_hourly_rates`
10. `employee_rate_history`
11. `employee_ids`
12. `employee_roles`
13. `employee_feature_permissions`
14. `employee_skill_sets`
15. `employee_notifications`
16. `user_presence`
17. `department_managers`
18. `manager_team_wallpapers`

**Round 4 — HR pipeline:**
19. `hr_pending_employees`
20. `hr_onboarding_submissions`
21. `offboarded_sheet`
22. `fpu_enrollments`
23. `department_transfer_requests`

**Round 5 — Payroll:**
24. `payment_dispatches` (needs hubstaff_uploads)
25. `disbursement_records` (needs payment_dispatches + hubstaff_uploads)

**Round 6 — Content/Social:**
26. `announcements`
27. `swall_posts`
28. `swall_reactions` (needs swall_posts)
29. `swall_comments` (needs swall_posts)
30. `leave_requests`
31. `pab_disputes`

**Round 7 — Gift/Orphanage:**
32. `employee_gift_shipping_details`
33. `gift_tracker_notes`
34. `gift_payments`
35. `orphanage_budget_requests`
36. `orphanage_dispatches` (needs budget_requests + gift_shipping)

**Round 8 — Contractor:**
37. `contractor_profiles`
38. `contractor_invoices` (needs contractor_profiles)

**Round 9 — HSL Bonus:**
39. `hsl_bonus_period_status`
