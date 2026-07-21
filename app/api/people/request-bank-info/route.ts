import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { normEmail } from '@/lib/email/norm-email';
import { sendBankInfoNotifyEmails } from '@/lib/people/bank-info-notify';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  /** A single recipient work email. */
  recipient_email?: string;
  /** Or a batch — used by the "Notify everyone" action in the modal. */
  emails?: string[];
  /** Optional { email, name } list, purely to personalise the email greeting
   *  ("Hi Ana," vs "Hi there,"). Never used to decide WHO gets notified — the
   *  recipient set is always derived from `emails` / `recipient_email` below. */
  recipients?: { email?: string | null; name?: string | null }[];
}

/**
 * Ask one or more employees to add their missing bank / payout details. Fired
 * from the People tab's "Missing bank info" modal (Notify button). Drops each
 * recipient a `bank_info.requested` notification, which makes their employee
 * dashboard blink the Profile → Payment section until they fill it in.
 *
 * Edit access to the `people` feature is required (accounting OR ceo OR admin) —
 * the same gate the special-transfer action uses. Best-effort per recipient: a
 * failed insert for one person doesn't fail the whole batch.
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

  // Collect + normalise + dedupe the recipient list from either shape, keeping
  // only well-formed addresses (normEmail just trims/lowercases — it doesn't
  // validate). This drops junk before it becomes rows in a table with no FK.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Aligned with Gmail's ~2,000/day send limit; the notify webhook sends these in
  // throttled batches (see references/n8n/bank-info-missing-notify.workflow.json).
  const MAX_RECIPIENTS = 2000;
  const raw = [
    ...(Array.isArray(body.emails) ? body.emails : []),
    ...(body.recipient_email ? [body.recipient_email] : []),
  ];
  const emails = Array.from(
    new Set(raw.map((e) => normEmail(e ?? '')).filter((e): e is string => !!e && EMAIL_RE.test(e))),
  );
  if (emails.length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid recipient email(s) provided.' }, { status: 400 });
  }
  if (emails.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      { ok: false, error: `Too many recipients (${emails.length}; max ${MAX_RECIPIENTS} per run). Notify in smaller groups.` },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: 'Database is not reachable.' }, { status: 500 });
  }

  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    actor = await getSessionActor();
  } catch { /* best-effort */ }

  const nowIso = new Date().toISOString();
  const payload = {
    type: 'bank_info.requested' as const,
    tone: 'neutral' as const,
    title: 'Add your bank / payout details',
    message:
      'We don’t have a way to pay you yet. Please open your Profile and add your bank / payout details under Payment so payroll can send your pay.',
    details: { requested_by: actor.user_name, via: 'people_tab' },
  };

  // One fresh nudge per person WITHOUT a delete window (a delete-then-insert can
  // momentarily show zero rows to the recipient's live subscription, flickering
  // their escalation off). Refresh any existing request in place; insert only for
  // people who don't have one yet. Re-surfaces as unread (read_at = null).
  let existing: string[] = [];
  try {
    const { data } = await supabase
      .from('employee_notifications')
      .select('recipient_email')
      .in('recipient_email', emails)
      .eq('type', 'bank_info.requested');
    existing = Array.from(
      new Set(
        ((data ?? []) as { recipient_email: string | null }[])
          .map((r) => (r.recipient_email ?? '').trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  } catch { /* fall back to insert-only below */ }

  const toInsert = emails.filter((e) => !existing.includes(e));

  if (existing.length > 0) {
    const { error: updErr } = await supabase
      .from('employee_notifications')
      .update({ ...payload, read_at: null, created_at: nowIso })
      .in('recipient_email', existing)
      .eq('type', 'bank_info.requested');
    if (updErr) {
      return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
    }
  }

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase
      .from('employee_notifications')
      .insert(toInsert.map((to) => ({ recipient_email: to, ...payload })));
    if (insErr) {
      return NextResponse.json({ ok: false, error: insErr.message }, { status: 500 });
    }
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'people.bank_info.requested',
    resource: 'employee_notifications',
    resource_id: null,
    details: { recipients: emails, count: emails.length },
  });

  // Best-effort red-alarm email on top of the in-app nudge above (which is the
  // guaranteed part). Personalise the greeting from any { email, name } the
  // caller passed; unknown names fall back to a generic greeting in n8n. A
  // webhook failure/timeout must never fail the request, so errors are swallowed
  // and we just report how many the email webhook accepted. No-ops (emailed: 0)
  // until the `bank_info_notify` webhook is configured in Admin -> Webhooks.
  const nameByEmail = new Map<string, string>();
  for (const r of Array.isArray(body.recipients) ? body.recipients : []) {
    const e = normEmail(r?.email ?? '');
    const n = (r?.name ?? '').trim();
    if (e && n && !nameByEmail.has(e)) nameByEmail.set(e, n);
  }
  let emailed = 0;
  try {
    const sendResult = await sendBankInfoNotifyEmails(
      emails.map((e) => ({ email: e, name: nameByEmail.get(e) ?? null })),
    );
    emailed = sendResult.sent;
  } catch {
    /* best-effort — the in-app notification already succeeded */
  }

  return NextResponse.json({ ok: true, error: null, notified: emails.length, emailed });
}
