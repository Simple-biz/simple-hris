# Client-side keys, certificate pinning and deep links — 2026-10-02

> **⚠ DO NOT PUSH this file while `Simple-biz/simple-hris` is public (item 307 / OW-1).** It describes
> open holes in enough detail to use them. Same rule as [owasp-2026-10-01.md](./owasp-2026-10-01.md).

Session `9a96c410`. Kane asked three questions in a row: *"Do we have API keys stuck in our client's phone
local storage?"*, *"Do we have certificate pinning for our API's?"*, *"and deeplink validation?"*, then
*"give me a full report on this"*. **No code changed.** This report comes from reading the code, plus one
unauthenticated `HEAD` of production `/login` to read its response headers. Nothing touched Supabase and
nothing was tried in a browser. Open item **336**.

---

## Short answers

| Question | Answer |
|---|---|
| API keys left in phone storage? | **No.** Nothing secret is written to `localStorage`, `sessionStorage`, IndexedDB or the Cache API. There are two caveats, and neither is about storage. **(a)** The Supabase anon key ships inside every visitor's JavaScript. That is normal for Supabase, but item 221 makes it a bank-table read key. **(b)** A newly issued `hris_live_` API key can be screen-recorded off an admin's browser through cobrowse (OW-3). See § 2. |
| Certificate pinning? | **No, and it does not apply.** There is no native app. Phones use the website in a mobile browser, and browsers do not let a website pin certificates. Production sends HSTS with `preload` (measured). § 3. |
| Deep link validation? | **There are no native deep links to validate.** The web equivalents are mixed. The post-sign-in `callbackUrl` is an **open redirect** (OW-29, still open, re-read here). The OAuth popup hand-off checks the message origin correctly. `?email=` in a dashboard link is pinned to the session by `proxy.ts`. Four client shells do not re-check it, so they depend on the proxy alone (OW-5). § 4. |

---

## 1. What a browser keeps (phone or desktop)

The same code serves phones and desktops. No phone-only storage exists.

| Store | What is in it | Secret? | How long it lasts |
|---|---|---|---|
| **Cookie** | The NextAuth session (`strategy: 'jwt'`, `src/lib/auth/auth-options.ts:189`). No `cookies` override, so it gets the NextAuth defaults: HttpOnly, Secure on https, SameSite=Lax. | Yes, but page JavaScript cannot read it | NextAuth's default session age |
| **sessionStorage** | The signed-in email, role and active view (`app/login/page.tsx:193-195`). It also holds the per-dashboard tab caches, which are page data, some of it pay-related. | No keys. It does hold personal and pay data. | Each entry is stamped with the viewer's identity. It expires after **12 h** (`create-tab-cache.ts:67`, `employee/tab-cache.ts:83`) and is **cleared on sign-out** (for example `EmployeeSidebar.tsx:368-377`, `AdminSidebar.tsx:330-337`). The HR and Orphanage caches stay in memory and are never written to storage. |
| **localStorage** | UI preferences: sidebar collapse, overview mode, theme (`simple-hris-ui-v4`), diagnostics map positions, wizard toggles, tutorial progress, load timings. Notification and "seen" markers (IDs and timestamps). The RBAC last-known-good snapshot (`rbac-cache.ts`, roles and tab permissions per email; its header says *"NEVER a security boundary"* because every write is re-checked server-side against the JWT). The People-tab edit-warning snooze. Termination-letter **manual repairs** (`termination-panel-rules.ts:134-143`: worker name, work email, master row id, column, value), which stay on purpose on the Accounting rep's machine. | No keys. The termination repairs hold a person's name and work email. | Until cleared |
| **IndexedDB, Cache API, service worker** | None. There is no PWA manifest and no service worker. | n/a | n/a |
| **Supabase auth token** (`sb-*-auth-token`) | **Never written.** `src/lib/supabase/browser.ts:20-21` sets `persistSession: false`. `src/lib/supabase/client.ts:15` would persist a session, but nothing imports it, and no client code calls `supabase.auth.*`. Sign-in is NextAuth only. | n/a | n/a |
| **External API keys we issue** (`hris_live_…`) | Shown **once**, from React state, in the hand-off dialog (`AdminExternalApiClients.tsx:185, 1227-1340`). Never written to storage. The server keeps only a salted hash. The cached client list (`ADMIN_CACHE_KEYS.integrationsClients`) holds `key_prefix` only. | Yes, while the dialog is open | Gone when the dialog closes |
| **Anthropic key** | Stored server-side as a secret-scoped setting. The browser gets only `masked` (`AdminApiKeys.tsx:26-58`). | No | n/a |

**Phone caveat.** The code comments assume *"sessionStorage dies with the tab"*. On a phone that is weak,
because mobile browsers keep tabs open for weeks and restore them, sessionStorage included, after a
restart. On a phone, the real limits are the **12 h expiry** and the **sign-out purge**. On a shared
phone, someone who closes the browser without signing out leaves up to 12 h of cached pages for the next
person who opens that tab, and the NextAuth cookie still signs them in anyway. This is not a key leak.
It is the normal risk of a shared device, and the identity stamp stops the cache from showing up under
a different account.

---

## 2. Where a key does reach the client

### 2a. The Supabase anon key is in every visitor's JavaScript (item 221, OPEN CRITICAL)

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is compiled into the client bundle. That bundle is served to anyone,
signed in or not, on `/login` and `/update-bank-info`, and the phone's HTTP cache keeps it. Supabase
expects this key to be public. **The harm comes from the database policies:** the anon role reads every
column of `employee_ids` (about 1,009 full account numbers) and all of `global_master_list`. Hiding or
rotating the key would not help, because a new key ships the same way. The fix is item 221's: drop the
anon and authenticated policies after the anon-client readers move to the service role. Nothing in this
session changes that item.

### 2b. A newly issued API key can be recorded off an admin's screen (new consequence of OW-3)

OW-3 already records that cobrowse lets anyone holding the public anon key screen-record any online
user. This session traced what that means for API keys:

- `CobrowseProvider` is mounted app-wide (`NextAuthProvider.tsx:43`), Admin included. Its rrweb driver
  starts recording whenever a `{t:'watch', target:<me>}` message arrives on the public `hris-cobrowse`
  Broadcast topic. The sender is not checked (`useCobrowse.ts:317-325`).
- `rr.record` sets no `maskAllInputs` and no `maskTextSelector`, only `blockClass: 'rr-block'`
  (`useCobrowse.ts:137-147`). rrweb's default masks **password inputs only**.
- The Integrations hand-off dialog shows the full `hris_live_…` key as plain text in a `<code>` element
  (`AdminExternalApiClients.tsx:1335`), along with a copy-ready hand-off note, `curl` line and MCP config
  that contain it (`:1246-1255`).
- The Anthropic key field is `type={reveal ? 'text' : 'password'}` (`AdminApiKeys.tsx:155`). Masked by
  default, but captured in clear once the admin clicks the eye icon.

**Result:** someone who knows an admin's email (the public `hris-presence` topic lists who is online)
and holds the anon key from `/login` can watch the admin's screen while a key is issued or rotated, and
read a working external API key with whatever data grants it carries. The key is never stored on the
phone. It leaves through the screen recording.

**Fix (all `hardening`):** the OW-3 fix closes this. The watched person's client must refuse a watch
request it cannot verify, and the topics should be private (`private: true` + `setAuth`). Two smaller
changes are worth making regardless: put `rr-block` (or a `maskTextSelector`) on the hand-off dialog and
the Anthropic key field. One open fact decides urgency: whether this Supabase project allows public
Realtime channels at all (OWASP doc § "Not checked"). If it does not, OW-3 and this path are already
closed.

---

## 3. Certificate pinning

- **There is no native app.** No `android/` or `ios/` folders, no Capacitor, React Native, Expo or Cordova
  in `package.json`. Employees on phones use the website in Safari or Chrome.
- **Browsers do not support pinning.** HPKP was removed from Chrome (2018) and Firefox. A website cannot
  pin. Browsers enforce Certificate Transparency instead, and that covers the same mis-issued-certificate
  risk.
- **Measured, production `/login`:** `Strict-Transport-Security: max-age=63072000; includeSubDomains;
  preload` (set by Vercel). A phone will not downgrade to http after its first visit. The custom bank and
  gift hostnames were not measured.
- **The same response had no CSP, `X-Frame-Options`, `X-Content-Type-Options` or `Referrer-Policy`.**
  This is the "zero security headers" item already on the pre-release list
  ([[pre-release-security-blockers]]), not a new finding. Of the missing headers, `frame-ancestors` /
  `X-Frame-Options` matters most, because without it the app can be framed for clickjacking.
- **Server-to-server TLS:** `src/`, `app/` and `proxy.ts` never disable certificate checks. There is no
  `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED` or custom `https.Agent`. Outbound calls to
  Hubstaff, Wise, Monday, n8n, OMS and Supabase use Node's default verification.
- **About 20 local scripts** under `scripts/` (the `apply-*` migrations, `audit-pending-migrations.mts`)
  connect to Postgres with `ssl: { rejectUnauthorized: false }`. The traffic is encrypted, but the server
  is not verified, so someone in the middle of the network a script runs on could capture the
  `DATABASE_URL` credentials. This is low risk and does not affect the deployed app. The fix is to verify
  against Supabase's root CA (`sslmode=verify-full` with the downloadable certificate).
- **If a mobile app is ever built:** pin the SPKI of the intermediate or root CA, plus a backup pin. Do not
  pin the leaf, which Vercel renews about every 90 days. Route that through `blueprint`; it is a new
  surface.

---

## 4. Deep links

**Native:** no `/.well-known/assetlinks.json`, no `apple-app-site-association`, no custom URL scheme.
There is nothing to validate.

**Web links that act like deep links:**

| Link | State | Detail |
|---|---|---|
| `/login?callbackUrl=…` | **OPEN — open redirect (OW-29)**, re-read this session | `app/login/page.tsx:202-206` accepts any value that starts with `/` and not with `/login`. `//evil.example` and `/\evil.example` both pass, and `router.replace(destination)` (`:429`) navigates off-site. It works when the victim is already signed in, and after a popup sign-in, because the page and its query string stay put while the popup runs. The full-redirect fallback (`:256`, `:272`) returns to a bare `/login` and drops the parameter. This lets an attacker send a real HRIS link that lands on a fake "session expired, sign in again" page. **Fix:** accept a value only if `new URL(raw, location.origin).origin === location.origin` and it starts with a known view route. |
| OAuth popup → `/auth-callback` | **OK** | The popup posts to `window.location.origin` only (`app/auth-callback/page.tsx:12`). The listener drops any message from another origin (`app/login/page.tsx:378`). |
| `?email=` on dashboard links | **OK at the server. Four client shells rely on it alone** | **The server pins it.** `proxy.ts` → `evaluateRouteAccess` (`src/lib/auth/route-access.ts:136-145`) redirects any page request whose `?email=` differs from the session email back to the session email. It does this for every non-elevated user, and for elevated users too on `/manager`, `/employee`, `/ceo` and `/qc`. Elevated users may preview someone else on the other dashboards, which is intended. **On the client,** Employee (`EmployeeApp.tsx:262-297`) and HR (`HrApp.tsx:155-172`) check `?email=` against the session again. Accounting (`App.tsx:127-136`), Manager (`ManagerApp.tsx:476-489`), CEO (`CeoApp.tsx:48-60`) and Admin (`app/admin/page.tsx:101-113`) do not. They take `?email=` into sessionStorage as the viewer, so they depend on the proxy alone. That only matters if the proxy is bypassed, and OW-5 records proxy-bypass advisories for `next` 16.2.2. **Fix (low priority):** copy the Employee/HR rule into the four shells, after the OW-5 upgrade. |
| `/update-bank-info`, gift link (emailed, OTP) | **OPEN (item 266)**, not re-read | The bank form's verify step tells an attacker whether an address belongs to an active employee, and its payroll-lock check lets saves through when the lock read fails. The gift link answers with one generic 400 and is the model to copy. |

---

## 5. What to do, in order

None of this needs certificate pinning. All of it is `hardening` work, and none was done here.

1. **OW-3 cobrowse authorization** (private topics, verified watch requests). This closes the only way a key
   leaves a device (§ 2b). Also add `rr-block` to the key hand-off dialog and the Anthropic key field.
2. **OW-29 open redirect.** A one-function guard on `callbackUrl` (§ 4).
3. **Item 221.** It is why the bundled anon key matters (§ 2a).
4. **The OW-5 `next` upgrade**, then a defense-in-depth check of `?email=` on the Accounting, Manager, CEO and
   Admin shells, as Employee and HR already do. The proxy pins it today.
5. **Security headers** (CSP with `frame-ancestors`), already on the pre-release list.
6. **Script TLS.** Verify the Postgres certificate in `scripts/`.

## Not checked

- The headers on the custom bank and gift hostnames, and on preview deployments.
- Whether Supabase Realtime allows public channels on this project. That decides whether § 2b is live today.
- Anything in a browser or on a real phone. Every finding here comes from reading the code, except the
  `/login` headers.
