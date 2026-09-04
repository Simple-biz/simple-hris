/**
 * GET /api/admin/diagnostics/hr-pipeline — Admin → Diagnostics → HR Pipeline.
 * How many of the people HR listed for a hiring week reached the master list.
 *
 * Three paged reads, joined by `src/lib/admin/hr-pipeline-performance.ts`:
 *   `listChecklistWeekCounts()`   — listed per week
 *   `listChecklistWeeksByEmail()` — the week join, HR's `period_start`
 *   `listOrientationHistory()`    — the staged hires and their stamps
 *
 * **A checklist failure is not survivable.** The week key is HR's
 * `period_start`; falling back to a hire's own dates is the key that filed 46%
 * of hires one week early (docs/features/manager-orientation-attendance.md).
 * If either checklist read fails, this route returns the error and NO numbers
 * rather than a plausible wrong answer.
 *
 * Unlike the payroll tab — whose close-outs are frozen declarations — this is a
 * LIVE read, and `hr_pending_employees` rows are removed by scheduled deletion
 * when someone is offboarded. An old week's `staged` count therefore shrinks
 * over time. `generatedAt` is what the UI stamps to say so.
 *
 * Authorization: the same admin gate as `/api/admin/diagnostics`.
 *
 * Security: AGGREGATES ONLY. `listOrientationHistory()` returns whole hire rows
 * including names, emails and pay rates; every one of them is projected away
 * here before anything is counted, and the response carries counts and dates
 * only. No name, no email, no rate, ever.
 */

import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/auth-options';
import { requireElevatedSession, deniedResponse } from '@/lib/auth/authorize-email';
import { listOrientationHistory } from '@/lib/supabase/hr-pending-employees';
import {
  listChecklistWeeksByEmail,
  listChecklistWeekCounts,
} from '@/lib/supabase/hr-new-hire-checklist';
import {
  buildHrPipeline,
  type HrPipelinePendingRow,
} from '@/lib/admin/hr-pipeline-performance';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function requireAdmin() {
  const authz = await requireElevatedSession();
  if (!authz.ok) return { ok: false as const, response: deniedResponse(authz) };
  const session = await getServerSession(authOptions);
  const roles = ((session?.user as { roles?: string[] } | undefined)?.roles ?? []) as string[];
  if (!roles.includes('admin')) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: 'Admin role required' }, { status: 403 }),
    };
  }
  return { ok: true as const };
}

function fail(error: string) {
  return NextResponse.json(
    { generatedAt: new Date().toISOString(), pipeline: null, error },
    { status: 500 },
  );
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [historyRes, weeksRes, countsRes] = await Promise.all([
    listOrientationHistory(),
    listChecklistWeeksByEmail(),
    listChecklistWeekCounts(),
  ]);

  if (historyRes.error) return fail(historyRes.error);
  // Either checklist read failing means the WEEK KEY is unavailable. There is
  // no degraded mode here: the fallback key is the known-wrong one.
  if (weeksRes.error) return fail(weeksRes.error);
  if (countsRes.error) return fail(countsRes.error);

  // Project every hire row down to the seven fields the funnel needs, dropping
  // names, work/personal identity beyond the join key, rates and notes before
  // anything else touches them.
  const pending: HrPipelinePendingRow[] = historyRes.rows.map((r) => ({
    personal_email: r.personal_email ?? null,
    created_at: r.created_at,
    status: r.status ?? null,
    onboarding_submission_id: r.onboarding_submission_id ?? null,
    orientation_attended_at: r.orientation_attended_at ?? null,
    no_show_at: r.no_show_at ?? null,
    promoted_at: r.promoted_at ?? null,
  }));

  const pipeline = buildHrPipeline({
    pending,
    checklistWeeksByEmail: weeksRes.weeksByEmail,
    checklistWeekCounts: countsRes.countsByWeek,
  });

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    pipeline,
    error: null,
  });
}
