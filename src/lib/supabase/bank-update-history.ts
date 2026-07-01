import 'server-only';

import { createSupabaseServiceRoleClient } from './server';
import { normEmail } from '@/lib/email/norm-email';

/**
 * Bank/payout change history — a dedicated, non-clearable table (separate from
 * `audit_log`, which any admin can truncate via DELETE /api/audit-log). Written
 * to by app/api/bank-update/save/route.ts ALONGSIDE the existing audit_log
 * insert; read by both the People-tab global feed and per-employee history.
 * See references/sql/migrate/2026-07-01_bank_update_history.sql.
 */

/** One field's masked before→after within a bank change. Values are masked at
 *  WRITE time (in the save route) — this table never holds a full account
 *  number. `before` is null for a first-time setup; `after` is null if cleared. */
export type BankChangeField = {
  field: string;
  before: string | null;
  after: string | null;
  /** Whether the raw value actually changed (computed pre-masking, so it's exact). */
  changed: boolean;
};

/** One self-service bank/payout change, shaped for the People-tab feeds. Carries
 *  WHO + WHEN + WHICH FIELD NAMES + processor + a MASKED before→after — never
 *  the full account values themselves. */
export type BankChangeEntry = {
  id: string;
  /** Employee display name (falls back to their work email). */
  name: string;
  /** Work email the change was keyed to. */
  email: string | null;
  /** Snake_case payout field names that were written this save. */
  fields: string[];
  /** Masked before→after per written field. Empty for legacy rows saved before
   *  value-snapshotting existed — the feed falls back to a "not tracked" note. */
  changes: BankChangeField[];
  /** Preferred processor at save time, if set (e.g. "wires", "wise"). */
  processor: string | null;
  /** True when this save created the employee's first payout record. */
  createdNew: boolean;
  /** Channel the change came through (e.g. "external_link"). */
  via: string | null;
  ip_address: string | null;
  created_at: string;
};

export type NewBankUpdateHistoryRow = {
  work_email: string;
  employee_name: string | null;
  fields: string[];
  changes: BankChangeField[];
  processor: string | null;
  created_new: boolean;
  via: string | null;
  ip_address: string | null;
};

/**
 * Record one bank/payout change. Best-effort — an un-migrated environment
 * (table not yet created) must not fail the payout save itself, mirroring the
 * other best-effort writes already in the save route (e.g. bank_last_self_updated_at).
 */
export async function insertBankUpdateHistory(row: NewBankUpdateHistoryRow): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase.from('bank_update_history').insert({
    work_email:    row.work_email,
    employee_name: row.employee_name,
    fields:        row.fields,
    changes:       row.changes,
    processor:     row.processor,
    created_new:   row.created_new,
    via:           row.via,
    ip_address:    row.ip_address,
  });

  return { error: error?.message ?? null };
}

function toEntry(r: Record<string, unknown>): BankChangeEntry {
  const rawFields = r.fields;
  const fields = Array.isArray(rawFields) ? rawFields.map((f) => String(f)) : [];
  const rawChanges = r.changes;
  const changes: BankChangeField[] = Array.isArray(rawChanges)
    ? rawChanges
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return {
            field: String(o.field ?? ''),
            before: o.before != null ? String(o.before) : null,
            after: o.after != null ? String(o.after) : null,
            changed: o.changed === true,
          };
        })
        .filter((c) => c.field)
    : [];
  return {
    id: String(r.id),
    name: ((r.employee_name as string | null) ?? '').trim() || ((r.work_email as string | null) ?? '—'),
    email: (r.work_email as string | null) ?? null,
    fields,
    changes,
    processor: (r.processor as string | null) ?? null,
    createdNew: r.created_new === true,
    via: (r.via as string | null) ?? null,
    ip_address: (r.ip_address as string | null) ?? null,
    created_at: String(r.created_at),
  };
}

/**
 * Most recent self-service bank/payout changes across everyone, newest first.
 * Powers the People-tab "Recent bank changes" global feed.
 */
export async function fetchRecentBankChanges(
  limit = 50,
): Promise<{ rows: BankChangeEntry[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('bank_update_history')
    .select('id, work_email, employee_name, fields, changes, processor, created_new, via, ip_address, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map(toEntry), error: null };
}

/**
 * One person's bank/payout change history, newest first. Powers the People-tab
 * per-employee "Bank change history" section.
 */
export async function getPeopleBankHistory(
  email: string,
  limit = 50,
): Promise<{ rows: BankChangeEntry[]; error: string | null }> {
  const target = normEmail(email);
  if (!target) return { rows: [], error: null };

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { data, error } = await supabase
    .from('bank_update_history')
    .select('id, work_email, employee_name, fields, changes, processor, created_new, via, ip_address, created_at')
    .ilike('work_email', target)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []).map(toEntry), error: null };
}
