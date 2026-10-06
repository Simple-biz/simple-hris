import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { decideCoeActiveGate } from '@/lib/documents/coe-admin';
import { getDocumentSignature } from '@/lib/documents/signatures';
import { ADDRESS_LETTER_GATE_WORDING, applyLetterFills } from '@/lib/documents/address-letter';
import { resolveAddressLetterFacts } from '@/lib/documents/address-letter-facts';
import { createSignedAddressLetter } from '@/lib/documents/requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Proof of Address — issue a SIGNED Proof of Residential
 * Address letter in one call (docs/features/proof-of-address-letter.md).
 *
 *   POST { work_email, fills? }   fills = the blank box fields the rep typed
 *     200 → { row }                 issued and signed; reaches the worker's profile
 *     400 → { error }               a fill touched an on-file field, was invalid,
 *                                   or a field is still blank
 *     412 → { error }               no active signature — checked BEFORE any work;
 *                                   the UI steers into the capture dialog
 *     422 → { blocked, code }       the active-GML gate, or name / start / team missing
 *     503 → { error, code }         the 'address' type migration has not run yet
 *
 * Refusal order (don't reorder): active gate → signature → facts → fills → create.
 * Carla's rule: only Accounting creates this letter. The employee route never
 * accepts `address` (EMPLOYEE_REQUEST_TYPES).
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await req.json().catch(() => ({}))) as { work_email?: string; fills?: unknown };
    const email = normEmail(body.work_email ?? '');
    if (!email) return NextResponse.json({ error: 'work_email is required' }, { status: 400 });

    // ── The population rule, fail closed ────────────────────────────────────
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

    // ── Signature gate, before any read of the address or any render ───────
    const { row: signature, error: sigErr } = await getDocumentSignature(authz.sessionEmail);
    if (sigErr) return NextResponse.json({ error: sigErr }, { status: 500 });
    if (!signature || !signature.enabled) {
      return NextResponse.json(
        {
          error: !signature
            ? 'No saved signature — draw and save your signature in the Documents tab first'
            : 'Your signature is switched off — turn it back on to sign documents',
        },
        { status: 412 },
      );
    }

    // ── Facts, re-resolved now — never trusted from the preview ─────────────
    const { facts, blocked, error: factsErr } = await resolveAddressLetterFacts(email);
    if (factsErr) return NextResponse.json({ error: factsErr }, { status: 500 });
    if (blocked) return NextResponse.json({ blocked: blocked.message, code: blocked.code }, { status: 422 });
    if (!facts) return NextResponse.json({ error: 'Could not resolve the letter details' }, { status: 500 });

    // ── The rep fills only what the records left blank ──────────────────────
    const merged = applyLetterFills(facts.address, body.fills);
    if (!merged.ok) return NextResponse.json({ error: merged.error }, { status: 400 });

    const created = await createSignedAddressLetter({
      facts,
      address: merged.address,
      typed: merged.typed,
      actorEmail: authz.sessionEmail,
    });
    if (created.code === 'no_signature') return NextResponse.json({ error: created.error }, { status: 412 });
    if (created.code === 'migration_pending') {
      return NextResponse.json({ error: created.error, code: created.code }, { status: 503 });
    }
    if (created.error || !created.row) {
      return NextResponse.json({ error: created.error ?? 'Could not issue the letter' }, { status: 500 });
    }
    return NextResponse.json({ row: created.row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
