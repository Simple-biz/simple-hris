# Database Map — Simple HRIS

All tables confirmed from `references/*.sql` migration files.  
Database: **Supabase PostgreSQL** (public schema).

---

## Table Inventory

### 1. `global_master_list`
**Purpose:** Canonical employee directory. Full-replace on each CSV/Sheets import.

| Column | Type | Notes |
|--------|------|-------|
| id | bigint IDENTITY PK | Auto-increment |
| import_batch_id | bigint | Upload batch grouping |
| source_file | text | Filename of import CSV |
| "Department" | text | Department name |
| "Name" | text | Display name (format: "Surname, Firstname") |
| "Personal Email" | text | Personal email (identity key for offboarding match) |
| "Work Email" | text | Work email (identity key for most lookups) |
| "Start Date" | text | Employment start date (text, not date type) |
| "Profile Photo URL" | text | Google profile photo URL |
| off_boarded_at | timestamptz | Set when offboarded |
| off_boarded_reason | text | Reason for offboarding |
| off_boarded_note | text | Free-form note |
| off_boarded_by | text | Who actioned it |
| employee_id | text | Generated YYMM-NNNN identifier |
| alt_work_email | text | Alternate work email |
| scheduled_deletion_at | timestamptz | Scheduled auto-delete |
| deletion_processed_at | timestamptz | When deletion ran |

**Status values:** N/A (off_boarded_at NULL = active)  
**Enums:** None  
**Relationships:** Referenced by employee_ids, employee_skill_sets, etc. via "Work Email"

---

### 2. `employee_hourly_rates`
**Purpose:** Denormalized current-rate cache per employee. Seeded from CSV; employee_rate_history is authoritative.

| Column | Type | Notes |
|--------|------|-------|
| id | bigint IDENTITY PK | |
| "Work Email" | text | Identity key |
| "Personal Email" | text | |
| "Regular Rate" | text | PHP/hr, stored as text |
| "OT Rate" | text | PHP/hr, OT rate |
| "Preferred Processor" | text | e.g. hurupay, wise, wires |
| "Bank Preferred" | text | Bank preference label |
| hurupay_email | text | Hurupay account email |
| wepay_email | text | WePay account email |
| higlobe_email | text | HiGlobe account email |
| higlobe_account_name | text | HiGlobe account holder name |
| wise_email | text | Wise email |
| wise_tag | text | Wise @tag |
| phone_number | text | Phone for Jeeves/wires |
| swift_code | text | SWIFT/BIC |
| full_address | text | Full mailing address |
| bank_name | text | Bank name |
| account_holder_name | text | Account holder |
| account_number | text | Bank account number |
| alt_bank_name | text | Alternate bank |
| alt_account_holder_name | text | Alternate account holder |
| alt_account_number | text | Alternate account number |
| alt_routing_number | text | Alternate routing number |

---

### 3. `employee_rate_history`
**Purpose:** Authoritative rate change log. Powers mid-cycle prorating.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_email | text NOT NULL | Lowercased work email |
| regular_rate | text | PHP/hr |
| ot_rate | text | PHP/hr |
| effective_from | date NOT NULL | Rate effective date |
| note | text | Reason for change |
| created_by | text | Who made the change |
| created_at | timestamptz | |

**Index:** `(lower(employee_email), effective_from DESC)`

---

### 4. `employee_ids`
**Purpose:** Employee-self-filled payment details and processor preferences.

| Column | Type | Notes |
|--------|------|-------|
| id | (PK, type inferred) | |
| work_email | text | Identity key |
| personal_email | text | |
| preferred_processor | text | |
| preferred_bank_slot | text DEFAULT 'primary' | |
| hurupay_email | text | |
| wepay_email | text | |
| higlobe_email | text | |
| higlobe_account_name | text | |
| wise_email | text | |
| wise_tag | text | |
| phone_number | text | |
| swift_code | text | |
| full_address | text | |
| bank_name | text | |
| account_holder_name | text | |
| account_number | text | |
| alt_bank_name | text | |
| alt_account_holder_name | text | |
| alt_account_number | text | |
| alt_routing_number | text | |
| hurupay_email (onboarding) | text | Prefilled from onboarding |
| is_mesa_member | boolean DEFAULT false | |
| orientation_done | boolean DEFAULT false | |

---

### 5. `employee_roles`
**Purpose:** Role assignments per user. Soft-deleted via revoked_at.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| work_email | text NOT NULL | |
| role | text NOT NULL | CHECK constraint (see values) |
| assigned_by | text | |
| assigned_at | timestamptz DEFAULT now() | |
| revoked_at | timestamptz | NULL = active |

**Role values:** `viewer`, `hr_coordinator`, `payroll_coordinator`, `payroll_manager`, `finance`, `admin`, `manager`, `orphanage_manager`, `ceo`

---

### 6. `employee_feature_permissions`
**Purpose:** Tab-level access overlay on top of role grants.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| work_email | text NOT NULL | |
| view_key | text NOT NULL | e.g. 'accounting', 'manager', 'hr' |
| feature | text NOT NULL | e.g. 'rates', 'payroll_wizard' |
| access | text NOT NULL | CHECK: 'view' or 'edit' |
| granted_by | text | |
| granted_at | timestamptz | |
| revoked_at | timestamptz | NULL = active |

---

### 7. `employee_skill_sets`
**Purpose:** Employee skills, current projects, manager notes.

| Column | Type | Notes |
|--------|------|-------|
| work_email | text PK | |
| role_title | text DEFAULT '' | Job title |
| currently_working_on | text DEFAULT '' | Current projects |
| skills | text DEFAULT '' | Skill tags |
| strengths | text DEFAULT '' | Strengths text |
| member_notes | text DEFAULT '' | Manager-authored notes |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 8. `employee_notifications`
**Purpose:** In-app notifications for rate changes and promotions.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| recipient_email | text NOT NULL | |
| type | text NOT NULL | CHECK: 'rate.change', 'promotion' |
| tone | text NOT NULL | CHECK: 'positive', 'neutral' |
| title | text NOT NULL | |
| message | text NOT NULL | |
| details | jsonb DEFAULT '{}' | Extra metadata |
| read_at | timestamptz | NULL = unread |
| created_at | timestamptz | |

---

### 9. `hr_pending_employees`
**Purpose:** Hiring pipeline — candidates before going live in master list.

| Column | Type | Notes |
|--------|------|-------|
| id | bigint IDENTITY PK | |
| name | text NOT NULL | |
| personal_email | text NOT NULL | |
| work_email | text | Assigned when ready |
| department | text NOT NULL | |
| job_description | text | |
| start_date | date | |
| source | text | Referral source |
| phone | text | |
| location | text | |
| regular_rate | numeric(10,2) | |
| ot_rate | numeric(10,2) | |
| status | text NOT NULL | CHECK: pending_work_email, ready, promoted, cancelled, no_show |
| notes | text | |
| no_show_at | timestamptz | |
| no_show_by | text | |
| no_show_note | text | |
| promoted_at | timestamptz | |
| promoted_to_master_id | uuid FK → global_master_list.id | |
| scheduled_deletion_at | timestamptz | |
| deletion_processed_at | timestamptz | |
| orientation_done | boolean DEFAULT false | |
| project_names | text | Comma-separated project list |
| created_at | timestamptz | |
| created_by | text | |
| updated_at | timestamptz | |

---

### 10. `hr_onboarding_submissions`
**Purpose:** New hire onboarding form data (token-based public form).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| token | text NOT NULL UNIQUE | Shared with new hire via email |
| status | text NOT NULL | CHECK: pending, submitted, archived |
| created_by | text | HR who created the invite |
| invite_name | text | Pre-filled name |
| invite_personal_email | text | Pre-filled email |
| invite_department | text | Pre-filled department |
| invite_note | text | HR note to candidate |
| full_name | text | Submitted by candidate |
| phone | text | |
| email | text | |
| non_solicitation_signature | text | |
| privacy_signature | text | |
| w8ben_applicable | boolean | |
| w8ben_file_path | text | Supabase storage path |
| w8ben_file_name | text | |
| payment_method | text | CHECK: hurupay, wires |
| hurupay_email | text | |
| bank_full_name | text | |
| bank_account_name | text | |
| bank_account_number | text | |
| bank_swift_code | text | |
| bank_street | text | |
| bank_city | text | |
| bank_province | text | |
| bank_postal_code | text | |
| bank_full_address | text | |
| contract_signature | text | |
| contract_date | date | |
| notes | text | |
| submitted_at | timestamptz | |
| archived_at | timestamptz | |
| created_at | timestamptz | |

---

### 11. `offboarded_sheet`
**Purpose:** Snapshot of employees offboarded (synced from Google Sheets).

| Column | Type | Notes |
|--------|------|-------|
| id | bigserial PK | |
| personal_email | text NOT NULL | |
| work_email | text | |
| name | text | |
| department | text | |
| start_date | text | |
| off_boarded_at | timestamptz | |
| off_boarded_reason | text | |
| off_boarded_note | text | |
| off_boarded_by | text | |
| synced_at | timestamptz DEFAULT now() | |

---

### 12. `hubstaff_hours`
**Purpose:** Time-tracking rows imported from Hubstaff weekly CSV exports.

| Column | Type | Notes |
|--------|------|-------|
| id | bigint IDENTITY PK | (inferred) |
| email | text | Employee work email |
| name | text | |
| hours | text | HH:MM format string |
| decimal_hours | numeric | Parsed decimal hours |
| department | text | From "Job type" column |
| source_file | text | Upload filename |
| upload_id | uuid FK → hubstaff_uploads | |
| period_start | date | Parsed from filename |
| period_end | date | Parsed from filename |

---

### 13. `hubstaff_uploads`
**Purpose:** Archive of Hubstaff CSV import events.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | Referenced by payment_dispatches, disbursement_records |
| source_file | text | |
| uploaded_at | timestamptz | |
| uploaded_by | text | |
| row_count | integer | |
| is_current | boolean DEFAULT false | |

---

### 14. `payment_dispatches`
**Purpose:** Log of every payment sent to an employee (Lenny's dispatch log).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| cycle_id | uuid FK → hubstaff_uploads | |
| cycle_period_start | date | |
| cycle_period_end | date | |
| cycle_source_file | text | |
| recipient_email | text NOT NULL | |
| recipient_name | text | |
| processor | text NOT NULL | e.g. hurupay, wise, wires |
| bank_preferred_raw | text | |
| recipient_preferred_bank | text | |
| recipient_account_number | text | |
| recipient_account_holder | text | |
| recipient_swift_code | text | |
| amount_usd | numeric(10,2) | |
| amount_php | numeric(12,2) | |
| transaction_id | text NOT NULL | |
| bank_used | text NOT NULL | |
| sent_date | date NOT NULL | |
| arrival_date | date | |
| status | text NOT NULL DEFAULT 'paid' | CHECK: paid, not_paid, threshold, problem |
| note | text | |
| created_by | text | |
| created_at | timestamptz | |

---

### 15. `disbursement_records`
**Purpose:** One row per (week, employee) — analytic source for Reports tab.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| cycle_period_start | date NOT NULL | |
| cycle_period_end | date NOT NULL | |
| source_file | text NOT NULL | |
| upload_id | uuid FK → hubstaff_uploads | |
| recipient_email | text NOT NULL | |
| recipient_name | text | |
| total_hours | numeric(7,2) | |
| regular_hours | numeric(7,2) | |
| ot_hours | numeric(7,2) | |
| regular_rate_php | numeric(10,2) | |
| ot_rate_php | numeric(10,2) | |
| amount_php | numeric(12,2) | |
| amount_usd | numeric(10,2) | |
| fx_rate | numeric(10,4) | |
| status | text NOT NULL DEFAULT 'pending' | CHECK: pending, paid, not_paid, threshold, problem |
| paid_amount_usd | numeric(10,2) | |
| paid_at | date | |
| bank_used | text | |
| transaction_id | text | |
| dispatch_id | uuid FK → payment_dispatches | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Unique constraint:** `(source_file, recipient_email)`

---

### 16. `department_managers`
**Purpose:** Manager-to-department assignment (many-to-many via rows).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| manager_email | text NOT NULL | |
| department | text NOT NULL | |
| assigned_by | text | |
| assigned_at | timestamptz DEFAULT now() | |
| revoked_at | timestamptz | NULL = active |

**Unique constraint:** `(manager_email, department)` — but multiple rows possible per pair (historical)

---

### 17. `department_transfer_requests`
**Purpose:** Employee department transfer workflow.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_email | text NOT NULL | |
| employee_name | text | |
| employee_work_email | text | |
| employee_personal_email | text | |
| from_department | text NOT NULL | |
| to_department | text NOT NULL | |
| reason | text | |
| status | text NOT NULL DEFAULT 'pending' | CHECK: pending, approved, rejected, cancelled |
| requested_by | text NOT NULL | |
| approver_email | text | |
| approver_note | text | |
| decided_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 18. `swall_posts`
**Purpose:** Company social feed (S-Wall) posts.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| author_email | text NOT NULL | |
| author_name | text | |
| body | text NOT NULL | |
| created_at | timestamptz | |

---

### 19. `swall_reactions`
**Purpose:** Emoji reactions on posts.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| post_id | uuid FK → swall_posts(id) ON DELETE CASCADE | |
| user_email | text NOT NULL | |
| emoji | text NOT NULL | CHECK: 👍❤️😂🔥😮👏 |
| created_at | timestamptz | |

**Unique constraint:** `(post_id, user_email, emoji)`

---

### 20. `swall_comments`
**Purpose:** Comments on S-Wall posts.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| post_id | uuid FK → swall_posts(id) ON DELETE CASCADE | |
| author_email | text NOT NULL | |
| author_name | text | |
| body | text NOT NULL | |
| created_at | timestamptz | |

---

### 21. `announcements`
**Purpose:** Company-wide and department-scoped announcements.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| author_email | text NOT NULL | |
| author_name | text | |
| scope | text NOT NULL | CHECK: general, department |
| department | text | NULL when scope = general |
| title | text NOT NULL | |
| body | text NOT NULL | |
| pinned | bool DEFAULT false | |
| created_at | timestamptz | |

---

### 22. `leave_requests`
**Purpose:** Employee leave request and approval tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_email | text NOT NULL | |
| employee_name | text | |
| department | text | |
| start_date | date NOT NULL | |
| end_date | date NOT NULL | |
| leave_type | text NOT NULL | |
| reason | text | |
| status | text NOT NULL DEFAULT 'pending' | CHECK: pending, approved, rejected, cancelled |
| manager_email | text | |
| approver_email | text | |
| approver_note | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 23. `employee_gift_shipping_details`
**Purpose:** Gift shipping data per employee per milestone.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| personal_email | text NOT NULL | |
| milestone_index | int NOT NULL CHECK >= 1 | 1=1yr, 2=2yr, etc. |
| milestone_date | date NOT NULL | |
| preferred_delivery_location | text DEFAULT '' | |
| active_contact_number | text DEFAULT '' | |
| notes | text DEFAULT '' | |
| status | text DEFAULT 'pending' | CHECK: pending, approved, rejected |
| decided_by | text | |
| decided_at | timestamptz | |
| decision_note | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**Unique:** `(personal_email, milestone_index)`

---

### 24. `gift_catalog`
**Purpose:** Singleton gift catalog (one row, id=1).

| Column | Type | Notes |
|--------|------|-------|
| id | int PK DEFAULT 1 | Singleton pattern |
| items | jsonb DEFAULT '[]' | Gift items array |
| anniversaries | jsonb DEFAULT '[]' | Anniversary milestones |
| suggestions | jsonb DEFAULT '[]' | Gift suggestions |
| updated_by | text | |
| updated_at | timestamptz | |

---

### 25. `gift_payments`
**Purpose:** Batch gift payments to vendors.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| created_by_email | text | |
| period_label | text | |
| batch_label | text | |
| vendor | jsonb | Vendor info |
| items | jsonb | Item list |
| shipping_fee | numeric(12,2) | |
| ordered_by | text | |
| total_usd | numeric(12,2) | |
| transaction_id | text | |
| staff | text | |
| date_sent | date | |
| arrival_date | date | |
| our_bank | text | |
| status | text DEFAULT 'pending' | CHECK: pending, sent, paid, cancelled |
| notes | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 26. `gift_tracker_notes`
**Purpose:** Free-form tracker notes per employee in gift tracker view.

| Column | Type | Notes |
|--------|------|-------|
| personal_email | text PK | |
| note | text DEFAULT '' | |
| updated_by | text | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 27. `orphanage_budget_requests`
**Purpose:** Budget requests for orphanage visits.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| submitter_email | text NOT NULL | |
| visit_type | text NOT NULL | CHECK: monthly, frequent, special |
| mission_trip | boolean DEFAULT false | |
| notes | text | |
| subtotal | numeric(12,2) | |
| leftover | numeric(12,2) | |
| final_amount | numeric(12,2) | |
| payload | jsonb | Budget line items |
| bank_account_name | text NOT NULL | |
| bank_account_number | text NOT NULL | |
| bank_name | text NOT NULL | |
| swift_code | text NOT NULL | |
| status | text DEFAULT 'pending' | CHECK: pending, approved, rejected |
| decided_by | text | |
| decided_at | timestamptz | |
| decision_note | text | |
| submitted_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 28. `orphanage_dispatches`
**Purpose:** Bank payment dispatches for orphanage budget requests and gift shipping.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| dispatch_type | text NOT NULL | CHECK: budget_request, gift_shipping |
| budget_request_id | uuid FK → orphanage_budget_requests | |
| gift_shipping_id | uuid FK → employee_gift_shipping_details | |
| label | text NOT NULL | |
| submitter_email | text NOT NULL | |
| bank_name | text | |
| bank_account_name | text | |
| bank_account_number | text | |
| swift_code | text | |
| amount_php | numeric(12,2) NOT NULL | |
| status | text DEFAULT 'pending' | CHECK: pending, paid, problem |
| transaction_id | text | |
| bank_used | text | |
| sent_date | date | |
| note | text | |
| created_by | text | |
| paid_by | text | |
| paid_at | timestamptz | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 29. `pab_disputes`
**Purpose:** Payroll Accuracy Board — employee disputes on pay calculations.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| employee_email | text NOT NULL | |
| employee_name | text | |
| department | text | |
| dispute_type | text | e.g. orphanage_visit, ceo_visitation |
| dispute_date | date | Date being disputed |
| reason | text | |
| details | text | |
| status | text DEFAULT 'pending' | CHECK: pending, approved, rejected |
| filed_by | text | 'employee' or manager email |
| approver_email | text | First-stage approver |
| second_approver_email | text | Second-stage (Carla) for manager-submitted |
| approver_note | text | |
| decided_at | timestamptz | |
| period_week | date | PAB week this belongs to |
| source_file | text | Hubstaff cycle this applies to |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 30. `contractor_profiles`
**Purpose:** Contractor payment profile (bank + processor details).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| contractor_email | text NOT NULL UNIQUE | |
| display_name | text | |
| preferred_processor | text | |
| preferred_bank_slot | text DEFAULT 'primary' | |
| hurupay_email | text | |
| wepay_email | text | |
| higlobe_email | text | |
| higlobe_account_name | text | |
| wise_email | text | |
| wise_tag | text | |
| phone_number | text | |
| full_address | text | |
| bank_name | text | |
| account_holder_name | text | |
| account_number | text | |
| swift_code | text | |
| alt_bank_name | text | |
| alt_account_holder_name | text | |
| alt_account_number | text | |
| alt_routing_number | text | |
| from_entity_name | text | Invoice sender entity |
| from_name | text | |
| from_address | text | |
| from_city_state_zip | text | |
| from_country | text DEFAULT 'Philippines' | |
| logo_data_url | text | Base64 company logo |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 31. `contractor_invoices`
**Purpose:** Contractor-generated invoice records.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| contractor_email | text NOT NULL | |
| invoice_number | text NOT NULL | |
| invoice_date | date | |
| due_date | date | |
| from_entity_name | text | |
| from_name | text | |
| from_address | text | |
| from_city_state_zip | text | |
| from_country | text DEFAULT 'Philippines' | |
| to_company | text DEFAULT 'Simple.biz' | |
| to_address | text DEFAULT 'Remote/USA' | |
| to_city_state_zip | text | |
| to_country | text DEFAULT 'USA' | |
| line_items | jsonb NOT NULL DEFAULT '[]' | |
| notes | text | |
| subtotal | numeric(12,2) | |
| tax_total | numeric(12,2) | |
| total | numeric(12,2) | |
| status | text DEFAULT 'pending' | |
| logo_data_url | text | |
| created_at | timestamptz | |

---

### 32. `hsl_team_members`
**Purpose:** Hogan Smith Law agent roster (synced from Google Sheets).

| Column | Type | Notes |
|--------|------|-------|
| email | text PK | |
| full_name | text | |
| hsl_name | text | Nickname/alias |
| role_raw | text | Original role string from sheet |
| dept_key | text | One of 13 HSL department keys |
| is_manager | boolean DEFAULT false | |
| hourly_rate | numeric(10,2) | |
| ot_rate | numeric(10,2) | |
| kpi_bonus | text | KPI/bonus field from sheet |
| upload_id | uuid FK → hsl_agent_uploads | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**HSL dept_key values:** ssd_medical_records, care_team, case_manager, filing_specialist, intake_specialist, post_hearing_prep, collections, healthcare_team_lead, collections_tl, chelzy_asst, vicky_asst_tl, case_mgmt_asst_tl, case_mgr_no_kpi

---

### 33. `hsl_agent_uploads`
**Purpose:** Archive of HSL Google Sheets sync events.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| source_file | text | |
| uploaded_at | timestamptz | |
| uploaded_by | text | |
| row_count | integer | |
| is_current | boolean DEFAULT false | |

---

### 34. `hsl_bonus_period_status`
**Purpose:** Per-department bonus period status tracking.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | (inferred) |
| dept_key | text | HSL department key |
| period_type | text | CHECK: weekly, monthly |
| period_label | text | e.g. "2026-W21" |
| status | text | CHECK: draft, ready, locked |
| kpi_meta | jsonb | KPI sub-team scores (in-memory only today) |
| created_at | timestamptz | |
| updated_at | timestamptz | |

---

### 35. `fpu_enrollments`
**Purpose:** Financial Peace University sign-ups.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| email | text NOT NULL | |
| full_name | text NOT NULL | |
| department | text NOT NULL | |
| shift_schedule_est | text NOT NULL | EST shift schedule |
| created_at | timestamptz | |

---

### 36. `user_presence`
**Purpose:** Last-seen timestamp for online presence indicators.

| Column | Type | Notes |
|--------|------|-------|
| email | text PK | |
| name | text | |
| last_seen_at | timestamptz DEFAULT now() | |

---

### 37. `manager_team_wallpapers`
**Purpose:** Per-department team banner image.

| Column | Type | Notes |
|--------|------|-------|
| department | text PK | |
| image_data_url | text NOT NULL | Base64 data URL |
| background_position | text DEFAULT '50% 50%' | CSS background-position |
| updated_by | text | |
| updated_at | timestamptz | |

---

### 38. `app_settings`
**Purpose:** Application-wide key-value settings store.

| Column | Type | Notes |
|--------|------|-------|
| key | text PK | Setting key |
| value | jsonb | JSON value |
| updated_by | text | |
| updated_at | timestamptz | |

**Known keys:** `usd_to_php_rate`, `auth.force_logout_map`, `payroll.dispatch_lock`, `pab_period_overrides`, `pab_period_active_month`

---

### 39. `master_list_uploads`
**Purpose:** Archive of global_master_list import events.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | (inferred from architecture pattern) |
| source_file | text | |
| uploaded_at | timestamptz | |
| uploaded_by | text | |
| row_count | integer | |
| is_current | boolean | |

---

## Views

### `active_hsl_agents`
Filters `hsl_team_members` to rows matching `hsl_agent_uploads.is_current = true`. Columns: email, full_name, hsl_name, Department/Role, KPI/Bonus, dept_key, is_manager, hourly_rate, ot_rate, upload_id, created_at, updated_at.

### `employee_hourly_rates_current`
Deduped latest rate per work email from `employee_hourly_rates`.
