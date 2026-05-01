import { NextResponse } from 'next/server';
import {
  createOrphanageManagerSubmittedDispute,
  isOrphanageStyleReason,
} from '@/lib/supabase/pab-day-disputes';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bulk-creates Orphanage Visit / CEO Visitation disputes on behalf of a list of employees.
 * Used by Alyson's Orphanage view ("+ Create disputes") and by Carla's Accounting view —
 * the underlying server function checks the actor's role and tags the audit log accordingly.
 * Rows land at `orphanage_manager_approved` so Carla can give the final Accounting decision
 * in one click.
 */
export async function POST(request: Request) {
  try {
    const authz = await requireElevatedSession();
    if (!authz.ok) return deniedResponse(authz);

    const body = (await request.json()) as {
      reason?: string;
      dispute_date?: string;
      employee_emails?: string[];
      explanation?: string | null;
    };

    const reason = body.reason?.trim() ?? '';
    if (!isOrphanageStyleReason(reason)) {
      return NextResponse.json(
        { error: 'reason must be orphanage_visit or ceo_visitation' },
        { status: 400 },
      );
    }

    const dispute_date = body.dispute_date?.trim() ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dispute_date)) {
      return NextResponse.json({ error: 'dispute_date must be YYYY-MM-DD' }, { status: 400 });
    }

    const emails = Array.isArray(body.employee_emails)
      ? body.employee_emails.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
      : [];
    if (emails.length === 0) {
      return NextResponse.json({ error: 'employee_emails must be a non-empty array' }, { status: 400 });
    }

    const result = await createOrphanageManagerSubmittedDispute({
      reason: reason as 'orphanage_visit' | 'ceo_visitation',
      dispute_date,
      employee_emails: emails,
      explanation: body.explanation,
      submitted_by: authz.sessionEmail,
    });

    if (result.forbidden) {
      return NextResponse.json({ error: result.errorMessage ?? 'Forbidden' }, { status: 403 });
    }
    if (result.errorMessage) {
      return NextResponse.json({ error: result.errorMessage }, { status: 400 });
    }

    return NextResponse.json({
      created: result.created,
      skipped: result.skipped,
      errors: result.errors,
      error: null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
