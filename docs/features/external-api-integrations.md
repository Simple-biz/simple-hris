# Integrations — outside systems read the Global Master List by key, REST or MCP

A key-gated, read-only way for a system we do not control (a coworker's dashboard, an n8n
flow, a Sheets script, an MCP client such as Claude Desktop) to read the **active** Global
Master List. Admins issue one key per system from **Admin → Webhooks & Integrations →
Integrations**, choose which **columns** it may read (the whole table, or hide some), how
long the key **lives** (1 day · 15 days · 30 days · does not expire) and how many **calls
per minute** it gets, hand over one ready-to-paste **hand-off** (key, endpoints, sample
payload, MCP config), and can edit, revoke, restore or rotate at any time with effect on the
next call. First shipped 2026-09-16 as "Admin → API tokens → External access" (commit
`a90155fc`, GML only, all columns); widened and moved 2026-09-17 (this commit).

Kane's framing, 2026-09-17: *"they only need Global Master List — I can give them a whole
table for the Global Master List or hide some of those columns to protect data so I can just
give them the payload and the key authorization as well I can also set time on how long that
key can survive … we should have rate limiting practices on this … [expiry] 1 day, 15 days,
30 days and not expiring but we should have the option to revoke the key … let them pull via
querying or MCP."*

## Key files

| Piece | File |
| --- | --- |
| The REST endpoint | `app/api/external/v1/global-master-list/route.ts` — `GET` only |
| The MCP endpoint | `app/api/external/mcp/route.ts` — `POST` only, stateless Streamable HTTP |
| The gate both share (auth → grant → rate → log) | `src/lib/external-api/serve.ts` |
| Bearer → client (revoked / **expired** / scope) | `src/lib/external-api/authenticate.ts` |
| Key generate / hash / fingerprint / pepper | `src/lib/external-api/keys.ts` (+ `.test.ts`) |
| **The column catalog** (offerable · sensitive · always · never) | `src/lib/external-api/catalog.ts` (+ `.test.ts`, pinned to the live schema) |
| **Grants** — select built from the grant, projection, refused filters | `src/lib/external-api/grants.ts` (+ `.test.ts`) |
| The one read pipeline REST and MCP both run | `src/lib/external-api/gml-read.ts` (+ `.test.ts`) |
| Query parse + filter + page (pure) | `src/lib/external-api/gml-query.ts` (+ `.test.ts`) |
| **Expiry** options and the fail-closed check | `src/lib/external-api/expiry.ts` (+ `.test.ts`) |
| **Rate limit** — per-client, DB-counted decision | `src/lib/external-api/rate-limit.ts` (+ `.test.ts`) |
| **MCP server** — the two read tools | `src/lib/external-api/mcp-server.ts` (+ `.test.ts`, tool list pinned) |
| Data access (service-role) incl. the rate meter | `src/lib/supabase/external-api-db.ts` |
| Admin management routes | `app/api/admin/external-api-clients/route.ts` · `[id]/route.ts` · `[id]/requests/route.ts` |
| Admin UI — the Integrations tab | `src/components/admin/AdminExternalApiClients.tsx`, mounted by `AdminWebhooks.tsx` (tab strip) |
| Sidebar label (id unchanged) | `src/components/admin/AdminSidebar.tsx` — `{ id: 'webhooks', label: 'Webhooks & Integrations' }` |
| SSO bypass | `proxy.ts` — `/api/external/` passes the gate; the handler IS the gate |
| Audit family | `src/lib/audit/registry.ts` — `external_api.` on `admin` |
| Tables | `references/sql/create/2026-09-16_external_api_clients.sql` (amended in place 2026-09-17, never applied before) |
| Migration | `scripts/apply-external-api-clients-migration.mts` · `scripts/Apply External API clients migration.cmd` |
| Dependencies | `@modelcontextprotocol/sdk` 1.29.0 · `zod` 3.25.76 — promoted from transitive to direct, pinned |

## Columns are a GRANT — the select is built from it, never `*`

`external_api_clients.granted_columns` is `NULL` (**the whole table** — every column in the
catalog) or a list of catalog column names (**only these**). The default in the picker is the
whole table; the admin hides by unticking. **An empty list is refused** by the route and the
SQL CHECK: NULL means everything, `[]` would mean nothing to one reader and everything to
another. A list that ticks every column is stored as NULL so "whole table" has one spelling.

The read selects exactly `id`, `off_boarded_at` and the granted columns (`selectFor`), and
every row is **projected** to the visible columns before it is serialised (`projectRow`) — on
the REST route and inside the MCP tool alike, because both run `executeGmlRead`. A hidden
column is not fetched-then-dropped; it is not fetched. `grants.test.ts`, `gml-read.test.ts`
and `mcp-server.test.ts` each assert a hidden column never appears in the output.

**A filter on a hidden column is a `400 column_not_granted`**, naming the parameter. Without
this, `?email=someone@gmail.com` against a key that cannot see Personal Email would still
confirm the address belongs to an active person. `?email=` and `?search=` match only the
email columns the key can see; `?department=` needs Department; `?search=` needs Name or a
visible email column. `describe_access` (MCP) tells the caller which filters it has.

**The catalog is code** (`catalog.ts`). A column reaches the picker only when it is named
there, in one of three classes — `id` (always; it is the page cursor), offerable (what the
admin picks; `sensitive` marks personal contact / address / photo data so it stands out —
no API effect), never (`import_batch_id`, `source_file`, the `*_upload_id`s, the four
`off_boarded_*` stamps, the two deletion stamps — not offerable, not returned even to a
whole-table key; `off_boarded_at` is still READ for the leaver check and projected away).
`catalog.test.ts` pins the union of the three classes to the live column list read on
2026-09-17: **a new column on `global_master_list` fails the suite until someone classifies
it**. That is the point — the decision must not be silent.

## The key can expire — and Revoke is always there

`expires_at` is NULL (does not expire) or a timestamp chosen at issue as **1 day · 15 days ·
30 days** from now (Kane, 2026-09-17); the Edit dialog can set a new one, counted from the
moment it is saved. `authenticateExternalRequest` checks it on **every call** against the row,
so an expired key gets the same one-sentence `401` a revoked key gets (`denial: expired`
inward), and shortening an expiry in the panel takes effect on the next call. `isExpired`
**fails closed**: a stamp that does not parse counts as expired.

Restore does not resurrect an expired key — extend the expiry with Edit. Rotate does not
touch `expires_at` — a rotated key keeps the client's expiry; extend it explicitly.

## The rate limit is per client, DB-counted, one budget for REST and MCP

Kane, 2026-09-17: *"we should have rate limiting practices on this."* Each client row carries
`rate_limit_per_minute` (default 60, range 1..600, enforced by CHECK and by `clampRateLimit`
on read, so a corrupt row cannot open the door). Before answering, `admitExternalCall` counts
the client's rows in `external_api_requests` over the last 60 s with `status ≠ 429` — a
refused call does not extend the window, or a throttled caller could never recover — and
decides with `decideFromWindow`. **The request log is the meter**, so the number on the
admin's screen is the number enforced, on every Vercel instance. If the count cannot be read
the call is **refused (503)**, never allowed.

One `POST` to the MCP route is one call, whatever JSON-RPC method it carries, against the
same budget the REST route spends. A refusal is `429` with `Retry-After`,
`X-RateLimit-Limit`, `X-RateLimit-Remaining` and a `rate_limited` log row; the table shows
throttled calls per client for 7 days. There is deliberately **no global cap** across keys.

The old in-memory `SlidingWindowLimiter` stays in `rate-limit.ts` for the `proxy.ts`-shaped
limiters and its tests; the external routes no longer use it.

## MCP — two read tools on the same key

`POST /api/external/mcp` is a **stateless** Streamable HTTP server (JSON responses, no
session id, no GET stream, no DELETE). A new `McpServer` + transport is built per request and
closed after it, so nothing is cached between calls and a revoke, an expiry or a narrowed
grant is honoured on the next POST. The tools, pinned by `mcp-server.test.ts`:

- `describe_access` — the table, the columns THIS key may read, the filters it may use, its
  rate limit and expiry. Callers should read this first.
- `query_global_master_list` — the REST contract as a tool: `department`, `email`, `search`,
  `limit` (1–500, default 100), `cursor`. Returns `{ data, page, columns }` after the same
  `executeGmlRead` pipeline; a filter on a hidden column is a tool error (`isError`), not an
  empty page.

Both carry `readOnlyHint: true`. **Adding a third tool, or a write, fails the suite** — a
write tool is a feature decision, not a config.

## The key is never stored

`external_api_clients.key_hash` holds `sha256(key · pepper)`, nothing else. The plaintext
appears in exactly two responses: the `POST` that created the client and the `PATCH` that
rotated it — rendered once in the **hand-off** dialog (key, curl, MCP config, sample payload
of only the granted columns, and one "everything, ready to paste" block). **There is no "show
key again"**; if it is lost, Rotate.

The pepper is `EXTERNAL_API_KEY_PEPPER`, falling back to `NEXTAUTH_SECRET`. `readPepper()`
**fails closed**: with neither set, no key can be issued (`503`) and no key can verify (`503`).
Never give it a literal default. Rotating whichever secret is in use kills every issued key;
that is the correct consequence, and it is why the dedicated variable exists.

## Revoke is instant because nothing is cached

Every call does one indexed equality lookup on the hash. There is no in-process client cache,
so `revoked_at` set → the next call is `401`. **Do not add a key cache**. Restore clears
`revoked_at` and the **same** key works again. Rotate issues a new key, keeps the client id,
grant, limit, expiry and history, and also clears a revocation. **There is no DELETE**:
`external_api_requests.client_id` references the client with `ON DELETE RESTRICT`, because
the history is the record of what system read the roster and it must outlive the key.

## Off-boarded people are unreachable — enforced twice

`readActiveGmlRows` filters `off_boarded_at IS NULL` in SQL, and `applyGmlQuery` drops any
row with `off_boarded_at` set **before** any filter runs — which is why `off_boarded_at` is
always selected and then projected away. There is no `include_offboarded` parameter; an
unknown parameter is a `400`. "Active" is the `gml-status.ts` rule (any unstamped row), **not**
the `active_employees` view (a `security_invoker` view that goes silently empty under RLS —
memory/security-invoker-view-silent-empty.md). Duplicate master rows for one person are
returned as-is — the API reports the table, it does not resolve identity.

## Every call is logged, denied ones included

One `external_api_requests` row per call — REST `GET` or MCP `POST`; `200`, `202`, `400`,
`401`, `403`, `429`, `500`, `503` alike — with the **presented** key prefix, the denial
reason (`missing / malformed / unknown / revoked / expired / scope / unconfigured /
unavailable / rate_limited / bad_request / column_not_granted / read_failed`), ip,
user-agent, row count and duration. For MCP the `query` column carries the JSON-RPC method
and, for a tool call, the tool + arguments. A denied call has `client_id NULL` and a
`denial`; the CHECK makes a success without a client, or a denial without a reason,
unrepresentable. The panel surfaces unattributed calls as a red notice.

This table is deliberately **not** `audit_log`. The audit log carries only the lifecycle
events — `external_api.client.created / revoked / restored / rotated / updated` — actor from
`auditFrom(request, authz)`, never the body; `updated` details name the grant, expiry and
limit changes (before and after), never key material.

## Why the proxy lets `/api/external/` through

`proxy.ts` passes the whole prefix without a session check: a tokenless or wrong-key caller
would otherwise receive a `302` to `/login` — HTML an API client cannot act on — while the
handler answers a JSON `401` and logs the attempt. `admitExternalCall` is fail-closed on
every branch, so the bypass loosens nothing. **Nothing under `/api/external/` may ever rely
on a session**; a new endpoint there goes through `admitExternalCall` or it does not ship.
The MCP route needed no proxy change — it is under the same prefix.

## One table = one route — still the rule

The Sep 16 rule stands: the only scope is `global_master_list.read`, and **adding a table
means a new scope in the SQL CHECK, a new catalog, and a new route (and MCP tool) that
honours it** — never widening this one. Kane's model ("they only need Global Master List")
kept v1 to this table; the catalog is where the next one goes.

## Contract

```
GET /api/external/v1/global-master-list
Authorization: Bearer hris_live_…

?department=   exact, case-insensitive             — needs Department visible
?email=        matches the VISIBLE email columns    — needs one visible
?search=       substring over Name + visible emails — needs Name or an email visible
?limit=        1–500, default 100
?cursor=       the previous page's page.next_cursor (exclusive, keyset on id)

200 { data: [...rows, granted columns only], page: { limit, max_limit, returned, total, next_cursor },
      meta: { as_of, active_only: true, client, columns: [...], expires_at } }
400 { error: 'Invalid query', details: [{ field, message }] }
400 { error: 'This key cannot filter on a column it was not granted', details: [{ field, message }] }
401 { error: 'Invalid or revoked API key' }        — ONE sentence for missing / malformed / unknown / revoked / EXPIRED
403 { error: 'Invalid or revoked API key' }        — a scope the row does not carry
429 { error: 'Rate limit exceeded …' }  Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining
503 { error: 'The external API is not configured …' | '… temporarily unavailable' }

POST /api/external/mcp        Streamable HTTP, stateless, JSON responses; same Bearer key
  tools: describe_access · query_global_master_list({ department?, email?, search?, limit?, cursor? })
  every POST = one call against the same rate limit; GET / DELETE = 405
```

Walk the roster with `cursor` until `next_cursor` is `null`. `limit` is capped at 500, below
the PostgREST 1000-row ceiling by construction (a test asserts `MAX_LIMIT < 1000`); the read
itself uses `selectAllPaged` regardless.

## Admin routes

```
GET   /api/admin/external-api-clients                 { clients: [+ calls_7d, denied_7d, throttled_7d], unattributed, configured, migration_applied, rest_path, mcp_path }
POST  /api/admin/external-api-clients                 { name, system, contact_email?, granted_columns?: null|string[], expiry: '1d'|'15d'|'30d'|'never', rate_limit_per_minute? } → { client, api_key }  (key shown ONCE)
PATCH /api/admin/external-api-clients/{id}            { action: 'revoke' | 'restore' | 'rotate' | 'update', …update fields: name?, system?, contact_email?, granted_columns?, expiry?, rate_limit_per_minute? }
GET   /api/admin/external-api-clients/{id}/requests   the newest calls, up to 500
```

All `requireAdminSession()`. No DELETE.

## The panel — Console-plain, and cached (2026-09-17 PM)

Kane: *"make this beautiful … simple like Google Console … add cache practices as well where it
doesn't go away after switching tabs or reload."* The Integrations panel is one title row with
the single primary action, an **endpoints strip** (REST · MCP · Auth, each with copy), a filter
toolbar (All / Live / Revoked / Expired counts, a text filter, an "Updated … ago" stamp and
Refresh), and **one flat table** on a hairline surface. Status is a dot and a word, never a
filled pill; the only accent is the app's orange on the primary action; row actions are ghost
icon buttons that come to full strength on hover or focus. The dialogs (Edit, hand-off, Calls) keep the same vocabulary — hairline borders, zinc, one primary.
**New client is a four-step slideshow** (Kane: *"separate them by group with a confirm at the end"*):
Who (name · system · contact) → Columns → Access (lifetime · limit) → **Confirm**, a read-back with
an Edit link per row. Next is gated on the current step only, done steps are clickable, Enter
advances, and nothing is created until Confirm — the key is issued on that click and shown once.

The client list lives in the **Admin tab cache** (`ADMIN_CACHE_KEYS.integrationsClients`,
`docs/features/admin-dashboard-cache.md`): a tab switch or reload paints the last list at once,
the fetch still runs on every mount and overwrites it, and the skeleton shows only when there is
nothing to paint. **A cached value paints, never decides** — nothing skips the fetch, because a
key revoked from another tab must not read as live. The plaintext key is never list state and so
is never cached. The Webhooks tab caches its open section and its entries as loaded/saved, never
as edited.

## Deploy notes

- **Migration PENDING** — `scripts/Apply External API clients migration.cmd` (rehearsal, then
  `APPLY`). Measured 2026-09-17: neither table exists in production yet. The create SQL was
  amended in place (never applied before), so this is still ONE migration. Until it runs, the
  Integrations tab says "table not applied yet" and both endpoints answer `503`. Needs
  `DATABASE_URL` (session pooler) in `.env.local` — present.
- **Env** — optional `EXTERNAL_API_KEY_PEPPER` on Vercel (unset as of 2026-09-17). Without it,
  `NEXTAUTH_SECRET` is the pepper. Set the dedicated one before issuing keys if you ever want
  to rotate the NextAuth secret without killing every API key.
- **Dependencies** — `@modelcontextprotocol/sdk@1.29.0` and `zod@3.25.76` are now direct,
  pinned dependencies (they were already in `node_modules` transitively via `shadcn`); the
  lockfile is updated, `npm install` is a no-op.
- **No n8n / cron.** No changes to `global_master_list`. No proxy change.
- First client: Admin → Webhooks & Integrations → Integrations → New client. Name = who,
  System = what will call, tick the columns, pick the expiry and the limit. Copy the hand-off
  from the dialog; the key is shown once.
