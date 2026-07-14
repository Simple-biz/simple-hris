/**
 * Canonical pay-period label shared by every surface that lists Hubstaff
 * batches (Payroll Wizard batch list + replay selector, Accounting Overview,
 * Employee Dashboard week selector, …).
 *
 * The period itself is encoded in the batch's source_file name as
 * `YYYY-MM-DD_to_YYYY-MM-DD` — both manual CSV exports
 * (`simple-biz_daily_report_2026-07-05_to_2026-07-11.csv`) and live API syncs
 * (`simple-biz_api_sync_2026-07-05_to_2026-07-11.csv`) carry the same block, so
 * one parser + one formatter keeps every selector in lock-step:
 *
 *   same month   → "Jul 5 - 11, 2026"
 *   cross-month  → "Jun 28 - Jul 4, 2026"
 *   cross-year   → "Dec 27, 2026 - Jan 2, 2027"
 */
import { parseDateRangeFromFilename } from '@/lib/hubstaff/calendar-column-dedupe';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** "Jul 5 - 11, 2026" style label for an inclusive local-date range. */
export function formatPeriodRange(start: Date, end: Date): string {
  const sM = MONTHS_SHORT[start.getMonth()];
  const eM = MONTHS_SHORT[end.getMonth()];
  const sD = start.getDate();
  const eD = end.getDate();
  const sY = start.getFullYear();
  const eY = end.getFullYear();
  if (sY !== eY) return `${sM} ${sD}, ${sY} - ${eM} ${eD}, ${eY}`;
  if (start.getMonth() !== end.getMonth()) return `${sM} ${sD} - ${eM} ${eD}, ${eY}`;
  return `${sM} ${sD} - ${eD}, ${eY}`;
}

/**
 * Pay-period label parsed from a batch filename's embedded date range.
 * Returns `fallback` (default: the raw filename) when no range is present, so
 * hand-renamed batches without a date block still render something sensible.
 */
export function periodLabelFromFilename(
  file: string | null | undefined,
  fallback?: string,
): string {
  if (!file) return fallback ?? '—';
  const r = parseDateRangeFromFilename(file);
  if (!r) return fallback ?? file;
  return formatPeriodRange(r.start, r.end);
}
