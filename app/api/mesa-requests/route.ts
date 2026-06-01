import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_requests';

export type MesaRequestType = 'opt_in' | 'opt_out' | 'disbursement' | 'return';
export type MesaRequestStatus = 'pending' | 'approved' | 'denied';

export interface MesaRequestRow {
  id: string;
  work_email: string;
  full_name: string;
  department: string;
  request_type: MesaRequestType;
  fpu_date: string | null;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  status: MesaRequestStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

// GET /api/mesa-requests
// ?email=xxx  => employee fetching their own requests  (authorizeEmailAccess)
// (no email)  => accounting listing all               (requireElevatedSession)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    const requestType = searchParams.get('request_type') ?? undefined;
    const limit = parseInt(searchParams.get('limit') ?? '200', 10);

    const authz = email
      ? await authorizeEmailAccess(email)
      : await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    let q = supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (email && authz.ok) {
      q = q.eq('work_email', authz.effectiveEmail);
    }
    if (status) q = q.eq('status', status);
    if (requestType) q = q.eq('request_type', requestType);

    const { data, error } = await q;
    if (error) return NextResponse.json({ rows: [], error: error.message }, { status: 500 });
    return NextResponse.json({ rows: data ?? [] });
  } catch (e) {
    return NextResponse.json({ rows: [], error: String(e) }, { status: 500 });
  }
}

// POST /api/mesa-requests
// Employee submitting a new MESA request.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      work_email?: string;
      full_name?: string;
      department?: string;
      request_type?: string;
      fpu_date?: string | null;
      disbursement_reason?: string | null;
      explanation?: string | null;
      amount_needed?: number | null;
    };

    const work_email = (body.work_email ?? '').trim().toLowerCase();
    if (!work_email) {
      return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    }

    const authz = await authorizeEmailAccess(work_email);
    if (!authz.ok) return deniedResponse(authz);

    const full_name = (body.full_name ?? '').trim();
    const department = (body.department ?? '').trim();
    const request_type = (body.request_type ?? '').trim();

    if (!full_name) return NextResponse.json({ error: 'full_name is required' }, { status: 400 });
    if (!department) return NextResponse.json({ error: 'department is required' }, { status: 400 });
    if (!['opt_in', 'opt_out', 'disbursement', 'return'].includes(request_type)) {
      return NextResponse.json({ error: 'invalid request_type' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const row: Omit<MesaRequestRow, 'id' | 'created_at' | 'status' | 'review_notes' | 'reviewed_by' | 'reviewed_at'> = {
      work_email: authz.effectiveEmail,
      full_name,
      department,
      request_type: request_type as MesaRequestType,
      fpu_date: body.fpu_date ?? null,
      disbursement_reason: body.disbursement_reason ?? null,
      explanation: body.explanation ?? null,
      amount_needed: body.amount_needed ?? null,
    };

    const { data, error } = await supabase.from(TABLE).insert(row).select('id').single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: `mesa.request.${request_type}`,
      resource: TABLE,
      resource_id: data?.id ?? null,
      details: { work_email: authz.effectiveEmail, request_type, department },
    });

    return NextResponse.json({ success: true, id: data?.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
