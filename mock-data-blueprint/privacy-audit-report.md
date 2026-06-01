# Privacy Audit Report — Simple HRIS

**Audit Date:** 2026-05-31  
**Scope:** All source files in `c:\Users\Itachi\Desktop\simple-hris\` (excluding `node_modules/`, `.next/`, `.git/`)  
**Purpose:** Identify all real PII and credentials that must be replaced before publishing as a portfolio project.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL — Credentials / Private Keys | 1 | MUST REMOVE IMMEDIATELY |
| HIGH — Real PII (names, emails, addresses, payroll) | 6 files | MUST REPLACE |
| MEDIUM — Semi-real mock / structural data | 2 files | SHOULD SANITIZE |
| LOW — Config references, non-sensitive identifiers | 3 | REVIEW / ACCEPTABLE |

---

## CRITICAL FINDINGS

### CRIT-01: Google Cloud Service Account Private Key

**File:** `references/global-master-list-hris-48ccf40267e0.json`  
**Severity:** CRITICAL  
**What:** Complete Google Cloud service account JSON credential file containing:
- Full RSA-2048 private key (multi-line PEM format)
- Service account email: `global-master-list-hris@global-master-list-hris.iam.gserviceaccount.com`
- Client ID: `102740592690982645271`
- Project ID: `global-master-list-hris`
- Private key ID (key fingerprint)

**Risk:** Anyone with access to this file can authenticate as the service account and access any Google API (Sheets, Drive, etc.) it has been granted access to. This is a live credential.

**Action Required:**
1. **Immediately revoke** the key in Google Cloud Console → IAM & Admin → Service Accounts → Delete Key
2. **Remove the file** from the repository entirely
3. **Remove from git history** using `git filter-repo` or BFG Repo Cleaner
4. Add `references/*.json` to `.gitignore`
5. For portfolio version: replace with a placeholder `google-service-account.example.json` containing only the field names (no values)

---

## HIGH SEVERITY FINDINGS

### HIGH-01: Real Employee Master List (~789 Records)

**File:** `references/seed_global_master_list.sql`  
**Severity:** HIGH  
**Lines:** 19–814+  
**What:** SQL INSERT statements with real employee data:
- Full names (format: "Surname, Firstname" — real Philippine employees)
- Personal Gmail/Yahoo/iCloud email addresses
- Work emails on `simple.biz` domain
- Employment start dates
- Department assignments

**Estimated Scope:** ~789 employee records

**Action Required:** Replace entire file with `seed_global_master_list.DEMO.sql` using fictional names from the `mock-generation-rules.json` Filipino name pools and `@example.com` / `@demo.biz` emails.

---

### HIGH-02: Employee Payroll Data (~431 Records)

**File:** `references/seed_employee_hourly_rates.sql`  
**Severity:** HIGH  
**Lines:** 11–444  
**What:** 431 employee compensation records:
- Work emails paired with personal emails (linking identities)
- Hourly rates in PHP (175–500+ PHP/hour)
- OT rates
- Real processor/bank preference data

**Estimated Scope:** ~431 employee rate records

**Action Required:** Replace with `seed_employee_hourly_rates.DEMO.sql` using fictional emails and rate values within realistic ranges (200–600 PHP regular, 1.5x OT).

---

### HIGH-03: Physical Home Addresses (~1025 Records)

**File:** `references/seed_global_master_list_addresses.sql`  
**Severity:** HIGH  
**Lines:** 24–50+  
**What:** Complete home addresses for ~1025 employees:
- Street addresses with lot/building numbers
- Barangay names
- Cities and provinces
- Postal codes
- Full formatted address strings
- Linked via work emails (`name@simple.biz`)

**Risk:** This is the most sensitive file — home addresses combined with names constitutes a serious privacy breach. Physical safety risk if exposed.

**Action Required:** Replace entire file with city-level-only addresses (`City, Province, Philippines`) — NO street numbers, no barangay. Or omit the addresses column entirely for portfolio use.

---

### HIGH-04: US Employee PII (~12 Records)

**File:** `references/seed_us_global_master_list.sql`  
**Severity:** HIGH  
**Lines:** 21–45  
**What:** 12 US-based employee records:
- Full real names: "Arndt, Thomas", "Thibodeau, Jeffrey", "Lepley, Teal", "Thomas, Carla"
- Real personal emails: `tmarndt11@gmail.com`, `jefft149@yahoo.com`, `tclepley@ncsu.edu`, `carlathomas0112@gmail.com`
- Work emails: `thomas@simple.biz`, `jeff@simple.biz`, `teal@simple.biz`, `carla@simple.biz`
- Employment start dates

**Risk:** US employees have CCPA/state privacy law protections. Real personal email + name = PII.

**Action Required:** Replace with fictional US-sounding names and `@example.com` personal emails. Map to new fictional `@demo.biz` work emails.

---

### HIGH-05: HSL Team Member PII (~80 Records with Real Emails)

**File:** `references/seed_hsl_team_members.sql`  
**Severity:** HIGH  
**Lines:** 19–130+  
**What:** ~80 real employee records for Hogan Smith Law agents:
- Real full names in Filipino format
- Real `@simple.biz` work emails
- Hourly rates
- Role assignments
- "HSL names" (Western aliases used in client-facing context)

**Action Required:** Replace names and emails with fictional equivalents. Keep the structural data (rates, roles, dept_keys) as it drives the HSL bonus demo functionality.

---

### HIGH-06: Department Manager Seed (Real Names + Roles)

**File:** `references/department_managers_seed_kane_client_va_ai_api.sql`  
**Severity:** HIGH  
**What:** Hardcoded real people's names and `@simple.biz` emails granted specific roles/permissions, including at least `kaner@simple.biz` and `carla@simple.biz` and other real employee identifiers.

**Action Required:** Replace all `@simple.biz` emails with `@demo.biz` fictional equivalents.

---

## MEDIUM SEVERITY FINDINGS

### MED-01: Hardcoded Mock Users in Source Code

**File:** `src/constants.ts`  
**Severity:** MEDIUM  
**Lines:** 3–66  
**What:** MOCK_USERS array with:
- Name: "Fran M", "Thomas Hogan" — semi-real names (Thomas Hogan = the law firm owner name)
- Emails: `fran.m@simple.biz`, `thomas.h@simple.biz` — real-looking company emails
- Bank account numbers: `123456789`, `987654321`
- Routing numbers: `987654321`, `123456789`
- Addresses: `123 Main St, New York, NY 10001` (generic but fake)
- Hourly rates: 50.0, 60.0, 45.0 USD

**Risk:** "Thomas Hogan" is the name of the law firm principal (Hogan Smith Law). Using his name in mock data could be misleading.

**Action Required:** Replace names with completely neutral fictional names (e.g. "Alex Demo", "Sam Example"). Replace `@simple.biz` emails with `@demo.biz`. Bank numbers are already fake sequences — acceptable to keep structure but change values.

---

### MED-02: SQL Migration with Real Role Assignments

**File:** `references/grant_manager_roles.sql`  
**Severity:** MEDIUM  
**Lines:** 37–49  
**What:** INSERT statements granting `manager` role to:
- `carla@simple.biz` — identified as "Carla T (HSL/payroll lead)"
- `kaner@simple.biz` — identified as "Kane R (developer building the system)"

Also includes a comment referencing a meeting: "(per the 2026-04-29 meeting notes)"

**Action Required:** Replace with `carla@demo.biz` and `kaner@demo.biz` for the portfolio seed. Remove the meeting notes reference comment.

---

## LOW SEVERITY FINDINGS

### LOW-01: Google Service Account Project ID in File Path

**File:** `references/global-master-list-hris-48ccf40267e0.json` (filename itself)  
**Severity:** LOW  
**What:** The filename `global-master-list-hris-48ccf40267e0.json` contains the Google Cloud key ID (`48ccf40267e0`) which is a public identifier for the revoked key.

**Action Required:** After revoking the key, delete this file. No further action needed as the key ID alone has no security value after revocation.

---

### LOW-02: App URL / Domain References

**Files:** `.env`, `.env.local`, `middleware.ts` (various)  
**Severity:** LOW  
**What:** References to `simple.biz` domain as the company email domain. This is a real company domain.

**Action Required:** For portfolio: update `.env.example` to use `demo.biz`. The actual `.env` and `.env.local` files are already `.gitignore`'d so they are not in source control.

---

### LOW-03: Webhook URLs

**File:** `references/seed_webhooks_config.sql`  
**Severity:** LOW  
**What:** May contain n8n webhook URLs pointing to real automation endpoints.

**Action Required:** Review and replace with placeholder URLs (`https://webhook.example.com/...`).

---

## Files Requiring Action — Prioritized

| Priority | File | Action |
|----------|------|--------|
| 1 (IMMEDIATE) | `references/global-master-list-hris-48ccf40267e0.json` | Revoke key + delete file + purge git history |
| 2 | `references/seed_global_master_list.sql` | Full replacement with fictional data |
| 3 | `references/seed_global_master_list_addresses.sql` | Replace with city-level-only addresses |
| 4 | `references/seed_employee_hourly_rates.sql` | Replace emails; keep rate structure |
| 5 | `references/seed_us_global_master_list.sql` | Replace all names and emails |
| 6 | `references/seed_hsl_team_members.sql` | Replace names and emails |
| 7 | `references/department_managers_seed_kane_client_va_ai_api.sql` | Replace emails |
| 8 | `references/grant_manager_roles.sql` | Replace emails; remove meeting reference |
| 9 | `src/constants.ts` | Replace names and emails in MOCK_USERS |
| 10 | `references/seed_webhooks_config.sql` | Replace webhook URLs |
| 11 | Any other `references/seed_*.sql` | Audit for embedded emails/names |

---

## Files NOT Requiring Action

These files contain no real PII:

- All `app/api/**/*.ts` route files (no hardcoded data)
- All `src/lib/**/*.ts` logic files  
- All `app/**/*.tsx` component/page files
- `src/types.ts` — type definitions only
- `src/lib/hsl-bonus/schema.ts` — configuration rules, no PII
- `tailwind.config.ts`, `tsconfig.json`, `next.config.ts` — config files
- `package.json`, `package-lock.json` — dependencies
- `.env.example` — placeholder values only

---

## Recommended .gitignore Additions

```gitignore
# Google service account credentials
references/*.json
references/*-credentials*.json
references/*service-account*.json

# Real seed data (keep demo versions only)
references/seed_global_master_list.sql
references/seed_employee_hourly_rates.sql
references/seed_global_master_list_addresses.sql
references/seed_us_global_master_list.sql
references/seed_hsl_team_members.sql
```

---

## After Sanitization Checklist

- [ ] Google service account key revoked in Google Cloud Console
- [ ] `references/global-master-list-hris-48ccf40267e0.json` deleted
- [ ] Git history purged of the credential file
- [ ] All `seed_*.sql` files replaced with DEMO versions
- [ ] `src/constants.ts` mock users renamed to fictional personas
- [ ] No `@simple.biz` emails appear in any committed file
- [ ] No real full names appear in any seed/migration SQL
- [ ] No real account numbers or SWIFT codes appear
- [ ] No physical addresses with street-level detail appear
- [ ] `.env.example` uses `@demo.biz` and `example.com` only
- [ ] `references/seed_webhooks_config.sql` uses placeholder URLs
- [ ] Test run: `grep -r "simple.biz" references/` returns only migration structural SQL, not data
