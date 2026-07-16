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

/** Fetch the active roster (/api/employees = Global Master List minus
 *  offboarded) and return its email set. Throws on HTTP failure so callers
 *  fail loudly instead of silently rendering an unfiltered list. */
export async function fetchRosterEmailSet(): Promise<Set<string>> {
  const res = await fetch('/api/employees', { cache: 'no-store' });
  if (!res.ok) throw new Error(`employees HTTP ${res.status}`);
  const json = (await res.json()) as { employees?: EmployeeRow[]; error?: string | null };
  const employees = json.employees ?? [];
  // The endpoint reports DB failures as 200 + { employees: [], error }, and a
  // real roster is never empty — treat empty as failure rather than letting an
  // empty allow-set hide every MESA row.
  if (employees.length === 0) throw new Error(json.error ?? 'Employee roster unavailable');
  return buildRosterEmailSet(employees);
}

/** True when the email belongs to someone on the Global Master List roster. */
export function isOnRoster(rosterEmails: Set<string>, email: string | null | undefined): boolean {
  const norm = normEmail(email ?? '');
  return norm !== null && rosterEmails.has(norm);
}
