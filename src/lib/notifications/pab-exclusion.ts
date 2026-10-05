import { parsePabPeriodExclusions, parseYearMonthKey, type PabExclusionsMap } from '@/lib/pab-period-settings';

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
  const { nextExclusions, outcomes } = applyPabExclusionBatchPatch(currentExclusions, monthKey, [email], excluded);
  // A blank email yields no outcome — nothing to store, nothing changed.
  const only = outcomes[0];
  return { nextExclusions, wasExcluded: only?.wasExcluded ?? false, changed: only?.changed ?? false };
}

export interface PabExclusionOutcome {
  /** Normalized (trimmed, lower-cased) — the value the blob stores. */
  email: string;
  wasExcluded: boolean;
  changed: boolean;
}

/**
 * The batch form of {@link applyPabExclusionPatch} — the PAB step's bulk Ignore
 * (2026-10-05). ONE patch over the whole list, so the route makes ONE write: a
 * bulk decision is all-or-nothing on the blob, never "the first 12 landed".
 *
 * Duplicates (after normalization) collapse to one outcome; the first spelling
 * wins its slot. Each outcome's `wasExcluded` is the state BEFORE the batch, so
 * a person listed twice never reads as "already excluded" by their own entry.
 */
export function applyPabExclusionBatchPatch(
  currentExclusions: PabExclusionsMap,
  monthKey: string,
  emails: readonly string[],
  excluded: boolean,
): { nextExclusions: Record<string, string[]>; outcomes: PabExclusionOutcome[] } {
  const before = currentExclusions.get(monthKey) ?? new Set<string>();
  const set = new Set(before);
  const outcomes: PabExclusionOutcome[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const norm = raw.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    const wasExcluded = before.has(norm);
    if (excluded) set.add(norm);
    else set.delete(norm);
    outcomes.push({ email: norm, wasExcluded, changed: wasExcluded !== excluded });
  }

  const nextExclusions: Record<string, string[]> = {};
  for (const [key, monthEmails] of currentExclusions.entries()) {
    if (key === monthKey) continue;
    if (monthEmails.size > 0) nextExclusions[key] = Array.from(monthEmails);
  }
  if (set.size > 0) nextExclusions[monthKey] = Array.from(set);

  return { nextExclusions, outcomes };
}

/**
 * Most people one request may decide. The largest month on record is 346
 * person-month entries (2026-08, measured 2026-10-05) and the review list peaked
 * at 476 rows (2026-08-28). This is a bound on one request's work — one
 * notification lookup + insert per person — not a business rule.
 */
export const PAB_EXCLUSION_BATCH_MAX = 500;

export type PabExclusionRequest =
  | { ok: true; monthKey: string; emails: string[]; excluded: boolean; batch: boolean }
  | { ok: false; error: string };

/**
 * Validates the route body. Exactly one of `email` (the original single toggle —
 * System Bonus modal, the PAB step's row Ignore) or `emails` (bulk Ignore). The
 * batch form refuses rather than trims: an empty list, a non-string entry, a
 * blank entry or an over-cap list is a 400, never a silently shorter write.
 */
export function parsePabExclusionRequest(body: unknown): PabExclusionRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const b = body as { email?: unknown; emails?: unknown; monthKey?: unknown; excluded?: unknown };
  const monthKey = typeof b.monthKey === 'string' ? b.monthKey.trim() : '';
  if (!parseYearMonthKey(monthKey)) {
    return { ok: false, error: 'monthKey must be a valid YYYY-MM month' };
  }
  if (typeof b.excluded !== 'boolean') {
    return { ok: false, error: 'excluded must be a boolean' };
  }
  if (b.email !== undefined && b.emails !== undefined) {
    return { ok: false, error: 'Send either email or emails, not both' };
  }

  if (b.emails !== undefined) {
    if (!Array.isArray(b.emails) || b.emails.length === 0) {
      return { ok: false, error: 'emails must be a non-empty array' };
    }
    if (b.emails.length > PAB_EXCLUSION_BATCH_MAX) {
      return { ok: false, error: `At most ${PAB_EXCLUSION_BATCH_MAX} people per request` };
    }
    const emails: string[] = [];
    const seen = new Set<string>();
    for (const e of b.emails) {
      const norm = typeof e === 'string' ? e.trim().toLowerCase() : '';
      if (!norm) return { ok: false, error: 'Every entry in emails must be a non-empty string' };
      if (seen.has(norm)) continue;
      seen.add(norm);
      emails.push(norm);
    }
    return { ok: true, monthKey, emails, excluded: b.excluded, batch: true };
  }

  const norm = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!norm) return { ok: false, error: 'Missing email' };
  return { ok: true, monthKey, emails: [norm], excluded: b.excluded, batch: false };
}

/**
 * The stored blob, parsed for a WRITE. `parsePabPeriodExclusions` (the reader
 * every pay path uses) turns malformed JSON into an empty map, which is right for
 * a reader and catastrophic for a writer: the read-patch-write would save
 * `{ <month>: [one person] }` over every other month's entries (629 of them on
 * 2026-10-05). So a non-empty value that is not a JSON object refuses the write.
 */
export function parseStoredPabExclusionsForWrite(
  raw: string | null,
): { ok: true; exclusions: PabExclusionsMap } | { ok: false } {
  if (raw == null || raw.trim() === '') return { ok: true, exclusions: new Map() };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  return { ok: true, exclusions: parsePabPeriodExclusions(raw) };
}
