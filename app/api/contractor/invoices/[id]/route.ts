import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  return errMsg(err);
}

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// PATCH /api/contractor/invoices/[id]  { status: 'approved' | 'rejected' | 'pending' }
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  try {
    const body = await req.json() as { status?: string };
    const status = body.status;
    if (status !== 'approved' && status !== 'rejected' && status !== 'pending') {
      return NextResponse.json({ error: 'status must be approved, rejected, or pending' }, { status: 400 });
    }
    const supabase = getServiceClient();

    // Fetch previous state for the audit trail's old → new diff.
    const { data: prevRow } = await supabase
      .from('contractor_invoices')
      .select('id, status, contractor_email, contractor_name, amount, currency, invoice_number')
      .eq('id', id)
      .maybeSingle();

    const { error } = await supabase
      .from('contractor_invoices')
      .update({ status })
      .eq('id', id);
    if (error) throw error;

    // Best-effort operator capture for the audit trail.
    let decidedBy = 'unknown';
    let decidedByRole = 'user';
    try {
      const sessionActor = await getSessionActor();
      decidedBy = sessionActor.user_name !== 'anonymous' ? sessionActor.user_name : 'unknown';
      decidedByRole = sessionActor.user_role;
    } catch {
      // ignore — audit trail is best-effort
    }

    void insertAuditLog({
      user_name: decidedBy,
      user_role: decidedByRole,
      action: 'contractor.decided',
      resource: 'contractor_invoices',
      resource_id: id,
      details: {
        previous_status: prevRow?.status ?? null,
        new_status: status,
        contractor_email: prevRow?.contractor_email ?? null,
        contractor_name: prevRow?.contractor_name ?? null,
        invoice_number: prevRow?.invoice_number ?? null,
        amount: prevRow?.amount ?? null,
        currency: prevRow?.currency ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
