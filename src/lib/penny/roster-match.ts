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
 * Since 2026-10-09 it also covers the `offboarded_sheet` LEDGER (Kane: "Admin -
 * Penny AI - Does not know about the Offboarded data"). The master-list stamps
 * reached only 1,520 of the ledger's 4,462 rows; the other 2,810 — every leaver
 * before the master list began on 2026-04-21, and HRIS offboards whose master
 * row is gone — were "not in the system". The ledger is the departures superset
 * (external-api-offboarded.md), so it is merged in by `mergeLedgerLeavers`.
 *
 * This module is deliberately free of I/O so the rules can be tested without a
 * database. `ceo-tools.ts` (server-only) does the reads and calls in here.
 */

import { nameKey, sameName } from '@/lib/payroll/paystub-delivery-address';
import { NOT_DEPARTURE, reasonKey, servedName, servedWorkEmail } from '@/lib/external-api/offboarded';

export type RosterStatus = 'active' | 'offboarded';

/** Where a leaver's departure is written down. */
export type LeaverSource = 'master_list' | 'offboarded_ledger';

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
  /** Leavers only: which records hold the departure. `['offboarded_ledger']`
   *  alone means there is NO master-list row — profile, rate, access and ID
   *  card tools have nothing for this person. */
  recorded_in?: LeaverSource[];
  /** Leavers only: the ACTIVE person (or people) who hold this work email now.
   *  Work emails are re-issued, so every email-keyed tool answers for THEM. */
  work_email_now_held_by?: string[];
  /** Leavers only: this is an EARLIER stint of someone who is ACTIVE again
   *  under these work emails — a re-hire, not a leaver today. */
  now_active_as?: string[];
}

/** One `offboarded_sheet` ledger row — one recorded departure. */
export interface LedgerLeaverRow {
  name: string | null;
  /** As stored: ~110 sheet-era rows hold a PERSONAL inbox here. */
  work_email: string | null;
  personal_email: string | null;
  department: string | null;
  off_boarded_at: string | null;
  off_boarded_reason: string | null;
  off_boarded_by: string | null;
}

/** An ACTIVE roster member, as the leaver merge needs them. */
export interface ActiveHolder {
  name: string | null;
  work_email: string | null;
  personal_email: string | null;
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
        recorded_in: ['master_list'],
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

/**
 * A ledger row's two addresses. `work_email` counts only on a company domain
 * (`servedWorkEmail`): ~110 sheet-era rows hold a personal inbox there, and
 * handing one to an email-keyed tool as a "work email" would be a lie. Such an
 * inbox becomes the personal address when the row has none.
 */
export function ledgerAddresses(
  r: Pick<LedgerLeaverRow, 'work_email' | 'personal_email'>,
): { work: string | null; personal: string | null } {
  const work = servedWorkEmail(r.work_email);
  const misfiled = !work && lower(r.work_email).includes('@') ? lower(r.work_email) : '';
  return { work, personal: lower(r.personal_email) || misfiled || null };
}

/**
 * Same human? The same personal inbox, or the same name by the paystub guard's
 * rule (`sameName`: one token set inside the other, at least two shared — Kane's
 * 432 ruling, "the NAME decides, never a date"). A shared WORK email proves
 * nothing: addresses are re-issued (`jamesc@` = three people).
 */
export function samePerson(
  a: { name: string | null; personal_email: string | null },
  b: { name: string | null; personal_email: string | null },
): boolean {
  const ap = lower(a.personal_email);
  if (ap && ap === lower(b.personal_email)) return true;
  return sameName(nameKey(a.name), nameKey(b.name));
}

/**
 * Merge the `offboarded_sheet` ledger into the master-list leavers.
 *
 * - **Not-a-departure rows are skipped** (`NOT_DEPARTURE`: temporary pause,
 *   "Active", the synthetic cleanup markers) — the same set the Offboarded
 *   dataset leaves out, reused rather than re-listed.
 * - **A departure of someone already listed joins their record** (same work
 *   email and the same person — or no name to tell them apart; or, with no
 *   company work email, the same personal inbox). Latest departure wins;
 *   departments union; `recorded_in` names both sources.
 * - **The active roster stays the authority.** A ledger row that is the same
 *   person as someone active (re-hire, still here) is dropped — their old
 *   departure is in `get_offboarding_info`. So is one on an active address when
 *   either name is missing: nothing proves it is someone else, and a current
 *   employee must never read as a leaver.
 * - **A PREVIOUS holder of a re-issued address is kept**, as their own person,
 *   with `work_email_now_held_by` naming who holds it now (People → Offboarded's
 *   warn-and-allow, people-offboarded-pay.md). Dropping them is how a leaver
 *   becomes "not in the system".
 */
export function mergeLedgerLeavers(
  ledger: LedgerLeaverRow[],
  masterLeavers: RosterCandidate[],
  active: ActiveHolder[],
): RosterCandidate[] {
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    if (!k) return;
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const holdersByWork = new Map<string, ActiveHolder[]>();
  const holdersByPersonal = new Map<string, ActiveHolder[]>();
  for (const h of active) {
    push(holdersByWork, lower(h.work_email), h);
    push(holdersByPersonal, lower(h.personal_email), h);
  }

  const out: RosterCandidate[] = [];
  const byWork = new Map<string, RosterCandidate[]>();
  const byPersonal = new Map<string, RosterCandidate[]>();
  const add = (c: RosterCandidate) => {
    out.push(c);
    push(byWork, lower(c.work_email), c);
    push(byPersonal, lower(c.personal_email), c);
  };
  for (const c of masterLeavers) {
    add({ ...c, departments: [...c.departments], recorded_in: [...(c.recorded_in ?? ['master_list'])] });
  }

  for (const r of ledger) {
    const reason = reasonKey(r.off_boarded_reason);
    if (reason && NOT_DEPARTURE.has(reason)) continue;
    const { work, personal } = ledgerAddresses(r);
    const name = servedName(r.name);
    if (!work && !personal && !name) continue;
    const me = { name, personal_email: personal };
    const day = isoDay(r.off_boarded_at);
    const dept = (r.department ?? '').trim() || null;
    const label = (r.off_boarded_reason ?? '').trim() || null;
    const by = (r.off_boarded_by ?? '').trim() || null;

    const into = work
      ? (byWork.get(work) ?? []).find((c) => !name || !c.name || samePerson(me, c))
      : personal
        ? (byPersonal.get(personal) ?? [])[0]
        : undefined;
    if (into) {
      if (!into.recorded_in!.includes('offboarded_ledger')) into.recorded_in!.push('offboarded_ledger');
      if (dept && !into.departments.includes(dept)) into.departments.push(dept);
      if (day && (!into.off_boarded_at || day > into.off_boarded_at)) {
        into.off_boarded_at = day;
        into.off_boarded_reason = label ?? into.off_boarded_reason;
        into.off_boarded_by = by ?? into.off_boarded_by;
        into.department = dept ?? into.department;
      }
      if (!into.name && name) into.name = name;
      if (!into.personal_email && personal) {
        into.personal_email = personal;
        push(byPersonal, personal, into);
      }
      continue;
    }

    const onWork = work ? (holdersByWork.get(work) ?? []) : [];
    const onPersonal = personal ? (holdersByPersonal.get(personal) ?? []) : [];
    const selves = [...new Set([...onWork, ...onPersonal])].filter((h) => samePerson(me, h));
    // The same person, active on THIS address: the active match already answers
    // a query for it.
    const queryAddr = work ?? personal;
    if (selves.some((h) => lower(h.work_email) === queryAddr || lower(h.personal_email) === queryAddr)) continue;
    if (onWork.length > 0 && !selves.length && (!name || onWork.some((h) => !servedName(h.name)))) continue;
    // The same person, active again under ANOTHER work email (measured
    // 2026-10-09: 44 ledger rows). Dropping the row made the OLD address "not in
    // the system", so the earlier stint stays — labelled with where they are now.
    const nowActiveAs = selves.map((h) => lower(h.work_email)).filter(Boolean);
    // Whoever ELSE holds this work email now (it was re-issued).
    const others = onWork.filter((h) => !selves.includes(h));

    add({
      name,
      work_email: work,
      personal_email: personal,
      department: dept,
      employee_id: null,
      status: 'offboarded',
      off_boarded_at: day,
      off_boarded_reason: label,
      off_boarded_by: by,
      departments: dept ? [dept] : [],
      recorded_in: ['offboarded_ledger'],
      ...(nowActiveAs.length ? { now_active_as: nowActiveAs } : {}),
      ...(others.length
        ? { work_email_now_held_by: others.map((h) => servedName(h.name)).filter((n): n is string => !!n) }
        : {}),
    });
  }
  return out;
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
  const reissued = matches.filter((m) => m.work_email_now_held_by?.length);
  const earlierStints = matches.filter((m) => m.now_active_as?.length);
  if (matches.length > 1) {
    return (
      'Multiple matches — ask the user which person (department or work email) before looking anything up.' +
      (gone ? ` ${gone} of them ${gone === 1 ? 'is' : 'are'} OFF-BOARDED — say so if you present them.` : '') +
      (reissued.length ? ` ${reissued.length} off-boarded match${reissued.length === 1 ? ' has a work email that was' : 'es have work emails that were'} RE-ISSUED to someone active (work_email_now_held_by) — say so if you present them.` : '') +
      (earlierStints.length ? ` ${earlierStints.length} off-boarded match${earlierStints.length === 1 ? ' is an EARLIER STINT of someone' : 'es are EARLIER STINTS of people'} ACTIVE again today (now_active_as) — the same person as their active record, not a leaver.` : '')
    );
  }
  const stints = gone === 1 ? matches[0]!.now_active_as : undefined;
  if (stints?.length) {
    const m = matches[0]!;
    return `This is an EARLIER STINT, not a leaver today: this person left${m.off_boarded_at ? ` on ${m.off_boarded_at}` : ''}${
      m.off_boarded_reason ? ` (reason: ${m.off_boarded_reason})` : ''
    } and is ACTIVE again as ${stints.join(' / ')}. They ARE a current employee — use that address for anything current. ${
      m.work_email_now_held_by?.length
        ? `Their old address was also RE-ISSUED to ${m.work_email_now_held_by.join(' / ')}, so records on it mix in that person's — check the name on each.`
        : 'This address holds only their earlier history.'
    } get_offboarding_info has the earlier departure.`;
  }
  if (gone === 1) {
    const m = matches[0]!;
    const ledgerOnly = m.recorded_in?.length === 1 && m.recorded_in[0] === 'offboarded_ledger';
    return (
      `This person is OFF-BOARDED${m.off_boarded_at ? ` since ${m.off_boarded_at}` : ' (departure date not recorded)'}${
        m.off_boarded_reason ? ` (reason: ${m.off_boarded_reason})` : ''
      }${m.off_boarded_by ? `, recorded by ${m.off_boarded_by}` : ''}. Their history and pay records are still searchable with the other tools; use get_offboarding_info for the full off-boarding record. Never describe them as a current employee.` +
      (ledgerOnly
        ? ' They are recorded ONLY on the Offboarded ledger — there is no master-list row (the master list starts 2026-04-21), so profile, rate, access and ID-card lookups will find nothing for them. That is expected; it does not mean they are unknown.'
        : '') +
      (m.work_email_now_held_by?.length
        ? ` Their work email ${m.work_email ?? ''} was RE-ISSUED and now belongs to ${m.work_email_now_held_by.join(' / ')} (active). Every tool keyed on that address — pay, rates, bank, timeline, audit — returns the CURRENT holder's records too; never attribute any of them to this person without checking the name and dates on each.`
        : '')
    );
  }
  return undefined;
}
