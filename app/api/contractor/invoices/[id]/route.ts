import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) return String((err as Record<string, unknown>).message);
  // Was `return errMsg(err)` — infinite recursion (stack overflow) on any
  // non-Error throw, in the code path that now authorizes money.
  return String(err);
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
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

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
    // NOTE: `contractor_name` and `amount` do NOT exist on this table (the real
    // column is `total`). Selecting them made every request error, so prevRow was
    // always null and every contractor.decided audit entry logged nulls.
    const { data: prevRow } = await supabase
      .from('contractor_invoices')
      .select('id, status, contractor_email, total, currency, invoice_number, from_name, dispatch_id, dispatch_claimed_at')
      .eq('id', id)
      .maybeSingle();

    // Once an invoice has been dispatched, its status is frozen: re-opening it
    // to 'approved' would put an already-PAID invoice back in the dispatch queue
    // as payable. Undoing the payment (dispatch → Done → "send back to the pay
    // processor") is the supported reversal — the AFTER DELETE trigger clears
    // both columns and the invoice becomes payable again on its own.
    const dispatched = prevRow as { dispatch_id?: string | null; dispatch_claimed_at?: string | null } | null;
    if (dispatched?.dispatch_id || dispatched?.dispatch_claimed_at) {
      return NextResponse.json(
        {
          error:
            'This invoice has already been dispatched for payment. Undo the payment in Payment Dispatch → Done before changing its status.',
        },
        { status: 409 },
      );
    }

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
        contractor_name: prevRow?.from_name ?? null,
        invoice_number: prevRow?.invoice_number ?? null,
        amount: prevRow?.total ?? null,
        currency: prevRow?.currency ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: errMsg(err) }, { status: 500 });
  }
}
