import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { decideCoeActiveGate } from '@/lib/documents/coe-admin';
import { ADDRESS_LETTER_GATE_WORDING } from '@/lib/documents/address-letter';
import { resolveAddressLetterFacts } from '@/lib/documents/address-letter-facts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Proof of Address — what the letter will state for one
 * picked worker, and which address fields the records leave blank for the rep.
 *
 *   GET ?email=<work email>
 *     200 → { facts }          facts.blanks lists the fields the rep must type
 *     422 → { blocked, code }  can't be issued: the active-GML gate, or a missing
 *                              name / start date / team
 *
 * Gated at `edit`, like Generate COE's preview: only reps who can issue the letter
 * need a worker's home address. The active gate runs BEFORE any address is read,
 * and again at generate time — never trusted from the picker.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  const email = normEmail(req.nextUrl.searchParams.get('email') ?? '');
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  const gml = await fetchGmlStatusMap();
  const gate = decideCoeActiveGate({
    status: gml.map.get(email),
    statusError: gml.error,
    wording: ADDRESS_LETTER_GATE_WORDING,
  });
  if (!gate.ok) {
    const { status, code, message } = gate.rejection;
    if (status === 422) return NextResponse.json({ blocked: message, code }, { status });
    return NextResponse.json({ error: message }, { status });
  }

  const { facts, blocked, error } = await resolveAddressLetterFacts(email);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (blocked) return NextResponse.json({ blocked: blocked.message, code: blocked.code }, { status: 422 });
  return NextResponse.json({ facts });
}
