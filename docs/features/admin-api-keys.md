# Admin API Keys

*Admin-only "API tokens" tab for managing third-party API credentials — today, the Anthropic (Claude) key that powers the CEO chat assistant. A key saved here is stored server-side, shown only as a masked preview, and overrides the `ANTHROPIC_API_KEY` environment variable so it can be rotated without a redeploy.*

---

## Where it lives

| Layer | File |
|---|---|
| Route (admin shell) | `app/admin/page.tsx` — mounts `<AdminApiKeys />` when `activeTab === 'api-tokens'` |
| Sidebar entry | `src/components/admin/AdminSidebar.tsx` — `{ id: 'api-tokens', label: 'API tokens', icon: KeyRound }` |
| Component | `src/components/admin/AdminApiKeys.tsx` |
| Management API | `app/api/admin/anthropic-key/route.ts` (GET / POST / DELETE) |
| Key resolver + masking | `src/lib/anthropic/api-key.ts` |
| Admin gate | `src/lib/auth/authorize-email.ts` — `requireAdminSession()` |
| Storage | `app_settings` row, key `secret.anthropic_api_key` (existing table — no migration) |
| Consumer | `app/api/ceo/chat/route.ts` — calls `resolveAnthropicApiKey()` |

The tab is mounted **only** in the Admin shell at `/admin`. No other dashboard imports `AdminApiKeys`.

---

## The key resolver — DB overrides env

`src/lib/anthropic/api-key.ts` is the single source of truth for "which Anthropic key are we using":

```ts
resolveAnthropicApiKey(): Promise<{ key: string | null; source: 'db' | 'env' | null }>
```

Precedence, in order:

| Order | Source | Condition |
|---|---|---|
| 1 | DB override (`app_settings['secret.anthropic_api_key']`) | a trimmed, non-empty value exists → `source: 'db'` |
| 2 | `process.env.ANTHROPIC_API_KEY` | DB empty/unreachable, env var set → `source: 'env'` |
| 3 | none | neither present → `{ key: null, source: null }` |

The DB read is wrapped in try/catch: if Supabase is unreachable the resolver silently falls back to the env var rather than throwing. Because the DB wins when set, an admin can set or rotate the key from the UI and it takes effect on the next request — **no redeploy**. The CEO chat route (`app/api/ceo/chat/route.ts`) consumes this and, when `key` is null, returns *"The assistant is not configured yet. Add an Anthropic API key in Admin → API tokens (or set ANTHROPIC_API_KEY)."*

### Masking — the full key never leaves the server

`maskAnthropicKey(key)` builds the only form ever sent to the client:

- Keeps the recognizable `sk-ant-` prefix (or the first 4 chars if the prefix differs), then `…`, six `•`, then the **last 4** characters — e.g. `sk-ant-…••••••wXyZ`.
- Keys of length ≤ 11 collapse to `••••••••`.

The raw key string is stored verbatim in `app_settings.value` (not JSON-wrapped) and is only ever read server-side by the resolver. The management route returns the masked form; it has no code path that returns the plaintext.

---

## Management route — `/api/admin/anthropic-key`

`runtime = 'nodejs'`, `dynamic = 'force-dynamic'`. Every method first calls `requireAdminSession()` and returns `deniedResponse(authz)` on failure (401 if not signed in, 403 if signed in but not `admin`).

All three methods return the same status shape (POST/DELETE also add `success: true`):

```ts
{ configured: boolean, masked: string | null, source: 'db' | 'env' | null }
```

| Method | Body | Behaviour |
|---|---|---|
| `GET` | — | Returns current status via `resolveAnthropicApiKey()` + `maskAnthropicKey()`. No plaintext. |
| `POST` | `{ key }` | Validates, then `upsertAppSetting('secret.anthropic_api_key', key)`. Returns refreshed status (`source: 'db'`). |
| `DELETE` | — | Deletes the `app_settings` row via service-role client → reverts to env var (or unconfigured). Returns refreshed status. |

> **Note:** the client (`AdminApiKeys.tsx`) writes the key with `POST` (not PUT). The route exposes `GET` / `POST` / `DELETE` only.

### POST validation (server-side)

The key string is trimmed and rejected with HTTP 400 if it:

1. is empty → *"API key is required"*
2. does not start with `sk-ant-` → *"That does not look like an Anthropic API key — it should start with \"sk-ant-\"."*
3. is shorter than 20 chars → *"That API key looks too short."*

On success the row is upserted with `onConflict: 'key'` and a fresh `updated_at`.

---

## `requireAdminSession` vs `requireElevatedSession`

`src/lib/auth/authorize-email.ts` defines two server gates that read roles off the NextAuth JWT (zero DB hit):

| Gate | Admits roles | Used for |
|---|---|---|
| `requireElevatedSession()` | any of `ELEVATED_ROLES` = `admin`, `accounting`, `hr_coordinator` (`src/lib/auth/elevated-roles.ts`) | cross-employee reads/writes (payroll, disputes, app-settings writes) |
| `requireAdminSession()` | `admin` **only** | true-administrator actions, e.g. managing API credentials |

`requireAdminSession()` is `requireElevatedSession()` plus a `roles.includes('admin')` check; it returns *"Forbidden — admin only"* (403) for an elevated-but-not-admin caller. This is the distinction that keeps `accounting` / `hr_coordinator` (which are *elevated*) out of the API-secrets surface.

---

## The `secret.*` admin-only tier in `/api/app-settings`

`app/api/app-settings/route.ts` has two sensitivity classifiers layered on top of each other:

| Classifier | Matches | Gate applied |
|---|---|---|
| `isSensitiveKey(key)` | keys starting `auth.`/`auth_`, or containing `force_logout`, `webhook`, `secret`, or `token` | `requireElevatedSession()` |
| `isAdminOnlyKey(key)` | keys starting `secret.` | `requireAdminSession()` (checked **first**, stricter) |

So a read of `secret.anthropic_api_key` through the generic settings endpoint requires `admin`, not merely elevation. This applies to both the single-key (`?key=`) and bulk (`?keys=a,b,c`) GET paths, and to writes: `POST /api/app-settings` requires elevation, and additionally rejects a `secret.*` write from a non-admin elevated caller with 403.

Because the setting key literally contains the substring `secret`, it is also caught by `isSensitiveKey` — meaning even if the admin-only branch were ever removed, a non-elevated caller still could not read it. The dedicated `app/api/admin/anthropic-key` route is the intended management surface (it also masks); the generic settings endpoint would return the raw value to an admin, which is why it stays admin-gated.

---

## The UI tab

`AdminApiKeys.tsx` renders a single Anthropic (Claude) key card under the "API tokens" header.

- **On mount**, `GET /api/admin/anthropic-key` (`cache: 'no-store'`) loads `{ configured, masked, source }`. Failure toasts *"Could not load API key status"*.
- **Status badge** (top-right of the card):
  - not configured → amber *"Not configured"*
  - `source === 'db'` → emerald *"Saved in app"*
  - `source === 'env'` → grey *"From environment"*
- **Current value** shows the masked string, or italic *"No key configured"*.
- **Set / Replace** — a password-type input (with eye toggle to reveal the *draft* only) + Save button. Label reads *"Replace key"* when a DB override is active, else *"Set key"*. Enter submits. Client trims and requires a non-empty draft; full server validation is authoritative. On success the field clears, reveal resets, and the status refreshes.
- **Remove override** — shown only when `source === 'db'`. `DELETE`s the row and toasts *"Removed saved key — reverted to the environment variable"* when an env var remains, otherwise *"Removed saved key"*.

A footer security note reiterates: stored under a secret-scoped setting (admin-readable only), masked everywhere, rotation is immediate with no redeploy.

---

## Security summary

- Full key is **never** sent to the client — GET/POST/DELETE all return only the masked preview + source.
- Stored raw in `app_settings` (service-role access only; the table is never read with the anon client for this key).
- Two independent gates protect reads: the dedicated route's `requireAdminSession()`, and the generic settings endpoint's `secret.*` admin-only + sensitive-key elevation tiers.
- Server-side validation (`sk-ant-` prefix, length ≥ 20) blocks obviously malformed values before they reach the DB.

---

## Extending (adding another credential)

The card is hard-coded to the Anthropic key today. To add another credential:

1. Store it under a `secret.<name>` key so it inherits the admin-only tier in `/api/app-settings` automatically.
2. Add a resolver/masker (mirror `src/lib/anthropic/api-key.ts`) so the full value never leaves the server.
3. Add a dedicated `requireAdminSession()`-gated route (mirror `app/api/admin/anthropic-key/route.ts`) and a second card in `AdminApiKeys.tsx`.
