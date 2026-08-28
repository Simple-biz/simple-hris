import { NextResponse } from 'next/server';

import { deniedResponse } from '@/lib/auth/authorize-email';
import { requireFeatureEdit } from '@/lib/auth/authorize-feature';
import { getSessionActor } from '@/lib/auth/session-actor';
import { normEmail } from '@/lib/email/norm-email';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import {
  canActOnDisputes,
  createDispute,
  decideDispute,
  disputeGrantsPabForgiveness,
  listDisputes,
  type PabDayDisputeRow,
} from '@/lib/supabase/pab-day-disputes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Forgive one person's WHOLE PAB month, from the Payroll Wizard's step-6 PAB review.
 *
 * ## Why this writes disputes instead of a "granted the month" record
 *
 * The obvious design is a month-level grant — the mirror of `pab_period_exclusions`,
 * which zeroes a month's PAB. It was scoped and rejected. The approved
 * `pab_day_disputes` row is the ONLY PAB input that every verdict in the product
 * already reads: the dispatch rail (`current-pay.ts`), the employee/manager rail
 * (`member-monthly-pay.ts`), both wizard breakdowns, the Employee Dashboard, My Hours,
 * `EmployeePabCalendar` and Overview. A new blob would need a read in each of them,
 * and its mirror is the proof of what happens when that is not done: nothing under
 * `src/components/employee/` mentions `pab_period_exclusions` at all, so a person
 * zeroed by an accountant is still told they are eligible. An invisible GRANT is
 * worse than an invisible exclusion — it is a benefit the employee was told they got.
 *
 * "Whole month, not per-day" is a statement about the button, not about the store.
 *
 * ## Why override_hours is 7
 *
 * Server-side, 7 is indistinguishable from the `null` this route's per-day sibling
 * writes: `applyPabAdjustments` bumps any forgiven day with ≥4h effective to a full
 * 7h either way. But `EmployeeDashboard.tsx` applies the override as a plain SET and
 * skips `null` entirely, so a `null` (or the 5h the modal writes for near-empty days)
 * leaves the day below the 7h bar, `pabViolations` still counts it, and the employee
 * is told "No longer Eligible for PAB — violated on <the days just forgiven>" while
 * being paid the bonus. Writing 7 is what makes the dashboard agree with the money
 * without touching the dashboard.
 *
 * The visible trade: the forgiven cell reads 7:00 with a "Forgiven" chip rather than
 * the real tracked hours. That is deliberate and is the opposite of the choice
 * orphanage coverage made (`docs/features/orphanage-pab-coverage.md`) — there the
 * calendar keeps real hours because the top-up is additive and needs no SET.
 *
 * ## All-or-nothing
 *
 * A partial month is the one outcome worse than no forgiveness: the operator sees a
 * success, the employee stays ineligible, and nobody knows which days are missing.
 * So every day is attempted, and if any day ends un-forgiven the response is a 500
 * carrying the per-day outcome. The verdict is re-derived from the DB afterwards and
 * returned — never "forgave N days", which is a claim about writes, not about
 * eligibility.
 */

/** Guards the batch: a PAB month is ~23 weekdays. Anything beyond a calendar month
 *  of days is a malformed client, not a real forgiveness. */
const MAX_DAYS = 40;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The reason code the wizard's per-day Forgive already uses. Keeping it identical
 *  means the two paths produce indistinguishable rows, so every downstream reader —
 *  and the employee's own Disputes list — treats them the same. */
const FORGIVE_REASON = 'other';

type DayOutcome = {
  iso: string;
  ok: boolean;
  /** `already` = a forgiving row was in place before this request. */
  state: 'forgiven' | 'already' | 'failed';
  error?: string;
};

function parseDays(raw: unknown): { days: string[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'days must be an array of YYYY-MM-DD strings' };
  const seen = new Set<string>();
  for (const d of raw) {
    if (typeof d !== 'string' || !ISO_DATE.test(d)) {
      return { error: `Invalid day: ${String(d)}` };
    }
    seen.add(d);
  }
  const days = [...seen].sort();
  if (days.length === 0) return { error: 'days must not be empty' };
  if (days.length > MAX_DAYS) return { error: `Too many days (${days.length}); max ${MAX_DAYS}` };
  return { days };
}

/**
 * Every day must sit inside the month being forgiven.
 *
 * The client sends the days it listed as failed, and the client's period can drift
 * from the server's — a stale wizard tab, or an accountant who re-set the PAB window
 * mid-session. Without this check a stale tab could forgive days in a month nobody
 * is reviewing, silently, and those rows would still be read by the pay path.
 * `YYYY-MM` prefix matching is the right test precisely BECAUSE the PAB window can
 * extend past the calendar month: it accepts the month the operator chose and
 * rejects everything else, without this route having to re-resolve the period.
 */
function daysOutsideMonth(days: string[], monthKey: string): string[] {
  return days.filter((d) => !d.startsWith(`${monthKey}-`));
}

export async function POST(req: Request) {
  const authz = await requireFeatureEdit('accounting', 'payroll_wizard');
  if (!authz.ok) return deniedResponse(authz);

  let body: { email?: unknown; monthKey?: unknown; days?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const email = normEmail(typeof body.email === 'string' ? body.email : null);
  if (!email) return NextResponse.json({ error: 'Missing or invalid email' }, { status: 400 });

  const monthKey = typeof body.monthKey === 'string' ? body.monthKey.trim() : '';
  if (!MONTH_KEY.test(monthKey)) {
    return NextResponse.json({ error: 'monthKey must be a valid YYYY-MM month' }, { status: 400 });
  }

  const parsed = parseDays(body.days);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { days } = parsed;

  const strays = daysOutsideMonth(days, monthKey);
  if (strays.length > 0) {
    return NextResponse.json(
      { error: `Days outside ${monthKey}: ${strays.join(', ')}` },
      { status: 400 },
    );
  }

  const actor = await getSessionActor();
  // decideDispute re-checks this itself; checking here too turns "created 20
  // pending disputes then failed to approve any of them" into a clean 403 that
  // leaves no debris behind.
  if (!(await canActOnDisputes(actor.user_name))) {
    return NextResponse.json(
      { error: 'Not authorized — only Accounting roles can forgive PAB days' },
      { status: 403 },
    );
  }

  const note =
    typeof body.note === 'string' && body.note.trim()
      ? body.note.trim()
      : `Forgiven by Accounting — whole PAB month ${monthKey}`;

  // Existing rows for the window, so a re-run is a no-op rather than a duplicate.
  // The table is unique on (work_email, dispute_date), so a blind create would 23505
  // on every already-forgiven day and report a failed batch for work already done.
  const existing = await listDisputes({
    email,
    from: days[0],
    to: days[days.length - 1],
    limit: MAX_DAYS * 2,
  });
  if (existing.error) {
    return NextResponse.json(
      { error: `Could not read existing issues: ${existing.error}` },
      { status: 500 },
    );
  }
  const byDate = new Map<string, PabDayDisputeRow>();
  for (const row of existing.rows) byDate.set(row.dispute_date, row);

  const outcomes: DayOutcome[] = [];

  for (const iso of days) {
    const prior = byDate.get(iso);

    if (prior && disputeGrantsPabForgiveness(prior)) {
      outcomes.push({ iso, ok: true, state: 'already' });
      continue;
    }

    // A row that exists but does not forgive is either pending (approve it) or
    // decided the other way. Re-deciding a denied row is NOT this route's job —
    // reversing an explicit denial belongs in the disputes queue where the note
    // and the original decider are visible.
    let id = prior?.id ?? null;
    if (prior && prior.status !== 'pending') {
      outcomes.push({
        iso,
        ok: false,
        state: 'failed',
        error: `Existing issue is ${prior.status} — resolve it in the Issues queue`,
      });
      continue;
    }

    if (!id) {
      const created = await createDispute({
        work_email: email,
        dispute_date: iso,
        reason: FORGIVE_REASON,
        explanation: note,
        created_by: actor.user_name,
      });
      if (created.error || !created.id) {
        outcomes.push({ iso, ok: false, state: 'failed', error: created.error ?? 'Create failed' });
        continue;
      }
      id = created.id;
    }

    const decided = await decideDispute(id, {
      status: 'approved',
      decided_by: actor.user_name,
      decision_note: note,
      // See the header: 7, not null — this is what reaches the employee.
      override_hours: 7,
    });
    if (decided.error) {
      outcomes.push({ iso, ok: false, state: 'failed', error: decided.error });
      continue;
    }
    outcomes.push({ iso, ok: true, state: 'forgiven' });
  }

  const failed = outcomes.filter((o) => !o.ok);
  const forgiven = outcomes.filter((o) => o.state === 'forgiven');

  // Re-read rather than trusting the writes. This is the difference between
  // reporting what we asked for and reporting what is true — and it is the only
  // thing that catches a row written and then immediately changed by someone else.
  const after = await listDisputes({
    email,
    from: days[0],
    to: days[days.length - 1],
    limit: MAX_DAYS * 2,
  });
  const forgivenNow = new Set(
    after.rows.filter((r) => disputeGrantsPabForgiveness(r)).map((r) => r.dispute_date),
  );
  const stillFailing = days.filter((d) => !forgivenNow.has(d));

  // ONE audit row for the decision, on top of the per-day pab_dispute.approved
  // rows decideDispute writes. The per-day rows are what the pay path reads; this
  // is what makes "granted the whole month of August" legible as a single act
  // instead of something an auditor has to reassemble from 20 fragments.
  await insertAuditLog({
    user_name: actor.user_name,
    user_role: actor.user_role,
    action: 'pab_dispute.month_forgiven',
    resource: 'pab_day_disputes',
    details: {
      employee: email,
      month: monthKey,
      days_requested: days.length,
      days_written: forgiven.length,
      days_already_forgiven: outcomes.filter((o) => o.state === 'already').length,
      days_still_failing: stillFailing,
      complete: stillFailing.length === 0,
      note,
    },
  });

  if (stillFailing.length > 0 || failed.length > 0) {
    return NextResponse.json(
      {
        error:
          `Forgave ${forgivenNow.size} of ${days.length} days — the month is NOT forgiven. ` +
          `Still failing: ${stillFailing.join(', ')}`,
        outcomes,
        stillFailing,
        complete: false,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    complete: true,
    email,
    monthKey,
    forgiven: [...forgivenNow].sort(),
    outcomes,
  });
}
