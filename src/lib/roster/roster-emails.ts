import { normEmail } from '@/lib/email/norm-email';
import type { EmployeeRow } from '@/lib/supabase/employees';

/** Every normalized email on the Global Master List roster (work, personal,
 *  and both alternate work emails), for membership checks against
 *  email-keyed feature tables. */
export function buildRosterEmailSet(employees: EmployeeRow[]): Set<string> {
  const set = new Set<string>();
  for (const e of employees) {
    for (const raw of [e.work_email, e.personal_email, e.alternate_work_email, e.alternate_work_email_2]) {
      const norm = normEmail(raw ?? '');
      if (norm) set.add(norm);
    }
  }
  return set;
}

export interface RosterEmailStatus {
  active: boolean;
  /** ISO date/timestamp; set only when `active` is false and a stamp exists. */
  offBoardedAt: string | null;
  /** Raw reason slug (see src/lib/hr/offboard-reasons.ts) — null for an
   *  unstamped "fell off the sheet" drop or a pre-reason-column stamp. */
  offBoardedReason: string | null;
}

/** Fetch every Global Master List email's active/offboarded status, keyed by
 *  normalized email. Reads global_master_list directly (service role) via
 *  /api/roster/gml-status — NOT /api/employees, whose active_employees view
 *  is RLS-blocked for the anon key and returns almost nothing (confirmed
 *  2026-08-03; only the manually-seeded US-xxxx accounts survive it), which
 *  previously false-flagged real active people — e.g. internal devs whose
 *  master row exists but isn't part of the latest sheet upload — as off-GML. */
export async function fetchRosterStatusMap(): Promise<Map<string, RosterEmailStatus>> {
  const res = await fetch('/api/roster/gml-status', { cache: 'no-store' });
  if (!res.ok) throw new Error(`roster status HTTP ${res.status}`);
  const json = (await res.json()) as {
    statuses?: { email: string; active: boolean; offBoardedAt: string | null; offBoardedReason: string | null }[];
    error?: string | null;
  };
  if (json.error) throw new Error(json.error);
  const statuses = json.statuses ?? [];
  // A real master list is never empty — treat empty as failure rather than
  // letting an empty allow-set hide/flag every row as off-roster.
  if (statuses.length === 0) throw new Error('Global Master List roster unavailable');
  const map = new Map<string, RosterEmailStatus>();
  for (const s of statuses) {
    map.set(s.email, { active: s.active, offBoardedAt: s.offBoardedAt, offBoardedReason: s.offBoardedReason });
  }
  return map;
}

/** Fetch the active roster as a plain email Set, for simple membership
 *  checks (see isOnRoster). Built from the same source as
 *  fetchRosterStatusMap — every email with `active: true`. */
export async function fetchRosterEmailSet(): Promise<Set<string>> {
  const map = await fetchRosterStatusMap();
  const set = new Set<string>();
  for (const [email, status] of map) if (status.active) set.add(email);
  return set;
}

/** True when the email belongs to someone on the Global Master List roster. */
export function isOnRoster(rosterEmails: Set<string>, email: string | null | undefined): boolean {
  const norm = normEmail(email ?? '');
  return norm !== null && rosterEmails.has(norm);
}
