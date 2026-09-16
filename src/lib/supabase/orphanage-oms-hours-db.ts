import { randomUUID } from 'node:crypto';

import { selectAllPaged } from './select-all-paged';
import { createSupabaseServiceRoleClient } from './server';
import type { OmsSavePayload, OmsSaveRow } from '@/lib/oms/oms-save';

/**
 * Persistence for OMS saves — `public.orphanage_oms_hours`
 * (references/sql/create/2026-09-16_orphanage_oms_hours.sql).
 *
 * APPEND-ONLY. One Save = one `save_id` across its rows. There is deliberately no
 * update or delete here: a save is a snapshot of what OMS said and what the HRIS
 * made of it at that moment, and the next save is simply newer. This table is NOT
 * money — nothing prices, dispatches or prints from it.
 *
 * Server-only (service role). RLS is on with no policies, so a browser client sees
 * nothing; every read goes through the route that calls these.
 */

const TABLE = 'orphanage_oms_hours';
const INSERT_BATCH = 500;

export interface OmsSavedRow extends OmsSaveRow {
  id: number;
}

export interface OmsSaveSummary {
  saveId: string;
  weekStart: string;
  sourceFile: string | null;
  mode: 'test' | 'live';
  savedBy: string;
  savedAt: string;
  approvedCount: number | null;
  latestUpdatedAt: string | null;
  truncated: boolean;
  matched: number;
  skipped: number;
  totalPhp: number;
  rows: OmsSavedRow[];
}

/**
 * Is the table there? `count: 'exact'` WITHOUT `head: true`, because a HEAD count
 * against a missing table can come back clean — this must fail loud so the panel
 * can say "table not applied yet" instead of a Save that 500s.
 */
export async function probeOmsHoursTable(): Promise<{ ready: boolean; reason: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { ready: false, reason: 'Supabase client unavailable' };
  const { error } = await supabase.from(TABLE).select('id', { count: 'exact' }).limit(1);
  if (!error) return { ready: true, reason: null };
  const missing = /does not exist|schema cache|PGRST205|42P01/i.test(`${error.code ?? ''} ${error.message}`);
  return {
    ready: false,
    reason: missing
      ? 'The orphanage_oms_hours table is not applied yet — run scripts/apply-orphanage-oms-hours-migration.mts --apply'
      : `orphanage_oms_hours is unreadable: ${error.message}`,
  };
}

const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Insert one save. Batched under a single save_id; a failed batch names the save_id. */
export async function insertOmsSave(params: {
  payload: OmsSavePayload;
  actor: string;
}): Promise<{ saveId: string; saved: number; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  const saveId = randomUUID();
  if (!supabase) return { saveId, saved: 0, error: 'Supabase client unavailable' };
  const { payload } = params;
  const savedAt = new Date().toISOString();

  const dbRows = payload.rows.map((r) => ({
    save_id: saveId,
    week_start: payload.week_start,
    source_file: payload.source_file,
    mode: payload.mode,
    saved_by: params.actor,
    saved_at: savedAt,
    oms_email: r.omsEmail,
    oms_pay_week: r.omsPayWeek,
    oms_hours_raw: r.omsHoursRaw,
    oms_hours: r.omsHours,
    matched: r.matched,
    employee_email: r.employeeEmail,
    employee_name: r.employeeName,
    reg_hours: r.regHours,
    ot_hours: r.otHours,
    regular_rate_php: r.regularRatePhp,
    ot_rate_php: r.otRatePhp,
    amount_php: r.amountPhp,
    skip_reason: r.skipReason,
    approved_count: payload.approved_count,
    latest_updated_at: payload.latest_updated_at,
    truncated: payload.truncated,
  }));

  let saved = 0;
  for (let i = 0; i < dbRows.length; i += INSERT_BATCH) {
    const batch = dbRows.slice(i, i + INSERT_BATCH);
    const { error } = await supabase.from(TABLE).insert(batch);
    if (error) {
      return { saveId, saved, error: `save ${saveId}: batch ${i / INSERT_BATCH + 1} failed — ${error.message}` };
    }
    saved += batch.length;
  }
  return { saveId, saved, error: null };
}

/** The newest save for a week, whole. Null when the week has never been saved. */
export async function latestOmsSaveForWeek(weekStart: string): Promise<{ save: OmsSaveSummary | null; error: string | null }> {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return { save: null, error: 'Supabase client unavailable' };

  const head = await supabase
    .from(TABLE)
    .select('save_id, saved_at')
    .eq('week_start', weekStart)
    .order('saved_at', { ascending: false })
    .limit(1);
  if (head.error) return { save: null, error: head.error.message };
  const saveId = (head.data?.[0] as { save_id?: string } | undefined)?.save_id;
  if (!saveId) return { save: null, error: null };

  const { rows, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    supabase.from(TABLE).select('*').eq('save_id', saveId).order('id', { ascending: true }).range(from, to),
  );
  if (error) return { save: null, error };
  if (rows.length === 0) return { save: null, error: null };

  const first = rows[0]!;
  const mapped: OmsSavedRow[] = rows.map((r) => ({
    id: Number(r.id),
    omsEmail: String(r.oms_email ?? ''),
    omsPayWeek: (r.oms_pay_week as string | null) ?? null,
    omsHoursRaw: String(r.oms_hours_raw ?? ''),
    omsHours: num(r.oms_hours),
    matched: r.matched === true,
    employeeEmail: (r.employee_email as string | null) ?? null,
    employeeName: (r.employee_name as string | null) ?? null,
    regHours: num(r.reg_hours),
    otHours: num(r.ot_hours),
    regularRatePhp: num(r.regular_rate_php),
    otRatePhp: num(r.ot_rate_php),
    amountPhp: num(r.amount_php),
    skipReason: (r.skip_reason as string | null) ?? null,
  }));
  const matched = mapped.filter((r) => r.matched);
  return {
    save: {
      saveId,
      weekStart: String(first.week_start),
      sourceFile: (first.source_file as string | null) ?? null,
      mode: first.mode === 'live' ? 'live' : 'test',
      savedBy: String(first.saved_by ?? ''),
      savedAt: String(first.saved_at ?? ''),
      approvedCount: num(first.approved_count),
      latestUpdatedAt: (first.latest_updated_at as string | null) ?? null,
      truncated: first.truncated === true,
      matched: matched.length,
      skipped: mapped.length - matched.length,
      totalPhp: Math.round(matched.reduce((s, r) => s + (r.amountPhp ?? 0), 0) * 100) / 100,
      rows: mapped,
    },
    error: null,
  };
}
