/**
 * The scheduled-deletion reaper's HOLD rule — who it must never delete.
 *
 * `app/api/cron/process-scheduled-deletions` fires `offboarding_delete`, which permanently deletes the
 * Workspace account behind a work email (and emails the leaver). Its queue is any row whose legacy
 * 14-day timer elapsed, and nothing on that row says whether the person is still gone. Measured
 * 2026-10-01 (audit item 301): of 83 overdue timers, THREE belong to people who are working:
 *
 *   - a rehire on a NEW master row with the SAME work email (live row, 20 h in the live week);
 *   - a person with NO live row at all who logged Hubstaff time on the account in the live week;
 *   - a rehire on a NEW work email whose personal email is on a live row.
 *
 * So a row is fired only when NONE of the signals below says the person is here. Every signal can
 * only HOLD: a held row gets no webhook and no write, and it is reported. That is what makes it safe
 * to hold on a personal email — an inbox shared by two people can produce a false hold, never a
 * deletion and never a write (`offboarding-automation.md`, "personal email … nothing may ever key off
 * it"). Clearing the timer would be a write keyed off exactly such a match, so the rule never clears.
 *
 * Work emails are recycled across people (memory `rehire-invisible-offboard-reuse`): a work-email hit
 * may be a DIFFERENT live person holding the same address, which is worse, not better — deleting the
 * account would delete theirs.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseHubstaffDurationSeconds } from '@/lib/hubstaff/duration';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';

export type DeletionHoldReason =
  /** A row that is not off-boarded carries this work email — the account is in use. */
  | 'work_email_on_live_row'
  /** A row that is not off-boarded carries this personal email — the person is back. */
  | 'personal_email_on_live_row'
  /** A hire on this work email is in flight, or was promoted after the off-board. */
  | 'later_hire_on_work_email'
  /** The current Hubstaff upload shows worked time on this work email. */
  | 'hubstaff_time_in_live_week';

/** Pending-hire statuses that are still on their way onto the roster. */
const IN_FLIGHT_HIRE_STATUSES: ReadonlySet<string> = new Set([
  'pending_work_email',
  'ready',
  'failed_to_promote',
]);

export interface PendingHireRow {
  id: number | string;
  work_email: string | null;
  status: string | null;
  created_at: string | null;
}

export interface DeletionGuardIndex {
  liveWorkEmails: ReadonlySet<string>;
  livePersonalEmails: ReadonlySet<string>;
  pendingHires: readonly PendingHireRow[];
  hubstaffWorkedEmails: ReadonlySet<string>;
}

export interface DeletionCandidate {
  workEmail: string | null;
  personalEmail: string | null;
  /** When the person left. A promoted hire created after this is a rehire. Null = unknown. */
  leftAt: string | null;
  /** The hr_pending_employees row the candidate IS (no-show branch), never counted as a later hire. */
  ownPendingId?: number | string | null;
}

/** Trimmed, lower-cased; an empty value is null so it can never match anything. */
export function normEmail(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase();
  return s ? s : null;
}

/**
 * Every reason this candidate must NOT be deleted. Empty means the reaper may fire.
 */
export function deletionHoldReasons(c: DeletionCandidate, idx: DeletionGuardIndex): DeletionHoldReason[] {
  const reasons: DeletionHoldReason[] = [];
  const work = normEmail(c.workEmail);
  const personal = normEmail(c.personalEmail);

  if (work && idx.liveWorkEmails.has(work)) reasons.push('work_email_on_live_row');
  if (personal && idx.livePersonalEmails.has(personal)) reasons.push('personal_email_on_live_row');

  if (work) {
    const leftAtMs = c.leftAt ? Date.parse(c.leftAt) : NaN;
    const laterHire = idx.pendingHires.some((p) => {
      if (c.ownPendingId != null && String(p.id) === String(c.ownPendingId)) return false;
      if (normEmail(p.work_email) !== work) return false;
      const status = (p.status ?? '').trim();
      if (IN_FLIGHT_HIRE_STATUSES.has(status)) return true;
      if (status !== 'promoted') return false;
      // An unknown departure date, or an unreadable hire date, cannot prove the hire came first.
      if (!Number.isFinite(leftAtMs)) return true;
      const createdMs = p.created_at ? Date.parse(p.created_at) : NaN;
      return !Number.isFinite(createdMs) || createdMs > leftAtMs;
    });
    if (laterHire) reasons.push('later_hire_on_work_email');
  }

  if (work && idx.hubstaffWorkedEmails.has(work)) reasons.push('hubstaff_time_in_live_week');
  return reasons;
}

export interface HeldDeletion {
  work_email: string | null;
  reasons: DeletionHoldReason[];
}

/** Split a due queue into what may fire and what is held, preserving order. */
export function splitDueDeletions<T>(
  due: readonly T[],
  candidateOf: (row: T) => DeletionCandidate,
  idx: DeletionGuardIndex,
): { fire: T[]; held: HeldDeletion[] } {
  const fire: T[] = [];
  const held: HeldDeletion[] = [];
  for (const row of due) {
    const c = candidateOf(row);
    const reasons = deletionHoldReasons(c, idx);
    if (reasons.length) held.push({ work_email: normEmail(c.workEmail), reasons });
    else fire.push(row);
  }
  return { fire, held };
}

/**
 * Read every signal, paged past the 1,000-row cap. ANY failed read returns an error and the caller
 * must fire NOTHING: a partial index would read as "nobody is here" and fail open on a deletion path.
 */
export async function loadDeletionGuardIndex(
  supabase: SupabaseClient,
  opts: { masterTable: string; hubstaffTable: string },
): Promise<{ index: DeletionGuardIndex; error: null } | { index: null; error: string }> {
  const live = await selectAllPaged<{ id: unknown; 'Work Email': string | null; 'Personal Email': string | null }>(
    (from, to) =>
      supabase
        .from(opts.masterTable)
        .select('id, "Work Email", "Personal Email"')
        .is('off_boarded_at', null)
        .order('id', { ascending: true })
        .range(from, to),
  );
  if (live.error) return { index: null, error: `live roster read failed: ${live.error}` };

  const pending = await selectAllPaged<PendingHireRow>((from, to) =>
    supabase
      .from('hr_pending_employees')
      .select('id, work_email, status, created_at')
      .not('work_email', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (pending.error) return { index: null, error: `pending hires read failed: ${pending.error}` };

  const { data: current, error: currentErr } = await supabase
    .from('hubstaff_uploads')
    .select('id')
    .eq('is_current', true)
    .limit(1)
    .maybeSingle();
  if (currentErr) return { index: null, error: `current Hubstaff upload read failed: ${currentErr.message}` };
  const uploadId = (current as { id?: unknown } | null)?.id;
  if (uploadId == null || uploadId === '') {
    return { index: null, error: 'no current Hubstaff upload, so live-week time cannot be checked' };
  }

  const hours = await selectAllPaged<{ id: unknown; Email: string | null; 'Total worked': unknown }>((from, to) =>
    supabase
      .from(opts.hubstaffTable)
      .select('id, "Email", "Total worked"')
      .eq('upload_id', uploadId)
      .order('id', { ascending: true })
      .range(from, to),
  );
  if (hours.error) return { index: null, error: `live-week Hubstaff read failed: ${hours.error}` };

  const liveWorkEmails = new Set<string>();
  const livePersonalEmails = new Set<string>();
  for (const r of live.rows) {
    const w = normEmail(r['Work Email']);
    const p = normEmail(r['Personal Email']);
    if (w) liveWorkEmails.add(w);
    if (p) livePersonalEmails.add(p);
  }
  const hubstaffWorkedEmails = new Set<string>();
  for (const r of hours.rows) {
    const e = normEmail(r.Email);
    if (e && parseHubstaffDurationSeconds(r['Total worked']) > 0) hubstaffWorkedEmails.add(e);
  }

  return {
    index: { liveWorkEmails, livePersonalEmails, pendingHires: pending.rows, hubstaffWorkedEmails },
    error: null,
  };
}
