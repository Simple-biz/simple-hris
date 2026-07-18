import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess, requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import {
  getDocumentRequestById,
  rejectDocumentRequest,
  signDocumentRequest,
  signedUrlForDocumentFile,
} from '@/lib/documents/requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One document request, from the Accounting → Documents tab.
 *
 *   GET   ?which=original|signed        → { url } preview/download URL (view).
 *   PATCH { action: 'sign' | 'reject', note? } → decide (edit).
 *
 * Signing stamps the CALLER's own saved signature (document_signatures row,
 * which must be enabled) into the PDF and notifies the employee.
 */

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { row, error } = await getDocumentRequestById(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

  const which = req.nextUrl.searchParams.get('which') === 'signed' ? 'signed' : 'original';
  const { url, error: urlErr } = await signedUrlForDocumentFile(row, which);
  if (urlErr || !url) return NextResponse.json({ error: urlErr ?? 'No file' }, { status: 404 });
  return NextResponse.json({ url });
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureEdit('accounting', 'documents');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; note?: string | null };
    if (body.action !== 'sign' && body.action !== 'reject') {
      return NextResponse.json({ error: 'action must be sign or reject' }, { status: 400 });
    }
    if (body.action === 'reject' && !(body.note ?? '').toString().trim()) {
      return NextResponse.json({ error: 'A short reason is required to reject' }, { status: 400 });
    }

    const { row, error } = body.action === 'sign'
      ? await signDocumentRequest(id, authz.sessionEmail)
      : await rejectDocumentRequest(id, authz.sessionEmail, body.note);

    if (error || !row) {
      const msg = error ?? 'Decision failed';
      const code = msg === 'Request not found' ? 404
        : msg.includes('no longer pending') || msg.includes('decided by someone else') ? 409
        : msg.includes('No saved signature') || msg.includes('switched off') ? 412
        : 500;
      return NextResponse.json({ error: msg }, { status: code });
    }
    return NextResponse.json({ row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
