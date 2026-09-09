# Pre-release security readiness

**Status: OPEN. Every finding below was re-verified in the working tree on 2026-09-09 and is still
present.** Nothing here has been fixed. This doc exists because the findings were made in session
`1a6b84b8` (2026-09-08 19:14) and lived only in that transcript.

Kane is releasing the HRIS to **all employees by end of September 2026**. Today the audience is
admins, HR, Accounting, managers and a small set of employees. Widening it turns three of these
findings from latent into actively exploited-by-accident.

Two findings are **blocking**. They are small, mechanical fixes — the helpers already exist.

Related: [route-authorization.md](./route-authorization.md) ·
[rbac-feature-permissions.md](./rbac-feature-permissions.md) ·
[workspace-account-verify.md](./workspace-account-verify.md) ·
[../../SECURITY_AUDIT.md](../../SECURITY_AUDIT.md) (2026-08-10; findings #39–41, #42, #44, #47, #48,
#54 referenced below are that document's numbering and are all still open)

---

## 1. BLOCKING — a shared-password impersonation backdoor on the public login page

[src/lib/auth/auth-options.ts:44-45](../../src/lib/auth/auth-options.ts#L44-L45)

```ts
const SUPER_ADMIN_PASSWORD = (process.env.SUPER_ADMIN_PASSWORD ?? 'super-admin').trim();
const IMPERSONATION_ENABLED = process.env.SUPER_ADMIN_IMPERSONATION !== 'off';
```

A second NextAuth credentials provider (`super-admin`) signs the caller in **as any `@simple.biz`
email, inheriting that person's full roles**, bypassing Google SSO entirely.

Every one of the following is true at once:

| | |
|---|---|
| **Password defaults to a literal** | `'super-admin'`, and `SUPER_ADMIN_PASSWORD` is **absent from `.env.local`**, so the fallback is what runs. |
| **The literal is committed** | [.env.example:69](../../.env.example#L69) ships `SUPER_ADMIN_PASSWORD="super-admin"` **uncommented**, and it is written out again in [docs/reference/system-architecture.md:459](../reference/system-architecture.md#L459). |
| **On by default** | Only an explicit `SUPER_ADMIN_IMPERSONATION=off` removes the provider. It is unset. |
| **Reachable with no credentials** | The form renders on `/login` ([app/login/page.tsx:126,296](../../app/login/page.tsx#L296)), which is in `PUBLIC_PATHS`. Its own label reads *"Sign in as any @simple.biz account."* |
| **No rate limit, no admin check** | `authorize()` has neither. There is no prior session to check — it is password-only by construction. `proxy.ts` rate-limits onboarding and bank-update only. |

Anyone who reads this repo, reads `.env.example`, reads the architecture doc, or simply guesses can
become `kaner@simple.biz` and read every salary and every bank account in the company.

Impersonation sign-ins **are** written to `audit_log` as `auth.impersonation.signin`. That is
detection, not prevention.

**Unresolvable from the repo:** only `.env.local` is visible here. If Vercel's *production*
environment sets `SUPER_ADMIN_IMPERSONATION=off`, the door is shut in prod. **Verify that first**
(`vercel env ls` — the CLI is not installed locally; `npm i -g vercel`). Because the default is *on*
with a *published* password, **treat production as exposed until proven otherwise.**

**Fix:** set `SUPER_ADMIN_IMPERSONATION=off` in production, redeploy, and **rotate `NEXTAUTH_SECRET`**
to invalidate any JWT already minted through this path. Remove the live value from `.env.example`.
If support impersonation is genuinely wanted, it must require an **existing admin session** — never
a shared password.

## 2. BLOCKING — six API routes with no authorization at all (2 CLOSED 2026-09-09, 4 REMAIN)

[route-access.ts:118](../../src/lib/auth/route-access.ts#L118) is explicit that *"`/api/*` enforces
its own authz"* — `evaluateRouteAccess` gates **page** access, and roughly 100 API namespaces are
each responsible for themselves. The session swept all **290** API routes against every exported
helper in `src/lib/auth/`. **270 are gated.** These are not:

| Route | What an authenticated-or-not caller gets |
|---|---|
| [manager/member-monthly-pay](../../app/api/manager/member-monthly-pay/route.ts) | `GET ?email=&year=&month=` → **anyone's monthly pay**. Zero auth imports. |
| ~~[employee-gift-shipping](../../app/api/employee-gift-shipping/route.ts)~~ **CLOSED 2026-09-09** | Was: `GET` with **no** `email` → **everyone's home address**; `PUT` wrote against an arbitrary `personal_email` with no ownership check. Now `authorizeShippingAccess()` — the owner of that row (matched through their master record, so a personal email resolves) or staff with `hr / gift_tracker`; the un-scoped list is staff-only. Writes audit `employee_gift_shipping.submitted` with the `channel`. See `audit-log.md`. |
| [hr/fpu-enrollments](../../app/api/hr/fpu-enrollments/route.ts) | Full enrollment list — name, email, department, shift. |
| ~~[import-daily-report](../../app/api/import-daily-report/route.ts)~~ **CLOSED 2026-09-09** | Was: unauthenticated **CSV → Postgres write**. Now `requireElevatedSession()` + a `daily_report.imported` audit event. **No component in the app fetches it** — deletion is the right end state, Kane's call (`audit-log.md` §8). |
| [hsl-bonus/period-summary](../../app/api/hsl-bonus/period-summary/route.ts) | Bonus totals per department. |
| [presence/last-seen](../../app/api/presence/last-seen/route.ts) | Service-role read, no session check. Found separately in session `993aad7f`. |

`member-monthly-pay` is the one to fix first — pay data is what causes an actual HR incident. The
two closed above were gated as part of the audit-log pass (an ungated write has no actor to record,
so it could not be audited honestly); `member-monthly-pay`, `hr/fpu-enrollments`,
`hsl-bonus/period-summary` and `presence/last-seen` are **still open**.

**Fix:** `authorizeEmailAccess` / `requireFeatureAccess` / `requireAdminSession` as appropriate. They
already exist; this is wiring, not design.

**Cleared as intentional, do not "fix" these:** `bank-update/*` and `onboarding/*` are public by
design (OTP + rate-limited in [proxy.ts](../../proxy.ts)), and `cron/sync-offboarded-from-sheet` is
tombstoned at 410.

## 3. The launch flag the code itself asks you to flip

[app/api/employee/paystub/route.ts:68](../../app/api/employee/paystub/route.ts#L68)

```ts
const SHOW_UNPAID_STAGED_PAYSTUBS = true;   // Flip to `false` at HRIS launch.
```

Every employee currently sees **every** week — unpaid weeks and snapshot-recovered weeks included —
presented as final. See [[employee-paystub-modal-and-paid-notification]], which records this as
temporary.

On day one of a company-wide release that intersects four known, still-open pay gaps:

- [[never-paid-and-misdelivered-paystubs]] — `canasm@`, `laurenc@` were **never paid**; they would
  see stubs for money they did not receive.
- [[orphanage-pay-ot-differential-underpay]] — `erict@` ₱5,373 restore still pending.
- [[employee-id-card]] — `formatStartDate` off-by-one puts the **wrong start date on every ID card**.
- [[maria-argote-split-identity]] — `mariaa@` vs `mariaar@`, never paid.

**This is a decision, not a defect.** Flip it to `false`, or reconcile those four names first. What
must not happen is the flag staying `true` by inattention on launch day.

## 4. No security headers

[vercel.json](../../vercel.json) carries only `regions` and `crons`; [next.config.ts](../../next.config.ts)
has no `headers` block. Verified 2026-09-09: **neither file contains the string `headers`.**

No HSTS, no CSP, no `X-Frame-Options` — the HRIS is clickjackable. This is finding **#54** in
`SECURITY_AUDIT.md` and it is cheap to close.

## 5. Standing compliance gaps

Carried from `SECURITY_AUDIT.md` (2026-08-10), unaddressed:

- **No login rate limiting** on `employee-login` or the impersonation provider (`proxy.ts` covers
  onboarding and bank-update only).
- **RLS + encryption at rest** — #42 / #44.
- **Retention policy + DPA** — #47 / #48. For Philippine employee data under the Data Privacy Act,
  these are the two compliance artifacts an HRIS is actually expected to hold before it is opened to
  every employee.
- **Vulnerable dependencies** — #39–41. Run `npm audit` before widening the audience.

---

## Recommended order

1. Verify and kill the impersonation backdoor in production; rotate `NEXTAUTH_SECRET`. **Blocking.**
2. Gate the six ungated routes. **Blocking.**
3. Add a security-headers block. Cheap.
4. Decide `SHOW_UNPAID_STAGED_PAYSTUBS` and reconcile the four named pay gaps.
5. Add login rate limiting.

## Scope of this pass — read this before trusting the absence of a finding

Session `1a6b84b8` audited **auth, authorization, and launch flags** in depth, and stopped the sweep
when finding #1 turned up. It did **not** audit payroll calculation correctness, RLS policy coverage,
or dependency CVEs. **An absent finding in those areas is an unexamined area, not a clean one.**
Payroll correctness is its own pass and has not been run.
