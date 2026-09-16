# External API — Global Master List read access for outside systems

A key-gated, read-only HTTP endpoint that lets a system we do not control (a coworker's
dashboard, an n8n flow, a Sheets script) read the **active** Global Master List. Admins issue
one key per system from Admin → API tokens → **External access**, see every call it makes, and
revoke or rotate it in one click with immediate effect. Shipped 2026-09-16 (this commit).

Kane's framing: *"a table query for the Global Master List where my coworker can query that
table only … like an API request where we can block it anytime and know what system they are
using."* Rulings the same day: **all columns** (Q1), **off-boarded people unreachable** (Q2),
**60 calls/min/key** (Q3), **Rotate keeps the client and its history** (Q4).

## Key files

| Piece | File |
| --- | --- |
| The endpoint | `app/api/external/v1/global-master-list/route.ts` — `GET` only |
| Bearer → client | `src/lib/external-api/authenticate.ts` |
| Key generate / hash / fingerprint / pepper | `src/lib/external-api/keys.ts` (+ `.test.ts`) |
| Query parse + filter + page (pure) | `src/lib/external-api/gml-query.ts` (+ `.test.ts`) |
| Per-key rate limit (pure) | `src/lib/external-api/rate-limit.ts` (+ `.test.ts`) |
| Data access (service-role) | `src/lib/supabase/external-api-db.ts` |
| Admin management routes | `app/api/admin/external-api-clients/route.ts` · `[id]/route.ts` · `[id]/requests/route.ts` |
| Admin UI | `src/components/admin/AdminExternalApiClients.tsx`, mounted by `AdminApiKeys.tsx` |
| SSO bypass | `proxy.ts` — `/api/external/` passes the gate; the handler IS the gate |
| Audit family | `src/lib/audit/registry.ts` — `external_api.` on `admin` |
| Tables | `references/sql/create/2026-09-16_external_api_clients.sql` |
| Migration | `scripts/apply-external-api-clients-migration.mts` · `scripts/Apply External API clients migration.cmd` |

## The key is never stored

`external_api_clients.key_hash` holds `sha256(key · pepper)`, nothing else. The plaintext
appears in exactly two responses: the `POST` that created the client and the `PATCH` that
rotated it. The admin dialog says so before it closes. **There is no "show key again"** and
there cannot be — if it is lost, Rotate.

The pepper is `EXTERNAL_API_KEY_PEPPER`, falling back to `NEXTAUTH_SECRET` (the OTP flows lean
on the same secret). `readPepper()` **fails closed**: with neither set, no key can be issued
(`503`) and no key can verify (`503`). Never give it a literal default — a known pepper makes
the hash reproducible from the row alone. Rotating whichever secret is in use kills every
issued key; that is the correct consequence, and it is why the dedicated variable exists.

`key_prefix` (`hris_live_` + 6 chars) is a fingerprint for the table and the log. It is not
enough to authenticate, and the migration's negative control proves a plaintext-shaped value
cannot be written into `key_hash`.

## Revoke is instant because nothing is cached

Every call does one indexed equality lookup on the hash. There is no in-process client cache,
so `revoked_at` set → the next call is `401`. **Do not add a key cache** to save the lookup; a
revoke that takes effect "within a few minutes" is not the feature Kane asked for.

Restore clears `revoked_at` and the **same** key works again. Rotate issues a new key, keeps the
client id and its history, and also clears a revocation (the point of rotating is to hand the
system a working key). **There is no DELETE**: `external_api_requests.client_id` references
the client with `ON DELETE RESTRICT`, because the history is the record of what system read
the roster and it must outlive the key.

## Off-boarded people are unreachable — enforced twice

`readActiveGmlRows` filters `off_boarded_at IS NULL` in SQL, and `applyGmlQuery` drops any
row with `off_boarded_at` set **before** any filter runs. There is no `include_offboarded`
parameter; an unknown parameter is a `400`. The test suite asserts a leaver cannot be reached
by work email, personal email, search or department.

"Active" here is the `gml-status.ts` rule (any unstamped row), **not** the `active_employees`
view: the view additionally requires membership in the latest sheet upload, which people seeded
outside the sync never satisfy, and it is a `security_invoker` view that goes silently empty
under RLS (memory/security-invoker-view-silent-empty.md). Duplicate master rows for one person
(memory/duplicate-master-rows-hsl-tiebreak.md) are returned as-is — the API reports the table,
it does not resolve identity.

## All columns, one table, one verb

Kane chose **every column** (Q1), so the row goes out as stored — Personal Email, Phone Number,
address fields and photo URLs included. The consumer is a coworker's system, and that choice is
on record. The route file exports `GET` and nothing else, so every other method is a framework
`405`; the only scope in the CHECK constraint is `global_master_list.read`, so a "write" scope
cannot even be stored. **Adding a table means a new scope in the SQL CHECK and a new route that
honours it** — never widening this one.

## Contract

```
GET /api/external/v1/global-master-list
Authorization: Bearer hris_live_…

?department=   exact, case-insensitive
?email=        matches Work / Personal / Alternate / Alternate 2, case-insensitive
?search=       substring over Name + the four email columns (≤120 chars)
?limit=        1–500, default 100
?cursor=       the previous page's page.next_cursor (exclusive, keyset on id)

200 { data: [...rows], page: { limit, max_limit, returned, total, next_cursor }, meta: { as_of, active_only: true, client } }
400 { error: 'Invalid query', details: [{ field, message }] }
401 { error: 'Invalid or revoked API key' }        — ONE sentence for missing / malformed / unknown / revoked
403 { error: 'Invalid or revoked API key' }        — a scope the row does not carry
429 { error: 'Rate limit exceeded …' }  Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining
503 { error: 'The external API is not configured …' | '… temporarily unavailable' }
```

Walk the roster with `cursor` until `next_cursor` is `null`. `limit` is capped at 500, below
the PostgREST 1000-row ceiling by construction (a test asserts `MAX_LIMIT < 1000`); the read
itself uses `selectAllPaged` regardless.

## The rate limit is per instance

`SlidingWindowLimiter` is in-memory in the route module — 60/min per client id, `429` with
`Retry-After`. On a multi-instance deploy each instance counts separately, so the true ceiling
is N × 60. It is abuse prevention, not a meter; the `external_api_requests` table is the meter.

## Every call is logged, denied ones included

One `external_api_requests` row per call — `200`, `400`, `401`, `403`, `429`, `500`, `503`
alike — with the **presented** key prefix, the denial reason, ip, user-agent, row count and
duration. A denied call has `client_id NULL` and a `denial`; the CHECK constraint makes a
success without a client, or a denial without a reason, unrepresentable. The admin panel
surfaces unattributed calls as a red notice: a revoked key being retried is normal, an unknown
prefix is someone guessing.

This table is deliberately **not** `audit_log` (17k rows, wider readership). The audit log
carries only the lifecycle events — `external_api.client.created / revoked / restored / rotated
/ updated` — actor from `auditFrom(request, authz)`, never the body, details naming the client
and prefixes but never key material.

## Why the proxy lets `/api/external/` through

`proxy.ts` passes the whole prefix without a session check. The brief proposed keying the
bypass on a `Bearer hris_` header; it was changed during build because a tokenless or wrong-key
caller would otherwise receive a `302` to `/login` — HTML an API client cannot act on — while
the handler answers a JSON `401` and logs the attempt. The handler is fail-closed on every
branch, so the bypass loosens nothing. **Nothing under `/api/external/` may ever rely on a
session**; if a second endpoint is added there, it authenticates with
`authenticateExternalRequest` or it does not ship.

## Deploy notes

- **Migration PENDING** — `scripts/Apply External API clients migration.cmd` (rehearsal, then
  `APPLY`). Until it runs, the panel says "table not applied yet" and the endpoint answers
  `503`. Needs `DATABASE_URL` (session pooler) in `.env.local`.
- **Env** — optional `EXTERNAL_API_KEY_PEPPER` on Vercel. Without it, `NEXTAUTH_SECRET` is the
  pepper (already set). Set the dedicated one before issuing keys if you ever want to rotate the
  NextAuth secret without killing every API key.
- **No n8n / cron.** No changes to `global_master_list`.
- First client: Admin → API tokens → External access → New client. Name = who, System = what
  will call. Copy the key from the dialog; it is shown once.
