import { NextResponse } from 'next/server';
import {
  authorizeEmailAccess,
  deniedResponse,
  requireElevatedSession,
} from '@/lib/auth/authorize-email';
import {
  listBankPreferredRequests,
  getLatestBankPreferredRequest,
  isBankPreferredRequestsMissing,
  type BankPreferredRequestStatus,
} from '@/lib/supabase/bank-preferred-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const STATUSES: BankPreferredRequestStatus[] = ['pending', 'approved', 'denied', 'superseded'];

// GET /api/bank-preferred-requests
//   ?email=xxx   => the employee's OWN latest request  (authorizeEmailAccess)
//   (no email)   => accounting listing all             (requireElevatedSession)
//   optional ?status=pending on the accounting listing.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email') ?? undefined;
    const statusParam = searchParams.get('status') ?? undefined;
    const status =
      statusParam && (STATUSES as string[]).includes(statusParam)
        ? (statusParam as BankPreferredRequestStatus)
        : undefined;

    const authz = email
      ? await authorizeEmailAccess(email)
      : await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    // Employee self-view.
    if (email && authz.ok) {
      const { row, error } = await getLatestBankPreferredRequest(authz.effectiveEmail);
      // Pre-migration: no table yet → just no pending badge, not an error.
      if (error && isBankPreferredRequestsMissing(error)) return NextResponse.json({ rows: [] });
      if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
      // The latest row is all the Payment-tab badge needs; return it as a
      // one-element array for a stable response shape.
      return NextResponse.json({ rows: row ? [row] : [] });
    }

    // Accounting listing.
    const { rows, error } = await listBankPreferredRequests({ status });
    // Pre-migration: no table yet → empty queue, not an error banner.
    if (error && isBankPreferredRequestsMissing(error)) return NextResponse.json({ rows: [] });
    if (error) return NextResponse.json({ rows: [], error }, { status: 500 });
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ rows: [], error: String(e) }, { status: 500 });
  }
}
