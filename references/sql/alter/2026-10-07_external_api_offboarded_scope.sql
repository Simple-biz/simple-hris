-- External read API — a SECOND scope: offboarded.read (the leavers list).
--
-- Kane, 2026-10-07: "lets add the offboarded list so that a key can be used to access this
-- please ASAP." Admin → Webhooks & Integrations → Data catalog had Offboarded as Planned; this
-- is the one control outside the repo that decides whether a key may hold it.
--
-- WHAT CHANGES: external_api_clients_scopes_known — the CHECK that enumerates every scope a
-- client row may carry — gains 'offboarded.read'. Nothing else. No table, no column, no row.
-- The live client(s) keep exactly the scopes they have; the column default stays
-- array['global_master_list.read'], so a client created by an older deploy is roster-only.
--
-- KEEP THE CHECK ENUMERATED (docs/superpowers/plans/2026-09-21-external-api-resources-and-writes.md
-- § Global constraints). Do not replace it with a shape regex like '^[a-z_]+\.read$' — the
-- enumeration is the only control that lives outside the repo, and a regex would let a typo'd
-- or future scope be stored before any route honours it. A new dataset needs a deploy anyway.
--
-- src/lib/external-api/datasets.test.ts reads the scope array out of the NEWEST dated SQL file
-- that defines this constraint and pins it, both directions, to the catalog's live datasets.
--
-- NO BEGIN/COMMIT HERE, DELIBERATELY. scripts/apply-external-api-offboarded-scope-migration.mts
-- owns the transaction; its dry run wraps this file in a transaction it always rolls back, and an
-- inner COMMIT would make the rehearsal permanent (memory offboarded-tab-merged-origin-column).
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD. Re-running is a no-op.
--
-- Apply with
--   node --import tsx scripts/apply-external-api-offboarded-scope-migration.mts --apply

alter table public.external_api_clients
  drop constraint if exists external_api_clients_scopes_known;

alter table public.external_api_clients
  add constraint external_api_clients_scopes_known
  check (scopes <@ array['global_master_list.read', 'offboarded.read']::text[] and cardinality(scopes) >= 1);

comment on table public.external_api_clients is
  'Outside systems allowed to call /api/external/v1/* and /api/external/mcp. One row per client; the key is NEVER stored — only sha256(key · pepper). revoked_at set or expires_at passed = dead on the next call (no cache). scopes: global_master_list.read (the active roster; granted_columns NULL = whole table, else only those columns) and/or offboarded.read (the leavers ledger, offboarded_sheet; fixed field list). READ-ONLY API.';

-- Verification:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'external_api_clients_scopes_known';
--   select name, scopes from public.external_api_clients order by created_at;
