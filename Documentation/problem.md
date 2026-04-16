# Simple HRIS — Latent Problem Inventory

Generated: 2026-04-15. To review & triage tomorrow.

31 findings. Severity: **P0** = shipping blocker · **P1** = fix this week · **P2** = fix this sprint · **P3** = tech debt.

---

## 1. Correctness bugs

- **P1** `src/components/PayrollWizard.tsx:1612` — Salary-date math `new Date(year, month, day + 8)`. Date constructor silently rolls over at month boundaries. For `weekStart = May 31`, `day+8 = 39` — JS handles this, but combined with the later `setFullYear/month` copies it's fragile. Fix: use `setDate`/`setUTCDate` or a dayjs equivalent consistently.
- **P1** `src/components/PayrollWizard.tsx:457-469` — Hubstaff date columns parsed via `new Date(y, m-1, d)` (local TZ) then compared to other dates constructed in UTC context elsewhere. On a Manila server (UTC+8) this shifts days. Fix: pick one — always `Date.UTC(...)` for date-only values.
- **P2** `src/components/employee/EmployeeDashboard.tsx:725-735` — No bounds checking on parsed column dates. `"2026-02-30"` silently becomes Mar 2 via Date rollover. Fix: reject parsed values where `m∉[1,12]` or `d∉[1,31]` before constructing.
- **P2** Email matching in `src/lib/payroll/compare-to-master.ts` and various — still uses `.eq("Work Email", email)` in a few call sites even after the recent ilike hardening in `update-employee-profile`. Same drift class as the John Rivera case. Fix: audit for remaining `.eq(` on email columns; swap to `ilike` + `trim()`.
- **P2** Bonus constants (`TECHNOLOGY_BONUS_PHP = 1850`, `PERFECT_ATTENDANCE_BONUS_PHP = 5000`) are hardcoded **twice** — once in `PayrollWizard.tsx`, once in `EmployeeDashboard.tsx`. Future amount change will desync the two surfaces. Fix: extract to `src/lib/payroll/constants.ts`.

## 2. Security & auth

- **P1** `app/api/employees/route.ts` — GET returns full employee list (names, emails, departments, start dates) with **no auth check**. Any unauthenticated request reads all PII. Fix: add role guard — `requireRole(req, ['admin','hr_coordinator','payroll_*'])`.
- **P1** `app/api/employee-hourly-rates/route.ts` — Same pattern: unauthenticated GET returns the full rates table (everyone's regular + OT rates). Fix: same role guard + pagination.
- **P1** `app/api/hubstaff-hours/route.ts` — GET returns every employee's hours for every day. No auth. Fix: role gate; for non-admin callers, filter to their own email server-side.
- **P1** `src/components/rbac/ViewSwitcher.tsx:38` — `sessionStorage['active_view'] = 'admin'` from DevTools and the switcher lets the user hop to the admin dashboard. RBAC is client-trusted. Fix: server-side session cookie (HttpOnly) plus a middleware role check on `/admin/**`.
- **P2** `app/api/update-employee-profile/route.ts:55, 64, 87, 96` — `ilike('Work Email', '%${value}%')` doesn't escape SQL-LIKE wildcards. If `originalWorkEmail = 'm%'` the UPDATE matches every email containing "m". Fix: escape `%` and `_` on input, or drop the surrounding `%...%` and trim server-side only.
- **P2** `app/api/employee-login/route.ts:34-51` — Audit log differentiates `employee.login.failed` vs `employee.login.success` with the email in both. The response is generic, but anyone who can read audit log can enumerate users. Fix: log without exposing whether the email was valid.
- **P2** `app/api/dispatch-paystubs/route.ts` — Webhook URL comes from `app_settings.webhooks.config`, admin-editable. No scheme or host allowlist. A compromised admin account could point paystubs at an attacker endpoint. Fix: validate `https://` scheme and match against a static allowlist (env-driven).

## 3. Data integrity

- **P2** `app/api/add-employee/route.ts` — Inserts into `employee_hourly_rates` **and** `global_master_list` as two independent statements. If the second fails (unique key, RLS), the first stays. No rollback. Fix: Supabase RPC wrapping both in a `BEGIN/COMMIT`, or compensating delete on error.
- **P2** `app/api/delete-employee/route.ts:35-50` — Mirror problem on delete. Conditional branches on which email was provided can leave the other table's row orphaned. Fix: always delete from both tables using the full email set.
- **P1** `src/lib/supabase/*` — `normEmail()` is applied at lookup time but **not** at DB read time. If a row was inserted with mixed case, later SELECTs that `normEmail()` the needle won't match. Fix: normalize on write OR wrap SELECT in `lower(trim(col))` comparison.

## 4. Scale & performance

- **P1** `app/api/hubstaff-hours/route.ts` — `select("*")` with no limit. Every Rates / Overview / Dashboard mount fetches the entire table (can exceed 10k cells). Same endpoint called from 3 places in parallel per mount. Fix: add `.range()` pagination, server-side filtering by employee for non-admin callers.
- **P2** `src/components/PayrollWizard.tsx` — Seven sequential `fetch()` calls in mount effects. All `cache: 'no-store'`, so a parent re-render re-fires all seven. Fix: `Promise.all` + `useMemo` stabilization of the combined result.
- **P2** `src/components/Rates.tsx:552-554` — `useEffect(..., [])` closes over `fetchProfiles` which is redefined each render → stale closure. Works today because effect only runs once, but refreshes after mutations won't pick up updated state. Fix: `useCallback(fetchProfiles, [])` or move definition outside.
- **P2** `src/components/employee/EmployeeDashboard.tsx` — 200+ Hubstaff column cells rendered without `React.memo` or virtualization. Every parent re-render re-renders all of them. Fix: memoize the day-cell component; consider virtualization if columns >500.
- **P2** `src/components/PayrollWizard.tsx` (6.5k lines) + `EmployeeDashboard.tsx` (~1.8k) — monolithic. Same date helpers duplicated. Fix: extract `src/lib/payroll/` modules for bonus calc, salary-date math, Hubstaff parsing.

## 5. UX footguns

- **P2** `src/components/Rates.tsx:651, 744` — `toast.success(...)` fires before checking `response.ok`. On API error, user sees a green "✓ updated" while the action silently failed. Fix: gate the toast behind `if (!res.ok) { toast.error(...); return; }`.
- **P2** `src/components/PayrollWizard.tsx:4819-4874` — Dispatch button toasts "Payroll Dispatched" **before** the webhook resolves. If n8n is down, the user walked away believing paystubs went out. Fix: `await` the webhook response; add a confirm dialog upstream.
- **P2** `src/components/employee/EmployeeLeaves.tsx` — Form submit only checks email; empty dates/reason get sent to the API, which bounces with a sparse error. Fix: client-side validation of required fields with inline messaging.
- **P2** `src/components/Rates.tsx:439-465` — Delete dialog sets `isDeleting` but close button isn't disabled. Close-mid-delete races with state updates. Fix: `disabled={isDeleting}` on both buttons; prevent dialog close while pending.

## 6. Operational

- **P1** `app/api/dispatch-paystubs/route.ts` — `fetch(webhookUrl, ...)` has no timeout, no retry. If n8n hangs, Vercel kills the request at ~30s and the user sees a 500 with no clue. Fix: `AbortController` with 10s timeout + 1–2 retries with backoff.
- **P2** `src/components/PayrollWizard.tsx:5029-5040` — `https://host.simple.biz/email/simplelogo.png` hardcoded in 12+ places across preview styles and email template. Fix: `process.env.NEXT_PUBLIC_EMAIL_LOGO_URL` with a sensible default.
- **P2** Overview / Rates / EmployeeDashboard — no `ErrorBoundary`. A single failing fetch crashes the page. Fix: wrap top-level routes in an `ErrorBoundary` with a retry UI.
- **P3** `src/components/PayrollWizard.tsx:1834, 1868` — `console.log('[hubstaff_hours] actual column names:', ...)` leaks column data to the prod browser console. Fix: gate on `process.env.NODE_ENV === 'development'` or remove.
- **P3** `app/api/hubstaff-hours/route.ts:119, 164` — `console.error(...)` dumps raw Supabase error strings (can include query text + table names). Fix: sanitize before logging; route full details to Sentry.
- **P3** Audit log helper `insertAuditLog` is called from 11+ places with inconsistent shapes (some include IP, some don't). Fix: middleware that observes mutating requests and inserts a canonical audit row.

## 7. Tech debt

- **P2** `src/constants.ts` — Contains `MOCK_USERS` and bonus constants that aren't used anywhere, while the **real** bonus constants live inline in two component files. New engineers will update the wrong file. Fix: delete mock constants; move real bonus constants here.
- **P3** `src/lib/email/norm-email.ts` — Only lowercases. Gmail's dot-and-plus rules ignored (`fran.m@gmail.com` ≡ `franm@gmail.com` ≡ `fran+test@gmail.com`). Probably fine for `simple.biz` domain but a surprise waiting to happen. Fix: document the assumption; add Gmail-specific normalization if needed.
- **P3** `src/components/admin/AdminRoles.tsx`, `AdminWebhooks.tsx` — `JSON.parse(raw) as WebhookEntry[]` trusts storage shape. A manually-edited `app_settings` row with a missing field will render a broken UI. Fix: Zod schema validation on read; fall back to defaults on parse error.

---

## Suggested tomorrow's order

1. **All P1 security** (employees / rates / hubstaff GETs unauthenticated) — 1 afternoon; biggest-blast-radius items.
2. **Dispatch webhook hardening** (timeout + URL allowlist) — 1 hour; prevents an admin-level mistake from leaking paystub data.
3. **Shared constants extract** — 30 min; quick win; prevents the next bonus-amount desync.
4. **Date/TZ audit** in PayrollWizard + EmployeeDashboard — half day; correctness bugs lurking here can show up as wrong paystubs.
5. Leave the 6.5k-line split as a dedicated later sprint unless something else forces it.
