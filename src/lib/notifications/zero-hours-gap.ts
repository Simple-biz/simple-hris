/**
 * `payroll.hours_gap` — tells ACCOUNTING, at the moment a Hubstaff week lands,
 * that N active roster members logged no hours and nothing in the HRIS explains
 * why.
 *
 * ## Why a notification and not a scheduled job
 *
 * There is no scheduler to hang this on, by measurement and by ruling. Every
 * `/api/cron/*` route 401s at the edge (`proxy.ts`'s fail-closed CRON_SECRET
 * gate) and the two Vercel crons that exist have never once run; the only real
 * scheduler this product had — the n8n weekly Hubstaff pull — was retired on
 * 2026-08-20 with "there is now no scheduler for this by design". A "weekly
 * reminder" would therefore have been dead on arrival and silently so.
 *
 * The Hubstaff ingest is the correct trigger anyway: it is the exact moment the
 * answer changes, it is already a human action someone is watching, and it is
 * where `payroll.available` already fires. If nobody uploads a week, there is
 * nothing to reconcile and no reminder is owed.
 *
 * ## Why the message carries a COUNT, not the people
 *
 * With Lead Gen tracked (Kane's Q1, 2026-08-21) the list runs ~190 people a
 * week. A notification listing 190 names is one nobody reads, which is the same
 * failure mode this feature exists to fix — the signal was already available on
 * the Accounting Overview tile and went unread for two weeks while
 * `jvincec@simple.biz` sat Active with no hours. So the card carries the count
 * plus the departments driving it, and points at the pane that has the rows.
 *
 * Recipients are active `accounting` role holders ONLY (Kane's Q4). Pattern
 * copied from `notifyReviewers` in app/api/bank-update/save/route.ts.
 */
import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { recordNotifyFailure } from '@/lib/notifications/notify-failure-audit';
import { summarizeZeroHoursGaps, zeroHoursDigestLine } from '@/lib/payroll/zero-hours-gap';

export const ZERO_HOURS_GAP_TYPE = 'payroll.hours_gap';

/** The roles that hear about it. Accounting only — Kane, 2026-08-21 (Q4). */
const RECIPIENT_ROLES = ['accounting'] as const;

/**
 * Fire the reminder for a freshly ingested week. Best-effort in the same sense
 * as every other notify helper here — it never throws and never fails the
 * ingest — but a failure is written to `audit_log` via `recordNotifyFailure`
 * rather than a `console.warn`, because a bare warn is precisely how
 * `kpi.scored` stayed dead for three days after its DDL was missed.
 *
 * Idempotent per (recipient, source_file): re-uploading or correcting the same
 * week never re-notifies someone already told about it, but an accountant newly
 * granted the role still gets the current week's card.
 */
export async function notifyZeroHoursGap(opts: {
  sourceFile?: string | null;
  /** The gap rows for the week — already classified by `classifyZeroHours`.
   *  Only the department is read (the card is a digest, not a roster), so both
   *  the tile's row shape and Readiness' leaner one satisfy it. */
  rows: readonly { department: string | null }[];
  /** The pay week label for the card, e.g. "Aug 9 – Aug 15". */
  weekLabel?: string | null;
}): Promise<{ inserted: number; skipped: number; recipients: number }> {
  const zero = { inserted: 0, skipped: 0, recipients: 0 };

  const sourceFile = opts.sourceFile?.trim() || null;
  // Without a source_file there is no week to de-dupe on, so a re-upload would
  // re-notify every accountant every time. Skip rather than spam.
  if (!sourceFile) return zero;

  // Nothing unexplained: say nothing. A "0 gaps" card every week is noise that
  // trains people to dismiss the card that matters.
  if (opts.rows.length === 0) return zero;

  const supabase = createSupabaseServiceRoleClient();
  if (!supabase) return zero;

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

    const recipients = [
      ...new Set(
        roleRows
          .map((r) => (r.work_email ?? '').trim().toLowerCase())
          .filter((e): e is string => Boolean(e)),
      ),
    ];
    if (recipients.length === 0) return zero;
    zero.recipients = recipients.length;

    // ── De-dupe per (recipient, source_file) ────────────────────────────────
    const { rows: existing, error: existingErr } = await selectAllPaged<{
      recipient_email?: string | null;
    }>((from, to) =>
      supabase
        .from('employee_notifications')
        .select('recipient_email')
        .eq('type', ZERO_HOURS_GAP_TYPE)
        // Same idiom payroll-available.ts de-dupes on — a jsonb text extract,
        // not `.contains`, so it matches that proven query shape exactly.
        .eq('details->>source_file', sourceFile)
        .order('recipient_email', { ascending: true })
        .range(from, to),
    );
    // A failed de-dupe read must NOT become a double-notify: bail instead. The
    // reminder is weekly and re-fires on the next ingest, so a skipped week is
    // recoverable while a duplicate storm across every accountant is not.
    if (existingErr) throw new Error(`de-dupe read: ${existingErr}`);

    const already = new Set(
      existing.map((r) => (r.recipient_email ?? '').trim().toLowerCase()).filter(Boolean),
    );
    const targets = recipients.filter((r) => !already.has(r));
    zero.skipped = recipients.length - targets.length;
    if (targets.length === 0) return zero;

    // ── The card ───────────────────────────────────────────────────────────
    const summary = summarizeZeroHoursGaps(opts.rows);
    const weekLabel = opts.weekLabel?.trim() || null;
    const title = `${summary.total} ${summary.total === 1 ? 'person' : 'people'} logged no hours${
      weekLabel ? ` · ${weekLabel}` : ''
    }`;
    const message = `${zeroHoursDigestLine(summary)} Check Payroll Notes → Readiness → No hours this week: still active, on leave, sick — or never offboarded?`;

    const { error: insertErr } = await supabase.from('employee_notifications').insert(
      targets.map((to) => ({
        recipient_email: to,
        type: ZERO_HOURS_GAP_TYPE,
        tone: 'neutral',
        title,
        message,
        details: {
          source_file: sourceFile,
          week_label: weekLabel,
          total: summary.total,
          by_department: summary.byDepartment,
        },
      })),
    );
    if (insertErr) throw new Error(insertErr.message);

    zero.inserted = targets.length;
    return zero;
  } catch (error) {
    // Never fails the ingest — but never invisible either.
    await recordNotifyFailure({
      notificationType: ZERO_HOURS_GAP_TYPE,
      origin: 'notifications/zero-hours-gap',
      error,
      details: { source_file: sourceFile, gap_count: opts.rows.length },
    });
    return zero;
  }
}

/**
 * The one-line form the ingest paths call: resolve the week's gap rows from
 * `getPayrollReadiness` and notify.
 *
 * It deliberately reads the rows from the readiness aggregator rather than
 * recomputing them, so the card's count can never disagree with the pane the
 * card tells the accountant to open. That costs a full readiness load on ingest,
 * which is acceptable here: the ingest is a manual once-a-week action that
 * already pages the whole hours table and the master list to fire
 * `payroll.available`, and the pane performs the same load every time anyone
 * opens it.
 *
 * Returns null when the load itself failed — the caller logs, the week is simply
 * not announced, and the next ingest of the same week tries again (nobody has
 * been notified, so the de-dupe has nothing to skip).
 */
export async function notifyZeroHoursGapForWeek(
  sourceFile: string | null | undefined,
): Promise<Awaited<ReturnType<typeof notifyZeroHoursGap>> | null> {
  const file = sourceFile?.trim() || null;
  if (!file) return null;
  // Imported lazily so the ingest route does not pull the whole readiness
  // aggregator (and its dozen table readers) into its module graph unless a
  // week is actually being announced.
  const { getPayrollReadiness } = await import('@/lib/payroll/payroll-readiness');
  const readiness = await getPayrollReadiness(file);
  return notifyZeroHoursGap({
    sourceFile: file,
    rows: readiness.zeroHours,
    weekLabel: readiness.weekLabel,
  });
}
