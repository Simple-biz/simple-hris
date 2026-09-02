import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { getSessionActor } from '@/lib/auth/session-actor';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { addInternRate, getInternById } from '@/lib/supabase/orphanage-interns-db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/orphanage-interns/{id}/rates  { rate_php, effective_from }
 *
 * Appends a DATED rate. History is never edited: a rate is a fact about a day
 * (memory: rate-updated-at-not-evidence), and every week prices with the rate
 * in force on each of its days. Orphanage-dashboard writers only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEdit('orphanage', 'interns');
  if (!authz.ok) return deniedResponse(authz);
  const { id } = await params;

  let body: { rate_php?: unknown; effective_from?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const ratePhp = Number(body.rate_php);
  const from = typeof body.effective_from === 'string' ? body.effective_from.trim() : '';
  if (!(ratePhp > 0)) return NextResponse.json({ error: 'rate_php must be positive' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return NextResponse.json({ error: 'effective_from must be YYYY-MM-DD' }, { status: 400 });

  const { intern, error: getErr } = await getInternById(id);
  if (getErr) return NextResponse.json({ error: getErr }, { status: 500 });
  if (!intern) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const actor = await getSessionActor();
  const { rate, error } = await addInternRate(id, ratePhp, from, actor.user_name !== 'anonymous' ? actor.user_name : null);
  if (error || !rate) {
    const dup = /duplicate key|unique/i.test(error ?? '');
    return NextResponse.json({ error: dup ? `A rate already starts on ${from}. Pick a different effective date.` : error ?? 'Could not add rate' }, { status: dup ? 409 : 500 });
  }

  void insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'orphanage_intern_rate.added',
    resource: 'orphanage_intern_rates',
    resource_id: rate.id,
    details: { intern_id: id, email: intern.email, rate_php: ratePhp, effective_from: from },
  });
  return NextResponse.json({ rate, error: null }, { status: 201 });
}
