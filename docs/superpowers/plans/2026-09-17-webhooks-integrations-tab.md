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

- [ ] `references/sql/create/2026-09-16_external_api_clients.sql` — add `granted_columns text[]`
  (NULL = whole table; non-null = only these, ≥1), `expires_at timestamptz` (NULL = never),
  `rate_limit_per_minute int not null default 60 check 1..600`. Requests: allow `POST` for the
  MCP route (CHECK widened to GET/POST), add denial reasons to the comment.
- [ ] `scripts/apply-external-api-clients-migration.mts` — constraint names, positive controls
  (a scoped client, an expiring client), negative controls (limit 0 / 601, empty granted list).
- [ ] `scripts/Apply External API clients migration.cmd` — copy points at Admin → Webhooks &
  Integrations → Integrations.

## Task 2 — pure modules + tests

- [ ] `src/lib/external-api/catalog.ts` — the GML column catalog: offerable columns, the
  `sensitive` group, `ALWAYS_COLUMNS` (`id` — the cursor), `NEVER_COLUMNS` (import/deletion
  bookkeeping, off-boarding stamps). `.test.ts`: every real column classified exactly once.
- [ ] `src/lib/external-api/grants.ts` — `normalizeGrant`, `selectFor`, `projectRow`,
  `filterColumnsFor` (a filter on a hidden column is refused). `.test.ts`: a hidden column
  never appears; `select` never contains `*`; filters on hidden columns are named.
- [ ] `src/lib/external-api/expiry.ts` — `EXPIRY_OPTIONS`, `expiresAtFor`, `isExpired`.
- [ ] `src/lib/external-api/rate-limit.ts` — `clampRateLimit`, `decideFromCount` (DB-counted
  window). Keep `SlidingWindowLimiter` for the tests that pin it.
- [ ] `src/lib/external-api/mcp-server.ts` — `buildMcpServer(ctx)`: tools `describe_access` and
  `query_global_master_list`; the tool list is pinned by test; output is projected.

## Task 3 — server

- [ ] `src/lib/supabase/external-api-db.ts` — new columns in types + PUBLIC_COLUMNS, create/patch
  fields, `readActiveGmlRows(select)`, `countRecentCalls(clientId, sinceIso)` (fail closed).
- [ ] `src/lib/external-api/authenticate.ts` — `expired` denial (401, same sentence).
- [ ] `src/lib/external-api/serve-gml.ts` — the shared auth → limit → query → project pipeline
  both routes call, so a REST call spends the MCP budget and vice versa.
- [ ] `app/api/external/v1/global-master-list/route.ts` — uses the pipeline.
- [ ] `app/api/external/mcp/route.ts` — POST only; stateless transport per request.
- [ ] `app/api/admin/external-api-clients/route.ts` + `[id]/route.ts` — grants, expiry, limit
  on POST and `update`; GET returns the catalog + `throttled_7d`.
- [ ] `src/lib/audit/registry.ts` — note names the new home.
- [ ] `package.json` — `@modelcontextprotocol/sdk` + `zod` promoted to direct deps, pinned.

## Task 4 — UI

- [ ] `src/components/admin/AdminExternalApiClients.tsx` — column picker (whole table default,
  sensitive group marked), expiry radio, limit field, Edit dialog, row shows Columns · Expires ·
  Limit · throttled; hand-off dialog with sample payload of only the granted columns + MCP config.
- [ ] `src/components/admin/AdminWebhooks.tsx` — tab strip Webhooks · Integrations; header
  actions only on Webhooks.
- [ ] `src/components/admin/AdminSidebar.tsx` — label "Webhooks & Integrations", id kept.
- [ ] `src/components/admin/AdminApiKeys.tsx` — unmount; hand-off note.

## Task 5 — docs, same commit

- [ ] `docs/features/external-api-integrations.md` (renamed from `external-api-global-master-list.md`)
- [ ] `docs/features/INDEX.md` — NEW row "Webhooks & Integrations"
- [ ] `docs/reference/api-reference.md` + `docs/reference/components.md` rows
- [ ] memory `external-api-integrations.md` + `MEMORY.md` pointer
- [ ] Open item 97 → shipped; Deploy notes mark the migration PENDING
