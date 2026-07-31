import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import {
  deleteDocumentRequest,
  getDocumentRequestById,
  signedUrlForDocumentFile,
} from '@/lib/documents/requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One of the caller's OWN document requests.
 *
 *   GET ?which=original|signed → { url } short-lived download URL.
 *   DELETE                     → remove it: cancels a pending request, or
 *                                deletes a decided one from their list. Both
 *                                drop the row and the stored files; the
 *                                audit_log keeps the record.
 */

async function sessionEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  return email || null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { row, error } = await getDocumentRequestById(id);
  if (error) return NextResponse.json({ error }, { status: 500 });
  if (!row || row.employee_email.trim().toLowerCase() !== email) {
    // 404 (not 403) so request ids can't be probed for existence.
    return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  }

  const which = req.nextUrl.searchParams.get('which') === 'signed' ? 'signed' : 'original';
  const { url, error: urlErr } = await signedUrlForDocumentFile(row, which);
  if (urlErr || !url) return NextResponse.json({ error: urlErr ?? 'No file' }, { status: 404 });
  return NextResponse.json({ url });
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { id } = await context.params;
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await deleteDocumentRequest(id, email, { requireOwner: true });
  if (error) {
    const code = error === 'Request not found' ? 404
      : error.includes('Not authorized') ? 403
      : 500;
    return NextResponse.json({ error }, { status: code });
  }
  return NextResponse.json({ success: true });
}
