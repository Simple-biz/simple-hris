import 'server-only';

/**
 * Who actually logged hours in a pay cycle's Hubstaff timesheet — the HARD
 * gate for every final-pay surface (Kane, 2026-08-07: "we only want people who
 * had work the previous week to get paid on that").
 *
 * Date-based week-scoping (`offboardedRelevantToWeek`) alone is not enough:
 * it trusts `off_boarded_at`, and one bad stamp defeats it entirely. Live case:
 * franm@simple.biz exists ONLY as an `offboarded_sheet` row stamped
 * `2027-04-20` — a year-typo for 2026 — which reads as "left during or after"
 * every week until then, so she rode the Offboarded tab and the wizard's
 * final-pay overlay for months after her real last hours (week of 2026-04-19).
 * Hours in the cycle's actual file can't be forged by a bad date: either the
 * timesheet has you or it doesn't.
 *
 * Matching is by normalized email OR exact name-token key — the same two ways
 * the wizard's own resolver matches a calc row to a person, so the gate can
 * never exclude someone the wizard could actually pay.
 */
import { normEmail } from '@/lib/email/norm-email';
import { normalizeNameTokens } from '@/lib/name/name-tokens';
import {
  listHubstaffUploads,
  fetchHubstaffRowsBySourceFile,
  rowsToPayrollRows,
} from '@/lib/supabase/hubstaff-hours-db';

export interface CycleHoursIndex {
  /** Every normalized email with a row in the cycle's timesheet. */
  emails: Set<string>;
  /** Every `normalizeNameTokens` key with a row in the cycle's timesheet. */
  nameTokenKeys: Set<string>;
  /** The file the index was built from (param, else the `is_current` upload). */
  sourceFile: string | null;
  /** Non-null when the index could not be built. Consumers FAIL OPEN on it —
   *  hiding someone owed money because a read hiccuped is the wrong direction —
   *  but must say so out loud (degraded note / error field). */
  error: string | null;
}

const EMPTY = (error: string): CycleHoursIndex => ({
  emails: new Set(),
  nameTokenKeys: new Set(),
  sourceFile: null,
  error,
});

export async function loadCycleHoursIndex(sourceFile: string | null): Promise<CycleHoursIndex> {
  try {
    let file = (sourceFile ?? '').trim() || null;
    if (!file) {
      const uploads = await listHubstaffUploads();
      file = (uploads.find((u) => u.is_current) ?? uploads[0])?.source_file ?? null;
    }
    if (!file) return EMPTY('No Hubstaff upload to build the cycle hours index from');

    const { rows } = await fetchHubstaffRowsBySourceFile(file);
    const emails = new Set<string>();
    const nameTokenKeys = new Set<string>();
    for (const r of rowsToPayrollRows(rows)) {
      const em = normEmail(r.email ?? '');
      if (em) emails.add(em);
      if (r.name) {
        const t = normalizeNameTokens(r.name);
        if (t) nameTokenKeys.add(t);
      }
    }
    return { emails, nameTokenKeys, sourceFile: file, error: null };
  } catch (e) {
    return EMPTY(e instanceof Error ? e.message : 'Cycle hours index failed to load');
  }
}

/** Whether a person is present in the cycle's timesheet, by any of their known
 *  emails or by exact name-token key. */
export function personWorkedCycle(
  idx: CycleHoursIndex,
  person: { emails: (string | null | undefined)[]; name?: string | null },
): boolean {
  for (const e of person.emails) {
    const n = normEmail(e ?? '');
    if (n && idx.emails.has(n)) return true;
  }
  if (person.name) {
    const t = normalizeNameTokens(person.name);
    if (t && idx.nameTokenKeys.has(t)) return true;
  }
  return false;
}
