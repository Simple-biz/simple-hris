# Implementation plan — Google Sign-In (SSO)

Saved 2026-04-18 for later execution. Summon with "look at the Google SSO plan" or similar.

## Goal

Let employees (including accounting/admin — everyone is in `employees`) sign in with their Google account instead of typing email + MMDDYY password. Google-verified email must match a registered employee; unknown emails are rejected.

## Decisions already made

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Unknown Google email → reject** with "Your Google email isn't in the employee roster — contact accounting." | Everyone is already in `employees`. No auto-provisioning. |
| 2 | **Keep existing password flow as fallback.** | Service accounts, external contractors, outage failsafe, gradual rollout. |
| 3 | **Match `work_email` first, `personal_email` second.** | Google account usually tied to work email; some master-list rows have Gmail as personal. |
| 4 | **Google only for now.** | Keep scope tight; more providers later if needed. |

## What Kane does (infrastructure — cannot be done from code)

1. **Google Cloud Console → APIs & Services → Credentials**
   - Create OAuth 2.0 Client ID (Web application)
   - Authorised JavaScript origins: `http://localhost:3000`, `https://<prod-domain>`
   - Authorised redirect URIs: `https://<your-supabase-ref>.supabase.co/auth/v1/callback`
   - Save `client_id` and `client_secret`

2. **Supabase Dashboard → Authentication → Providers → Google**
   - Toggle on
   - Paste `client_id` and `client_secret`
   - Save

3. **Supabase Dashboard → Authentication → URL Configuration**
   - Site URL: `http://localhost:3000` for dev, prod URL in prod
   - Redirect URLs (whitelist): `http://localhost:3000/auth/callback`, `https://<prod-domain>/auth/callback`

## What Claude does (code side)

1. `npm install @supabase/ssr` (browser + server Supabase clients with cookie-backed sessions)

2. **Create `src/lib/supabase/browser.ts`** — browser client factory using `createBrowserClient` from `@supabase/ssr`, reading `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

3. **`src/components/employee/EmployeeLogin.tsx`** — add a **Sign in with Google** button above the existing form. On click:
   ```ts
   await supabase.auth.signInWithOAuth({
     provider: 'google',
     options: { redirectTo: `${window.location.origin}/auth/callback` },
   });
   ```

4. **`app/auth/callback/page.tsx`** — new route. Handles Supabase's post-OAuth return:
   - Exchange code for session (Supabase `exchangeCodeForSession`)
   - Read `session.user.email` (Google-verified)
   - `fetch('/api/verify-employee?email=...')` → looks up in `employees` (work_email first, personal_email second)
   - If not found: sign out of Supabase, toast error, redirect to `/login`
   - If found: fetch `/api/employee-roles?email=...`, compute view via `viewsForRoles`, write sessionStorage (`employee_session_email`, `employee_session_role`, `active_view`), redirect to `${VIEW_ROUTES[target]}?email=...`

5. **`app/api/verify-employee/route.ts`** — new endpoint that queries the employees table, matching work_email first, then personal_email (case-insensitive via `normEmail`). Returns `{ matched: boolean, work_email: string | null }`.

6. **`app/api/employee-login/route.ts`** — leave untouched (password flow remains).

## Edge cases to cover

- User signs in with Google email that matches `personal_email` of an employee whose `work_email` is a different Google account → match succeeds, but log it in the audit log for traceability.
- User's Google account is unverified (`email_verified: false`) → reject. Supabase Auth should already enforce this, but double-check.
- User signs out — clear Supabase session AND sessionStorage.
- Account-switching — if user is already signed in with Google and clicks Google again, it should just re-redirect them (no-op feeling).

## Audit log events to add

- `auth.google.success` — employee, work_email, matched_by ('work_email' | 'personal_email')
- `auth.google.rejected_unknown_email` — google_email (so accounting can see attempted unauthorised logins)

## Testing checklist

- [ ] Known employee with matching `work_email` → lands on the right view
- [ ] Known employee with Gmail matching `personal_email` → matches, logs it
- [ ] Unknown Google email → rejected with clear toast, session cleared
- [ ] Admin user with Google SSO → sessionStorage correct, admin view loads
- [ ] Existing password login still works after SSO is enabled (regression)
- [ ] Signing out clears both Supabase session and sessionStorage

## Env vars required

```
NEXT_PUBLIC_SUPABASE_URL=<already set>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<already set>
```

No new env vars — Google credentials live in Supabase's dashboard, not in the app.

## Out of scope for this plan

- Microsoft / Apple / GitHub OAuth
- Magic-link email login
- MFA / 2FA
- Account-linking (letting an employee tie Google + password to the same identity)

These can be added later by extending the same foundation.

## Ready to execute when Kane:

1. Has completed the Google Cloud + Supabase dashboard setup above
2. Says "let's do the Google SSO" (or similar) — Claude then jumps to the "What Claude does" section
