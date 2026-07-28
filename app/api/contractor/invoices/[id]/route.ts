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
    //
    // The dispatch columns only exist after add_contractor_dispatch_link.sql, so
    // the select is attempted WITH them and retried without — and its error is
    // handled rather than discarded, otherwise a failed read would silently null
    // the whole audit entry again (and skip the freeze guard below).
    const BASE_COLS = 'id, status, contractor_email, total, currency, invoice_number, from_name';
    const DISPATCH_COLS = 'dispatch_id, dispatch_claimed_at';
    let prevRow: Record<string, unknown> | null = null;
    let dispatchColumnsExist = true;
    {
      const withDispatch = await supabase
        .from('contractor_invoices')
        .select(`${BASE_COLS}, ${DISPATCH_COLS}`)
        .eq('id', id)
        .maybeSingle();
      if (withDispatch.error) {
        dispatchColumnsExist = false;
        const fallback = await supabase
          .from('contractor_invoices')
          .select(BASE_COLS)
          .eq('id', id)
          .maybeSingle();
        if (fallback.error) throw fallback.error;
        prevRow = fallback.data as Record<string, unknown> | null;
      } else {
        prevRow = withDispatch.data as Record<string, unknown> | null;
      }
    }
    if (!prevRow) return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });

    // Once an invoice has been dispatched, its status is frozen: re-opening it
    // to 'approved' would put an already-PAID invoice back in the dispatch queue
    // as payable. Undoing the payment (dispatch → Done → "send back to the pay
    // processor") is the supported reversal — the AFTER DELETE trigger clears
    // both columns and the invoice becomes payable again on its own.
    //
    // Enforced in the WHERE clause of the UPDATE as well as here, because the
    // read above is a check-then-act: a Mark Paid claim can land in between, and a
    // status write must not be able to overtake a payment that is already in flight.
    if (prevRow.dispatch_id || prevRow.dispatch_claimed_at) {
      return NextResponse.json(
        {
          error:
            'This invoice has already been dispatched for payment. Undo the payment in Payment Dispatch → Done before changing its status.',
        },
        { status: 409 },
      );
    }

    let update = supabase.from('contractor_invoices').update({ status }).eq('id', id);
    if (dispatchColumnsExist) {
      update = update.is('dispatch_id', null).is('dispatch_claimed_at', null);
    }
    const { data: updated, error } = await update.select('id');
    if (error) throw error;
    if (!updated || updated.length === 0) {
      return NextResponse.json(
        {
          error:
            'This invoice was just dispatched for payment. Undo the payment in Payment Dispatch → Done before changing its status.',
        },
        { status: 409 },
      );
    }

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
