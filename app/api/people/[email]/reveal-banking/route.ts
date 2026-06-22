import { NextResponse } from 'next/server';
import { requireRateVisibilitySession, deniedResponse } from '@/lib/auth/authorize-email';
import { getPeopleBanking } from '@/lib/people/people-banking';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Reveal a person's FULL (unmasked) payout details. Every reveal is recorded in
 * the audit log (who viewed whose banking, and when) — that audit trail is the
 * whole point of keeping this behind a deliberate action instead of returning
 * full numbers from the detail endpoint. Gated to RATE_VISIBLE_ROLES.
 */
export async function POST(
  _req: Request,
  context: { params: Promise<{ email: string }> },
) {
  const authz = await requireRateVisibilitySession();
  if (!authz.ok) return deniedResponse(authz);

  const { email: raw } = await context.params;
  const email = decodeURIComponent(raw ?? '').trim();
  if (!email) return NextResponse.json({ error: 'Missing email' }, { status: 400 });

  const { banking, error } = await getPeopleBanking(email, true);
  if (error) return NextResponse.json({ banking: null, error }, { status: 500 });

  let actor = { user_name: 'unknown', user_role: 'user' };
  try {
    actor = await getSessionActor();
  } catch { /* best-effort audit */ }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'people.banking.revealed',
    resource: 'employee_ids',
    resource_id: email,
    details: { revealed_for: email, processor: banking?.preferred_processor ?? null },
  });

  return NextResponse.json({ banking, error: null });
}
