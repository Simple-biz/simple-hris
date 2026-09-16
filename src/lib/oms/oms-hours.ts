/**
 * Orphanage Management System (OMS) — the read side. Server-only.
 *
 * Two calls, both scoped to ONE pay week (its Sunday) and to APPROVED rows only —
 * Kane, 2026-09-16: "when OMS will approve it only then the data is available".
 *
 *   omsWeekStatus       cheap: how many approved rows exist + the latest stamp.
 *                       Feeds the "ready to pull" indicator. Never returns rows.
 *   pullOmsApprovedHours the rows, paged (PostgREST caps a page at 1000 even with
 *                       .range() — see selectAllPaged), stable order, hard cap with
 *                       an explicit `truncated` flag rather than a silent tail drop.
 *
 * Neither call writes anything to OMS. The HRIS decides what is overtime — OMS hands
 * over pay week + email + hours and nothing else is read from the row.
 *
 * Doc: docs/features/orphanage-oms-pull.md
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import type { OrphanageHourRow } from '@/lib/payroll/orphanage-rows';

import type { OmsConfig } from './oms-config';

/** More approved rows than this for ONE week is not a pay week, it is a mistake upstream. */
export const OMS_MAX_ROWS = 10_000;

export interface OmsWeekStatus {
  approvedCount: number;
  /** ISO timestamp of the newest approved row's `updatedAt` column, when configured. */
  latestUpdatedAt: string | null;
}

export interface OmsPullResult {
  rows: OrphanageHourRow[];
  approvedCount: number;
  latestUpdatedAt: string | null;
  truncated: boolean;
}

export function createOmsClient(cfg: OmsConfig): SupabaseClient {
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(weekStart: string): void {
  if (!ISO_DATE.test(weekStart)) throw new Error(`week_start must be YYYY-MM-DD, got "${weekStart}"`);
}

/**
 * Approved-row count for the week. `count: 'exact'` WITHOUT `head: true` on purpose:
 * a HEAD count against a missing table can come back as a clean zero, and this
 * indicator must fail loud when the table or column is wrong, not read "not ready".
 */
export async function omsWeekStatus(cfg: OmsConfig, weekStart: string, client = createOmsClient(cfg)): Promise<OmsWeekStatus> {
  assertIsoDate(weekStart);
  const { cols } = cfg;
  const selectCols = cols.updatedAt ? `${cols.email},${cols.updatedAt}` : cols.email;
  let q = client
    .from(cfg.table)
    .select(selectCols, { count: 'exact' })
    .eq(cols.weekStart, weekStart)
    .eq(cols.status, cfg.approvedValue);
  if (cols.updatedAt) q = q.order(cols.updatedAt, { ascending: false, nullsFirst: false });
  const { data, error, count } = await q.limit(1);
  if (error) throw new Error(`OMS status read failed: ${error.message}`);
  // The select string is built at runtime, so supabase-js cannot type the row.
  const first = (data?.[0] ?? null) as unknown as Record<string, unknown> | null;
  const stamp = cols.updatedAt && first ? first[cols.updatedAt] : null;
  return {
    approvedCount: count ?? 0,
    latestUpdatedAt: typeof stamp === 'string' && stamp ? stamp : null,
  };
}

/**
 * Every APPROVED row for the week, shaped for `resolveOrphanageHourRows`. The pay-week
 * label is the OMS column when configured, else the range label the caller passes —
 * informational either way, never used to pick the period.
 */
export async function pullOmsApprovedHours(
  cfg: OmsConfig,
  weekStart: string,
  fallbackPayWeekLabel: string,
  client = createOmsClient(cfg),
): Promise<OmsPullResult> {
  assertIsoDate(weekStart);
  const { cols } = cfg;
  const selectCols = [cols.email, cols.hours, cols.payWeek, cols.updatedAt].filter((c): c is string => !!c).join(',');

  const { rows: raw, error } = await selectAllPaged<Record<string, unknown>>((from, to) =>
    client
      .from(cfg.table)
      .select(selectCols)
      .eq(cols.weekStart, weekStart)
      .eq(cols.status, cfg.approvedValue)
      .order(cols.email, { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>,
  );
  if (error) throw new Error(`OMS pull failed: ${error}`);

  const truncated = raw.length > OMS_MAX_ROWS;
  const kept = truncated ? raw.slice(0, OMS_MAX_ROWS) : raw;

  let latest: string | null = null;
  const rows: OrphanageHourRow[] = kept.map((r, i) => {
    const stamp = cols.updatedAt ? r[cols.updatedAt] : null;
    if (typeof stamp === 'string' && stamp && (!latest || stamp > latest)) latest = stamp;
    const label = cols.payWeek ? r[cols.payWeek] : null;
    const hours = r[cols.hours];
    return {
      line: i + 1,
      payWeek: typeof label === 'string' && label.trim() ? label.trim() : fallbackPayWeekLabel,
      email: String(r[cols.email] ?? ''),
      hours: typeof hours === 'number' ? hours : String(hours ?? ''),
    };
  });

  return { rows, approvedCount: raw.length, latestUpdatedAt: latest, truncated };
}
