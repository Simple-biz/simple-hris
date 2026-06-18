import { NextRequest, NextResponse } from 'next/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getSessionActor } from '@/lib/auth/session-actor';
import { forwardPaystubDispatch } from '@/lib/payroll/paystub-dispatch';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';

/**
 * Forwards a paystub dispatch to the n8n workflow webhook.
 * Keeps the webhook URL server-side (N8N_DISPATCH_WEBHOOK_URL env var).
 *
 * As of the per-employee dispatch change, the Payroll Wizard no longer calls
 * this in a batch — it stages paystubs to `paystub_dispatch_queue` instead, and
 * POST /api/payment-dispatches fires this same webhook one employee at a time
 * (server-side, via the shared `forwardPaystubDispatch` helper) as Lenny marks
 * each person Paid. This route remains for manual / preview / re-sends.
 *
 * Expected body:
 * - pay_period?: { currency: 'PHP'; hubstaff_source_file: string | null; pab_evaluation: {...} }
 * - employees: Array<{ name, email, personal_email, department_*, hours, rates_php, pay_php }>
 * - cycle?: { source_file, period_start, period_end, fx_rate, cycle_id }
 */
export async function POST(req: NextRequest) {
  // Manual / re-send path — elevated only (the wizard no longer calls this; it
  // stages to paystub_dispatch_queue and the per-employee send runs inside
  // /api/payment-dispatches). Without a gate this would let any authenticated
  // user fire arbitrary paystub emails through the n8n webhook.
  const authz = await requireFeatureEdit('accounting', 'payment_dispatch');
  if (!authz.ok) return deniedResponse(authz);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Operator + cycle context (best-effort — never block dispatch on audit prep).
  let operatorEmail = 'unknown';
  let operatorRole = 'user';
  try {
    const sessionActor = await getSessionActor();
    operatorEmail = sessionActor.user_name;
    operatorRole = sessionActor.user_role;
  } catch {
    // ignore
  }
  const cycle = (body.cycle ?? null) as Record<string, unknown> | null;
  const employees = Array.isArray(body.employees) ? (body.employees as unknown[]) : [];
  const payPeriod = (body.pay_period ?? null) as Record<string, unknown> | null;

  const writeAudit = (success: boolean, extra: Record<string, unknown>): void => {
    void insertAuditLog({
      user_name: operatorEmail,
      user_role: operatorRole,
      action: 'paystubs.dispatched',
      resource: 'dispatch_paystubs',
      resource_id: null,
      details: {
        success,
        employee_count: employees.length,
        pay_period: payPeriod,
        cycle,
        ...extra,
      },
    });
  };

  const result = await forwardPaystubDispatch({
    pay_period: payPeriod,
    employees,
    cycle,
  });

  if (result.notConfigured) {
    return NextResponse.json({ error: result.detail }, { status: 500 });
  }
  if (!result.ok) {
    writeAudit(false, {
      http_status: result.status,
      n8n_error_excerpt: result.detail,
    });
    return NextResponse.json(
      {
        error: result.status ? `n8n webhook returned ${result.status}` : 'Failed to reach n8n',
        detail: result.detail,
      },
      { status: 502 },
    );
  }

  writeAudit(true, { http_status: result.status });
  return NextResponse.json({ ok: true, n8n: result.parsed });
}
