import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import {
  ensureQcAssignmentsForPeriod,
  getQcRosterMembers,
  summarizeOfficers,
  getQcOfficerNameMap,
  computeDeptTotals,
  listQcOfficerLocks,
  listQcReviewStatus,
  listManagedQcDepts,
} from '@/lib/supabase/qc-db';
import { isQcDeptKey } from '@/lib/qc/constants';
import type { EmployeeRow } from '@/lib/supabase/employees';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

/**
 * GET ?period_start=YYYY-MM-DD
 * Ensures the equal-split assignment for the week, then returns:
 *  - officers:    [{ email, index (1-based), memberCount }] for "QC Officer N"
 *  - assignments: full officer→member map (manager responsibility view)
 *  - locks:       per-officer lock log (who/when)
 *  - review:      per-dept manager decision
 *  - mine:        the signed-in officer's assigned members (full EmployeeRow[])
 *                 for their own calculator (empty for managers/admins)
 *
 * Readable by QC officers, the dept managers, and admins.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { email?: string | null; roles?: string[] } | undefined;
  const email = norm(user?.email);
  const roles = user?.roles ?? [];
  if (!email) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!(roles.includes('qc') || roles.includes('manager') || roles.includes('admin'))) {
    return NextResponse.json({ error: 'QC, manager, or admin role required' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const periodStart = searchParams.get('period_start');
  if (!periodStart) return NextResponse.json({ error: 'period_start required' }, { status: 400 });

  const { officers, rows: allRows, error } = await ensureQcAssignmentsForPeriod(periodStart);
  if (error) return NextResponse.json({ error }, { status: 500 });

  // Only surface departments currently in QC scope. ensureQcAssignmentsForPeriod
  // keeps sticky rows for departed slots (transfers), and legacy rows may exist
  // for a dept since moved out of QC (e.g. Discovery → its manager) — filtering
  // here keeps those out of the officer/manager view without deleting history.
  const rows = allRows.filter((r) => isQcDeptKey(r.department));

  const [allLocks, allReview] = await Promise.all([
    listQcOfficerLocks(periodStart),
    listQcReviewStatus(periodStart),
  ]);

  // The signed-in officer's OWN slots (all lifecycle statuses, so a transferred/
  // removed person they were assigned stays scoreable) — computed BEFORE any
  // manager scoping so an officer always gets their full set.
  const myRows = rows.filter((r) => norm(r.qc_officer_email) === email);
  const myEmails = [...new Set(myRows.map((r) => r.member_email))];
  // Slot-aware roster per dept so the calculator shows each member under their
  // ASSIGNED dept (a transferred person appears under both their old + new dept).
  const myByDept: Record<string, Array<{ email: string; name: string }>> = {};
  for (const r of myRows) {
    (myByDept[r.department] ??= []).push({ email: r.member_email, name: r.member_name ?? r.member_email });
  }

  // A plain dept manager (not admin, not a QC officer) only sees the log for the
  // departments they manage; admins and QC officers see all QC departments.
  let assignments = rows;
  let locks = allLocks;
  let review = allReview;
  let officerEmails = officers;
  if (!roles.includes('admin') && !roles.includes('qc') && roles.includes('manager')) {
    const managed = new Set(await listManagedQcDepts(email));
    assignments = rows.filter((r) => managed.has(r.department));
    review = allReview.filter((r) => managed.has(r.department));
    const inScope = new Set(assignments.map((r) => norm(r.qc_officer_email)));
    locks = allLocks.filter((l) => inScope.has(norm(l.qc_officer_email)));
    officerEmails = officers.filter((o) => inScope.has(norm(o)));
  }

  // Live EmployeeRows for the officer's ACTIVE members (used for email aliasing
  // in the calculator). Transferred/removed people aren't in the live roster —
  // the calculator gets them from myByDept instead.
  let members: EmployeeRow[] = [];
  if (myEmails.length > 0) {
    const roster = await getQcRosterMembers();
    const set = new Set(myEmails.map(norm));
    members = roster.filter((e) => set.has(norm(e.personal_email) || norm(e.work_email)));
  }

  // Resolve officer names from the master list so the first-pass rail can show
  // each officer by name instead of "QC Officer N".
  const officerNames = await getQcOfficerNameMap(officerEmails);

  return NextResponse.json({
    periodStart,
    officers: summarizeOfficers(officerEmails, assignments, officerNames),
    // Use the SCOPED officer set: a plain manager sees only the officers working
    // their departments, so the "÷ N QC → ~M each" split reflects their view.
    officerCount: officerEmails.length,
    deptTotals: computeDeptTotals(assignments, officerEmails.length),
    assignments,
    locks,
    review,
    mine: { memberEmails: myEmails, byDept: myByDept, members },
    error: null,
  });
}
