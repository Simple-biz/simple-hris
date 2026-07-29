import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import { countMesaReceipts } from '@/lib/mesa/receipts';

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
  /** Opt-out only: the day participation ends (weekly deduction + match stop). */
  effective_date: string | null;
  disbursement_reason: string | null;
  explanation: string | null;
  amount_needed: number | null;
  status: MesaRequestStatus;
  review_notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  /** Attached receipt files (disbursement only). Derived on read from
   *  mesa_request_receipts — not a stored column. */
  receipt_count?: number;
  /** Newest receipt's upload time — what the 14-day submission rule is judged
   *  against. Null when nothing is attached. */
  receipt_last_uploaded_at?: string | null;
}

// GET /api/mesa-requests
// ?email=xxx  => employee fetching their own requests  (authorizeEmailAccess)
// (no email)  => accounting listing all               (requireElevatedSession)
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email') ?? undefined;
    const status = searchParams.get('status') ?? undefined;
    // Accept multiple request_type params (?request_type=a&request_type=b) as an IN filter.
    const requestTypes = searchParams.getAll('request_type').filter(Boolean);
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
    if (requestTypes.length === 1) q = q.eq('request_type', requestTypes[0]);
    else if (requestTypes.length > 1) q = q.in('request_type', requestTypes);

    const { data, error } = await q;
    if (error) return NextResponse.json({ rows: [], error: error.message }, { status: 500 });

    // Receipt tallies for the disbursement rows, in one extra round trip rather
    // than one fetch per row. `countMesaReceipts` swallows its own failures
    // (including the table not existing yet, pre-migration) and returns {}, so a
    // request list never fails over a receipt count — the rows just report zero.
    const rows = (data ?? []) as MesaRequestRow[];
    const counts = await countMesaReceipts(
      rows.filter((r) => r.request_type === 'disbursement').map((r) => r.id),
    );
    const withReceipts = rows.map((r) =>
      r.request_type === 'disbursement'
        ? {
            ...r,
            receipt_count: counts[r.id]?.count ?? 0,
            receipt_last_uploaded_at: counts[r.id]?.last_uploaded_at ?? null,
          }
        : r,
    );

    return NextResponse.json({ rows: withReceipts });
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
      effective_date?: string | null;
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

    // Opt-out carries the date participation ends. It lands in a DATE column, so
    // only a strict YYYY-MM-DD is accepted; every other type stores null rather
    // than whatever the caller sent, keeping the column single-purpose.
    const effective_date = (body.effective_date ?? '').trim();
    if (request_type === 'opt_out') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
        return NextResponse.json(
          { error: 'effective_date (YYYY-MM-DD) is required for an opt-out' },
          { status: 400 },
        );
      }
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const row: Omit<MesaRequestRow, 'id' | 'created_at' | 'status' | 'review_notes' | 'reviewed_by' | 'reviewed_at'> = {
      work_email: authz.effectiveEmail,
      full_name,
      department,
      request_type: request_type as MesaRequestType,
      fpu_date: body.fpu_date ?? null,
      effective_date: request_type === 'opt_out' ? effective_date : null,
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
      details: {
        work_email: authz.effectiveEmail,
        request_type,
        department,
        ...(request_type === 'opt_out' ? { effective_date } : {}),
      },
    });

    return NextResponse.json({ success: true, id: data?.id });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
