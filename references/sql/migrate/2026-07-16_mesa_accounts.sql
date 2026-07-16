-- Migration: MESA accounts (per-enrollment-stint account numbers)
-- Created: 2026-07-16
--
-- WHAT THIS ADDS
-- --------------
-- 1) `mesa_accounts` — a registry with ONE ROW PER ENROLLMENT STINT. Opting out
--    CLOSES the open account (stamps closed_on); opting back in opens a NEW
--    account with a NEW account number. Account numbers are minted as
--    "YY-MM-#####" (year+month the account was opened + a per-month serial),
--    e.g. 26-07-00001.
-- 2) `employee_hourly_rates.mesa_account_number` — the member's CURRENT (open)
--    account number, denormalized onto the rates rows exactly like
--    `mesa_member` / `mesa_member_since`, so it flows through the existing
--    /api/employee-hourly-rates plumbing into the Accounting → MESA tables.
--    Cleared (NULL) on opt-out — the old account is closed and "zeroed";
--    balances shown in the app are computed from ledger events ON/AFTER the
--    open account's opened_on, so a re-joined member starts from ₱0 and only
--    accrues the latest values.
--
-- The view `employee_hourly_rates_current` materialized its column list when it
-- was created, so it must be recreated to expose the new column. The definition
-- below is copied VERBATIM from
-- references/sql/fix/fix_employee_hourly_rates_current_view_by_upload.sql —
-- only re-run after the ALTER TABLE so `select *` picks up the new column.
--
-- DATA BACKFILL: run `node scripts/seed-mesa-accounts.mjs --apply` AFTER this
-- migration (dry-run without the flag). It derives one account per historical
-- enrollment stint from mesa_ledger (stints are bounded by termination events:
-- an 'Inactive' status row or an 'Opt-out' disbursement), numbers them by
-- opening month, and stamps every current member's open account number (and
-- corrected mesa_member_since) onto their rates rows.
--
-- Idempotent: safe to re-run.

-- ── 1) Account registry ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.mesa_accounts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number text        NOT NULL UNIQUE,
  email          text        NOT NULL,          -- lowercased member email (ledger key)
  name           text,
  opened_on      date        NOT NULL,          -- opt-in effective date; account number's YY-MM comes from this
  closed_on      date,                          -- NULL = the member's current (open) account
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.mesa_accounts IS
  'One row per MESA enrollment stint. Opt-out closes the open account (closed_on); re-opt-in opens a new one with a new YY-MM-##### number. Balances in the app aggregate mesa_ledger events dated on/after the open account''s opened_on, so closed accounts are settled ("zeroed") and a re-join starts fresh.';
COMMENT ON COLUMN public.mesa_accounts.account_number IS
  'Format YY-MM-##### — opening year+month plus a per-month serial (e.g. 26-07-00001).';

CREATE INDEX IF NOT EXISTS mesa_accounts_email_idx
  ON public.mesa_accounts (lower(email));

-- Exactly one OPEN account per member.
CREATE UNIQUE INDEX IF NOT EXISTS mesa_accounts_one_open_per_email
  ON public.mesa_accounts (lower(email))
  WHERE closed_on IS NULL;

-- ── 2) Current account number on the rates rows ─────────────────────────────

ALTER TABLE public.employee_hourly_rates
  ADD COLUMN IF NOT EXISTS mesa_account_number text;

COMMENT ON COLUMN public.employee_hourly_rates.mesa_account_number IS
  'The member''s CURRENT (open) mesa_accounts.account_number. NULL when not enrolled — cleared on opt-out, set on opt-in. Kept on every row for the email, like mesa_member.';

-- ── 3) Recreate employee_hourly_rates_current so it exposes the new column ──
-- (verbatim from references/sql/fix/fix_employee_hourly_rates_current_view_by_upload.sql)

drop view if exists public.employee_hourly_rates_current;

create view public.employee_hourly_rates_current as
with ranked as (
  select
    ehr.*,
    ru.is_current  as _ru_is_current,
    ru.uploaded_at as _ru_uploaded_at
  from public.employee_hourly_rates ehr
  left join public.rates_uploads ru on ru.id = ehr.upload_id
),
latest_by_personal as (
  select distinct on (lower(trim("Personal Email"))) *
  from ranked
  where nullif(trim("Personal Email"), '') is not null
  order by
    lower(trim("Personal Email")),
    _ru_is_current  desc nulls last,
    _ru_uploaded_at desc nulls last,
    id desc
),
latest_by_work as (
  select distinct on (lower(trim("Work Email"))) *
  from ranked
  where nullif(trim("Work Email"), '') is not null
  order by
    lower(trim("Work Email")),
    _ru_is_current  desc nulls last,
    _ru_uploaded_at desc nulls last,
    id desc
)
select * from latest_by_personal
union
select * from latest_by_work;

comment on view public.employee_hourly_rates_current is
  'Current rate per personal_email AND per work_email (unioned), picked by is_current upload then uploaded_at then id desc. Replaces the old random-UUID (id desc only) ordering that froze employees on stale rates. See references/fix_employee_hourly_rates_current_view_by_upload.sql.';
