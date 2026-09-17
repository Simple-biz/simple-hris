-- External read API — per-client keys for OUTSIDE systems that query the Global Master List.
--
-- Admin → Webhooks & Integrations → Integrations (moved out of Admin → API tokens on 2026-09-17).
-- An admin creates a CLIENT (a named system — "Ops dashboard", "n8n roster sync"), chooses which
-- COLUMNS of the Global Master List it may read (NULL = the whole table), how long the key lives
-- (expires_at; NULL = until revoked) and how many calls per minute it gets, and is shown the key
-- ONCE. The key is never stored: only sha256(key · pepper) is, and every call to
-- /api/external/v1/* and /api/external/mcp is authenticated by hashing the presented Bearer
-- token and looking that hash up here. Revoking a client (revoked_at set) or an expiry passing
-- makes its key fail on the very next call — there is no key cache.
--
-- Rotate keeps the client row and its history and replaces key_hash + key_prefix; the old key
-- dies instantly. Nothing deletes a client: the request log below is the record of what system
-- called us, and that record outlives the key.
--
-- external_api_requests is APPEND-ONLY: one row per call INCLUDING denied ones (401 / 429),
-- so a leaked or guessed key shows up as a stream of failures against a key_prefix. It is also
-- the RATE-LIMIT METER: the route counts this client's rows in the last 60 seconds before it
-- answers, so the limit holds across every server instance (2026-09-17, Kane: "we should have
-- rate limiting practices on this"). It is deliberately its OWN table — audit_log carries the
-- lifecycle events (created / revoked / restored / rotated / updated) and must not grow by one
-- row per API call.
--
-- READ-ONLY BY CONSTRUCTION: no scope other than global_master_list.read exists; the REST route
-- is a GET and the MCP route registers two read tools. Off-boarded people are unreachable
-- (Kane, 2026-09-16) — the route filters off_boarded_at IS NULL in SQL and again in memory.
--
-- Idempotent: safe to re-run. Apply with
--   node --import tsx scripts/apply-external-api-clients-migration.mts --apply

create table if not exists public.external_api_clients (
  id                     uuid          primary key default gen_random_uuid(),
  name                   text          not null,                        -- who: "Ops team roster mirror"
  system                 text          not null,                        -- what: "n8n", "Google Sheets script", "Retool"
  contact_email          text,                                          -- whom to call when it misbehaves
  key_prefix             text          not null,                        -- first 16 chars of the key, for display + log correlation
  key_hash               text          not null,                        -- sha256 hex of (key · pepper); the ONLY thing verified against
  scopes                 text[]        not null default array['global_master_list.read'],
  granted_columns        text[],                                        -- NULL = the whole table; otherwise ONLY these columns go out
  expires_at             timestamptz,                                   -- NULL = never; past = the key is dead on the next call
  rate_limit_per_minute  integer       not null default 60,             -- per key, REST + MCP together, counted in external_api_requests
  created_by             text          not null,
  created_at             timestamptz   not null default now(),
  revoked_at             timestamptz,                                   -- set = the key is dead; null = live
  revoked_by             text,
  rotated_at             timestamptz,
  rotated_by             text,
  last_used_at           timestamptz,

  constraint external_api_clients_name_present     check (btrim(name) <> ''),
  constraint external_api_clients_system_present   check (btrim(system) <> ''),
  constraint external_api_clients_key_hash_hex     check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint external_api_clients_key_hash_unique  unique (key_hash),
  constraint external_api_clients_prefix_shape     check (key_prefix ~ '^hris_(live|test)_[A-Za-z0-9_-]{6}$'),
  -- the ONLY scope that exists. Adding a scope means adding it here AND a route that honours it.
  constraint external_api_clients_scopes_known
    check (scopes <@ array['global_master_list.read']::text[] and cardinality(scopes) >= 1),
  -- a column list is either absent (whole table) or names at least one column; an empty list
  -- would read as "nothing" to one reader and "everything" to another
  constraint external_api_clients_granted_columns_nonempty
    check (granted_columns is null or cardinality(granted_columns) >= 1),
  -- 1..600 per minute; the code clamps to the same range
  constraint external_api_clients_rate_limit_range
    check (rate_limit_per_minute between 1 and 600),
  -- a revocation always names who did it
  constraint external_api_clients_revoked_shape
    check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

comment on table public.external_api_clients is
  'Outside systems allowed to call /api/external/v1/* and /api/external/mcp. One row per client; the key is NEVER stored — only sha256(key · pepper). revoked_at set or expires_at passed = dead on the next call (no cache). granted_columns NULL = whole Global Master List, else only those columns. READ-ONLY API: the only scope is global_master_list.read.';
comment on column public.external_api_clients.key_prefix is 'First 16 chars of the issued key (hris_live_xxxxxx). Display + correlation with external_api_requests only — never enough to authenticate.';
comment on column public.external_api_clients.key_hash is 'sha256 hex of (plaintext key · EXTERNAL_API_KEY_PEPPER). Looked up by equality, then compared constant-time.';
comment on column public.external_api_clients.granted_columns is 'NULL = every catalog column of global_master_list. Otherwise the ONLY columns this key receives, on REST and MCP alike; a filter on a column outside the list is refused (400). Validated against src/lib/external-api/catalog.ts on write.';
comment on column public.external_api_clients.expires_at is 'NULL = never expires (revoke to stop it). Past = denial "expired" (401, same sentence as revoked). Chosen at issue as 1 day / 15 days / 30 days / never; editable.';
comment on column public.external_api_clients.rate_limit_per_minute is 'Calls allowed in any 60-second window, REST + MCP together. Counted from external_api_requests (rows with status <> 429), so it holds across server instances. Default 60, range 1..600.';

create index if not exists external_api_clients_live_idx
  on public.external_api_clients (created_at desc) where revoked_at is null;

create table if not exists public.external_api_requests (
  id              bigint        generated always as identity primary key,
  client_id       uuid          references public.external_api_clients(id) on delete restrict,   -- null when the key was unknown
  key_prefix      text,                                          -- what the caller PRESENTED, valid or not
  method          text          not null,                        -- GET (REST) or POST (MCP)
  path            text          not null,
  query           jsonb,                                         -- REST: the query string; MCP: { tool, arguments }
  status          integer       not null,
  row_count       integer,
  denial          text,                                          -- missing / malformed / unknown / revoked / expired / scope / unconfigured / unavailable / rate_limited / bad_request / column_not_granted / read_failed; null on success
  ip              text,
  user_agent      text,
  duration_ms     integer,
  created_at      timestamptz   not null default now(),

  constraint external_api_requests_status_range check (status between 100 and 599),
  constraint external_api_requests_method_known check (method in ('GET', 'POST')),
  -- a success has a client and no denial; a denial has a reason
  constraint external_api_requests_outcome_shape
    check ((status < 400 and client_id is not null and denial is null) or (status >= 400 and denial is not null))
);

comment on table public.external_api_requests is
  'One row per call to /api/external/v1/* or /api/external/mcp, INCLUDING denied ones. APPEND-ONLY. The record of which system read what and when, AND the rate-limit meter (rows per client in the last 60s). audit_log carries only the lifecycle events.';

create index if not exists external_api_requests_client_time_idx
  on public.external_api_requests (client_id, created_at desc);
create index if not exists external_api_requests_time_idx
  on public.external_api_requests (created_at desc);

-- Both tables name people and the fingerprints of secrets, and NEXT_PUBLIC_SUPABASE_ANON_KEY ships
-- in the client bundle. RLS on with NO policies: only the service-role server routes read or write.
alter table public.external_api_clients  enable row level security;
alter table public.external_api_requests enable row level security;

-- Verification:
--   select name, system, key_prefix, revoked_at is null as live, expires_at, rate_limit_per_minute,
--          coalesce(array_length(granted_columns, 1), 0) as columns_or_0_for_all, last_used_at
--     from public.external_api_clients order by created_at desc;
--   select c.name, r.status, r.denial, count(*) from public.external_api_requests r
--     left join public.external_api_clients c on c.id = r.client_id
--    where r.created_at > now() - interval '7 days' group by 1,2,3 order by 1,2;
