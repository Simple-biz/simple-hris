import { NextRequest, NextResponse } from 'next/server';
import { requireFeatureAccess } from '@/lib/auth/authorize-feature';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { listDocumentRequests } from '@/lib/documents/requests';
import type { DocumentRequestStatus } from '@/lib/documents/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: readonly DocumentRequestStatus[] = ['pending', 'signed', 'rejected'];

/**
 * Accounting → Documents queue.
 *   GET ?status=pending|signed|rejected → { rows } (all employees' requests).
 * Gated on the accounting `documents` feature (view). Admin bypasses.
 */
export async function GET(req: NextRequest) {
  const authz = await requireFeatureAccess('accounting', 'documents', 'view');
  if (!authz.ok) return deniedResponse(authz);

  const raw = req.nextUrl.searchParams.get('status')?.trim().toLowerCase() ?? '';
  const status = (STATUSES as readonly string[]).includes(raw)
    ? (raw as DocumentRequestStatus)
    : undefined;

  const { rows, error } = await listDocumentRequests({ status });
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ rows });
}
