import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory } from '@/lib/supabase/bank-update-history';
import { getSessionActor } from '@/lib/auth/session-actor';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { getBankPreferredRequestById } from '@/lib/supabase/bank-preferred-requests';
import { invalidateRateProfilesCache } from '@/lib/supabase/employee-rate-profiles';
import { pulseBankChanges } from '@/lib/supabase/app-settings';
import {
  bankPreferredLabelForProcessor,
  isBankPreferredTransitionAllowed,
} from '@/lib/employee-payment-processors';
import type { ProcessorId } from '@/lib/employee-payment-processors';
import { randomUUID } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'bank_preferred_change_requests';

function labelFor(v: string | null): string {
  if (!v) return 'none';
  return bankPreferredLabelForProcessor(v as ProcessorId) || v;
}

// PATCH /api/bank-preferred-requests/[id]
// Accounting-only (Issues tab): approve or deny a Bank Preferred change request.
// On approve, the requested value is written to employee_ids.bank_preferred.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Same gate as the rest of the Issues tab (PAB disputes live here too).
    const authz = await requireFeatureEditAnyView('disputes');
    if (!authz.ok) return deniedResponse(authz);

    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json()) as { status?: string; review_notes?: string | null };
    const status = (body.status ?? '').trim();
    if (!['approved', 'denied'].includes(status)) {
      return NextResponse.json({ error: 'status must be approved or denied' }, { status: 400 });
    }

    const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
    if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

    const { row, error: loadErr } = await getBankPreferredRequestById(id);
    if (loadErr) return NextResponse.json({ error: loadErr }, { status: 500 });
    if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    if (row.status !== 'pending') {
      return NextResponse.json(
        { error: `This request is already ${row.status} and can't be changed.` },
        { status: 409 },
      );
    }

    const nowIso = new Date().toISOString();
    const reviewNotes = body.review_notes ?? null;

    // On APPROVE, write the value into employee_ids.bank_preferred first. Only if
    // that succeeds do we mark the request approved — so a write failure never
    // leaves an "approved" request whose value never landed.
    if (status === 'approved') {
      const workEmail = row.work_email.trim().toLowerCase();

      // WIRES lock re-check: verify against the CURRENT stored value, not the
      // request's from_value (it may have changed since the request was filed).
      // A WIRES employee can never be approved onto hurupay/higlobe.
      const { data: liveRows } = await supabase
        .from('employee_ids')
        .select('bank_preferred')
        .ilike('work_email', workEmail)
        .limit(1);
      const liveCurrent =
        Array.isArray(liveRows) && liveRows[0] && typeof liveRows[0].bank_preferred === 'string'
          ? (liveRows[0].bank_preferred as string)
          : null;
      if (!isBankPreferredTransitionAllowed(liveCurrent, row.to_value)) {
        return NextResponse.json(
          {
            error:
              'This employee is set to WIRES and can only be paid via wires — approving Hurupay/HiGlobe is not possible. Deny this request instead.',
          },
          { status: 400 },
        );
      }

      const { data: updatedRows, error: updErr } = await supabase
        .from('employee_ids')
        .update({ bank_preferred: row.to_value, bank_last_self_updated_at: nowIso })
        .ilike('work_email', workEmail)
        .select('employee_id');

      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

      // No employee_ids row yet (employee only ever submitted a Bank Preferred and
      // had no payout row) — bootstrap one so the approved value has a home.
      if (!updatedRows || updatedRows.length === 0) {
        const employeeId = `SELF-${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
        const { error: insErr } = await supabase.from('employee_ids').insert({
          employee_id: employeeId,
          name: row.employee_name ?? workEmail,
          work_email: workEmail,
          bank_preferred: row.to_value,
          bank_last_self_updated_at: nowIso,
        });
        if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
      }

      invalidateRateProfilesCache();

      // Record into the People-tab bank-change history so approvals are auditable
      // there alongside self-service changes. Best-effort.
      await insertBankUpdateHistory({
        work_email: workEmail,
        employee_name: row.employee_name,
        fields: ['bank_preferred'],
        changes: [
          {
            field: 'bank_preferred',
            before: labelFor(row.from_value),
            after: labelFor(row.to_value),
            changed: (row.from_value ?? '') !== (row.to_value ?? ''),
          },
        ],
        processor: row.to_value,
        created_new: false,
        via: 'accounting_approval',
        ip_address: null,
      }).catch(() => undefined);
      await pulseBankChanges().catch(() => undefined);
    }

    const { error: markErr } = await supabase
      .from(TABLE)
      .update({
        status,
        review_notes: reviewNotes,
        reviewed_by: authz.sessionEmail,
        reviewed_at: nowIso,
        applied_at: status === 'approved' ? nowIso : null,
      })
      .eq('id', id);

    if (markErr) return NextResponse.json({ error: markErr.message }, { status: 500 });

    // Notify the employee of the decision. Best-effort.
    try {
      const approved = status === 'approved';
      await supabase.from('employee_notifications').insert({
        recipient_email: row.work_email.trim().toLowerCase(),
        type: 'bank_preferred.decided',
        tone: approved ? 'positive' : 'neutral',
        title: approved ? 'Bank Preferred change approved' : 'Bank Preferred change denied',
        message: approved
          ? `Accounting approved your Bank Preferred change to ${labelFor(row.to_value)}. It's now active.`
          : `Accounting denied your Bank Preferred change to ${labelFor(row.to_value)}. Your current setting is unchanged.${reviewNotes ? ` Note: ${reviewNotes}` : ''}`,
        details: { kind: 'bank_preferred_request', status, from: row.from_value, to: row.to_value },
      });
    } catch {
      /* notification failure must not fail the decision */
    }

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: `bank_preferred.request.${status}`,
      resource: TABLE,
      resource_id: id,
      details: { work_email: row.work_email, from: row.from_value, to: row.to_value, review_notes: reviewNotes },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
