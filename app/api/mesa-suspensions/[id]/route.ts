import { NextResponse } from 'next/server';
import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getMesaSuspension, resumeMesaSuspension } from '@/lib/supabase/mesa-suspensions';
import { MESA_SUSPENSIONS_NOT_SET_UP, checkResume, firstAffectedWeek } from '@/lib/mesa/suspension';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// PATCH /api/mesa-suspensions/[id]
// Body: { resumeOn: 'YYYY-MM-DD' }
//
// Resumes a suspended member: pay weeks whose FRIDAY deposit date is on/after
// `resumeOn` are charged ₱100 and deposited ₱400 again. Resuming ON the start
// date cancels the suspension (the window is empty, no week was skipped) —
// that is how a mistaken suspension is undone; nothing is ever deleted.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await requireFeatureEditAnyView('mesa');
  if (!authz.ok) return deniedResponse(authz);
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const body = (await request.json().catch(() => null)) as { resumeOn?: unknown } | null;
    if (!body) return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });

    const found = await getMesaSuspension(id);
    if (!found.ok) {
      return NextResponse.json(
        { error: `Could not read this suspension, so nothing was changed. (${found.error})` },
        { status: 503 },
      );
    }
    if (!found.available) return NextResponse.json({ error: MESA_SUSPENSIONS_NOT_SET_UP }, { status: 503 });
    if (!found.suspension) return NextResponse.json({ error: 'No such suspension' }, { status: 404 });
    // The member opted out since: the account is closed and this window is
    // inert. Resuming it would record a restart nothing will ever honour.
    if (found.accountClosedOn) {
      return NextResponse.json(
        {
          error: `Account ${found.suspension.accountNumber} was closed on ${found.accountClosedOn} (opted out); there is nothing to resume.`,
        },
        { status: 409 },
      );
    }

    const check = checkResume({ resumeOn: body.resumeOn, window: found.suspension });
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

    const written = await resumeMesaSuspension({ id, resumeOn: check.resumeOn, resumedBy: authz.sessionEmail });
    if (!written.ok) {
      if (written.conflict) return NextResponse.json({ error: written.error }, { status: 409 });
      return NextResponse.json({ error: written.error }, { status: 500 });
    }

    const cancelled = check.resumeOn === found.suspension.suspendedFrom;
    const firstWeek = firstAffectedWeek(check.resumeOn);
    await insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee.mesa.resume',
      resource: 'mesa_suspensions',
      resource_id: id,
      details: {
        roster_email: found.suspension.rosterEmail,
        account_email: found.suspension.email,
        mesa_account_number: found.suspension.accountNumber,
        suspended_from: found.suspension.suspendedFrom,
        resumed_on: check.resumeOn,
        // Resumed on its own start date: no week was ever skipped.
        cancelled,
        first_week_charged_again: `${firstWeek.weekStart}..${firstWeek.weekEnd}`,
      },
    });

    return NextResponse.json({ success: true, suspension: written.suspension, firstWeek, cancelled });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
