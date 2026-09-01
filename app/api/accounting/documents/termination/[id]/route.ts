import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import {
  getTerminationDocumentById,
  signedUrlForTerminationDocument,
} from '@/lib/documents/termination/termination-log';
import type { TerminationFileResponse } from '@/lib/documents/termination/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * [TERMINATION-DOCS] Download one generated termination letter.
 *
 *   GET → { url } — a 3600 s signed URL for the stored PDF.
 *
 * `view`: reading back a document the rep already generated is not a mutation.
 *
 * An id that does not exist returns **404, not 403** — the same defence as
 * `app/api/employee/documents/[id]/route.ts:44`. A 403 on a real id and a 404 on
 * a fake one would turn this endpoint into an existence oracle for termination
 * records.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ url: null, error: 'Missing id' } as TerminationFileResponse, { status: 400 });
  }

  const { row, error } = await getTerminationDocumentById(id);
  if (error) {
    return NextResponse.json({ url: null, error } as TerminationFileResponse, { status: 500 });
  }
  if (!row) {
    return NextResponse.json(
      { url: null, error: 'Document not found' } as TerminationFileResponse,
      { status: 404 },
    );
  }

  const { url, error: urlErr } = await signedUrlForTerminationDocument(row);
  if (urlErr || !url) {
    return NextResponse.json(
      { url: null, error: urlErr ?? 'No file' } as TerminationFileResponse,
      { status: 404 },
    );
  }
  return NextResponse.json({ url } as TerminationFileResponse);
}
