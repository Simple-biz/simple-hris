/**
 * Who the KPI Calculator's "Add External Member" picker can offer
 * (`DeptBonusCalculator`), beyond what `/api/manager/transfer-candidates` returns.
 *
 * Without `?purpose=transfer` that endpoint drops every department the manager
 * holds (`candidatePool`, `department-transfers.md` § The candidate picker). The
 * rule is correct for the endpoint, but it made anyone in a SECOND department the
 * manager holds unreachable from the first one's card. cjm@ was granted Lead Gen
 * on 2026-09-23. From then on, the Lead Gen VAs she had added to Client VA as
 * externals every week (rjq@, charlesla@: 08-30, 09-06, 09-13) were "not on the
 * master list" in her Client VA picker.
 *
 * The fix mirrors "Add missing as externals" (`qc-scoring.md` § Add missing): the
 * master-list results plus the manager's OWN roster, minus whoever is already on
 * THIS card. "External" means external to the card, not to every team the
 * manager holds. The endpoint's contract is unchanged.
 *
 * The roster passed in is the UNFILTERED one, so that people the departed guard
 * hides from this week's table can still be added. johnpaulc@ (Client VA,
 * working) is hidden on 2026-09-20 because a stale Lead Gen off-board record
 * outlives him and the week has no Hubstaff file yet (audit item 131). Add
 * External Member is the documented recovery path for someone the table does
 * not serve (`hsl-kpi-calculator-2026-07.md`). Those picks carry
 * `hiddenThisWeek` so the picker can say why they are not on the table.
 */

import { normEmail } from '@/lib/email/norm-email';

/** A manager-roster row — the fields of `EmployeeRow` this needs. */
export interface RosterPerson {
  name: string | null;
  department: string | null;
  personal_email: string | null;
  work_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
}

/** One person the picker can offer. Same shape as a transfer-candidates row. */
export interface ExternalPick {
  name: string;
  department: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** On the manager's roster but hidden from this week's table by the departed guard. */
  hiddenThisWeek?: boolean;
}

/** Every address a person is known by, normalized and de-duplicated. */
export function addressesOf(p: {
  personal_email?: string | null;
  work_email?: string | null;
  alternate_work_email?: string | null;
  alternate_work_email_2?: string | null;
}): string[] {
  const out: string[] = [];
  for (const e of [p.personal_email, p.work_email, p.alternate_work_email, p.alternate_work_email_2]) {
    const n = normEmail(e ?? null);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The manager's own roster people who are NOT on this card, as picks.
 *
 * @param roster the manager's roster, UNFILTERED by the departed guard.
 * @param cardEmails normalized emails of everyone already on this card. Any
 *   address of a roster person matching one means they are on the card.
 * @param departed the departed-guard set for the week in view.
 */
export function rosterExternalCandidates(
  roster: readonly RosterPerson[],
  cardEmails: ReadonlySet<string>,
  departed: ReadonlySet<string>,
): ExternalPick[] {
  const seen = new Set<string>();
  const out: ExternalPick[] = [];
  for (const r of roster) {
    const name = (r.name ?? '').trim();
    const addrs = addressesOf(r);
    if (!name || addrs.length === 0) continue;
    if (addrs.some((a) => cardEmails.has(a))) continue;
    // One human, several roster rows (a transfer inserts a row and orphans the
    // first): offer them once.
    if (addrs.some((a) => seen.has(a))) continue;
    for (const a of addrs) seen.add(a);
    out.push({
      name,
      department: r.department,
      work_email: normEmail(r.work_email ?? null),
      personal_email: normEmail(r.personal_email),
      hiddenThisWeek: addrs.some((a) => departed.has(a)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The server's `?q=` match, applied locally to the roster picks: a substring
 *  of name, department, work email or personal email. */
export function externalPickMatches(c: ExternalPick, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, c.department, c.work_email, c.personal_email].some((f) =>
    (f ?? '').toLowerCase().includes(q),
  );
}

/**
 * The list the picker renders. Server results already on the card are dropped
 * (the add would refuse them anyway). When both lists hold the same person, the
 * roster copy is kept because it carries `hiddenThisWeek`.
 */
export function mergeExternalPicks(
  server: readonly ExternalPick[],
  roster: readonly ExternalPick[],
  cardEmails: ReadonlySet<string>,
): ExternalPick[] {
  const rosterAddrs = new Set(roster.flatMap((c) => addressesOf(c)));
  const fromServer = server.filter((c) => {
    const addrs = addressesOf(c);
    return !addrs.some((a) => cardEmails.has(a) || rosterAddrs.has(a));
  });
  return [...roster, ...fromServer].sort((a, b) => a.name.localeCompare(b.name));
}
