import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { normEmail } from '@/lib/email/norm-email';
import {
  listSecondApprovalsForApprover,
  signTimeAdjustmentImageUrls,
} from '@/lib/supabase/time-adjustments';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET — the signed-in person's second-approver queue, for the EMPLOYEE portal.
 *
 * This is the read half of "the assignment IS the authorization" (Kane's ruling
 * 2026-08-27). A manager may now name any active member of the employee's own team as
 * second approver, and that person needs no Manager access: they review the request
 * here, in the portal they already use.
 *
 * Deliberately session-scoped with NO email parameter. There is nothing to authorize
 * beyond "who are you" precisely because the query itself is the authorization — it can
 * only ever return rows that name the caller. A person who has never been named gets an
 * empty list, which is exactly how the portal tab stays hidden for the whole company.
 *
 * This grants NOTHING else. It is a single read of one table filtered to the caller's
 * own assignments; leaves, transfers, offboarding, suspension and the rest of the
 * Manager dashboard remain gated by their own per-tab grants, which this caller does
 * not hold. See `docs/features/time-adjustment-requests.md`.
 *
 * Evidence images come back as short-lived signed URLs for these rows only — a reviewer
 * who cannot see the proof cannot judge the request. The read widens exactly as far as
 * the write does, and no further.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const sessionEmail = normEmail(
      (session?.user as { email?: string | null } | undefined)?.email ?? null,
    );
    if (!sessionEmail) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    }

    const { rows, error } = await listSecondApprovalsForApprover(sessionEmail);
    if (error) {
      return NextResponse.json({ rows: [], signedUrls: {}, pendingCount: 0, error }, { status: 500 });
    }

    // Rows still owed this person's signature — the sidebar badge, and the count that
    // decides whether the Approvals tab exists for them at all. Keyed on the DECISION,
    // not the status: a second approver may act while the row is still `pending`
    // because the manager has not gone first.
    const pendingCount = rows.filter(
      (r) =>
        r.second_decision == null &&
        (r.status === 'pending' || r.status === 'awaiting_second_approval'),
    ).length;

    // Signing evidence URLs costs a Storage round-trip per request, so the portal shell
    // (which only needs the count) asks without it and the tab itself asks with it.
    const wantsEvidence = new URL(request.url).searchParams.get('evidence') === '1';
    const signedUrls = wantsEvidence
      ? await signTimeAdjustmentImageUrls(rows.flatMap((r) => r.image_paths ?? []))
      : {};

    return NextResponse.json({
      rows,
      signedUrls,
      pendingCount,
      viewerEmail: sessionEmail,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ rows: [], signedUrls: {}, error: msg }, { status: 500 });
  }
}
