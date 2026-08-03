import { parseYearMonthKey, type PabExclusionsMap } from '@/lib/pab-period-settings';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-08" -> "August 2026". Falls back to the raw key when it doesn't parse. */
export function formatPabMonthLabel(monthKey: string): string {
  const ym = parseYearMonthKey(monthKey);
  if (!ym) return monthKey;
  return `${MONTH_NAMES[ym.month] ?? ''} ${ym.year}`.trim();
}

export type PabExclusionNotificationType = 'pab.excluded' | 'pab.restored';

export interface PabExclusionNotificationContent {
  type: PabExclusionNotificationType;
  tone: 'neutral' | 'positive';
  title: string;
  message: string;
}

/**
 * Notification copy for a PAB exclusion state change. Pure — no I/O — so the
 * API route just calls this and inserts the result.
 */
export function buildPabExclusionNotification(
  excluded: boolean,
  monthKey: string,
): PabExclusionNotificationContent {
  const monthLabel = formatPabMonthLabel(monthKey);
  if (excluded) {
    return {
      type: 'pab.excluded',
      tone: 'neutral',
      title: 'Excluded from Perfect Attendance Bonus',
      message: `You've been excluded from the Perfect Attendance Bonus for ${monthLabel}. You'll earn ₱0 PAB for this period regardless of attendance. Reach out to Accounting if this doesn't look right.`,
    };
  }
  return {
    type: 'pab.restored',
    tone: 'positive',
    title: 'Perfect Attendance Bonus Restored',
    message: `Your Perfect Attendance Bonus exclusion for ${monthLabel} has been reversed. You're eligible again based on your attendance for the period.`,
  };
}

export interface PabExclusionPatchResult {
  /** Full month -> emails[] map, ready to JSON.stringify and save verbatim. */
  nextExclusions: Record<string, string[]>;
  /** Whether `email` was excluded for `monthKey` BEFORE this patch. */
  wasExcluded: boolean;
  /** Whether membership actually changed (wasExcluded !== excluded). */
  changed: boolean;
}

/**
 * Pure patch step: add/remove `email` from `monthKey`'s set inside the parsed
 * exclusions map, and return the FULL map ready to re-serialize. Every other
 * month is preserved untouched; a month whose set ends up empty is dropped so
 * the blob stays compact (same shape the Payroll Wizard already writes).
 */
export function applyPabExclusionPatch(
  currentExclusions: PabExclusionsMap,
  monthKey: string,
  email: string,
  excluded: boolean,
): PabExclusionPatchResult {
  const norm = email.trim().toLowerCase();
  const set = new Set(currentExclusions.get(monthKey) ?? []);
  const wasExcluded = set.has(norm);
  if (excluded) set.add(norm);
  else set.delete(norm);

  const nextExclusions: Record<string, string[]> = {};
  for (const [key, emails] of currentExclusions.entries()) {
    if (key === monthKey) continue;
    if (emails.size > 0) nextExclusions[key] = Array.from(emails);
  }
  if (set.size > 0) nextExclusions[monthKey] = Array.from(set);

  return { nextExclusions, wasExcluded, changed: wasExcluded !== excluded };
}
