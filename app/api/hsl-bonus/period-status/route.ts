import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { rejectWhilePayrollProcessing } from '@/lib/payroll/processing-guard';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { normalizeSource, sourceLabel, MANAGER_KPI_SOURCE } from '@/lib/payroll/readiness-audit';
import { notifyKpiScored } from '@/lib/notifications/kpi-scored';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dept = searchParams.get('dept');
  const period_start = searchParams.get('period_start');

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  let query = supabase.from('hsl_bonus_period_status').select('*');
  if (dept) query = query.eq('department', dept);
  if (period_start) query = query.eq('period_start', period_start);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('manager', 'hsl_bonus');
  if (!authz.ok) return deniedResponse(authz);
  const processing = await rejectWhilePayrollProcessing('the KPI Calculator');
  if (processing) return processing;
  const body = (await req.json()) as {
    department: string;
    period_type: string;
    period_start: string;
    period_end: string;
    status: 'draft' | 'ready' | 'locked';
    locked_by?: string;
    /** Where the submission came from: the manager's own KPI tab (default) or
     *  the Payroll Wizard Readiness "fix it from here" calculator. */
    source?: string;
  };

  if (!body.department || !body.period_start || !body.status) {
    return NextResponse.json({ error: 'department, period_start, status required' }, { status: 400 });
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 });

  const row = {
    department: body.department,
    period_type: body.period_type,
    period_start: body.period_start,
    period_end: body.period_end,
    status: body.status,
    locked_by: body.status === 'locked' ? (body.locked_by ?? null) : null,
    locked_at: body.status === 'locked' ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('hsl_bonus_period_status')
    .upsert(row, { onConflict: 'department,period_start' })
    .select('id, department, period_start, status')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // The week just became (or stayed) visible to employees → tell everyone whose
  // KPI bonus total changed since their last kpi.scored notification. The
  // helper itself gates on ready/locked and diffs per person, so Mark Ready
  // notifies the whole dept-week once, a later Lock inserts nothing new, and a
  // reopen→re-ready after a dispute re-notifies only the corrected people.
  // Best-effort: a notify failure never fails the submission.
  if (body.status === 'ready' || body.status === 'locked') {
    try {
      await notifyKpiScored({ department: body.department, periodStart: body.period_start });
    } catch (e) {
      console.warn('[kpi.scored] notify on status change failed:', e);
    }
  }

  // Audit the submission transition (Mark Ready / Lock / reopen) — this route
  // had no trail before. Tagged with its source so a Payroll-Wizard fix reads
  // "via Payroll Wizard". Score-saves are intentionally NOT audited (high
  // volume). Best-effort; never fails the status write. Identity is the
  // verified session, not the client-supplied `locked_by`.
  const source = normalizeSource(body.source, MANAGER_KPI_SOURCE);
  const action =
    body.status === 'ready'
      ? 'payroll.kpi.marked_ready'
      : body.status === 'locked'
        ? 'payroll.kpi.locked'
        : 'payroll.kpi.reopened';
  const who = await getSessionActor();
  void insertAuditLog({
    user_name: who.user_name,
    user_role: who.user_role,
    action,
    resource: 'hsl_bonus_period_status',
    resource_id: body.department,
    details: {
      source,
      source_label: sourceLabel(source),
      department: body.department,
      period_type: body.period_type,
      period_start: body.period_start,
      period_end: body.period_end,
      status: body.status,
    },
  }).catch(() => undefined);

  return NextResponse.json({ row: data });
}
