/**
 * Shared bucketing for URGENT payouts (MESA disbursements + one-off People-tab
 * payments). These bypass the weekly Payroll Wizard cycle but still reconcile
 * into a Sun→Sat weekly report, so every urgent `payment_dispatches` row is
 * tagged with the week it was sent.
 *
 * WHY THIS MODULE EXISTS — the urgent marker is `cycle_source_file`, NOT `cycle_id`.
 *
 * `payment_dispatches.cycle_id` is `UUID REFERENCES hubstaff_uploads(id)`
 * (references/sql/seed/seed_payment_dispatches.sql). Both urgent dispatch routes
 * used to write the sentinel string `cycle_id: 'urgent'` into it, and the report
 * reader filtered `.eq('cycle_id','urgent')` — so Postgres rejected every urgent
 * write and every urgent read with:
 *
 *     22P02  invalid input syntax for type uuid: "urgent"
 *
 * Send / Mark as Paid failed for MESA and one-off payments alike, and the weekly
 * Urgent report silently came back empty. Urgent rows have no Hubstaff upload, so
 * `cycle_id` is now left NULL (the column is nullable by design — its FK is
 * ON DELETE SET NULL) and the week lives in `cycle_source_file`, which is where
 * the rest of the report pipeline already looked for it:
 * `getDisbursementReportDetail` keys off `sourceFile.startsWith('urgent_')` and
 * `buildUrgentWeeklyReports` groups by `cycle_source_file`.
 *
 * Keep writers and readers on these helpers so the two can never drift apart.
 */

/**
 * Marks a `payment_dispatches.cycle_source_file` as an urgent bucket rather than
 * a real Hubstaff CSV cycle. Nothing else in the pipeline writes this prefix —
 * regular payroll rows carry the upload's filename (`simple-biz_daily_report_…csv`).
 */
export const URGENT_SOURCE_FILE_PREFIX = 'urgent_';

/**
 * Bucket an ISO date (or full timestamp) into its Sunday→Saturday payroll week.
 * Urgent payments reconcile alongside the regular Hubstaff cycles, which also run
 * Sun→Sat (e.g. 2026-04-12_to_2026-04-18), so they must share the same boundaries.
 *
 * All arithmetic is UTC so the bucket never shifts with the server's timezone.
 * Returns null when the input carries no usable leading `YYYY-MM-DD`.
 */
export function sundayWeekRange(isoDate: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back up to Sunday
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6); // Saturday
  const fmt = (x: Date) =>
    `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
  return { start: fmt(start), end: fmt(end) };
}

/**
 * The `cycle_source_file` an urgent payout sent on `sentDate` belongs to.
 *
 * The fallback keeps the `urgent_` prefix on purpose: the report detail lookup
 * recognizes an urgent bucket *only* by that prefix, so a name without it would
 * make the payment unreachable in the UI (the old `mesa_urgent` / `oneoff_urgent`
 * fallbacks did exactly that). An unbucketed payment is still visible; it just
 * isn't filed under a week.
 */
export function urgentCycleSourceFile(sentDate: string | null | undefined): string {
  const week = sentDate ? sundayWeekRange(sentDate) : null;
  return week
    ? `${URGENT_SOURCE_FILE_PREFIX}${week.start}_to_${week.end}`
    : `${URGENT_SOURCE_FILE_PREFIX}unbucketed`;
}

/** True when a `cycle_source_file` denotes an urgent bucket rather than a payroll cycle. */
export function isUrgentSourceFile(sourceFile: string | null | undefined): boolean {
  return !!sourceFile && sourceFile.startsWith(URGENT_SOURCE_FILE_PREFIX);
}
