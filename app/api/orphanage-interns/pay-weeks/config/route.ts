import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getAppSetting, upsertAppSetting } from '@/lib/supabase/app-settings';
import { INTERN_CONFIG_KEY, parseInternConfig, serializeInternConfig, type InternConfig } from '@/lib/interns/intern-config';
import type { InternShareMode } from '@/lib/interns/intern-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 *  GET  /api/orphanage-interns/pay-weeks/config  → { shareMode }
 *  POST /api/orphanage-interns/pay-weeks/config  { shareMode: 'system_split' | 'intern_remits' | null }
 *
 * The interns' one setting — how the orphanage share is paid (Q2, Ellie/Ralph).
 * Set by Accounting (payroll_wizard edit); readable by the Orphanage dashboard
 * so the mini wizard can say WHY Lock in is refused. Until it is set, no intern
 * week can be locked. The PAB rule is fixed in code and not here.
 */
export async function GET() {
  const acct = await requireFeatureAccess('accounting', 'payroll_wizard', 'view');
  if (!acct.ok) {
    const orph = await requireFeatureAccess('orphanage', 'interns', 'view');
    if (!orph.ok) return deniedResponse(acct);
  }
  const raw = await getAppSetting(INTERN_CONFIG_KEY);
  return NextResponse.json({ config: parseInternConfig(raw), error: null });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let body: { shareMode?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const m = body.shareMode;
  if (m !== null && m !== 'system_split' && m !== 'intern_remits') {
    return NextResponse.json({ error: "shareMode must be 'system_split', 'intern_remits' or null" }, { status: 400 });
  }

  const before = parseInternConfig(await getAppSetting(INTERN_CONFIG_KEY));
  const next: InternConfig = { shareMode: m as InternShareMode | null };
  const { error } = await upsertAppSetting(INTERN_CONFIG_KEY, serializeInternConfig(next));
  if (error) return NextResponse.json({ error }, { status: 500 });

  const actor = await getSessionActor();
  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_interns.config_changed',
    resource: 'app_settings',
    resource_id: INTERN_CONFIG_KEY,
    details: { before, after: next },
  });
  return NextResponse.json({ config: next, error: null });
}
