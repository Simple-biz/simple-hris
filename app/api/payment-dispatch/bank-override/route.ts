import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { insertBankUpdateHistory } from '@/lib/supabase/bank-update-history';
import { maskFieldValue } from '@/lib/bank-update/mask-field';
import { pulseBankChanges } from '@/lib/supabase/app-settings';
import {
  mapBankOverrideToColumns,
  type BankOverrideTarget,
  type BankOverrideValues,
} from '@/lib/payroll/bank-override-mapping';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST /api/payment-dispatch/bank-override
// Accounting-only (Mark Paid modal): save corrected receiving-end bank details
// back to the employee's profile (employee_ids), overriding the dashboard
// values. Deliberately NO dispatch-lock check — this is the sanctioned
// mid-processing correction path (the lock exists to stop EMPLOYEES changing
// details while accounting pays). Routing (bank_preferred) is never written.
export async function POST(req: Request) {
  try {
    const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
    if (!authz.ok) return deniedResponse(authz);

    const body = (await req.json()) as {
      work_email?: string;
      target?: string;
      processor?: string;
      display_name?: string;
      values?: BankOverrideValues;
    };

    const workEmail = (body.work_email ?? '').trim().toLowerCase();
    const target = (body.target ?? '') as BankOverrideTarget;
    const processor = (body.processor ?? '').trim().toLowerCase();
    const displayName = (body.display_name ?? '').trim() || null;

    if (!workEmail) return NextResponse.json({ error: 'work_email is required' }, { status: 400 });
    if (target !== 'bank' && target !== 'wallet') {
      return NextResponse.json({ error: "target must be 'bank' or 'wallet'" }, { status: 400 });
    }
    if (!body.values) return NextResponse.json({ error: 'values is required' }, { status: 400 });

    const supabase = createSupabaseServiceRoleClient();
    if (!supabase) {
      return NextResponse.json(
        { error: 'SUPABASE_SERVICE_ROLE_KEY is required for bank-override writes.' },
        { status: 500 },
      );
    }

    // Current row: the slot decides which columns a 'bank' write targets, and
    // the before-values feed the masked history entry.
    const { data: currentRows, error: loadErr } = await supabase
      .from('employee_ids')
      .select(
        'employee_id, name, preferred_bank_slot, bank_name, account_holder_name, account_number, swift_code, alt_bank_name, alt_account_holder_name, alt_account_number, alt_routing_number, hurupay_email, wepay_email, higlobe_email, higlobe_account_name, wise_email',
      )
      .ilike('work_email', workEmail)
      .limit(1);
    if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
    const beforeRow = (currentRows?.[0] ?? null) as Record<string, unknown> | null;

    const slot: 'primary' | 'alternative' =
      beforeRow?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';

    const mapped = mapBankOverrideToColumns({
      target,
      processor,
      preferredBankSlot: slot,
      values: body.values,
    });
    if ('error' in mapped) return NextResponse.json({ error: mapped.error }, { status: 400 });
    const { columns } = mapped;

    // Write: update the existing row, or bootstrap one for a person who only
    // exists in the rates CSV (same SELF- pattern as the bank-preferred
    // approval route).
    let created = false;
    if (beforeRow) {
      const { error: updErr } = await supabase
        .from('employee_ids')
        .update(columns)
        .ilike('work_email', workEmail);
      if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    } else {
      created = true;
      const employeeId = `SELF-${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;
      const { error: insErr } = await supabase.from('employee_ids').insert({
        employee_id: employeeId,
        name: displayName ?? workEmail,
        work_email: workEmail,
        ...columns,
      });
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    // ── Best-effort trail: history feed, audit log, live pulse, employee
    // notification. None of these may fail the save. ──────────────────────
    const fields = Object.keys(columns);
    const changes = fields.map((field) => {
      const rawBefore = beforeRow?.[field] != null ? String(beforeRow[field]) : null;
      const rawAfter = columns[field];
      return {
        field,
        before: maskFieldValue(field, rawBefore),
        after: maskFieldValue(field, rawAfter),
        changed: (rawBefore ?? '').trim() !== (rawAfter ?? '').trim(),
      };
    });
    const employeeName =
      displayName ?? (typeof beforeRow?.name === 'string' ? (beforeRow.name as string) : null);

    await insertBankUpdateHistory({
      work_email: workEmail,
      employee_name: employeeName,
      fields,
      changes,
      processor: processor || null,
      created_new: created,
      via: 'mark_paid_override',
      ip_address: null,
    }).catch(() => undefined);

    const actor = await getSessionActor();
    void insertAuditLog({
      user_name: actor.user_name,
      user_role: actor.user_role,
      action: 'bank_override.saved',
      resource: 'employee_ids',
      resource_id: workEmail,
      details: { via: 'mark_paid_override', target, processor, fields, changes, created },
    });

    await pulseBankChanges().catch(() => undefined);

    try {
      await supabase.from('employee_notifications').insert({
        recipient_email: workEmail,
        type: 'people.banking.overridden',
        tone: 'neutral',
        title: 'Accounting updated your bank details',
        message: `Accounting corrected your payout details (${fields.join(', ')}) while processing your payment. Review them under Profile → Payment.`,
        details: { kind: 'bank_override', via: 'mark_paid_override', fields },
      });
    } catch {
      /* notification failure must not fail the save */
    }

    return NextResponse.json({ success: true, created });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
