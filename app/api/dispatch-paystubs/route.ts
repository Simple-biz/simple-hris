import { NextRequest, NextResponse } from 'next/server';
import { resolveWebhookUrl } from '@/lib/webhooks/resolve-webhook';

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
 */
export async function POST(req: NextRequest) {
  const webhookUrl = await resolveWebhookUrl('paystub_dispatch', {
    envVars: ['N8N_DISPATCH_WEBHOOK_URL'],
  });
  if (!webhookUrl) {
    return NextResponse.json(
      { error: 'No paystub_dispatch webhook configured (Admin → Webhooks) and N8N_DISPATCH_WEBHOOK_URL env var unset' },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json(
        { error: `n8n webhook returned ${res.status}`, detail: text },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, n8n: safeParse(text) });
  } catch (err) {
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
