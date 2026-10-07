# External API — the Offboarded dataset (a second scope, REST + MCP)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:executing-plans`. Steps use `- [ ]` syntax.

**Goal:** a key can read the leavers list. Kane, 2026-10-07: *"lets add the offboarded list so that a key can be
used to access this please ASAP."* The Data catalog's **Offboarded** page moves from Planned to Live.

**Spec:** the `BLUEPRINT` brief posted in this session (2026-10-07). It follows the shipped rule *one table = one
route* (`external-api-integrations.md` § One table = one route): a new scope in the SQL CHECK, a new catalog, a
new route and MCP tool. It is **not** Phase A (`2026-09-21-external-api-resources-and-writes.md`), which is still
unbuilt. Two of Phase A's guards are adopted here because they apply to any second scope: the CHECK stays
**enumerated**, and the scope a route needs is a **required** argument with no default.

**Measured read-only 2026-10-07 (production):** `offboarded_sheet` holds 4,446 rows (ids 41958–46420, bigint).
Origin is 3,519 `google_sheet` / 927 `hris`. 774 rows have no `off_boarded_at`, 3,354 have no department and 12 have no work email.
29 distinct reason keys, including free-text sentences. 378 work emails carry more than one row.
1,726 master rows are stamped; 355 of those have no ledger row (349 `duplicate_cleanup`, 6 real departures).
193 ledger rows share a work email with an unstamped master row (65 with the same personal email).
The anon key reads 0 rows of `offboarded_sheet` (RLS on; negative control `PGRST205`).

## Tasks

- [x] **1 · SQL.** `references/sql/alter/2026-10-07_external_api_offboarded_scope.sql` drops and re-adds
      `external_api_clients_scopes_known` with `array['global_master_list.read','offboarded.read']`. No BEGIN/COMMIT.
      `scripts/apply-external-api-offboarded-scope-migration.mts` (dry by default, `--apply`, `--verify`, positive +
      negative controls) and `scripts/Apply External API offboarded scope migration.cmd`.
- [x] **2 · `scopes.ts`.** `GML_SCOPE`, `OFFBOARDED_SCOPE`, `EXTERNAL_SCOPES`, `normalizeScopes` (unknown → error,
      empty → error, catalog order).
- [x] **3 · `offboarded.ts` (+ test).** Field list, `reasonCategory` (category or `null`, `NOT_DEPARTURE` → excluded),
      `parseOffboardedQuery`, `applyOffboardedQuery` (exclusions first, then filters, then integer keyset page),
      `projectOffboardedRow`, `executeOffboardedRead`.
- [x] **4 · Gate.** `authenticateExternalRequest(request, acceptedScopes)`: required, any-of, no default.
      `admitExternalCall` takes `scopes` in `info`. The GML route passes `[GML_SCOPE]`, the offboarded route
      `[OFFBOARDED_SCOPE]`, and MCP every scope.
- [x] **5 · Read.** `readOffboardedLedgerRows()` = `selectAllPaged` over `offboarded_sheet`, a fixed select, `order('id')`.
- [x] **6 · Route.** `app/api/external/v1/offboarded/route.ts`, `GET` only, which logs every outcome.
- [x] **7 · MCP.** Tools are registered per held scope. A GML-only key sees exactly today's two tools and today's
      `describe_access` payload. `MCP_TOOL_NAMES` = 3.
- [x] **8 · Admin routes.** POST takes `scopes` (default GML only); PATCH `update` takes `scopes`. Both are validated and
      audited (before/after). A CHECK violation on the scope gives a 503 that names the migration.
- [x] **9 · Panel.** The Datasets step goes before Columns. Columns applies only when the roster is ticked. The column header
      becomes Access. The endpoints strip gains the Offboarded row, and the hand-off names what the key holds.
- [x] **10 · Catalog.** Offboarded → `live`. `fieldGrantFor` returns `whole` for it (no per-field grant exists) and
      caveats are re-dated to today's measurements.
- [x] **11 · Verify.** `npm test` (external-api suites), `npx tsc --noEmit`. **No `next build`: a dev server is on :3000.**
- [x] **12 · Docs.** `docs/features/external-api-offboarded.md`, INDEX row, `external-api-integrations.md` and
      `integrations-data-catalog.md` cross-links, memory + `MEMORY.md`, one commit by explicit path.
