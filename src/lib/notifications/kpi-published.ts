/**
 * `kpi.published` — tells ACCOUNTING that a department manager marked a
 * dept-week's KPI bonuses Ready or Locked, so the week is scored and can be paid.
 *
 * Kane, 2026-09-10 (Q1 of the score-ahead brief): managers may lock and submit
 * the UPCOMING pay week before its Hubstaff file exists, and *"Accounting should
 * be able to be notified when a bonus is added."*
 *
 * ## Why it fires on PUBLISH, not on every score
 *
 * "A bonus is added" happens per keystroke: the calculator autosaves every field,
 * and applied-row saves are deliberately unaudited on exactly those volume grounds
 * (`audit-log.md` §6). Firing there would hit Accounting hundreds of times a week.
 * The publish step — Mark Ready / Lock — is the moment the numbers become the
 * ones the Payroll Wizard pays, so it is the moment Accounting needs to hear.
 *
 * ## Recipients and de-dupe
 *
 * Active `accounting` role holders only — the `payroll.hours_gap` rule (Kane,
 * 2026-08-21). Idempotent per (recipient, department, period_start, status): a
 * dept-week says "ready" once and "locked" once; a reopen → re-ready does not
 * re-notify. Employees are told separately, with amounts, by `kpi.scored`.
 *
 * Best-effort like every notify helper — never throws, never fails the status
 * write — but a failure lands in `audit_log` via `recordNotifyFailure`, never a
 * `console.warn`, because a bare warn is how `kpi.scored` stayed dead for three
 * days after its DDL was missed. Until the paired ALTER runs, THIS type is dead
 * the same way, and that audit row is what will say so.
 */
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { humanizeDeptKey } from '@/lib/departments/dept-identity';

export const KPI_PUBLISHED_TYPE = 'kpi.published';

/** The roles that hear about it. Accounting only — same rule as payroll.hours_gap. */
const RECIPIENT_ROLES = ['accounting'] as const;

export type KpiPublishStatus = 'ready' | 'locked';

/** The one string every de-dupe read and write agree on. */
export function kpiPublishedDedupeKey(department: string, periodStart: string, status: KpiPublishStatus): string {
  return `${department.trim().toLowerCase()}|${periodStart}|${status}`;
}

/** The card. Pure, so the copy is testable and the insert shape is fixed in one place. */
export function kpiPublishedCard(opts: {
  department: string;
  periodStart: string;
  periodEnd?: string | null;
  status: KpiPublishStatus;
  /** True when the week has no Hubstaff file yet — the score-ahead case. */
  aheadOfHubstaff?: boolean;
}): { title: string; message: string; details: Record<string, unknown> } {
  const dept = humanizeDeptKey(opts.department);
  const span = opts.periodEnd ? `${opts.periodStart} – ${opts.periodEnd}` : `week of ${opts.periodStart}`;
  const verb = opts.status === 'locked' ? 'locked' : 'marked ready';
  const title = `${dept} KPI bonuses ${verb} · ${span}`;
  const ahead = opts.aheadOfHubstaff
    ? ' Scored ahead of the Hubstaff report — the amounts will be paid with that week once it is uploaded.'
    : '';
  const message = `The ${dept} manager ${verb} the week's KPI bonuses.${ahead} Review them in Payroll Notes → Readiness → KPI Submissions.`;
  return {
    title,
    message,
    details: {
      department: opts.department,
      period_start: opts.periodStart,
      period_end: opts.periodEnd ?? null,
      status: opts.status,
      ahead_of_hubstaff: !!opts.aheadOfHubstaff,
      dedupe_key: kpiPublishedDedupeKey(opts.department, opts.periodStart, opts.status),
    },
  };
}

/** Recipients minus anyone already told about this exact (dept, week, status). Pure. */
export function kpiPublishedTargets(recipients: readonly string[], alreadyNotified: readonly string[]): string[] {
  const done = new Set(alreadyNotified.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const e = r.trim().toLowerCase();
    if (!e || seen.has(e) || done.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

export async function notifyKpiPublished(opts: {
  department: string;
  periodStart: string;
  periodEnd?: string | null;
  status: KpiPublishStatus;
  aheadOfHubstaff?: boolean;
}): Promise<{ inserted: number; skipped: number; recipients: number }> {
  const zero = { inserted: 0, skipped: 0, recipients: 0 };
  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return zero;

  const dedupeKey = kpiPublishedDedupeKey(opts.department, opts.periodStart, opts.status);

  try {
    // ── Recipients: active accounting role holders ──────────────────────────
    const { rows: roleRows, error: roleErr } = await selectAllPaged<{ work_email?: string | null }>(
      (from, to) =>
        supabase
          .from('employee_roles')
          .select('work_email')
          .in('role', [...RECIPIENT_ROLES])
          .is('revoked_at', null)
          .order('work_email', { ascending: true })
          .range(from, to),
    );
    if (roleErr) throw new Error(`employee_roles: ${roleErr}`);
    const recipients = roleRows.map((r) => r.work_email ?? '').filter(Boolean);
    if (recipients.length === 0) return zero;
    zero.recipients = new Set(recipients.map((e) => e.trim().toLowerCase())).size;

    // ── De-dupe per (recipient, dedupe_key) ─────────────────────────────────
    const { rows: existing, error: existingErr } = await selectAllPaged<{ recipient_email?: string | null }>(
      (from, to) =>
        supabase
          .from('employee_notifications')
          .select('recipient_email')
          .eq('type', KPI_PUBLISHED_TYPE)
          // The same jsonb text-extract idiom payroll.hours_gap de-dupes on.
          .eq('details->>dedupe_key', dedupeKey)
          .order('recipient_email', { ascending: true })
          .range(from, to),
    );
    // A failed de-dupe read must NOT become a double-notify: bail instead.
    if (existingErr) throw new Error(`de-dupe read: ${existingErr}`);

    const targets = kpiPublishedTargets(
      recipients,
      existing.map((r) => r.recipient_email ?? ''),
    );
    zero.skipped = zero.recipients - targets.length;
    if (targets.length === 0) return zero;

    const card = kpiPublishedCard(opts);
    const { error: insertErr } = await supabase.from('employee_notifications').insert(
      targets.map((to) => ({
        recipient_email: to,
        type: KPI_PUBLISHED_TYPE,
        tone: 'neutral',
        title: card.title,
        message: card.message,
        details: card.details,
      })),
    );
    if (insertErr) throw new Error(insertErr.message);

    zero.inserted = targets.length;
    return zero;
  } catch (error) {
    // Never fails the status write — but never invisible either.
    await recordNotifyFailure({
      notificationType: KPI_PUBLISHED_TYPE,
      origin: 'notifications/kpi-published',
      error,
      details: { department: opts.department, period_start: opts.periodStart, status: opts.status, dedupe_key: dedupeKey },
    });
    return zero;
  }
}
