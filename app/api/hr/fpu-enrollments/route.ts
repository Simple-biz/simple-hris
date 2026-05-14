import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Row = {
  id: string;
  email: string;
  full_name: string;
  department: string;
  shift_schedule_est: string;
  created_at: string;
};

type AuditDetails = {
  email?: string;
  full_name?: string;
  department?: string;
  shift_schedule_est?: string;
};

export async function GET() {
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({
      rows: [] as Row[],
      source: 'audit' as const,
      error: 'Supabase not configured',
    });
  }

  // Prefer the dedicated table when present.
  const tableRes = await supabase
    .from('fpu_enrollments')
    .select('id, email, full_name, department, shift_schedule_est, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (!tableRes.error && tableRes.data) {
    return NextResponse.json({
      rows: tableRes.data as Row[],
      source: 'table' as const,
      error: null,
    });
  }

  // Fallback: reconstruct from audit_log entries written by /api/fpu-enroll.
  // This keeps HR's view working pre-migration.
  const auditRes = await supabase
    .from('audit_log')
    .select('id, created_at, details')
    .eq('action', 'fpu.enroll')
    .order('created_at', { ascending: false })
    .limit(500);

  if (auditRes.error || !auditRes.data) {
    return NextResponse.json({
      rows: [] as Row[],
      source: 'audit' as const,
      error: auditRes.error?.message ?? 'Could not load enrollments',
    });
  }

  const rows: Row[] = auditRes.data.map((entry) => {
    const details = (entry.details ?? {}) as AuditDetails;
    return {
      id: String(entry.id),
      email: details.email ?? '',
      full_name: details.full_name ?? '',
      department: details.department ?? '',
      shift_schedule_est: details.shift_schedule_est ?? '',
      created_at: String(entry.created_at),
    };
  });

  return NextResponse.json({
    rows,
    source: 'audit' as const,
    error: tableRes.error?.message ?? null,
  });
}
