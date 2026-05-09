import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/hsl-bonus/period-summary?depts=key1,key2[,...]
 *
 * Aggregates `hsl_bonus_period_status` ⨝ `hsl_bonus_entries` per (department,
 * period_start) into a flat list — used by the manager Bonus History tab. A
 * period appears in the result if either table has a row for it (an entries-
 * only week is implicitly "draft"). Sorted period_start DESC, dept ASC.
 */
interface SummaryRow {
  department: string;
  period_type: string;
  period_start: string;
  period_end: string;
  status: 'draft' | 'ready' | 'locked';
  updated_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  employee_count: number;
  scored_count: number;
  total_bonus: number;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const deptsParam = searchParams.get('depts');
  const depts = deptsParam
    ? deptsParam.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (depts.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });
  }

  const [statusRes, entriesRes] = await Promise.all([
    supabase
      .from('hsl_bonus_period_status')
      .select(
        'department, period_type, period_start, period_end, status, updated_at, locked_by, locked_at',
      )
      .in('department', depts),
    supabase
      .from('hsl_bonus_entries')
      .select('department, period_type, period_start, period_end, calculated_bonus')
      .in('department', depts),
  ]);

  if (statusRes.error) {
    return NextResponse.json({ error: statusRes.error.message }, { status: 500 });
  }
  if (entriesRes.error) {
    return NextResponse.json({ error: entriesRes.error.message }, { status: 500 });
  }

  type EntryRow = {
    department: string;
    period_type: string | null;
    period_start: string;
    period_end: string | null;
    calculated_bonus: number | null;
  };
  type StatusRow = {
    department: string;
    period_type: string;
    period_start: string;
    period_end: string;
    status: 'draft' | 'ready' | 'locked';
    updated_at: string | null;
    locked_by: string | null;
    locked_at: string | null;
  };

  // Aggregate entries per (dept, period_start). Track period_type/end here too
  // so periods with entries-only (no status row) still produce a complete
  // SummaryRow.
  interface Agg {
    dept: string;
    period_type: string | null;
    period_start: string;
    period_end: string | null;
    count: number;
    total: number;
    scored: number;
  }
  const aggMap = new Map<string, Agg>();
  for (const e of (entriesRes.data ?? []) as EntryRow[]) {
    const key = `${e.department}::${e.period_start}`;
    const a =
      aggMap.get(key) ??
      ({
        dept: e.department,
        period_type: e.period_type,
        period_start: e.period_start,
        period_end: e.period_end,
        count: 0,
        total: 0,
        scored: 0,
      } as Agg);
    a.count += 1;
    const b = Number(e.calculated_bonus ?? 0);
    a.total += b;
    if (b > 0) a.scored += 1;
    aggMap.set(key, a);
  }

  const statusByKey = new Map<string, StatusRow>();
  for (const s of (statusRes.data ?? []) as StatusRow[]) {
    statusByKey.set(`${s.department}::${s.period_start}`, s);
  }

  // Union of keys — entries-only periods get an implicit 'draft' status.
  const allKeys = new Set<string>([...aggMap.keys(), ...statusByKey.keys()]);
  const rows: SummaryRow[] = [];
  for (const key of allKeys) {
    const agg = aggMap.get(key);
    const s = statusByKey.get(key);
    const dept = agg?.dept ?? s!.department;
    const period_start = agg?.period_start ?? s!.period_start;
    const period_end = s?.period_end ?? agg?.period_end ?? '';
    const period_type = s?.period_type ?? agg?.period_type ?? 'weekly';
    rows.push({
      department: dept,
      period_type,
      period_start,
      period_end,
      status: (s?.status ?? 'draft'),
      updated_at: s?.updated_at ?? null,
      locked_by: s?.locked_by ?? null,
      locked_at: s?.locked_at ?? null,
      employee_count: agg?.count ?? 0,
      scored_count: agg?.scored ?? 0,
      total_bonus: Math.round(agg?.total ?? 0),
    });
  }

  rows.sort((a, b) => {
    if (a.period_start !== b.period_start) {
      return b.period_start.localeCompare(a.period_start);
    }
    return a.department.localeCompare(b.department);
  });

  return NextResponse.json({ rows });
}
