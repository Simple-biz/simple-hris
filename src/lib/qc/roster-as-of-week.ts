/**
 * Who was in a QC department **during the scored week** — as opposed to who is
 * in it today.
 *
 * The deal used to draw its slots from the live active roster, whatever week it
 * was dealing. That is right only while the week being scored is the week you
 * are standing in. Carla, 2026-09-14: *"there's going to be people that were
 * offboarded that are on the usual list that Jackie sends us, but they're not
 * going to be assigned because they've been offboarded and they'd have to be
 * added externally into the lead gen. And same if they got transferred to HSL"*
 * — and, asked whether it was already handled: *"That's not happening. Every
 * time someone gets transferred, we have to just add it externally."* Kane:
 * *"if they have an appointment, or within the week if they were just midweek
 * transferred — within the week if they are still legion at that time, they can
 * still be scored."*
 *
 * With 50–75 people offboarded a week, the gap is simply the days between a
 * week ending and an officer opening the dashboard: anyone who left or moved in
 * that window vanished from the only roster the deal could see.
 *
 * ## Every rule here fires on a POSITIVE record, never on an absence
 *
 * Transfer data in this system is known to be incomplete — a move can go
 * unfiled entirely ([[markm-hsl-transfer-never-filed]]) and a master-sheet sync
 * can clobber a department ([[hris-is-dept-source-of-truth]]). So nobody is
 * dropped because a record is *missing*; they are dropped only when a filed,
 * applied/approved transfer says in so many words that they arrived after the
 * week was over. An absent record always means "keep" — the house pattern, and
 * the only safe direction when the alternative is failing to pay someone.
 *
 * ## The three rules
 *
 * - **KEEP** everyone the live roster already puts in the department (this is
 *   the old behaviour, untouched) unless rule 3 fires.
 * - **ADD** people who were in the department during the week and have since
 *   left it: offboarded, or moved out on a transfer effective after the week
 *   ended — both inside the churn window below.
 * - **DROP** people who arrived *after* the week ended — a filed transfer INTO
 *   the department dated past the week end. A midweek arrival is kept, per
 *   Kane above: being there for part of the week is being there.
 *
 * ## The window is bounded at BOTH ends
 *
 * Carla: *"If I was offboarded today, I should be on the list next week, but
 * then after that I am gone."* Payroll runs a week in arrears, so someone
 * stamped on a Monday still has two weeks owed to them — the completed week
 * being scored right now, and the part-week they were stamped in. After that
 * they are done.
 *
 * A departure counts for week `W` only while
 * `weekStart <= when <= weekEnd + CHURN_GRACE_DAYS`:
 *
 * - The **lower** bound is "then I am gone" — stamped before the week began,
 *   they were already gone and their final cheque went out in an earlier run.
 * - The **upper** bound stops a closed week being rewritten, and is why this
 *   covers only the churn gap (see CHURN_GRACE_DAYS). Measured on real data:
 *   unbounded, opening the June 21 period today would have dealt **240** new
 *   slots into a long-closed week.
 *
 * Start date still gates separately, in the caller: someone who had not joined
 * yet cannot be scored, and an unknown start date is kept.
 *
 * Pure — no I/O, no Supabase — so `node:test` can exercise every branch and the
 * caller owns the reads.
 */

/**
 * `YYYY-MM-DD` day strings compare correctly as strings — but ONLY if they are
 * real days. A shape-only check lets `2026-13-40` through, and it then sorts
 * above every real date, so a garbage transfer date would read as "effective
 * after this week" and silently drop the person from the deal. Caught by test.
 * Same failure class as franm@'s `2027-04-20` offboard stamp.
 */
import { calendarDay as day } from './period';

/**
 * How far past a week's end a departure may fall and still count as "they were
 * here during that week".
 *
 * This window exists to cover ONE gap: the days between a week ending and an
 * officer opening the dashboard, during which someone can leave or move and so
 * disappear from the roster the deal reads. Two payroll cycles is generous for
 * a late scoring run and still short enough that a closed week stays closed.
 *
 * It is NOT a claim about who was in the department. Someone who moved out of
 * Lead Gen two months after the week was obviously in Lead Gen that week — but
 * they were also on the live roster when that week was dealt, so the roster
 * path already has them. Only the churn gap needs covering.
 *
 * Measured on real data (`scripts/verify-qc-roster-as-of-week.mts`): unbounded,
 * opening the June 21 period today would have dealt **240** new slots into a
 * closed week. The upsert is diff-only and never deletes, so that is history
 * being written that was never true of the week — exactly what `qc-scoring.md`
 * means by "forward only".
 */
const CHURN_GRACE_DAYS = 14;

/** `YYYY-MM-DD` plus `n` days, in UTC so no DST boundary can shift it. */
function addDays(isoDay: string, n: number): string {
  const dt = new Date(Date.UTC(+isoDay.slice(0, 4), +isoDay.slice(5, 7) - 1, +isoDay.slice(8, 10) + n));
  return dt.toISOString().slice(0, 10);
}


/** A person who might hold a slot, from the live roster or an offboard record. */
export interface AsOfWeekCandidate {
  /** The email the slot is keyed on (personal-first, matching the roster). */
  email: string;
  /** Every identity email this person answers to, for transfer matching. */
  identityEmails: readonly string[];
  name: string | null;
  /** Normalized department key as recorded TODAY (or at offboard). */
  departmentKey: string | null;
  /** `YYYY-MM-DD` they left, or null while employed. */
  offBoardedAt: string | null;
}

/** One applied/approved department move. */
export interface AsOfWeekTransfer {
  identityEmails: readonly string[];
  /** Normalized department keys; null when the cell was unparseable. */
  fromKey: string | null;
  toKey: string | null;
  /** `YYYY-MM-DD`, verbatim from the transfer — never snapped. */
  effectiveDate: string | null;
}

export interface AsOfWeekSlot {
  email: string;
  name: string | null;
  /** The QC department key this slot scores. */
  dept: string;
  /** Why this person is in the week — for the audit trail, not for gating. */
  basis: 'roster' | 'offboarded-during-week' | 'transferred-out-after-week';
}

/**
 * Build the (member, department) slots that should exist for the week starting
 * `weekStart` and ending `weekEnd` (both `YYYY-MM-DD`, inclusive).
 *
 * `isScoredDept` decides which department keys QC scores — passed in rather
 * than imported so this module can never be the place `QC_DEPT_KEYS` gets
 * quietly widened (`qc-scoring.md`: *"the roster READ widened; the KEYS did
 * not"*).
 */
export function qcSlotsAsOfWeek(opts: {
  /** Everyone on the live active roster. */
  roster: readonly AsOfWeekCandidate[];
  /** People with an offboard stamp — the roster cannot see them at all. */
  offboarded: readonly AsOfWeekCandidate[];
  transfers: readonly AsOfWeekTransfer[];
  weekStart: string;
  weekEnd: string;
  /** A type predicate, so a scored key narrows to `string` by being checked
   *  rather than by a `!` further down. */
  isScoredDept: (key: string | null) => key is string;
}): AsOfWeekSlot[] {
  const { roster, offboarded, transfers, weekStart, weekEnd, isScoredDept } = opts;
  const start = day(weekStart);
  const end = day(weekEnd);
  // Without a well-formed week there is nothing to scope to. Returning the
  // live roster unchanged is the pre-existing behaviour, and the caller's
  // Sunday lock (src/lib/qc/period.ts) makes this unreachable in practice.
  if (!start || !end) {
    const out: AsOfWeekSlot[] = [];
    for (const p of roster) {
      if (isScoredDept(p.departmentKey)) {
        out.push({ email: p.email, name: p.name, dept: p.departmentKey, basis: 'roster' });
      }
    }
    return out;
  }

  const add = (m: Map<string, Set<string>>, email: string, dept: string) => {
    const set = m.get(email);
    if (set) set.add(dept);
    else m.set(email, new Set([dept]));
  };
  /** Moves INTO a scored dept, effective strictly after the week ended. */
  const arrivedAfter = new Map<string, Set<string>>();
  /** Moves OUT of a scored dept, effective strictly after the week ended. */
  const leftAfter = new Map<string, Set<string>>();
  // Only moves inside the churn window count. Effective ON or BEFORE the week's
  // end means they were in the department during it (handled by the roster
  // path); effective beyond the window means the week was already dealt with
  // them on the roster, so re-deriving it now would only rewrite a closed week.
  const churnHorizon = addDays(end, CHURN_GRACE_DAYS);
  for (const t of transfers) {
    const eff = day(t.effectiveDate);
    if (!eff || eff <= end || eff > churnHorizon) continue;
    if (isScoredDept(t.toKey)) {
      for (const e of t.identityEmails) if (e) add(arrivedAfter, e, t.toKey);
    }
    if (isScoredDept(t.fromKey)) {
      for (const e of t.identityEmails) if (e) add(leftAfter, e, t.fromKey);
    }
  }
  const anyOf = (m: Map<string, Set<string>>, emails: readonly string[]): Set<string> => {
    const out = new Set<string>();
    for (const e of emails) for (const d of m.get(e) ?? []) out.add(d);
    return out;
  };

  const slots: AsOfWeekSlot[] = [];
  const seen = new Set<string>();
  const push = (email: string, name: string | null, dept: string, basis: AsOfWeekSlot['basis']) => {
    const key = `${email}|${dept}`;
    if (!email || seen.has(key)) return;
    seen.add(key);
    slots.push({ email, name, dept, basis });
  };

  for (const p of roster) {
    if (!isScoredDept(p.departmentKey)) continue;
    // A filed transfer says they arrived in this department only AFTER the week
    // was over, so they cannot have been scored in it. A midweek arrival has an
    // effective date inside the week and never reaches here.
    if (anyOf(arrivedAfter, p.identityEmails).has(p.departmentKey)) continue;
    push(p.email, p.name, p.departmentKey, 'roster');
  }

  // Moved OUT of a scored dept after the week ended — still there during it.
  for (const p of roster) {
    for (const dept of anyOf(leftAfter, p.identityEmails)) {
      push(p.email, p.name, dept, 'transferred-out-after-week');
    }
  }

  // Left the company inside the leaver window: they worked into this week and
  // their final scores are still owed. Stamped BEFORE it began and they were
  // already gone; stamped more than a week after it ended and this week's pay
  // ran long ago, so adding them now would rewrite a closed week.
  const lastOwedDay = churnHorizon;
  for (const p of offboarded) {
    const off = day(p.offBoardedAt);
    if (!off || off < start || off > lastOwedDay) continue;
    if (isScoredDept(p.departmentKey)) {
      push(p.email, p.name, p.departmentKey, 'offboarded-during-week');
    }
    for (const dept of anyOf(leftAfter, p.identityEmails)) {
      push(p.email, p.name, dept, 'offboarded-during-week');
    }
  }

  return slots;
}
