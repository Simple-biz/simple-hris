import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { recordSpecialTransfer } from '@/lib/people/special-transfer';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { formatPeso } from '@/lib/hsl-bonus/schema';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  recipient_email?: string;
  amount_php?: number | string;
  sent_date?: string;
  reason?: string;
  processor?: string | null;
  bank_used?: string | null;
  transaction_id?: string | null;
  notify?: boolean;
}

/**
 * Record a one-off "special transfer" to an employee from the People tab. Writes
 * the disbursement_records + payment_dispatches rows (see recordSpecialTransfer),
 * audit-logs it, and — when `notify` is set — drops the employee a notification.
 * Edit access to the `people` feature on the caller's dashboard is required
 * (accounting OR ceo OR admin).
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEditAnyView('people');
  if (!authz.ok) return deniedResponse(authz);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    actor = await getSessionActor();
  } catch { /* best-effort */ }

  const result = await recordSpecialTransfer({
    recipientEmail: body.recipient_email ?? '',
    amountPhp: Number(body.amount_php),
    sentDate: body.sent_date ?? '',
    reason: body.reason ?? '',
    processor: body.processor ?? null,
    bankUsed: body.bank_used ?? null,
    transactionId: body.transaction_id ?? null,
    createdBy: actor.user_name !== 'anonymous' ? actor.user_name : null,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'people.special_transfer.created',
    resource: 'disbursement_records',
    resource_id: result.sourceFile ?? null,
    details: {
      recipient_email: (body.recipient_email ?? '').trim().toLowerCase(),
      recipient_name: result.recipientName,
      amount_php: result.amountPhp,
      amount_usd: result.amountUsd,
      sent_date: result.sentDate,
      reason: (body.reason ?? '').trim(),
      source_file: result.sourceFile,
    },
  });

  // Optional employee-facing notification (best-effort).
  let notified = false;
  if (body.notify) {
    try {
      const supabase = createSupabaseServiceRoleClient();
      if (supabase) {
        const { error: notifErr } = await supabase.from('employee_notifications').insert({
          recipient_email: (body.recipient_email ?? '').trim().toLowerCase(),
          type: 'special_transfer.recorded',
          tone: 'positive',
          title: 'Special transfer sent',
          message: `A special transfer of ${formatPeso(result.amountPhp ?? 0)} was sent on ${result.sentDate}${
            (body.reason ?? '').trim() ? ` — ${(body.reason ?? '').trim()}` : '.'
          }`,
          details: {
            amount_php: result.amountPhp,
            amount_usd: result.amountUsd,
            sent_date: result.sentDate,
            reason: (body.reason ?? '').trim(),
          },
        });
        notified = !notifErr;
      }
    } catch {
      /* notification is best-effort — the money record already succeeded */
    }
  }

  return NextResponse.json({ ok: true, error: null, notified, transfer: result });
}
