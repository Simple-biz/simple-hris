-- [TERMINATION-DOCS]
-- Termination Docs — the permanent, searchable log of generated termination
-- letters, plus the reversal trail for the blank-only write-back.
--
-- Reversed by references/sql/fix/drop_termination_docs.sql. Run the reverse
-- script scripts/revert-termination-doc-writebacks.mts BEFORE the drop — the
-- undo data lives in this table's `field_writebacks` column.
--
-- NOT a `document_requests` row and NOT a new `document_type`. `document_requests`
-- is served to employees by GET /api/employee/documents via listDocumentRequests
-- (src/lib/documents/requests.ts:45-61, from(TABLE) where TABLE is the literal
-- 'document_requests' at :32). Keeping this in its own table is the leak proof.
--
-- Storage: reuses the EXISTING private bucket `document-requests`
-- (src/lib/documents/types.ts:108) under a distinct `termination/` prefix, so
-- no new bucket and no new storage policy migration is created — and revert is
-- a prefix delete that cannot touch a document_requests object.

create table if not exists public.termination_documents (
  id                      uuid        primary key default gen_random_uuid(),

  -- ── Identity (G1: work email IDENTIFIES) ──────────────────────────────────
  work_email              text        not null,
  personal_email          text,
  master_row_id           uuid,
  worker_name             text        not null,

  -- ── Printed facts ─────────────────────────────────────────────────────────
  termination_date        date        not null,
  reason_key              text        not null,
  reason_label            text        not null,
  ending_department_raw   text,
  ending_department_label text        not null,
  start_date              date,
  starting_rate           numeric(12,2),
  starting_rate_currency  text,
  starting_rate_source    text,
  ending_rate             numeric(12,2),
  ending_rate_currency    text,
  ending_rate_source      text,

  -- ── Provenance / reversal ─────────────────────────────────────────────────
  facts                   jsonb       not null default '{}'::jsonb,
  filled_by_rep           text[]      not null default '{}',
  field_writebacks        jsonb       not null default '[]'::jsonb,

  -- ── Signed at generation ──────────────────────────────────────────────────
  generated_by            text        not null,
  generated_by_name       text,
  generated_by_title      text,
  generated_at            timestamptz not null default now(),

  -- ── File ──────────────────────────────────────────────────────────────────
  file_path               text        not null,
  file_name               text        not null,
  file_size               integer,

  created_at              timestamptz not null default now(),

  -- G2 IN THE DATABASE: a suspension can never become a termination letter.
  -- Positive allowlist = VALID_OFFBOARD_REASONS (src/lib/hr/offboard-reasons.ts:11)
  -- minus 'temporary_pause'. A denylist is forbidden by ruling.
  constraint termination_documents_reason_key_check
    check (reason_key in ('ncns','resigned','end_of_contract','performance',
                          'attendance','time_manipulation','other')),

  -- No document may state a rate of zero.
  constraint termination_documents_starting_rate_positive
    check (starting_rate is null or starting_rate > 0),
  constraint termination_documents_ending_rate_positive
    check (ending_rate is null or ending_rate > 0),

  -- A raw hsl:* slug must never reach a human-readable column.
  constraint termination_documents_dept_label_not_slug
    check (ending_department_label not like 'hsl:%'),

  -- The re-hire guard, restated as data (G4).
  constraint termination_documents_off_after_start
    check (start_date is null or termination_date > start_date),

  -- A currency, when stated, is one of the three the document can print. The
  -- app resolves one for every rate — including a BLANK one, where it records
  -- which carrier's currency was consulted — so a null currency beside a null
  -- amount stays legal and the equality form
  -- `(starting_rate is null) = (starting_rate_currency is null)` is deliberately
  -- NOT used: it would reject that recorded-carrier row.
  constraint termination_documents_currency_check
    check (
      (starting_rate_currency is null or starting_rate_currency in ('PHP','USD','COP')) and
      (ending_rate_currency   is null or ending_rate_currency   in ('PHP','USD','COP'))
    ),

  -- Money with no unit is not a fact. A PRESENT rate therefore REQUIRES its
  -- currency: `numeric` says nothing about denomination, and a peso reading of a
  -- COP figure is a ~57x misstatement on a signed letter. The route now carries
  -- the resolved currency through a rep-filled rate (it used to hardcode 'PHP'),
  -- and this is the layer that holds when the one above it breaks.
  constraint termination_documents_currency_present_with_rate
    check (
      (starting_rate is null or starting_rate_currency is not null) and
      (ending_rate   is null or ending_rate_currency   is not null)
    )
);

comment on table public.termination_documents is
  '[TERMINATION-DOCS] Permanent log of generated termination letters. field_writebacks is the ONLY undo data for the blank-only write-back — run scripts/revert-termination-doc-writebacks.mts before dropping this table.';

-- Log search: by person, newest first.
create index if not exists termination_documents_work_email_idx
  on public.termination_documents (lower(work_email), generated_at desc);
-- G1: personal email SEARCHES.
create index if not exists termination_documents_personal_email_idx
  on public.termination_documents (lower(personal_email));
-- Default log ordering + keyset paging.
create index if not exists termination_documents_generated_at_idx
  on public.termination_documents (generated_at desc);
-- "what did this rep issue" audit queries.
create index if not exists termination_documents_generated_by_idx
  on public.termination_documents (lower(generated_by), generated_at desc);
-- Reverse-script scan: only rows that actually wrote something.
create index if not exists termination_documents_writebacks_idx
  on public.termination_documents using gin (field_writebacks);

-- ─── Row-level security ───────────────────────────────────────────────────────
-- This table holds worker PII (names, emails) plus pay rates and a departure
-- reason. Enable RLS with NO policies so the public API roles
-- (anon/authenticated) get ZERO rows even if Supabase's default privileges
-- granted them SELECT. The service_role key used by all four
-- /api/accounting/documents/termination routes has BYPASSRLS, so the app still
-- reads/writes everything. Idempotent — enabling already-enabled RLS is a no-op.
--
-- The precedent is references/sql/create/create_screening.sql:96-101, the house
-- treatment for a PII-bearing table. Without this line, the DB — the one place
-- this table's reachability from a browser is actually decided — decides
-- nothing: NEXT_PUBLIC_SUPABASE_ANON_KEY ships in the client bundle, and
-- `supabase.from('termination_documents').select('*')` from the employee
-- dashboard would return every letter's row. G8's own proof is scoped to
-- /api/employee/*; this is the layer under it.
alter table public.termination_documents enable row level security;
