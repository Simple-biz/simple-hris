import { createSupabaseServiceRoleClient, createSupabaseServerClient } from "@/lib/supabase/server";
import { normEmail } from "@/lib/email/norm-email";

export interface RateHistoryRow {
  email: string;
  regularRate: number | null;
  otRate: number | null;
  effectiveFrom: Date;
}

/** Map<lowercased-email, sorted-desc-by-effective-from RateHistoryRow[]>. */
export type RateHistoryByEmail = Map<string, RateHistoryRow[]>;

function parseNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDateOnly(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Fetch the entire rate-history table once and index it by email. Caller is
 * responsible for caching this between requests if needed — for a single
 * payroll cycle compute, one fetch is fine.
 */
export async function fetchAllRateHistory(): Promise<RateHistoryByEmail> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  const out: RateHistoryByEmail = new Map();
  if (!supabase) return out;

  const { data, error } = await supabase
    .from('employee_rate_history')
    .select('employee_email, regular_rate, ot_rate, effective_from')
    .order('effective_from', { ascending: false });

  if (error || !data) return out;

  for (const r of data as Array<Record<string, unknown>>) {
    const em = normEmail(String(r['employee_email'] ?? '')) ?? null;
    const eff = parseDateOnly(r['effective_from']);
    if (!em || !eff) continue;
    const row: RateHistoryRow = {
      email: em,
      regularRate: parseNum(r['regular_rate']),
      otRate: parseNum(r['ot_rate']),
      effectiveFrom: eff,
    };
    const list = out.get(em);
    if (list) list.push(row);
    else out.set(em, [row]);
  }
  return out;
}

/**
 * Resolve the rate row that was in effect on `date` for `email`. Returns the
 * newest history row with `effective_from <= date`. Caller already supplies
 * the per-email sorted list; this is a tight inner-loop helper so we don't
 * pay for repeated map lookups during a per-day pay computation.
 */
export function resolveRateAsOfDate(
  rows: RateHistoryRow[] | undefined,
  date: Date,
): { regularRate: number | null; otRate: number | null } | null {
  if (!rows || rows.length === 0) return null;
  const t = date.getTime();
  for (const r of rows) {
    if (r.effectiveFrom.getTime() <= t) {
      return { regularRate: r.regularRate, otRate: r.otRate };
    }
  }
  return null;
}

/**
 * Resolve from the full map. Convenience for callers that only need one
 * lookup. For per-day loops, fetch the per-email list once via
 * `byEmail.get(email)` and call `resolveRateAsOfDate` directly.
 */
export function resolveRateFromMap(
  byEmail: RateHistoryByEmail,
  email: string,
  date: Date,
): { regularRate: number | null; otRate: number | null } | null {
  const em = normEmail(email);
  if (!em) return null;
  return resolveRateAsOfDate(byEmail.get(em), date);
}

/** Insert a new history row. Email is lowercased server-side via trigger. */
export async function insertRateHistoryRow(args: {
  email: string;
  regularRate: string | number | null;
  otRate: string | number | null;
  effectiveFrom: Date;
  createdBy?: string;
  note?: string;
}): Promise<{ error: string | null }> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return { error: 'supabase client unavailable' };

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const { error } = await supabase.from('employee_rate_history').insert({
    employee_email: args.email,
    regular_rate: args.regularRate == null ? null : String(args.regularRate),
    ot_rate: args.otRate == null ? null : String(args.otRate),
    effective_from: fmt(args.effectiveFrom),
    note: args.note ?? null,
    created_by: args.createdBy ?? null,
  });
  return { error: error?.message ?? null };
}
