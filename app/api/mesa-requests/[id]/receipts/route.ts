// Receipts attached to a MESA disbursement request.
//
//   GET    /api/mesa-requests/[id]/receipts        → list + short-lived signed URLs
//   POST   /api/mesa-requests/[id]/receipts        → attach one file (multipart `file`)
//   DELETE /api/mesa-requests/[id]/receipts?receipt_id=…
//
// Authorization is the parent request's owner OR an elevated role (the same gate
// as GET /api/mesa-requests?email=…): the member who filed the disbursement
// manages its receipts, and Accounting reads them to confirm the request was
// legitimate. `uploaded_by` records which of the two actually uploaded.
//
// One file per POST, deliberately: three 5 MB parts in a single body would sit
// past the serverless request-body limit, and per-file responses let the dialog
// show "Uploading 2 of 3" and survive one failure without losing the others.

import { NextResponse } from 'next/server';
import { createSupabaseServiceRoleClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { getSessionActor } from '@/lib/auth/session-actor';
import { authorizeEmailAccess, deniedResponse } from '@/lib/auth/authorize-email';
import {
  createMesaReceipt,
  deleteMesaReceipt,
  listMesaReceiptsWithUrls,
} from '@/lib/mesa/receipts';
import { MAX_MESA_RECEIPT_BYTES } from '@/lib/mesa/receipt-types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TABLE = 'mesa_requests';

interface ParentRequest {
  id: string;
  work_email: string;
  request_type: string;
  status: string;
}

/** Load the parent request, or the error response to return instead. Its
 *  work_email is what the caller is authorized against, so this always runs
 *  before anything else. */
async function loadParent(id: string): Promise<ParentRequest | NextResponse> {
  const supabase = createSupabaseServiceRoleClient() ?? createSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: 'DB unavailable' }, { status: 500 });

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, work_email, request_type, status')
    .eq('id', id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
  return data as ParentRequest;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const parent = await loadParent(id);
    if (parent instanceof NextResponse) return parent;

    const authz = await authorizeEmailAccess(parent.work_email);
    if (!authz.ok) return deniedResponse(authz);

    const { rows, error } = await listMesaReceiptsWithUrls(id);
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ rows: [], error: String(e) }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const parent = await loadParent(id);
    if (parent instanceof NextResponse) return parent;

    const authz = await authorizeEmailAccess(parent.work_email);
    if (!authz.ok) return deniedResponse(authz);

    // Receipts exist to substantiate money that left the fund. Nothing else has
    // one to show, so the column stays single-purpose.
    if (parent.request_type !== 'disbursement') {
      return NextResponse.json(
        { error: 'Only a disbursement request can carry a receipt.' },
        { status: 400 },
      );
    }
    if (parent.status === 'denied') {
      return NextResponse.json(
        { error: 'This request was denied — no funds were released, so there is nothing to receipt.' },
        { status: 409 },
      );
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file was received.' }, { status: 400 });
    }
    // Cheap pre-check on the declared size before buffering the whole thing; the
    // real gate is the byte length inside createMesaReceipt.
    if (file.size > MAX_MESA_RECEIPT_BYTES) {
      return NextResponse.json({ error: 'Each receipt must be 5 MB or smaller.' }, { status: 400 });
    }

    const actor = await getSessionActor();
    const { row, error, status } = await createMesaReceipt({
      request_id: id,
      work_email: parent.work_email,
      uploaded_by: authz.sessionEmail,
      bytes: await file.arrayBuffer(),
      file_name: file.name,
      actor,
    });
    if (error || !row) {
      return NextResponse.json({ error: error ?? 'Upload failed' }, { status: status ?? 500 });
    }

    // Return the full, freshly-signed list so the dialog re-renders from server
    // truth rather than appending an optimistic row.
    const { rows } = await listMesaReceiptsWithUrls(id);
    return NextResponse.json({ success: true, receipt: row, rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const receiptId = new URL(request.url).searchParams.get('receipt_id')?.trim();
    if (!receiptId) return NextResponse.json({ error: 'receipt_id is required' }, { status: 400 });

    const parent = await loadParent(id);
    if (parent instanceof NextResponse) return parent;

    const authz = await authorizeEmailAccess(parent.work_email);
    if (!authz.ok) return deniedResponse(authz);

    const actor = await getSessionActor();
    const { error, status } = await deleteMesaReceipt({
      id: receiptId,
      request_id: id,
      actor,
    });
    if (error) return NextResponse.json({ error }, { status: status ?? 500 });

    const { rows } = await listMesaReceiptsWithUrls(id);
    return NextResponse.json({ success: true, rows });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
