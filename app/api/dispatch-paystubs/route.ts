import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';
import { insertAuditLog } from '@/lib/supabase/audit-log';

/**
 * Forwards a paystub dispatch to the n8n workflow webhook.
 * Keeps the webhook URL server-side (N8N_DISPATCH_WEBHOOK_URL env var).
 *
 * Expected body:
 * - pay_period?: { currency: 'PHP'; hubstaff_source_file: string | null; pab_evaluation: { month_label, range_start, range_end } }
 * - employees: Array<{
 *     name, email, personal_email,
 *     department_key, department_name,
 *     hours: { total, regular, ot },
 *     rates_php: { regular, ot },
 *     pay_php: { regular, ot, initial, bonuses_total, perfect_attendance_bonus, tech_bonus, other_bonuses, final }
 *   }>
 * - cycle?: { source_file, period_start, period_end, fx_rate, cycle_id }
 *     Optional audit-only context; the wizard passes this so the cycle Reports
 *     drill-down can surface the dispatch event without time-window guessing.
 */
export async function POST(req: NextRequest) {
  const webhookUrl = await resolveWebhookUrl('paystub_dispatch', {
    envVars: ['N8N_DISPATCH_WEBHOOK_URL'],
  });
  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'No paystub_dispatch webhook configured (Admin -> Webhooks) and N8N_DISPATCH_WEBHOOK_URL env var unset' },
      { status: 500 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Operator + cycle context (best-effort — never block dispatch on audit prep).
  let operatorEmail = 'unknown';
  try {
    const session = await getServerSession();
    operatorEmail = session?.user?.email ?? 'unknown';
  } catch {
    // ignore
  }
  const cycle = (body.cycle ?? null) as Record<string, unknown> | null;
  const employees = Array.isArray(body.employees) ? (body.employees as unknown[]) : [];
  const payPeriod = (body.pay_period ?? null) as Record<string, unknown> | null;

  const writeAudit = (
    success: boolean,
    extra: Record<string, unknown>,
  ): void => {
    void insertAuditLog({
      user_name: operatorEmail,
      user_role: 'payroll_clerk',
      action: 'paystubs.dispatched',
      resource: 'dispatch_paystubs',
      resource_id: null,
      details: {
        success,
        employee_count: employees.length,
        pay_period: payPeriod,
        cycle: cycle,
        ...extra,
      },
    });
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      writeAudit(false, {
        http_status: res.status,
        n8n_error_excerpt: text.slice(0, 500),
      });
      return NextResponse.json(
        { error: `n8n webhook returned ${res.status}`, detail: text },
        { status: 502 },
      );
    }
    writeAudit(true, { http_status: res.status });
    return NextResponse.json({ ok: true, n8n: safeParse(text) });
  } catch (err) {
    writeAudit(false, {
      transport_error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Failed to reach n8n', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
