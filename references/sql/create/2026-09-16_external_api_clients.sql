-- External read API — per-client keys for OUTSIDE systems that query the Global Master List.
--
-- Admin → API tokens → "External access". An admin creates a CLIENT (a named system —
-- "Ops dashboard", "n8n roster sync") and is shown its key ONCE. The key is never stored:
-- only sha256(key · pepper) is, and every call to /api/external/v1/* is authenticated by
-- hashing the presented Bearer token and looking that hash up here. Revoking a client
-- (revoked_at set) makes its key fail on the very next call — there is no key cache.
--
-- Rotate keeps the client row and its history and replaces key_hash + key_prefix; the old
-- key dies instantly. Nothing deletes a client: the request log below is the record of what
-- system called us, and that record outlives the key.
--
-- external_api_requests is APPEND-ONLY: one row per call INCLUDING denied ones (401 / 429),
-- so a leaked or guessed key shows up as a stream of failures against a key_prefix.
-- It is deliberately its OWN table — audit_log carries the lifecycle events (created /
-- revoked / restored / rotated) and must not grow by one row per API call.
--
-- READ-ONLY BY CONSTRUCTION: no scope other than global_master_list.read exists, and the
-- only external route is a GET. Off-boarded people are unreachable through it (Kane,
-- 2026-09-16) — the route filters off_boarded_at IS NULL in SQL and again in memory.
--
-- Idempotent: safe to re-run. Apply with
--   node --import tsx scripts/apply-external-api-clients-migration.mts --apply

create table if not exists public.external_api_clients (
  id              uuid          primary key default gen_random_uuid(),
  name            text          not null,                        -- who: "Ops team roster mirror"
  system          text          not null,                        -- what: "n8n", "Google Sheets script", "Retool"
  contact_email   text,                                          -- whom to call when it misbehaves
  key_prefix      text          not null,                        -- first 16 chars of the key, for display + log correlation
  key_hash        text          not null,                        -- sha256 hex of (key · pepper); the ONLY thing verified against
  scopes          text[]        not null default array['global_master_list.read'],
  created_by      text          not null,
  created_at      timestamptz   not null default now(),
  revoked_at      timestamptz,                                   -- set = the key is dead; null = live
  revoked_by      text,
  rotated_at      timestamptz,
  rotated_by      text,
  last_used_at    timestamptz,

  constraint external_api_clients_name_present     check (btrim(name) <> ''),
  constraint external_api_clients_system_present   check (btrim(system) <> ''),
  constraint external_api_clients_key_hash_hex     check (key_hash ~ '^[0-9a-f]{64}$'),
  constraint external_api_clients_key_hash_unique  unique (key_hash),
  constraint external_api_clients_prefix_shape     check (key_prefix ~ '^hris_(live|test)_[A-Za-z0-9_-]{6}$'),
  -- the ONLY scope that exists. Adding a scope means adding it here AND a route that honours it.
  constraint external_api_clients_scopes_known
    check (scopes <@ array['global_master_list.read']::text[] and cardinality(scopes) >= 1),
  -- a revocation always names who did it
  constraint external_api_clients_revoked_shape
    check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

comment on table public.external_api_clients is
  'Outside systems allowed to call /api/external/v1/*. One row per client; the key is NEVER stored — only sha256(key · pepper). revoked_at set = dead on the next call (no cache). READ-ONLY API: the only scope is global_master_list.read.';
comment on column public.external_api_clients.key_prefix is 'First 16 chars of the issued key (hris_live_xxxxxx). Display + correlation with external_api_requests only — never enough to authenticate.';
comment on column public.external_api_clients.key_hash is 'sha256 hex of (plaintext key · EXTERNAL_API_KEY_PEPPER). Looked up by equality, then compared constant-time.';

create index if not exists external_api_clients_live_idx
  on public.external_api_clients (created_at desc) where revoked_at is null;

create table if not exists public.external_api_requests (
  id              bigint        generated always as identity primary key,
  client_id       uuid          references public.external_api_clients(id) on delete restrict,   -- null when the key was unknown
  key_prefix      text,                                          -- what the caller PRESENTED, valid or not
  method          text          not null,
  path            text          not null,
  query           jsonb,
  status          integer       not null,
  row_count       integer,
  denial          text,                                          -- missing / malformed / unknown / revoked / unconfigured / rate_limited; null on success
  ip              text,
  user_agent      text,
  duration_ms     integer,
  created_at      timestamptz   not null default now(),

  constraint external_api_requests_status_range check (status between 100 and 599),
  constraint external_api_requests_method_get   check (method = 'GET'),
  -- a success has a client and no denial; a denial has a reason
  constraint external_api_requests_outcome_shape
    check ((status < 400 and client_id is not null and denial is null) or (status >= 400 and denial is not null))
);

comment on table public.external_api_requests is
  'One row per call to /api/external/v1/*, INCLUDING denied ones. APPEND-ONLY. The record of which system read what and when; audit_log carries only the lifecycle events.';

create index if not exists external_api_requests_client_time_idx
  on public.external_api_requests (client_id, created_at desc);
create index if not exists external_api_requests_time_idx
  on public.external_api_requests (created_at desc);

-- Both tables name people and secrets' fingerprints, and NEXT_PUBLIC_SUPABASE_ANON_KEY ships
-- in the client bundle. RLS on with NO policies: only the service-role server routes read or write.
alter table public.external_api_clients  enable row level security;
alter table public.external_api_requests enable row level security;

-- Verification:
--   select name, system, key_prefix, revoked_at is null as live, last_used_at from public.external_api_clients order by created_at desc;
--   select c.name, r.status, r.denial, count(*) from public.external_api_requests r
--     left join public.external_api_clients c on c.id = r.client_id
--    where r.created_at > now() - interval '7 days' group by 1,2,3 order by 1,2;
