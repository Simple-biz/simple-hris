import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { resolveCoeFacts } from '@/lib/documents/coe-facts';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { decideCoeActiveGate } from '@/lib/documents/coe-admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Generate COE — the read-only facts card for one
 * picked employee, the same card the employee sees on their own request form
 * (`/api/employee/documents/coe-preview`), resolved by the same
 * `resolveCoeFacts` so the two can never disagree.
 *
 *   GET ?email=<work email>
 *     200 → { facts }
 *     422 → { blocked, code } — the certificate can't be issued (message is
 *           employee-readable; the gate's not_active/not_on_gml arms land here
 *           too, since the population rule is part of "can this be issued")
 *
 * Gated at `edit`: only reps who can generate need the full rate readout, and
 * the ACTIVE-GML gate is judged here as well as at generate time so the rep
 * learns about a refusal before clicking, not after.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  const email = normEmail(req.nextUrl.searchParams.get('email') ?? '');
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  // The population rule, fail closed — never resolve facts (which include the
  // person's rate) for someone the rule refuses.
  const gml = await fetchGmlStatusMap();
  const gate = decideCoeActiveGate({ status: gml.map.get(email), statusError: gml.error });
  if (!gate.ok) {
    const { status, code, message } = gate.rejection;
    if (status === 422) return NextResponse.json({ blocked: message, code }, { status });
    return NextResponse.json({ error: message }, { status });
  }

  const { facts, blocked, error } = await resolveCoeFacts(email);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (blocked) return NextResponse.json({ blocked: blocked.message, code: blocked.code }, { status: 422 });
  return NextResponse.json({ facts });
}
