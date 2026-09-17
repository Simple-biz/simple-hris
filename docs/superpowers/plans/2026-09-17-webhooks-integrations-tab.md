# Webhooks & Integrations — the Integrations tab (per-column grants, expiry, rate limits, MCP)

**Approved brief:** in-session 2026-09-17 (session `675a6e09`), Open item 97 in
`docs/audits/audit-2026-09-16-session-log.md`. Kane's rulings, in order:

- *"they only need Global Master List — I can give them a whole table or hide some columns to
  protect data … give them the payload and the key … set time on how long that key can survive"*
- *"we should have rate limiting practices on this"*
- Expiry choices: **1 day · 15 days · 30 days · not expiring** — *"but we should have the option
  to revoke the key"* (Revoke stays).
- Pulled *"via querying or MCP"* ⇒ an MCP server on the SAME key, grants and budget.

Decisions the session made (posted, not vetoed): one table = one route stays (GML only) ·
grants, expiry and limit are editable after issue (audited) · default is the WHOLE table, hide
by unticking · External access LEAVES Admin → API tokens (one home) · the un-applied 09-16
create SQL is amended in place · MCP is on for every key · the limiter counts in the DB.

**Precedent:** `src/components/admin/AdminExternalApiClients.tsx` (moves, not rebuilt) ·
`app/api/external/v1/global-master-list/route.ts` (auth → limiter → log → answer) ·
`src/components/admin/AdminPages.tsx:233` (tab strip).

## Task 1 — the data layer (SQL amended in place, never applied yet)

- [x] `references/sql/create/2026-09-16_external_api_clients.sql` — add `granted_columns text[]`
  (NULL = whole table; non-null = only these, ≥1), `expires_at timestamptz` (NULL = never),
  `rate_limit_per_minute int not null default 60 check 1..600`. Requests: allow `POST` for the
  MCP route (CHECK widened to GET/POST), add denial reasons to the comment.
- [x] `scripts/apply-external-api-clients-migration.mts` — constraint names, positive controls
  (a scoped client, an expiring client), negative controls (limit 0 / 601, empty granted list).
- [x] `scripts/Apply External API clients migration.cmd` — copy points at Admin → Webhooks &
  Integrations → Integrations.

## Task 2 — pure modules + tests

- [x] `src/lib/external-api/catalog.ts` — the GML column catalog: offerable columns, the
  `sensitive` group, `ALWAYS_COLUMNS` (`id` — the cursor), `NEVER_COLUMNS` (import/deletion
  bookkeeping, off-boarding stamps). `.test.ts`: every real column classified exactly once.
- [x] `src/lib/external-api/grants.ts` — `normalizeGrant`, `selectFor`, `projectRow`,
  `filterColumnsFor` (a filter on a hidden column is refused). `.test.ts`: a hidden column
  never appears; `select` never contains `*`; filters on hidden columns are named.
- [x] `src/lib/external-api/expiry.ts` — `EXPIRY_OPTIONS`, `expiresAtFor`, `isExpired`.
- [x] `src/lib/external-api/rate-limit.ts` — `clampRateLimit`, `decideFromCount` (DB-counted
  window). Keep `SlidingWindowLimiter` for the tests that pin it.
- [x] `src/lib/external-api/mcp-server.ts` — `buildMcpServer(ctx)`: tools `describe_access` and
  `query_global_master_list`; the tool list is pinned by test; output is projected.

## Task 3 — server

- [x] `src/lib/supabase/external-api-db.ts` — new columns in types + PUBLIC_COLUMNS, create/patch
  fields, `readActiveGmlRows(select)`, `countRecentCalls(clientId, sinceIso)` (fail closed).
- [x] `src/lib/external-api/authenticate.ts` — `expired` denial (401, same sentence).
- [x] `src/lib/external-api/serve-gml.ts` — the shared auth → limit → query → project pipeline
  both routes call, so a REST call spends the MCP budget and vice versa.
- [x] `app/api/external/v1/global-master-list/route.ts` — uses the pipeline.
- [x] `app/api/external/mcp/route.ts` — POST only; stateless transport per request.
- [x] `app/api/admin/external-api-clients/route.ts` + `[id]/route.ts` — grants, expiry, limit
  on POST and `update`; GET returns the catalog + `throttled_7d`.
- [x] `src/lib/audit/registry.ts` — note names the new home.
- [x] `package.json` — `@modelcontextprotocol/sdk` + `zod` promoted to direct deps, pinned.

## Task 4 — UI

- [x] `src/components/admin/AdminExternalApiClients.tsx` — column picker (whole table default,
  sensitive group marked), expiry radio, limit field, Edit dialog, row shows Columns · Expires ·
  Limit · throttled; hand-off dialog with sample payload of only the granted columns + MCP config.
- [x] `src/components/admin/AdminWebhooks.tsx` — tab strip Webhooks · Integrations; header
  actions only on Webhooks.
- [x] `src/components/admin/AdminSidebar.tsx` — label "Webhooks & Integrations", id kept.
- [x] `src/components/admin/AdminApiKeys.tsx` — unmount; hand-off note.

## Task 5 — docs, same commit

- [x] `docs/features/external-api-integrations.md` (renamed from `external-api-global-master-list.md`)
- [x] `docs/features/INDEX.md` — NEW row "Webhooks & Integrations"
- [x] `docs/reference/api-reference.md` + `docs/reference/components.md` rows
- [x] memory `external-api-integrations.md` + `MEMORY.md` pointer
- [x] Open item 97 → shipped; Deploy notes mark the migration PENDING

## Shipped

- `4ec186c0` — Tasks 1–5 as planned (grants · expiry · rate limit · MCP · the tab · docs).
- `9ffcc84f` — follow-up (Kane, same day): Console-plain panel + the Admin tab cache
  (`src/lib/admin/tab-cache.ts`, `docs/features/admin-dashboard-cache.md`).
- `62930939` — New client as a four-step slideshow (Who → Columns → Access → Confirm).
- `1a450758` — hand-off dialog as one wrapping column with a segmented preview (it overflowed sideways).

Still PENDING on Kane: the migration (`scripts/Apply External API clients migration.cmd`) and, optionally,
`EXTERNAL_API_KEY_PEPPER` on Vercel. Not exercised in a browser by the session.
