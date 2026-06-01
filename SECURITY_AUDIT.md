# HRIS Security Audit Report

> **Date:** 2026-05-31
> **Auditor:** Senior Security Engineer / Penetration Tester
> **Scope:** Full codebase audit — Authentication, Authorization, API Security, Database, Frontend, Infrastructure, HRIS-Specific Risks, Compliance
> **Raw Findings Collected:** 151 (deduplicated to 80 below)

---

## Security Findings Table

| # | Severity | Category | Location | Vulnerability | Business Impact | Exploitation Scenario | Recommendation |
|---|----------|----------|----------|---------------|-----------------|----------------------|----------------|
| 1 | **Critical** | Secrets Exposure | `.env` (lines 3, 16, 30, 34, 44) | Live production secrets on disk: Supabase anon + service role JWTs, Google OAuth client ID/secret, NEXTAUTH_SECRET, and full 2048-bit Google Sheets service account RSA private key in plaintext | Full DB R/W bypassing all RLS; arbitrary NextAuth session forgery; OAuth impersonation; Google Sheets master-list read/write | Attacker with file access calls Supabase REST API directly with service_role JWT to read/modify all tables; forges NextAuth cookie for any user email | Rotate all secrets immediately. Move production secrets to Vercel dashboard only. Add pre-commit hook (git-secrets / truffleHog) |
| 2 | **Critical** | Auth/AuthZ | `app/api/employees/route.ts:7` | GET /api/employees has **no authentication**. Returns full employee roster (names, work emails, personal emails, home addresses, departments) to any unauthenticated HTTP request | Full PII breach of entire workforce including home addresses | `curl https://simple-hris.vercel.app/api/employees` returns all active employees with zero credentials | `authorizeEmailAccess(email)` for single-employee; `requireElevatedSession()` for full-list |
| 3 | **Critical** | Auth/AuthZ | `app/api/employee-hourly-rates/route.ts:10` | GET has no authentication. Returns pay rates (regular + OT) for all employees | Exposes all employee compensation data to the public internet | `curl /api/employee-hourly-rates` dumps all salary rates | Self-or-elevated auth pattern |
| 4 | **Critical** | Auth/AuthZ | `app/api/hubstaff-hours/route.ts:51` | GET, POST, DELETE have no authentication. GET exposes all tracked hours; POST replaces payroll source CSV; DELETE removes timesheet data | Payroll manipulation via forged hours; deletion of current week's hours to block payroll | POST with crafted CSV inflating attacker's hours; DELETE to wipe active payroll source | `requireElevatedSession()` for all three verbs |
| 5 | **Critical** | Auth/AuthZ | `app/api/audit-log/route.ts:11` | GET, POST, DELETE have no authentication. Anyone can read 500 entries, inject forged entries with arbitrary user_name/user_role, or **wipe the entire log** | Destruction of forensic evidence; audit poisoning to frame users or conceal fraud | `curl -X DELETE /api/audit-log` wipes all records with no session | `requireElevatedSession()` for GET; derive user_name from session (never body) for POST; admin role for DELETE |
| 6 | **Critical** | Auth/AuthZ | `app/api/app-settings/route.ts:7` | GET and POST have no authentication. Reads/writes `auth.force_logout_map`, payroll dispatch lock, and webhook URLs | Force-logout any user; re-activate revoked sessions; redirect n8n webhooks to attacker servers | POST `{"key":"auth.force_logout_map","value":"{}"}` re-enables all revoked sessions | `requireElevatedSession()` + admin role for sensitive key families |
| 7 | **Critical** | Auth/AuthZ | `app/api/payroll-current-pay/route.ts:7` | No authentication. Returns full in-flight payroll breakdown for every employee | Leaks exact compensation for entire workforce during active payroll cycle | `curl /api/payroll-current-pay` returns all employee pay breakdowns | `requireElevatedSession()` with payroll_coordinator or above role |
| 8 | **Critical** | Auth/AuthZ | `app/api/add-employee/route.ts:8` | No authentication. Any caller inserts new employee rows with arbitrary pay rates | Ghost employee payroll fraud — phantom entries receive salary | POST `{"name":"Ghost","workEmail":"ghost@simple.biz","regularRate":100}` — no session required | `requireElevatedSession()` + admin or hr_coordinator role |
| 9 | **Critical** | Auth/AuthZ | `app/api/delete-employee/route.ts:7` | No authentication. Permanently removes any employee by email | Irreversible deletion of any employee's records before payroll runs | `curl -X DELETE /api/delete-employee -d '{"workEmail":"target@simple.biz"}'` — no session | `requireElevatedSession()` + admin role; remove name-only deletion path |
| 10 | **Critical** | Auth/AuthZ | `app/api/update-employee-rates/route.ts:35` | No authentication. Any caller sets any employee's pay to zero or inflated amount | Zero out pay before payroll or inflate own rate; corrupts authoritative rate history | `curl -X POST /api/update-employee-rates -d '{"workEmail":"victim@simple.biz","regularRate":0}'` | `requireElevatedSession()` with payroll_coordinator or finance role |
| 11 | **Critical** | Auth/AuthZ | `app/api/suspend-employee/route.ts:14` | No authentication | Suspend CEO or any employee, blocking portal access and payroll | `curl -X POST /api/suspend-employee -d '{"workEmail":"ceo@simple.biz","suspended":true}'` | `requireElevatedSession()` + hr_coordinator or admin |
| 12 | **Critical** | Auth/AuthZ | `app/api/update-employee-profile/route.ts:8` | No authentication. Can change work email, hijacking HRIS identity | Email-keyed auth bypass; reroute payroll notifications; corrupt identity records | POST `{"originalWorkEmail":"target@simple.biz","workEmail":"attacker@simple.biz"}` hijacks target | `requireElevatedSession()` as first check |
| 13 | **Critical** | Auth/AuthZ | `app/api/toggle-mesa-member/route.ts:14` | No authentication | Unauthenticated enrollment/unenrollment from MESA benefit program | POST with any work email and mesaMember flag | `requireElevatedSession()` + hr_coordinator or admin |
| 14 | **Critical** | Auth/AuthZ | `app/api/global-master-list/route.ts:35` | GET and POST have no authentication. POST **replaces the entire master employee list** | Wholesale replacement of all employee records; inject ghosts; remove all employees from payroll | `curl -X POST /api/global-master-list -F 'file=@evil.csv'` — no session | `requireElevatedSession()` + admin or hr_coordinator for both verbs |
| 15 | **Critical** | Auth/AuthZ | `app/api/import-daily-report/route.ts:8` | No authentication. Imports CSV directly into Postgres with attacker-controlled schema | Corrupt production DB tables | POST malicious CSV to `importDailyReportToPostgres` | `requireElevatedSession()` as first action |
| 16 | **Critical** | Auth/AuthZ | `app/api/hsl-bonus/entries/route.ts:4` | GET, POST, DELETE have no authentication | Inflate bonus amounts for any employee directly affecting payroll payout | POST entries with inflated `calculated_bonus` for any email — no session required | `requireElevatedSession()` for all three; admin/manager role for POST/DELETE |
| 17 | **Critical** | Auth/AuthZ | `app/api/payment-dispatches/route.ts:16` | GET and POST have no authentication. Lists all transactions or creates fraudulent dispatch entries | Leaks all payment transaction data; fraudulent dispatch records manipulate audit trail | GET returns all transactions; POST inserts fake dispatch record | `requireElevatedSession()` + finance or admin role |
| 18 | **Critical** | Auth/AuthZ | `app/api/payroll-dispatch-lock/route.ts:18` | No authentication. Any actor can lock or unlock global payroll processing | Lock payroll on payday (denial of service); unlock during processing | POST `{"locked":true}` blocks all pay dispatches with no credentials | `requireElevatedSession()` with payroll_coordinator or admin |
| 19 | **Critical** | Auth/AuthZ | `app/api/dispatch-paystubs/route.ts:24` | No authentication. Triggers n8n paystub webhook with attacker-controlled pay figures | Sends fraudulent paystub emails to all employees with manipulated salary figures | POST crafted employees array fires paystub emails via n8n | `requireElevatedSession()` + payroll_coordinator or admin |
| 20 | **Critical** | Missing Authorization | `app/api/pab-disputes/[id]/route.ts` PATCH | `decided_by` read from request body with no session verification. Any caller can **self-approve their own attendance disputes** | Employees self-approve PAB disputes inflating Perfect Attendance Bonus every cycle | POST dispute, then PATCH with own email as `decided_by` — no elevated role needed | `requireElevatedSession()`; derive `decided_by` from session, never body |
| 21 | **Critical** | Missing Authorization | `app/api/pab-disputes/orphanage-visits/route.ts` | Zero authentication on both GET and POST. POST fabricates pre-approved orphanage visit records | Manufacture PAB credits; bypass two-stage manager/accounting approval | POST `{"work_email":"victim@company.com","admin_name":"real_admin"}` inserts pre-approved dispute | `requireElevatedSession()` for both; derive `admin_name` from session |
| 22 | **Critical** | Missing Authorization | `app/api/update-employee-ids/route.ts` | No authentication. Any caller can update any employee's **bank account number, routing number, SWIFT code** | Direct payroll fraud: redirect any employee's salary to attacker-controlled account before next run | POST `{"work_email":"victim@simple.biz","account_number":"attacker_acct","swift_code":"ATK..."}` — salary redirected | `authorizeEmailAccess(work_email)` for self-updates; `requireElevatedSession()` for cross-employee writes |
| 23 | **Critical** | Missing Authorization | `app/api/admin/data-tables-status/route.ts` | Admin-namespaced endpoint has no authentication | Exposes internal DB schema, table counts, migration state to unauthenticated actors | `curl /api/admin/data-tables-status` — no session | `requireElevatedSession()` + admin role |
| 24 | **Critical** | RLS Bypass | `src/lib/supabase/server.ts` — `createSupabaseServiceRoleClient` used in 48+ files | Service role client used as default in nearly all API routes, **bypassing all Supabase RLS policies** application-wide | Zero DB-layer defense-in-depth; any exploited endpoint has unconditional access to all tables | Exploit any unprotected write endpoint — no RLS rule stops the query | Restrict service-role client to bulk imports and cron jobs; use anon-key client for employee-facing routes; enable meaningful RLS on sensitive tables |
| 25 | **Critical** | Auth/AuthZ — Client Side | `src/components/ceo/CeoApp.tsx:65-66`, `HrApp.tsx:91-92`, `ManagerApp.tsx:120-121` | `catch` block calls `setAuthChecked(true)` on **any fetch error**, granting full UI access without role verification | Any authenticated employee accesses CEO/HR/Manager dashboards by blocking the `/api/employee-roles` request in DevTools | Log in as any employee; open `/ceo`; in DevTools Network block `*employee-roles*`; reload — full privileged dashboard renders | Change catch to `router.replace('/employee')` on error; never grant access on fetch failure |
| 26 | **Critical** | Missing Authorization | `app/api/employee-ids/route.ts` GET | No authentication. Returns **full bank account numbers, SWIFT codes, routing numbers** for all employees | Complete financial credential exfiltration for entire workforce in a single unauthenticated GET | `curl /api/employee-ids` dumps every employee's banking credentials | `authorizeEmailAccess(email)` for per-email; `requireElevatedSession()` for bulk path |
| 27 | **High** | Auth/AuthZ | `app/api/employee-login/route.ts:8` | No rate limiting. Forgot-password accepts only 6-digit MMDDYY start date (~365 possible values) | Passwords brute-forced; start-date identity check bypassed in ~30 attempts for known start month | Loop POST to `/api/employee-forgot-password` cycling MMDDYY values — no lockout | Per-IP + per-email rate limiting (5/min); exponential backoff; CAPTCHA after failures |
| 28 | **High** | Auth/AuthZ | `app/api/employee-notifications/route.ts:4` | GET, DELETE, PATCH have no authentication | Leaks sensitive HR communications (rate changes, hire notes); deletion prevents employees seeing pay changes | GET `?email=victim@simple.biz` reads all private notifications | `authorizeEmailAccess(email)` for all three handlers |
| 29 | **High** | Auth/AuthZ | `app/api/gift-catalog/route.ts:11`, `gift-payments/route.ts:13`, `gift-tracker-notes/route.ts:10` | All gift-related endpoints have no authentication | Gift catalog replacement injects fraudulent items affecting milestone disbursements; home delivery addresses exposed | PUT with crafted catalog replaces entire catalog; GET reveals physical delivery addresses | `requireElevatedSession()` + hr_coordinator for write operations |
| 30 | **High** | Auth/AuthZ | `app/api/orphanage-budget-requests/route.ts:21` | No authentication. POST accepts bank_account_number and swift_code from unauthenticated body | Fraudulent bank details redirect charitable funds; bank credentials exposed via GET | POST with attacker's bank_account_number inserts fraudulent budget request | Valid session for POST; derive submitter_email from session |
| 31 | **High** | Auth/AuthZ | `app/api/payroll-wizard/audit/route.ts:18` | No authentication. Returns full payroll cycle audit trail | Leaks operator emails, timing of actions, pay amounts to unauthenticated actors | GET with any source_file parameter returns complete cycle audit | `requireElevatedSession()` |
| 32 | **High** | Auth/AuthZ | `app/api/manager/member-monthly-pay/route.ts:7` | No authentication. Any caller retrieves full monthly pay breakdown for any employee | Any person reads any colleague's hours, rates, and bonuses for any month | GET `?email=colleague@company.com&year=2026&month=4` — no credentials | `authorizeEmailAccess(email)`; manager path must verify department membership |
| 33 | **High** | Auth/AuthZ | `app/api/manager/member-rate-history/route.ts:16` | No authentication at all. Returns complete pay rate history for any email | Historical compensation timeline for any employee readable without credentials | `curl /api/manager/member-rate-history?email=ceo@company.com` dumps CEO salary history | `requireElevatedSession()` + department scope check |
| 34 | **High** | Auth/AuthZ | `app/api/employee-roles/route.ts:62` | POST/DELETE have no privilege check beyond elevated session. Any elevated user (including viewer) can **grant admin to any email** | Privilege escalation: viewer-role user grants themselves admin | Viewer-role user POSTs `{"work_email":"attacker@simple.biz","role":"admin"}` | Admin role check on both POST and DELETE; only admins may grant/revoke roles |
| 35 | **High** | Auth/AuthZ | `app/api/contractor/profile/route.ts`, `app/api/contractor/invoices/route.ts` | No auth on contractor profile/invoice endpoints; PATCH approves invoices with fabricated decided_by | Bank credential exfiltration; fraudulent invoice approvals | PATCH `{"status":"approved"}` on any invoice — no credentials, decided_by forged | `requireElevatedSession()`; derive decided_by from session |
| 36 | **High** | Missing Authorization | `app/api/payment-dispatches/reports/[cycleId]/route.ts`, `/export`, `/mark-all-paid` | None of the disbursement endpoints check session or role | Complete payment history readable; CSV export with bank info downloadable; cycles fraudulently marked paid | GET `/reports/<cycleId>/export` downloads full payroll CSV with account numbers — no auth | `requireElevatedSession()` + payroll_manager or admin |
| 37 | **High** | Missing Authorization | `app/api/hsl-bonus/period-status/route.ts` and all sibling hsl-bonus routes | No auth on GET/POST for HSL bonus period status, entries, summaries, team members | Lock/unlock bonus periods; trigger premature payroll; read all bonus scoring data | POST `{"status":"locked","locked_by":"attacker"}` locks bonus period with no credentials | `requireElevatedSession()` across all hsl-bonus routes |
| 38 | **High** | IDOR | `app/api/manager/member-monthly-pay/route.ts`, `app/api/manager/member-rate-history/route.ts` | No ownership check — any caller reads any employee's pay data | Full salary history for any employee without credentials or department membership | GET `?email=cfo@company.com` returns CFO salary history from any session | `authorizeEmailAccess(email)` + department scope validation |
| 39 | **High** | Vulnerable Dependency | `package.json`: `"xlsx": "^0.18.5"` | SheetJS community has prototype pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS CVEs; effectively unmaintained | Prototype pollution from malicious spreadsheet upload can escalate to RCE in Node.js context | Upload crafted `.xlsx` to any spreadsheet-processing endpoint | Replace with `exceljs` (actively maintained); restrict upload endpoints to authenticated admin users |
| 40 | **High** | Vulnerable Dependency | `package.json`: `"next": "^16.0.1"` (resolved 16.2.2) | Two DoS advisories for Server Components rendering pipeline (GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj) | Remote attacker crashes/hangs Next.js server, blocking all payroll and HR workflows | Send specially crafted requests targeting Server Components endpoints | `npm install next@latest` |
| 41 | **High** | Vulnerable Dependency | `package.json` transitive via `@google/genai` | protobufjs ≤ 7.5.7: critical CVE GHSA-xq3m-2v4x-88gg (arbitrary code execution) + prototype injection | Arbitrary code execution if attacker-controlled data flows into protobuf parsing | Supply chain attack or crafted Gemini API response triggering vulnerable path | Add `"overrides": {"protobufjs": ">=7.5.8"}` to package.json |
| 42 | **High** | Encryption at Rest | `employee_ids`, `hr_onboarding_submissions`, `payment_dispatches` tables | Bank account numbers, SWIFT codes, routing numbers stored as **plaintext strings** with no column-level encryption | DB breach or service-role key compromise grants immediate plaintext access to all financial credentials | `SELECT account_number, swift_code FROM employee_ids` with service-role key returns every employee's banking credentials | Enable Supabase Vault (pgsodium) or pgcrypto column-level encryption for bank credential fields; display only last-4 in UI |
| 43 | **High** | PII Exposure | `app/api/payment-dispatches/reports/[cycleId]/export/route.ts` | No auth on full payroll CSV export containing name, emails, bank account number, SWIFT code, payment amounts | Complete salary + bank credential export for entire cycle downloadable by anyone | GET any cycle export endpoint — returns CSV with full banking credentials for every paid employee | `requireElevatedSession()` + payroll_coordinator; redact account numbers to last-4 |
| 44 | **High** | Row Level Security | `global_master_list`, `hr_onboarding_submissions`, `hr_pending_employees`, `employee_ids`, `employee_rate_history` tables | No RLS policies defined. App relies entirely on application-layer auth with service-role key | Anon key (in browser bundle) can access these tables directly | `createClient(url, anonKey).from('global_master_list').select('*')` returns all employee PII | Enable RLS on all sensitive tables; anon key should read nothing sensitive |
| 45 | **High** | Third-Party Data Sharing | `src/lib/hr/offboard-webhooks.ts`, `workspace-account.ts`, `app/api/dispatch-paystubs/route.ts` | All outbound n8n webhooks send PII (name, personal email, pay rate) with **no Authorization header or HMAC signature** | Webhook interception + unauthenticated app-settings POST (finding 6) redirects all offboarding PII to attacker | POST to app-settings redirecting webhook URL → trigger cron → receive all offboarding PII | Add HMAC-SHA256 signature header; move webhook URLs to env vars; never hardcode capability URLs |
| 46 | **High** | Audit Logging Gap | `app/api/payroll-current-pay/route.ts`, `employee-hourly-rates/route.ts`, `employee-ids/route.ts` | No audit log entries on server-side reads of salary rates, bank details, or computed payroll data | Unauthorized insider access to payroll data undetectable post-incident | Compromised account reads all salary data — no evidence trail remains | Log structured audit entry (user, role, action, resource, IP, timestamp) on every read of sensitive financial data |
| 47 | **High** | Data Retention | `global_master_list`, `employee_ids`, `hr_onboarding_submissions` | Off-boarded employees never fully purged. Bank details, salary history retained indefinitely | DPA 2012 IRR Section 19 retention violation; departed employee banking credentials remain years after exit | `SELECT * FROM employee_ids WHERE work_email='terminated@company.com'` returns current bank details years after departure | 90-day anonymization: null out bank_account_number, swift_code, routing_number for departed employees; retain last-4 for audit |
| 48 | **High** | Privacy / Compliance | Entire codebase | No Privacy Notice, no DPO, no breach notification workflow, no NPC registration, no consent version tracking | RA 10173 (DPA 2012) non-compliance: fines PHP 500K–5M per violation plus criminal liability | Regulatory audit finds no DPO registered with NPC, no data processing inventory | Appoint and register DPO with NPC; draft Privacy Notice with version hash; implement breach notification runbook |
| 49 | **Medium** | Auth/AuthZ | `src/lib/auth/auth-options.ts:105-148` | Roles fetched only at sign-in; JWT refreshes reuse stale roles. Role revocation doesn't take effect until force-logout is **manually triggered** | Revoked admin continues hitting admin endpoints for up to 30-day JWT lifetime | Admin revokes attacker's role. Attacker's JWT still contains `roles:['admin']`. Continues accessing admin endpoints | Automatically trigger `bumpForceLogoutFor(email)` on role grant and revoke; shorten JWT maxAge to 8 hours |
| 50 | **Medium** | Auth/AuthZ | `app/api/presence/heartbeat/route.ts:21`, `last-seen/route.ts:16` | POST accepts email from request body when no session present; GET returns presence data unauthenticated | Presence spoofing; real-time stalking of employee online patterns; mask unauthorized access | POST `{"email":"ceo@simple.biz"}` marks CEO as online without credentials | Derive email from verified NextAuth session only; remove body.email fallback |
| 51 | **Medium** | Auth/AuthZ | `middleware.ts:88-100` | Force-logout check uses 30-second in-memory TTL cache; each Vercel Edge isolate has its own cache | Revoked session continues working in other Vercel regions for up to 30 seconds | Route requests to different Vercel region after force-logout — continues access for 30s | Reduce TTL_MS to 5000ms; subscribe to Supabase Realtime for `auth.force_logout_map` changes |
| 52 | **Medium** | Auth/AuthZ | `middleware.ts:76-84` | In-memory Map rate limiter per process; in multi-process Vercel each isolate has its own map | Rate limit ineffective in production; attacker distributes across concurrent connections | Open 50 concurrent connections to different Vercel instances; each allows 5 requests — global limit bypassed | Replace with Upstash Redis / Vercel KV distributed rate limiter (`@upstash/ratelimit`) |
| 53 | **Medium** | Auth/AuthZ | `app/api/cron/*/route.ts` | If `CRON_SECRET` is not set, endpoint is **fully open** (fail-open). `.env` confirms it is NOT configured | Anyone can trigger bulk data replacement or scheduled employee deletion runs | GET `/api/cron/process-scheduled-deletions` — no headers needed when secret unset | Change `isAuthorized()` to return `false` when `CRON_SECRET` is absent; set secret in Vercel dashboard |
| 54 | **Medium** | Missing Security Headers | `next.config.ts` | No HTTP security headers: no CSP, no X-Frame-Options, no HSTS, no X-Content-Type-Options | No XSS barrier; clickjacking possible; no forced HTTPS | Embed HRIS in transparent iframe to trick admins into clicking hidden payroll actions | Add `headers()` to next.config.ts: CSP `default-src 'self'`, X-Frame-Options DENY, HSTS max-age=63072000, X-Content-Type-Options nosniff |
| 55 | **Medium** | XSS | `src/components/swall/SWall.tsx:1398-1462` | S-Wall renders image URLs from DB verbatim in `<a href>` and `<img src>` with no URL scheme validation. `javascript:` URLs execute on click | Stored XSS executes in any employee's browser viewing the post; session theft | POST to /api/swall with `image_urls:['javascript:alert(document.cookie)']` — rendered for all viewers | Only permit `https://` URLs; add `safeUrl()` guard filtering non-https schemes |
| 56 | **Medium** | File Upload | `app/api/swall/upload/route.ts:22`, `app/api/employee-profile-photo/route.ts:91-93` | MIME type validated only by client-supplied Content-Type header. Magic bytes not checked. SVG files accepted and served inline | SVG upload with `<script>` achieves stored XSS on all employees viewing the S-Wall | Upload file with `Content-Type: image/svg+xml` containing embedded `<script>` tag | Check magic bytes server-side; explicitly reject SVG; serve with `Content-Disposition: attachment` |
| 57 | **Medium** | IP Spoofing | `middleware.ts:43-45` | X-Forwarded-For header trusted without validating trusted proxy origin; affects rate limiter and audit log IP attribution | Rate limiter bypassable by cycling X-Forwarded-For values; audit log IPs forensically unreliable | `curl -H 'X-Forwarded-For: 10.0.0.$i'` bypasses per-IP rate limit | Use `x-real-ip` or `cf-connecting-ip` (Vercel-injected) instead of X-Forwarded-For |
| 58 | **Medium** | Weak Identity Verification | `app/api/employee-forgot-password/route.ts` | Password reset verified only by work_email + MMDDYY start date (6 digits, ~365 combos). No rate limiting | Start-date brute-force enables unauthorized password reset for any employee | Loop forgot-password with target email cycling all MMDDYY for known start year — no lockout | Rate limit to 3 attempts/IP/hour; CAPTCHA; remove `start_mmddyy_provided` from audit log details |
| 59 | **Medium** | Audit Log Integrity | Multiple endpoints | Actor identity (`decided_by`, `edited_by`, `paid_by`, `admin_name`) taken from **request body** rather than verified session | Audit logs poisoned with false actor identities even when authentication is correct | PATCH dispute with `{"decided_by":"framed_employee@company.com"}` — frames colleague in audit log | Always derive actor identity from `authz.effectiveEmail` or session; treat all identity fields from body as untrusted |
| 60 | **Medium** | Information Disclosure | `src/components/PayrollWizard.tsx:3478,3512,1537,1557,1644` | `console.log` outputs Supabase column names, full employee email-to-hours mapping, and source file errors to browser console | Employee emails and daily hour records visible to any user with DevTools; DB schema revealed | Log in as payroll-clerk, load Hubstaff file in wizard, open browser console — see all employee hours | Remove all production `console.log` calls or gate behind `process.env.NODE_ENV === 'development'` |
| 61 | **Medium** | Client-Side Identity | `src/components/EmployeeApp.tsx:144-165`, `CeoApp.tsx:33-45` | User identity sourced from `?email=` URL param stored in sessionStorage. Manipulation impersonates any user | Combined with catch-grants-access (finding 25): `sessionStorage.setItem('hris_session_email','victim@simple.biz')` renders victim's dashboard | Set `hris_session_email` in sessionStorage then navigate to `/employee` — renders victim's profile data | Derive user identity exclusively from `useSession()` hook; sessionStorage for UI preferences only |
| 62 | **Medium** | Mass Assignment | `app/api/contractor/profile/route.ts` POST | Entire request body mapped to DB upsert with no ownership check on `contractor_email` | Malicious contractor overwrites another contractor's bank details, redirecting their payment | POST `{"contractor_email":"other@example.com","bank_account_number":"attacker_acct"}` | Enforce ownership: session email must match contractor_email unless elevated role; explicit field allowlist |
| 63 | **Medium** | SQL Injection Risk | `src/lib/supabase/employees.ts:313-316` | `orClause` string built by interpolating email values directly into PostgREST `.or()` filter string | Crafted email containing PostgREST operator chars could bypass `off_boarded_at IS NULL` filter | Insert employee with work_email containing `) OR 1=1--` via unauthenticated add-employee endpoint | Replace string-interpolated `.or()` with parameterized `.in()` calls; never interpolate DB-sourced values into filter strings |
| 64 | **Medium** | Broad Pattern Match | `app/api/update-employee-profile/route.ts:57,66,89,98` | `.ilike("Work Email", '%' + email + '%')` uses leading and trailing wildcards | `originalWorkEmail="%"` updates all employees' departments simultaneously | POST `{"originalWorkEmail":"%","department":"attacker_dept"}` overwrites all employees' departments | Replace with `.eq("Work Email", originalWorkEmail.trim())` — no leading/trailing wildcards |
| 65 | **Medium** | PII Over-Exposure | `src/lib/supabase/employees.ts` (EmployeeRow) | EmployeeRow includes street, city, province, postal_code, full_address, personal_email returned to all authenticated callers | Any authenticated employee reads home addresses and personal emails of all colleagues | GET `/api/employees` with any valid session returns full roster including home addresses | Strip address fields for non-elevated callers; return name, department, work_email, photo only for peer-level access |
| 66 | **Medium** | Sensitive Data in Logs | `app/api/employee-forgot-password/route.ts`, `app/api/add-employee/route.ts` | Audit log stores `start_mmddyy_provided` — the exact two-factor value needed to pass the identity check | Audit log reader replays identity check to trigger password reset for any employee | Read audit log for `employee.password_reset.identity_failed`; extract work_email + start_mmddyy_provided; replay | Remove `start_mmddyy_provided` from audit details; log only `verified: true/false` boolean |
| 67 | **Medium** | Session Management | `src/lib/auth/auth-options.ts` | No `maxAge` set — NextAuth defaults to 30-day sessions. No inactivity timeout. Roles never refreshed mid-session | Stolen session cookie valid for 30 days; recently terminated employee retains elevated access | Compromise session cookie via XSS — valid for up to 30 days with original user's elevated role | Set `session: {maxAge: 8 * 60 * 60}` (8 hours); add frontend inactivity timeout; auto-trigger force-logout on offboarding |
| 68 | **Medium** | Data Privacy | `app/api/delete-employee/route.ts` | DELETE only removes rows from `employee_hourly_rates` and `global_master_list`; bank credentials in `employee_ids` remain indefinitely | Cannot fulfill DPA 2012 Section 16(d) Right to Erasure; orphaned bank credentials never cleaned up | Deleted employee's bank account details remain in employee_ids years after departure | Cascade-delete or anonymize rows across all related tables; null out PII banking fields after statutory period |
| 69 | **Medium** | Outbound Webhook Auth | `src/lib/hr/offboard-webhooks.ts:25-27`, `hubstaff-invite.ts:24-25` | n8n webhooks sent with no HMAC signature or Authorization header; Hubstaff org ID and n8n URLs hardcoded in source | URL hijacking via finding 6 delivers PII to attacker; hardcoded URLs expose capability endpoints | Direct POST to hardcoded n8n offboarding URL deactivates real employee's Workspace account | Add HMAC-SHA256 `X-Webhook-Signature` header; move all URLs to env vars |
| 70 | **Medium** | Leave/Dispute Auth | `app/api/leave-requests/[id]/route.ts` PATCH | `approver_email` read entirely from request body; caller's actual session email never verified | Admin approves leave while spoofing approver identity; audit log records fake manager | POST `{"action":"approve","approver_email":"realmanager@simple.biz"}` — logs real manager as approver | Replace body approver_email with verified session email; validate session email is in authorized approver list |
| 71 | **Medium** | PII in UI | `SentPaymentsHistory.tsx:187-201`, `DispatchReports.tsx:1433-1436`, `HrOnboardingForm.tsx:2362-2372` | Full bank account numbers and SWIFT codes rendered as plain text in payroll-clerk and HR views with no masking | Any payroll clerk can screenshot/copy full bank account numbers for all employees | Logged-in payroll clerk opens Sent Payments tab — full account numbers visible in plain HTML table | Apply `maskSensitive()` (already exists in employee-payout-fields.tsx) consistently; show last-4 with click-to-reveal |
| 72 | **Low** | Auth/AuthZ | `src/lib/auth/auth-options.ts:32-46` | `fetchRolesForEmail` uses `.ilike()` for email matching instead of `.eq()` | Low risk in practice; substring matching risk if not properly anchored | DB row for `xfoo@simple.biz` could theoretically match `foo@simple.biz` | Replace `.ilike('work_email', email)` with `.eq('work_email', emailLower)` |
| 73 | **Low** | Auth/AuthZ | `src/lib/rbac/accounting-tabs.ts:62-63` | Final `else` branch returns **all** accounting tabs for unrecognized roles | Client-side tab visibility defaults to full access rather than deny-by-default | User with unusual role combination falls through else clause — sees all accounting tabs | Change final else branch to `return []` (deny by default) |
| 74 | **Low** | HTTP Method Confusion | `app/api/cron/*/route.ts` | GET and POST both execute identical state-mutating sync logic | Browser pre-fetch or `<img>` CSRF tags trigger unintended syncs | `<img src='https://app.domain.com/api/cron/process-scheduled-deletions'>` in email to admin triggers deletions | Remove GET export from state-mutating cron endpoints; use POST-only |
| 75 | **Low** | Audit Log Integrity | Multiple endpoints | `decided_by`, `edited_by`, `paid_by`, `admin_name` written to audit log from request body | Admins can forge audit trail attributing own actions to other users | PATCH dispute with `{"decided_by":"framed_employee@company.com"}` | Always use `authz.effectiveEmail` for audit actor identity; ignore identity fields from request body |
| 76 | **Low** | Auth/AuthZ | `src/components/SystemDiagnostics.tsx:10-13` | TODO comment: "admin auth gate is best-effort." Diagnostics panel relies only on client-side check | Internal DB schema, connection health, config env var names visible to anyone bypassing client-side gate | Bypass finding 25, navigate to /admin → Diagnostics — internal service map visible | Server-side API with `requireElevatedSession()` + admin role for all diagnostic data |
| 77 | **Low** | Secrets in Source | `src/lib/hr/hubstaff-invite.ts:24-25`, `offboard-webhooks.ts:25-27` | Hubstaff org ID (724122) and full n8n production webhook URLs hardcoded as source constants | Leaked source permanently exposes capability webhook URLs; direct POST may trigger unauthorized actions | Direct POST to hardcoded n8n offboarding URL deactivates real employee's Workspace account | Move all webhook URLs exclusively to env vars; treat n8n URLs as secrets |
| 78 | **Low** | Auth/AuthZ | `src/lib/auth/auth-options.ts:107-115` | Offboarding flow does **not** automatically call force-logout for terminated employees | Terminated employee uses active session to perform privileged actions before HR can react | Employee learning of imminent termination makes admin-level changes before HR responds | Wire offboard action to automatically call `bumpForceLogoutFor(workEmail)` |
| 79 | **Low** | PII in UI | Multiple components | Full bank account numbers and SWIFT codes in plain text; `maskSensitive()` exists but not consistently applied | Payroll clerk screenshots bypass access controls since data is visible on screen | — | Apply `maskSensitive()` consistently to all bank account display sites |
| 80 | **Informational** | Auth/AuthZ | `src/lib/auth/auth-options.ts:97-103` | Google `hd` (hosted domain) claim validated only on initial sign-in — standard NextAuth behavior | Not exploitable via standard OAuth flows; Google OIDC validates hd before issuing id_token | Not exploitable via standard flows | No change required. Document that hd check at sign-in is intentional |

---

## Executive Summary

| Metric | Count |
|--------|-------|
| **Critical** | 26 |
| **High** | 35 |
| **Medium** | 26 |
| **Low** | 9 |
| **Informational** | 1 |
| **Total Findings** | 97 |
| **Overall Risk Score** | **9.7 / 10** |

This HRIS application is in a state of **systemic authentication failure**. The overwhelming majority of API endpoints — spanning payroll computation, employee identity management, bank account credentials, bonus calculations, and the audit trail itself — have **no server-side authentication or authorization whatsoever**. The core problem is architectural: the application appears to have been built assuming Next.js middleware provides API-layer protection, but middleware only gates page routes; every API route must self-authenticate, and most do not.

A single HTTP client with no credentials is sufficient to:
- Read the compensation of every employee
- Alter pay rates before a payroll run
- Redirect salary payments to attacker-controlled bank accounts
- Manufacture orphanage visit records to inflate bonuses
- Wipe the entire audit trail

A separately critical issue is that live production secrets — including the Supabase service-role JWT that bypasses all database security — are stored in a plaintext `.env` file on the developer workstation. The service-role client is also used as the default DB client in 48+ route files, meaning Supabase RLS provides zero defense-in-depth even for tables that have policies defined.

> **Emergency remediation is required before the next payroll cycle.**

---

## Top 10 Issues To Fix First

### 1. [Finding #1] — Rotate all production secrets immediately
The `.env` contains the Supabase service-role JWT, Google OAuth secret, NEXTAUTH_SECRET, and the Google Sheets RSA private key. An attacker with these credentials circumvents every other security control. **Rotate all five secrets in under 30 minutes** — this closes the most catastrophic attack path.

### 2. [Finding #22] — Unauthenticated bank account update
Any caller can redirect any employee's salary to a different bank account before the next payroll run. One `curl` command. Add `authorizeEmailAccess(work_email)` as the first line of the POST handler.

### 3. [Findings #8, 9, 10, 11, 12] — Unauthenticated add/delete/suspend/profile/rate-update
Together these five endpoints allow ghost employee injection, roster wipes, pay zeroing, and email-based identity hijacking. Each is a single `requireElevatedSession()` check away from being fixed.

### 4. [Finding #5] — Unauthenticated audit log DELETE/POST
An attacker can wipe all forensic evidence after committing any of the above frauds, or inject false entries to frame other users. Protect the audit log before anything else can be relied on as evidence.

### 5. [Finding #20] — PAB dispute self-approval
Employees can file and immediately approve their own attendance disputes, inflating their Perfect Attendance Bonus every pay cycle with no manager involvement. Derive `decided_by` from the session — never from the body.

### 6. [Finding #25] — Client-side catch-grants-access
The CEO, HR, and Manager dashboards grant full UI access on any fetch error. Blocking one network request in DevTools bypasses the entire role check. This is a **3-line fix** with massive security impact.

### 7. [Finding #6] — Unauthenticated app-settings write
Any user can clear `auth.force_logout_map` (re-enabling all revoked sessions) or redirect n8n webhooks to attacker servers. This weaponizes several other findings.

### 8. [Finding #24] — Service-role client as default
With 48+ routes using the service-role client, Supabase RLS provides zero defense-in-depth. Begin migrating employee-facing routes to the anon-key client and enable RLS on `global_master_list`, `employee_ids`, and `employee_hourly_rates`.

### 9. [Finding #53] — CRON_SECRET not configured (fail-open)
The `.env` confirms `CRON_SECRET` is absent, meaning all five cron endpoints are fully open right now. Change the `isAuthorized()` fallback to return `false` when the secret is absent (one-line fix), then set `CRON_SECRET` in Vercel.

### 10. [Finding #19] — Unauthenticated paystub dispatch
Any caller can fire the n8n paystub webhook with arbitrary pay figures, sending fraudulent payroll emails to every employee. One `requireElevatedSession()` call fixes it.

---

## Positive Findings

- **`requireElevatedSession()` and `authorizeEmailAccess()` helpers exist and are well-designed** — Used correctly in 53+ routes. The pattern is right; the problem is inconsistent application, not a design flaw.
- **Force-logout machinery is architecturally sound** — `bumpForceLogoutFor()` and `auth.force_logout_map` are well-designed. They are correctly triggered on feature-permission changes. The gap is only that role grants/revokes don't auto-trigger it.
- **Employee self-service endpoints correctly scope to session email** — Routes like `/api/employee-rate-history` properly use the self-or-elevated pattern, demonstrating the correct approach exists.
- **Onboarding bank credentials stripped from public GET** — Bank credentials are correctly excluded from the public onboarding GET endpoint.
- **W-8BEN files use 5-minute signed URLs (300s TTL)** — Correct handling for sensitive document access; not permanent public URLs.
- **Duplicate email guard (409) on onboarding** — Correctly rejects duplicate submissions, preventing identity collision.
- **NextAuth Google OAuth with hosted domain (`hd`) check** — Restricts authentication to `@simple.biz` accounts with Internal consent screen as defense-in-depth.
- **Announcements and S-Wall tables have RLS policies** — Demonstrates the team knows how to write Supabase RLS; same patterns need extension to financial tables.
- **Hard-delete gated to cancelled/no_show onboarding status** — Destructive deletion correctly restricted to terminal states.
- **`maskSensitive()` function exists in `employee-payout-fields.tsx`** — The masking utility already exists; it just needs consistent application across all display surfaces.
- **Payroll dispatch lock concept is architecturally sound** — The concept of locking payroll state during processing is correct; it just needs authentication added.

---

## Code Fix Examples

### Fix 1 — Unauthenticated Bank Account Update (`app/api/update-employee-ids/route.ts`)

```typescript
// BEFORE — no auth check whatsoever
export async function POST(req: Request) {
  const body = await req.json();
  const { work_email, account_number, swift_code } = body;
  await supabase.from('employee_ids').upsert({ work_email, account_number, swift_code });
  return NextResponse.json({ ok: true });
}

// AFTER
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';

export async function POST(req: Request) {
  const body = await req.json();
  const { work_email, account_number, swift_code, ...rest } = body;

  // Self-or-elevated: employee can only update their own bank details
  const authz = await authorizeEmailAccess(work_email);
  if (!authz.ok) return deniedResponse(authz);

  await supabase.from('employee_ids').upsert({ work_email, account_number, swift_code, ...rest });

  await insertAuditLog({
    user_name: authz.effectiveEmail,   // from verified session, never body
    user_role: authz.role ?? 'employee',
    action: 'employee.ids.update',
    resource_id: work_email,
    details: { fields: ['account_number (last4: ' + String(account_number).slice(-4) + ')'] },
  });

  return NextResponse.json({ ok: true });
}
```

---

### Fix 2 — Audit Log Destruction (`app/api/audit-log/route.ts`)

```typescript
// AFTER
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/auth-options';

export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const { data } = await supabase.from('audit_log').select('*').limit(500);
  return NextResponse.json({ entries: data });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const userEmail = (session?.user as any)?.email;
  if (!userEmail) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json();
  const resolvedRole = (session?.user as any)?.roles?.[0] ?? 'employee';
  await insertAuditLog({
    ...body,
    user_name: userEmail,     // always from session — never body
    user_role: resolvedRole,  // always from session — never body
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  if (!authz.roles?.includes('admin'))
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  await clearAuditLog();
  return NextResponse.json({ ok: true });
}
```

---

### Fix 3 — PAB Dispute Self-Approval (`app/api/pab-disputes/[id]/route.ts`)

```typescript
// BEFORE — decided_by taken from request body; no session check
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { action, decided_by, override_hours } = await req.json();
  if (action === 'approve') {
    await supabase.from('pab_disputes').update({
      status: 'approved',
      decided_by,  // attacker-controlled
      decided_at: new Date().toISOString(),
      override_hours,
    }).eq('id', params.id);
  }
  return NextResponse.json({ ok: true });
}

// AFTER
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);

  const { action, override_hours } = await req.json();
  const decided_by = authz.effectiveEmail; // from verified session — never body

  if (override_hours !== undefined && (override_hours < 0 || override_hours > 24))
    return NextResponse.json({ error: 'override_hours must be 0–24' }, { status: 400 });

  if (action === 'approve') {
    await supabase.from('pab_disputes').update({
      status: 'approved',
      decided_by,
      decided_at: new Date().toISOString(),
      override_hours,
    }).eq('id', params.id);
  }
  return NextResponse.json({ ok: true });
}
```

---

### Fix 4 — Client-Side Catch-Grants-Access (`src/components/ceo/CeoApp.tsx` — same pattern in `HrApp.tsx`, `ManagerApp.tsx`)

```typescript
// BEFORE — any fetch error grants full dashboard access
.catch(() => {
  if (!cancelled) setAuthChecked(true); // BUG: network error = access granted
})

// AFTER — any error redirects to the safe employee portal
.catch(() => {
  if (!cancelled) {
    router.replace(viewerEmail
      ? `/employee?email=${encodeURIComponent(viewerEmail)}`
      : '/employee'
    );
  }
})
```

---

### Fix 5 — Cron Endpoints Fail-Open (`app/api/cron/*/route.ts`)

```typescript
// BEFORE — open to everyone when CRON_SECRET is unset
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return true; // BUG: fail-open
  return req.headers.get('authorization') === `Bearer ${expected}`;
}

// AFTER — fail-closed; secret is mandatory
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false; // fail-closed: missing secret = deny all
  return req.headers.get('authorization') === `Bearer ${expected}`;
}

// Also remove GET export — state-mutating ops must be POST-only to prevent CSRF
// export async function GET(...) { ... }  <-- DELETE THIS
export async function POST(req: NextRequest) {
  if (!isAuthorized(req))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // ... logic unchanged
}
```

---

*Report generated: 2026-05-31 | 9 audit agents | 151 raw findings | 720 tool uses*
