import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { normEmail } from '@/lib/email/norm-email';
import { fetchGmlStatusMap } from '@/lib/roster/gml-status';
import { decideCoeActiveGate } from '@/lib/documents/coe-admin';
import { getDocumentSignature } from '@/lib/documents/signatures';
import {
  createCoeDocumentRequest,
  listDocumentRequests,
  signDocumentRequest,
} from '@/lib/documents/requests';
import type { DocumentRequestRow } from '@/lib/documents/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Accounting → Documents → Generate COE — generate AND sign in one action.
 *
 *   POST { work_email }
 *     200 → { row, sign_error: null }            generated and signed
 *     200 → { row, sign_error }                  generated, sign step failed —
 *           the pending row sits in the queue and the normal Approve path
 *           finishes it (that degradation is the design, not a bug)
 *     409 → { error, pending_id }                a pending COE already exists
 *     412 → { error }                            no active signature — checked
 *           BEFORE any row is created, so a signature-less rep never mints a
 *           pending row they then can't sign; the UI steers into the capture
 *           dialog exactly like the Approve path's 412
 *     422 → { blocked, code }                    the certificate can't be
 *           issued: resolveCoeFacts refusals AND the active-GML gate
 *
 * Delivery needs nothing new: the row is an ordinary `document_requests` COE
 * row, so the signed copy lands in the employee's Profile → Request Documents
 * with the `documents.signed` notification. The audit entry names the ADMIN
 * (`generated_for` carries the employee) and the accounting self-ping is
 * suppressed — see createCoeDocumentRequest.
 *
 * Population rule (Kane 2026-09-01): ACTIVE Global Master List people only,
 * re-judged HERE against the live status map — never trusted from what the
 * picker showed minutes earlier — and failing CLOSED on every non-active arm.
 */
export async function POST(req: NextRequest) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  try {
    const body = (await req.json().catch(() => ({}))) as { work_email?: string };
    const email = normEmail(body.work_email ?? '');
    if (!email) return NextResponse.json({ error: 'work_email is required' }, { status: 400 });

    // ── The population rule, fail closed ────────────────────────────────────
    const gml = await fetchGmlStatusMap();
    const gate = decideCoeActiveGate({ status: gml.map.get(email), statusError: gml.error });
    if (!gate.ok) {
      const { status, code, message } = gate.rejection;
      if (status === 422) return NextResponse.json({ blocked: message, code }, { status });
      return NextResponse.json({ error: message }, { status });
    }

    // ── One pending COE per person ──────────────────────────────────────────
    // The employee may already have filed one (or another rep generated it);
    // minting a second would put two live certificates in the queue.
    const { rows: pending, error: pendingErr } = await listDocumentRequests({
      email,
      status: 'pending',
    });
    if (pendingErr) return NextResponse.json({ error: pendingErr }, { status: 500 });
    const existing = pending.find((r) => r.document_type === 'coe');
    if (existing) {
      return NextResponse.json(
        {
          error: 'A pending COE request already exists for this employee — approve or reject that one instead of generating a second.',
          pending_id: existing.id,
        },
        { status: 409 },
      );
    }

    // ── Signature gate, BEFORE any row exists ───────────────────────────────
    // Same 412 semantics as the Approve path ([id]/route.ts): the UI steers
    // into the signature-capture dialog. Checking first means a rep with no
    // signature never creates a pending row as a side effect of a refused sign.
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

    // ── Generate (as the ADMIN, with the disclosure note) ───────────────────
    const created = await createCoeDocumentRequest({
      employee_email: email,
      note: 'Issued by Accounting on behalf of the employee.',
      actor: { email: authz.sessionEmail },
      notifyAccounting: false,
    });
    if (created.blocked) {
      return NextResponse.json({ blocked: created.blocked, code: 'facts' }, { status: 422 });
    }
    if (created.error || !created.row) {
      return NextResponse.json({ error: created.error ?? 'Could not generate the certificate' }, { status: 500 });
    }

    // ── Sign — the session rep's own signature, via the one shared path ─────
    // A failure past this point is returned WITH the row, never as a bare
    // error: the pending row is real, visible in the queue, and finishable by
    // the ordinary Approve button, so telling the rep "it failed" outright
    // would hide a certificate that exists.
    const signed = await signDocumentRequest(created.row.id, authz.sessionEmail);
    const row: DocumentRequestRow = signed.row ?? created.row;
    return NextResponse.json({ row, sign_error: signed.row ? null : (signed.error ?? 'Signing failed') });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
