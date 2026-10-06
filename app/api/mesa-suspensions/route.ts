import { NextResponse } from 'next/server';
import { deniedResponse, requireElevatedSession } from '@/lib/auth/authorize-email';
import { requireFeatureEditAnyView } from '@/lib/auth/authorize-feature';
import { auditFrom } from '@/lib/audit/context';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { getOpenMesaAccount, getOpenMesaAccountAcrossAliases } from '@/lib/supabase/mesa-accounts';
import {
  insertMesaSuspension,
  listMesaSuspensionsForAccount,
  listMesaSuspensionsForOpenAccounts,
} from '@/lib/supabase/mesa-suspensions';
import {
  MESA_SUSPENSIONS_NOT_SET_UP,
  checkSuspend,
  checkSuspensionReason,
  firstAffectedWeek,
} from '@/lib/mesa/suspension';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/mesa-suspensions
// Every suspension window on a currently OPEN account. Read by the Payroll
// Wizard (which weeks it charges) and Accounting → MESA → Active Members.
// Program-wide, so elevated only — the same gate as the program-wide
// /api/mesa-ledger read.
//
// `available: false` = the table is missing (migration pending): nobody can be
// suspended, so an empty list is the truth. Any other failure is a 500 — never
// an empty list, which every reader would spend as "nobody is suspended".
export async function GET() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return deniedResponse(authz);
  const list = await listMesaSuspensionsForOpenAccounts();
  if (!list.ok) {
    return NextResponse.json({ error: `Could not read MESA suspensions: ${list.error}` }, { status: 500 });
  }
  return NextResponse.json({ available: list.available, suspensions: list.suspensions });
}

// POST /api/mesa-suspensions
// Body: { workEmail?: string; personalEmail?: string; name?: string; from: 'YYYY-MM-DD'; reason?: string }
//
// Suspends the member's weekly contribution — the ₱100 deduction AND the
// ₱100 + ₱300 deposit — for every pay week whose FRIDAY deposit date is on/after
// `from`. The member stays enrolled: the account, its number and its balance
// are untouched and nothing is released. Same gate as the Opt In / Opt Out
// buttons beside it (`/api/toggle-mesa-member`).
export async function POST(request: Request) {
  const authz = await requireFeatureEditAnyView('mesa');
  if (!authz.ok) return deniedResponse(authz);
  try {
    const body = (await request.json().catch(() => null)) as {
      workEmail?: unknown;
      personalEmail?: unknown;
      name?: unknown;
      from?: unknown;
      reason?: unknown;
    } | null;
    if (!body) return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });

    const workEmail = typeof body.workEmail === 'string' ? body.workEmail.trim().toLowerCase() : '';
    const personalEmail = typeof body.personalEmail === 'string' ? body.personalEmail.trim().toLowerCase() : '';
    const rosterEmail = workEmail || personalEmail;
    if (!rosterEmail) {
      return NextResponse.json({ error: 'workEmail or personalEmail is required' }, { status: 400 });
    }
    const name = typeof body.name === 'string' ? body.name.trim() || null : null;

    const reasonCheck = checkSuspensionReason(body.reason);
    if (!reasonCheck.ok) return NextResponse.json({ error: reasonCheck.error }, { status: reasonCheck.status });

    // The OPEN account this suspends — under the roster address, or under an
    // earlier address of the same person (a drifted MESA identity, e.g. dale@
    // on the account, dales@ on the roster). Never mints anything.
    let account = await getOpenMesaAccount(rosterEmail);
    if (!account) {
      const alias = await getOpenMesaAccountAcrossAliases(rosterEmail);
      if (!alias.ok) {
        return NextResponse.json(
          { error: `Could not read this member's MESA account, so nothing was suspended. (${alias.error})` },
          { status: 503 },
        );
      }
      account = alias.found?.account ?? null;
    }
    if (!account) {
      return NextResponse.json(
        { error: `${name ?? rosterEmail} has no open MESA account, so there is no contribution to suspend.` },
        { status: 409 },
      );
    }

    const existing = await listMesaSuspensionsForAccount(account.account_number);
    if (!existing.ok) {
      return NextResponse.json(
        { error: `Could not read this account's suspensions, so nothing was suspended. (${existing.error})` },
        { status: 503 },
      );
    }
    if (!existing.available) return NextResponse.json({ error: MESA_SUSPENSIONS_NOT_SET_UP }, { status: 503 });

    const check = checkSuspend({ from: body.from, accountOpenedOn: account.opened_on, existing: existing.suspensions });
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

    const written = await insertMesaSuspension({
      accountNumber: account.account_number,
      accountEmail: account.email,
      rosterEmail,
      suspendedFrom: check.from,
      reason: reasonCheck.reason,
      suspendedBy: authz.sessionEmail,
    });
    if (!written.ok) {
      if (written.conflict) return NextResponse.json({ error: written.error }, { status: 409 });
      if (written.missing) return NextResponse.json({ error: MESA_SUSPENSIONS_NOT_SET_UP }, { status: 503 });
      return NextResponse.json({ error: written.error }, { status: 500 });
    }

    const firstWeek = firstAffectedWeek(check.from);
    await insertAuditLog({
      ...auditFrom(request, authz),
      action: 'employee.mesa.suspend',
      resource: 'mesa_suspensions',
      resource_id: written.suspension.id,
      details: {
        name,
        roster_email: rosterEmail,
        account_email: account.email,
        mesa_account_number: account.account_number,
        suspended_from: check.from,
        first_week_not_charged: `${firstWeek.weekStart}..${firstWeek.weekEnd}`,
        reason: reasonCheck.reason,
      },
    });

    return NextResponse.json({ success: true, suspension: written.suspension, firstWeek });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
