import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { getEmployeeMasterRecord } from '@/lib/supabase/employees';
import {
  createDocumentRequest,
  listDocumentRequests,
} from '@/lib/documents/requests';
import { MAX_DOCUMENT_BYTES, isDocumentRequestType } from '@/lib/documents/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Employee self-serve document requests (Profile → Request Documents). Always
 * scoped to the CALLER's own session email — never a query param — mirroring
 * /api/employee/paystub.
 *
 *   GET  → { rows } the caller's own requests, newest first.
 *   POST → multipart { file, document_type, period_label?, note? } — submit a
 *          PDF for Accounting to sign. Lands `pending` in Accounting → Documents.
 */

async function sessionEmail(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  const email = (session?.user as { email?: string | null } | undefined)?.email
    ?.trim()
    .toLowerCase();
  return email || null;
}

export async function GET() {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { rows, error } = await listDocumentRequests({ email });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ rows });
}

export async function POST(req: NextRequest) {
  const email = await sessionEmail();
  if (!email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const documentType = String(form.get('document_type') ?? '').trim();
    const periodLabel = String(form.get('period_label') ?? '').trim() || null;
    const note = String(form.get('note') ?? '').trim() || null;

    if (!file) return NextResponse.json({ error: 'Attach a PDF to submit' }, { status: 400 });
    if (!isDocumentRequestType(documentType)) {
      return NextResponse.json({ error: 'Choose a document type' }, { status: 400 });
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      return NextResponse.json({ error: 'Max 10 MB per document' }, { status: 400 });
    }
    if (note && note.length > 2000) {
      return NextResponse.json({ error: 'Note is too long (max 2000 characters)' }, { status: 400 });
    }

    // Display name from the master list — never trusted from the client.
    const { employee: master } = await getEmployeeMasterRecord(email);

    const { row, error } = await createDocumentRequest({
      employee_email: email,
      employee_name: master?.name ?? null,
      document_type: documentType,
      period_label: periodLabel,
      note,
      file_name: file.name || null,
      bytes: await file.arrayBuffer(),
    });
    if (error || !row) return NextResponse.json({ error: error ?? 'Submit failed' }, { status: 400 });
    return NextResponse.json({ row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
