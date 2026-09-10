/**
 * Comparing Jackie's pasted appointment counts against the QC officers' first pass.
 *
 * Pure. The component resolves identity and applicable bonuses (it already has
 * `canonEmail`, `applicableBonuses` and `bonusVariables`) and hands the results
 * in; this module only decides, per person, which bucket they fall in and who
 * entered the QC number. Keeping it pure is what makes the four buckets testable
 * against fixtures that pin the LIVE variable names.
 *
 * TWO IDENTITY FACTS THIS DEPENDS ON
 * ----------------------------------
 * 1. Applied and QC rows are keyed PERSONAL-first — `rowEmail` / `memberEmail` =
 *    `personal_email || work_email` — while the paste supplies the WORK email.
 *    So a pasted email is bridged through the member's full email set to their
 *    canonical identity, and matching is done on the canonical, never on the
 *    pasted string. A work email that bridges to TWO canonicals is refused as
 *    ambiguous rather than guessed.
 * 2. The bonus variable is resolved PER MEMBER. In production the Lead Gen
 *    department bonus is `=IF(Appts_Set>=10, …)` (variable `Appts_Set`), but
 *    reinelr@ is excluded from it and holds an individual `Lead Gen (COP)` bonus
 *    whose variable is `Appts`. Assuming one variable would compare his paste
 *    against a key that does not exist on his row.
 *
 * WHAT "WRONG" MEANS (Kane, 2026-09-10)
 * -------------------------------------
 * The QC officer's count differs from Jackie's pasted count. In appointments.
 * No pesos, no tiers, no FX — the officers cannot see her sheet, so any delta is
 * a scoring error by definition, and the currency question never arises.
 */

export interface CompareMember {
  /** The identity every applied / QC row is keyed on (personal-first). */
  canonical: string;
  /** Every email that resolves to this person, lowercased: personal, work, alternates. */
  emails: readonly string[];
  name: string;
  /** For display beside the canonical when they differ. */
  workEmail: string | null;
  /** The formula bonus this member is scored under this week, and its variable.
   *  Null when no applicable formula bonus carries a variable — such a member
   *  cannot be compared and is refused, not silently skipped. */
  bonusId: string | null;
  varName: string | null;
}

export interface QcSubmissionLite {
  employee_email: string;
  bonus_id: string;
  vars: Record<string, number> | null;
  /** Who typed it — `qc_kpi_submissions.scored_by`, stamped from the officer's session. */
  scored_by: string | null;
}

export interface PastedCount {
  line: number;
  email: string;
  displayName: string;
  count: number;
}

export type CompareBucket = 'match' | 'mismatch' | 'paste_only' | 'qc_only';

export interface CompareEntry {
  bucket: CompareBucket;
  canonical: string;
  name: string;
  workEmail: string | null;
  bonusId: string;
  varName: string;
  /** Jackie's number. Null in `qc_only`. */
  pasted: number | null;
  /** The officer's number. Null in `paste_only`. */
  qc: number | null;
  /** The officer who entered `qc`. Null when there is no QC row. */
  scoredBy: string | null;
  /** The paste line this came from. Absent in `qc_only`. */
  line?: number;
}

export type CompareRefusalKind = 'unmatched' | 'ambiguous' | 'no_bonus' | 'duplicate_person';

export interface CompareRefusal {
  line: number;
  email: string;
  kind: CompareRefusalKind;
  reason: string;
}

export interface CompareResult {
  entries: CompareEntry[];
  refusals: CompareRefusal[];
  counts: Record<CompareBucket, number>;
}

function norm(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

function readVar(vars: Record<string, number> | null, name: string): number | null {
  if (!vars) return null;
  const v = vars[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function compareAppointments(
  pasted: readonly PastedCount[],
  members: readonly CompareMember[],
  qcRows: readonly QcSubmissionLite[],
): CompareResult {
  // email → every canonical it belongs to. A Set, so a collision is DETECTED
  // rather than overwritten (the component's own alias map is last-write-wins,
  // which is fine for its purpose and wrong for this one).
  const canonicalsByEmail = new Map<string, Set<string>>();
  const byCanonical = new Map<string, CompareMember>();
  for (const m of members) {
    const c = norm(m.canonical);
    if (!c) continue;
    byCanonical.set(c, m);
    for (const e of [m.canonical, ...m.emails]) {
      const k = norm(e);
      if (!k) continue;
      const set = canonicalsByEmail.get(k) ?? new Set<string>();
      set.add(c);
      canonicalsByEmail.set(k, set);
    }
  }

  // (canonical, bonus_id) → the QC row. One per key by the table's conflict target.
  const qcByKey = new Map<string, QcSubmissionLite>();
  for (const r of qcRows) {
    qcByKey.set(`${norm(r.employee_email)}|${r.bonus_id}`, r);
  }

  const entries: CompareEntry[] = [];
  const refusals: CompareRefusal[] = [];
  const lineByCanonical = new Map<string, number>();

  for (const p of pasted) {
    const key = norm(p.email);
    const set = canonicalsByEmail.get(key);
    if (!set || set.size === 0) {
      refusals.push({
        line: p.line,
        email: p.email,
        kind: 'unmatched',
        reason: 'No one in this department matches that work email',
      });
      continue;
    }
    if (set.size > 1) {
      refusals.push({
        line: p.line,
        email: p.email,
        kind: 'ambiguous',
        reason: `That email belongs to ${set.size} people on the roster — fix the master list before comparing`,
      });
      continue;
    }
    const canonical = [...set][0]!;
    const member = byCanonical.get(canonical)!;

    // Two pasted emails resolving to the SAME person (work + alternate): the second
    // is a duplicate of a person, not of a string — the parser cannot see this.
    const seenAt = lineByCanonical.get(canonical);
    if (seenAt !== undefined) {
      refusals.push({
        line: p.line,
        email: p.email,
        kind: 'duplicate_person',
        reason: `Resolves to the same person as line ${seenAt}`,
      });
      continue;
    }
    lineByCanonical.set(canonical, p.line);

    if (!member.bonusId || !member.varName) {
      refusals.push({
        line: p.line,
        email: p.email,
        kind: 'no_bonus',
        reason: `${member.name || canonical} has no formula bonus to score this week`,
      });
      continue;
    }

    const qc = qcByKey.get(`${canonical}|${member.bonusId}`);
    const qcValue = qc ? readVar(qc.vars, member.varName) : null;
    const base = {
      canonical,
      name: member.name,
      workEmail: member.workEmail,
      bonusId: member.bonusId,
      varName: member.varName,
      pasted: p.count,
      line: p.line,
    };
    if (!qc || qcValue === null) {
      entries.push({ ...base, bucket: 'paste_only', qc: null, scoredBy: qc ? norm(qc.scored_by) || null : null });
    } else if (qcValue === p.count) {
      entries.push({ ...base, bucket: 'match', qc: qcValue, scoredBy: norm(qc.scored_by) || null });
    } else {
      entries.push({ ...base, bucket: 'mismatch', qc: qcValue, scoredBy: norm(qc.scored_by) || null });
    }
  }

  // Officers scored people Jackie did not paste. Not an error — Kane: absence is
  // not zero — but it is information she needs to see.
  for (const m of members) {
    const c = norm(m.canonical);
    if (!c || lineByCanonical.has(c) || !m.bonusId || !m.varName) continue;
    const qc = qcByKey.get(`${c}|${m.bonusId}`);
    if (!qc) continue;
    const qcValue = readVar(qc.vars, m.varName);
    if (qcValue === null) continue;
    entries.push({
      bucket: 'qc_only',
      canonical: c,
      name: m.name,
      workEmail: m.workEmail,
      bonusId: m.bonusId,
      varName: m.varName,
      pasted: null,
      qc: qcValue,
      scoredBy: norm(qc.scored_by) || null,
    });
  }

  const counts: Record<CompareBucket, number> = { match: 0, mismatch: 0, paste_only: 0, qc_only: 0 };
  for (const e of entries) counts[e.bucket] += 1;

  return { entries, refusals, counts };
}

/**
 * The entries an Override actually changes: Jackie's number replaces the
 * officer's where they disagree, and fills in people the officers never scored.
 * Matches are already right, and `qc_only` has nothing of hers to apply.
 */
export function overrideTargets(result: CompareResult): CompareEntry[] {
  return result.entries.filter((e) => e.bucket === 'mismatch' || e.bucket === 'paste_only');
}
