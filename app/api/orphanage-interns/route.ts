import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  addInternRate,
  createIntern,
  listInterns,
  validateInternProfile,
  type InternProfileInput,
} from '@/lib/supabase/orphanage-interns-db';
import type { OrphanageInternRateRow } from '@/lib/interns/intern-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Orphanage intern profiles. The ONLY writers of intern personal + bank data
 * (Kane 2026-09-02: "all personal data changes even banks will be done at the
 * Orphanage Dashboard") — gated on the orphanage view's `interns` feature.
 * Accounting reads through /api/orphanage-interns/pay-weeks/* only.
 *
 *  GET  /api/orphanage-interns[?includeEnded=1]  → list (account masked to last 4)
 *  POST /api/orphanage-interns                    → create; optional first rate
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('orphanage', 'interns', 'view');
  if (!authz.ok) return deniedResponse(authz);
  const includeEnded = req.nextUrl.searchParams.get('includeEnded') === '1';
  const { items, error } = await listInterns({ includeEnded });
  if (error) return NextResponse.json({ items: [], error }, { status: 500 });
  return NextResponse.json({ items, error: null });
}

export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const input = body as unknown as InternProfileInput;
  const invalid = validateInternProfile(input, true);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const ratePhp = body.rate_php == null || body.rate_php === '' ? null : Number(body.rate_php);
  const rateFrom = typeof body.rate_effective_from === 'string' ? body.rate_effective_from.trim() : '';
  if (ratePhp != null && !(ratePhp > 0)) return NextResponse.json({ error: 'rate_php must be positive' }, { status: 400 });
  if (ratePhp != null && !/^\d{4}-\d{2}-\d{2}$/.test(rateFrom)) {
    return NextResponse.json({ error: 'rate_effective_from (YYYY-MM-DD) is required with rate_php' }, { status: 400 });
  }

  const actor = await getSessionActor();
  const by = actor.user_name !== 'anonymous' ? actor.user_name : null;
  const { intern, error } = await createIntern(input, by);
  if (error || !intern) {
    const dup = /duplicate key|unique/i.test(error ?? '');
    return NextResponse.json({ error: dup ? 'An intern with this email already exists.' : error ?? 'Create failed' }, { status: dup ? 409 : 500 });
  }

  let rate: OrphanageInternRateRow | null = null;
  if (ratePhp != null) {
    const r = await addInternRate(intern.id, ratePhp, rateFrom, by);
    if (r.error) return NextResponse.json({ intern, rate: null, error: `Profile saved but the rate was not: ${r.error}` }, { status: 500 });
    rate = r.rate;
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern.saved',
    resource: 'orphanage_interns',
    resource_id: intern.id,
    details: { created: true, email: intern.email, full_name: intern.full_name, status: intern.status, rate_php: ratePhp, rate_effective_from: ratePhp != null ? rateFrom : null },
  });

  return NextResponse.json({ intern, rate, error: null }, { status: 201 });
}
