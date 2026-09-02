import { createSupabaseServiceRoleClient } from './server';
import { selectAllPaged } from './select-all-paged';
import type {
  InternHoursByDayEntry,
  InternPabMode,
  InternPayStatus,
  InternShareMode,
  OrphanageInternPayRow,
} from '@/lib/interns/intern-types';

/**
 * The locked intern week — the ONE carrier of intern money.
 *
 *   submitted  → the Orphanage Manager locked the week in the mini wizard
 *   accepted   → Accounting took it in the Payroll Wizard's Interns view;
 *                accepted rows become pending items in Payment Dispatch → Orphanage
 *   rejected   → Accounting sent it back with a note; the mini wizard re-opens
 *
 * 'paid' is never stored here — it is derived from orphanage_dispatches rows
 * that reference intern_pay_id. There is deliberately no app_settings blob.
 */

const COLS =
  'id, source_file, intern_id, intern_email, intern_name, week_start, week_end, hours_raw, hours_paid, hours_by_day, rate_php, pay_php, pab_php, pab_mode, pab_month, gross_php, orphanage_share_pct, orphanage_share_php, intern_share_php, share_mode, status, submitted_by, submitted_at, decided_by, decided_at, decision_note, created_at, updated_at';

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function mapInternPay(r: Record<string, unknown>): OrphanageInternPayRow {
  return {
    id: String(r.id),
    source_file: String(r.source_file ?? ''),
    intern_id: String(r.intern_id ?? ''),
    intern_email: String(r.intern_email ?? ''),
    intern_name: String(r.intern_name ?? ''),
    week_start: String(r.week_start ?? ''),
    week_end: String(r.week_end ?? ''),
    hours_raw: num(r.hours_raw),
    hours_paid: num(r.hours_paid),
    hours_by_day: ((r.hours_by_day as Record<string, InternHoursByDayEntry>) ?? {}),
    rate_php: num(r.rate_php),
    pay_php: num(r.pay_php),
    pab_php: num(r.pab_php),
    pab_mode: ((r.pab_mode as string) ?? 'not_payout_week') as InternPabMode,
    pab_month: (r.pab_month as string | null) ?? null,
    gross_php: num(r.gross_php),
    orphanage_share_pct: num(r.orphanage_share_pct),
    orphanage_share_php: num(r.orphanage_share_php),
    intern_share_php: num(r.intern_share_php),
    share_mode: ((r.share_mode as string) ?? 'system_split') as InternShareMode,
    status: ((r.status as string) ?? 'submitted') as InternPayStatus,
    submitted_by: (r.submitted_by as string | null) ?? null,
    submitted_at: String(r.submitted_at ?? ''),
    decided_by: (r.decided_by as string | null) ?? null,
    decided_at: (r.decided_at as string | null) ?? null,
    decision_note: (r.decision_note as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

export type InternPayUpsertInput = Omit<
  OrphanageInternPayRow,
  'id' | 'status' | 'decided_by' | 'decided_at' | 'decision_note' | 'created_at' | 'updated_at' | 'submitted_at'
>;

export async function listInternPayBySourceFile(sourceFile: string): Promise<{ rows: OrphanageInternPayRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_intern_pay').select(COLS).eq('source_file', sourceFile).order('intern_name').order('id').range(from, to),
  );
  if (error) return { rows: [], error };
  return { rows: rows.map(mapInternPay), error: null };
}

export async function listInternPayByStatus(statuses: InternPayStatus[]): Promise<{ rows: OrphanageInternPayRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_intern_pay').select(COLS).in('status', statuses).order('week_start', { ascending: false }).order('intern_name').order('id').range(from, to),
  );
  if (error) return { rows: [], error };
  return { rows: rows.map(mapInternPay), error: null };
}

/** Every locked week for one intern (all statuses) — the PAB month's evidence. */
export async function listInternPayForIntern(internId: string): Promise<{ rows: OrphanageInternPayRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_intern_pay').select(COLS).eq('intern_id', internId).order('week_start').order('id').range(from, to),
  );
  if (error) return { rows: [], error };
  return { rows: rows.map(mapInternPay), error: null };
}

/** All locked weeks in a date window, for PAB across every intern at once. */
export async function listInternPayBetween(weekEndFrom: string, weekEndTo: string): Promise<{ rows: OrphanageInternPayRow[]; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_intern_pay').select(COLS).gte('week_end', weekEndFrom).lte('week_end', weekEndTo).order('week_start').order('id').range(from, to),
  );
  if (error) return { rows: [], error };
  return { rows: rows.map(mapInternPay), error: null };
}

/**
 * Lock a week: upsert every row as `submitted`, keyed on (source_file, intern_id).
 * Refused when any row for the file is already `accepted` — the manager cannot
 * overwrite what Accounting has taken (409 at the route).
 */
export async function submitInternPayWeek(
  sourceFile: string,
  rows: InternPayUpsertInput[],
  submittedBy: string | null,
): Promise<{ rows: OrphanageInternPayRow[]; error: string | null; conflict?: boolean }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };

  const { rows: existing, error: exErr } = await listInternPayBySourceFile(sourceFile);
  if (exErr) return { rows: [], error: exErr };
  if (existing.some((r) => r.status === 'accepted')) {
    return { rows: [], error: 'This week has already been accepted by Accounting. Ask them to reopen it before locking in again.', conflict: true };
  }

  // A fresh lock supersedes every earlier row for the file (a rejected week is
  // re-entered whole; an intern who dropped out of the file drops out here).
  const { error: delErr } = await supabase.from('orphanage_intern_pay').delete().eq('source_file', sourceFile);
  if (delErr) return { rows: [], error: delErr.message };
  if (rows.length === 0) return { rows: [], error: null };

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    source_file: sourceFile,
    intern_id: r.intern_id,
    intern_email: r.intern_email,
    intern_name: r.intern_name,
    week_start: r.week_start,
    week_end: r.week_end,
    hours_raw: r.hours_raw,
    hours_paid: r.hours_paid,
    hours_by_day: r.hours_by_day,
    rate_php: r.rate_php,
    pay_php: r.pay_php,
    pab_php: r.pab_php,
    pab_mode: r.pab_mode,
    pab_month: r.pab_month,
    gross_php: r.gross_php,
    orphanage_share_pct: r.orphanage_share_pct,
    orphanage_share_php: r.orphanage_share_php,
    intern_share_php: r.intern_share_php,
    share_mode: r.share_mode,
    status: 'submitted' as const,
    submitted_by: submittedBy,
    submitted_at: now,
    decided_by: null,
    decided_at: null,
    decision_note: null,
  }));
  const { data, error } = await supabase.from('orphanage_intern_pay').insert(payload).select(COLS);
  if (error) return { rows: [], error: error.message };
  return { rows: ((data ?? []) as Record<string, unknown>[]).map(mapInternPay), error: null };
}

/** Withdraw a week the manager submitted. Only `submitted`/`rejected` rows can go. */
export async function withdrawInternPayWeek(sourceFile: string): Promise<{ deleted: OrphanageInternPayRow[]; error: string | null; conflict?: boolean }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { deleted: [], error: 'Supabase not configured' };
  const { rows, error: exErr } = await listInternPayBySourceFile(sourceFile);
  if (exErr) return { deleted: [], error: exErr };
  if (rows.some((r) => r.status === 'accepted')) {
    return { deleted: [], error: 'This week has been accepted by Accounting and can only be reopened from their side.', conflict: true };
  }
  const { error } = await supabase.from('orphanage_intern_pay').delete().eq('source_file', sourceFile);
  if (error) return { deleted: [], error: error.message };
  return { deleted: rows, error: null };
}

/** Dispatch state for a set of intern_pay ids: which types exist and whether any is paid. */
export async function listInternPayDispatchState(
  ids: string[],
): Promise<{ byId: Map<string, { types: string[]; paid: boolean; problem: boolean }>; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { byId: new Map(), error: 'Supabase not configured' };
  const byId = new Map<string, { types: string[]; paid: boolean; problem: boolean }>();
  if (ids.length === 0) return { byId, error: null };
  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from('orphanage_dispatches').select('intern_pay_id, dispatch_type, status').in('intern_pay_id', ids).order('id').range(from, to),
  );
  if (error) return { byId, error };
  for (const r of rows) {
    const id = String(r.intern_pay_id);
    const cur = byId.get(id) ?? { types: [], paid: false, problem: false };
    cur.types.push(String(r.dispatch_type));
    if (r.status === 'paid') cur.paid = true;
    if (r.status === 'problem') cur.problem = true;
    byId.set(id, cur);
  }
  return { byId, error: null };
}

/**
 * Accounting's decision on a week. `accepted`/`rejected` from `submitted`;
 * `reopen` puts an accepted week back to `submitted` and is REFUSED while any
 * referencing dispatch is paid — paid money is never re-priced silently.
 */
export async function decideInternPayWeek(
  sourceFile: string,
  decision: 'accepted' | 'rejected' | 'reopen',
  decidedBy: string | null,
  note: string | null,
): Promise<{ rows: OrphanageInternPayRow[]; error: string | null; conflict?: boolean }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { rows: [], error: 'Supabase not configured' };
  const { rows: existing, error: exErr } = await listInternPayBySourceFile(sourceFile);
  if (exErr) return { rows: [], error: exErr };
  if (existing.length === 0) return { rows: [], error: 'No locked week found for this file.' };

  if (decision === 'reopen') {
    const { byId, error: dErr } = await listInternPayDispatchState(existing.map((r) => r.id));
    if (dErr) return { rows: [], error: dErr };
    const paid = existing.filter((r) => byId.get(r.id)?.paid);
    if (paid.length > 0) {
      return {
        rows: [],
        conflict: true,
        error: `Cannot reopen: ${paid.length} row${paid.length === 1 ? ' has' : 's have'} already been paid (${paid.map((r) => r.intern_name).join(', ')}).`,
      };
    }
  } else if (existing.some((r) => r.status !== 'submitted')) {
    return { rows: [], conflict: true, error: `This week is ${existing[0].status}, not submitted.` };
  }
  if (decision === 'rejected' && !(note ?? '').trim()) return { rows: [], error: 'A note is required to reject a week.' };

  const patch =
    decision === 'reopen'
      ? { status: 'submitted', decided_by: null, decided_at: null, decision_note: null }
      : { status: decision, decided_by: decidedBy, decided_at: new Date().toISOString(), decision_note: (note ?? '').trim() || null };
  const { data, error } = await supabase.from('orphanage_intern_pay').update(patch).eq('source_file', sourceFile).select(COLS);
  if (error) return { rows: [], error: error.message };
  return { rows: ((data ?? []) as Record<string, unknown>[]).map(mapInternPay), error: null };
}
