/**
 * Pure matching + labelling for Penny's `find_employee`.
 *
 * Until 2026-09-15 the tool searched the ACTIVE roster only, so a person
 * off-boarded the day before a question was asked simply "wasn't in the
 * system" (Carla, about adrianm@simple.biz, off-boarded 2026-09-14). History
 * questions are very often about leavers, so the search now covers both — but
 * every match carries its `status`, and a leaver is never presented as a roster
 * member: active matches rank first, and an off-boarded match says when, why
 * and by whom.
 *
 * This module is deliberately free of I/O so the rules can be tested without a
 * database. `ceo-tools.ts` (server-only) does the reads and calls in here.
 */

export type RosterStatus = 'active' | 'offboarded';

export interface RosterCandidate {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  /** The roster department (active) or the LATEST stamped row's department. */
  department: string | null;
  employee_id: string | null;
  status: RosterStatus;
  /** `YYYY-MM-DD` — present only when `status === 'offboarded'`. */
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
  /** Every department the person's stamped master rows carried — a person with
   *  two rows (e.g. "Lead Gen" and "hsl:attestation") sits in two calculators,
   *  which is exactly the kind of fact a bonus question needs. */
  departments: string[];
}

/** One raw `global_master_list` row that carries an off-board stamp. */
export interface OffboardedMasterRow {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  employee_id: string | null;
  /** ISO timestamp or date — normalised to `YYYY-MM-DD` here. */
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
}

const lower = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();

/** Calendar-date prefix of an ISO timestamp/date; null when unparseable. */
export function isoDay(v: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((v ?? '').trim());
  return m ? m[1]! : null;
}

/**
 * The matching rule, unchanged from the active-only version: an email query
 * (contains `@`) matches the work OR personal address EXACTLY; anything else
 * matches the name as a substring or the work-email local part.
 */
export function matchesRosterQuery(
  c: Pick<RosterCandidate, 'name' | 'work_email' | 'personal_email'>,
  rawQuery: string,
): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return false;
  const name = lower(c.name);
  const we = lower(c.work_email);
  const pe = lower(c.personal_email);
  if (q.includes('@')) return we === q || pe === q;
  const local = we.split('@')[0] ?? '';
  return name.includes(q) || local.includes(q);
}

/**
 * Collapse stamped master rows into one candidate per PERSON.
 *
 * - Grouped by work email (a person's duplicate rows share it); rows with no
 *   work email fall back to the personal email, then to name + employee id.
 * - The LATEST stamp wins for date / reason / actor / department; every row's
 *   department is kept in `departments`.
 * - Anyone whose work email is on the ACTIVE roster is dropped: the active view
 *   is the authority on "still here", and a stamped duplicate beside an active
 *   row must never make a current employee read as a leaver.
 */
export function collapseOffboardedRows(
  rows: OffboardedMasterRow[],
  activeWorkEmails: Set<string>,
): RosterCandidate[] {
  const byPerson = new Map<string, RosterCandidate & { _stamp: string }>();
  for (const r of rows) {
    const we = lower(r.work_email);
    const pe = lower(r.personal_email);
    if (we && activeWorkEmails.has(we)) continue;
    const key = we || (pe ? `personal:${pe}` : `row:${lower(r.name)}|${r.employee_id ?? ''}`);
    const day = isoDay(r.off_boarded_at) ?? '';
    const dept = (r.department ?? '').trim() || null;
    const cur = byPerson.get(key);
    if (!cur) {
      byPerson.set(key, {
        name: r.name ?? null,
        work_email: r.work_email ?? null,
        personal_email: r.personal_email ?? null,
        department: dept,
        employee_id: r.employee_id ?? null,
        status: 'offboarded',
        off_boarded_at: day || null,
        off_boarded_reason: r.off_boarded_reason ?? null,
        off_boarded_by: r.off_boarded_by ?? null,
        departments: dept ? [dept] : [],
        _stamp: day,
      });
      continue;
    }
    if (dept && !cur.departments.includes(dept)) cur.departments.push(dept);
    if (day > cur._stamp) {
      cur._stamp = day;
      cur.off_boarded_at = day;
      cur.off_boarded_reason = r.off_boarded_reason ?? cur.off_boarded_reason;
      cur.off_boarded_by = r.off_boarded_by ?? cur.off_boarded_by;
      cur.department = dept ?? cur.department;
    }
    if (!cur.employee_id && r.employee_id) cur.employee_id = r.employee_id;
    if (!cur.name && r.name) cur.name = r.name;
  }
  return [...byPerson.values()].map(({ _stamp: _ignored, ...c }) => c);
}

/** Active first; then leavers newest-departure first; ties by name. */
export function rankRosterMatches(matches: RosterCandidate[]): RosterCandidate[] {
  return [...matches].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    if (a.status === 'offboarded') {
      const d = (b.off_boarded_at ?? '').localeCompare(a.off_boarded_at ?? '');
      if (d !== 0) return d;
    }
    return lower(a.name).localeCompare(lower(b.name));
  });
}

/** The nudge Penny reads after the match list. */
export function rosterMatchNote(matches: RosterCandidate[]): string | undefined {
  if (matches.length === 0) {
    return 'No employee matched — active OR off-boarded. Try a different spelling, or ask the user for the work email.';
  }
  const active = matches.filter((m) => m.status === 'active').length;
  const gone = matches.length - active;
  if (matches.length > 1) {
    return (
      'Multiple matches — ask the user which person (department or work email) before looking anything up.' +
      (gone ? ` ${gone} of them ${gone === 1 ? 'is' : 'are'} OFF-BOARDED — say so if you present them.` : '')
    );
  }
  if (gone === 1) {
    const m = matches[0]!;
    return `This person is OFF-BOARDED${m.off_boarded_at ? ` since ${m.off_boarded_at}` : ''}${
      m.off_boarded_reason ? ` (reason: ${m.off_boarded_reason})` : ''
    }${m.off_boarded_by ? `, recorded by ${m.off_boarded_by}` : ''}. Their history and pay records are still searchable with the other tools; use get_offboarding_info for the full off-boarding record. Never describe them as a current employee.`;
  }
  return undefined;
}
