/**
 * "Add missing as externals" — who is on Jackie's sheet, or in the QC first
 * pass, but NOT on this week's manager table, and what to add them as.
 *
 * Pure. The component resolves the two rosters it can reach (the week-scoped
 * Offboarded · last pay list and the active master list) into `KnownPerson`s,
 * each already carrying the ONE email its applied row must be keyed on so the
 * wizard can pay it; this module only decides, per off-table person, whether
 * they are known, what count they get, and who is a PROBLEM. Keeping the
 * pay-key decision in the caller is deliberate: the rule differs by source
 * (offboarded ⇒ Hubstaff login; active ⇒ personal-first like every roster row)
 * and this module must never guess it — a wrong key pays ₱0 silently.
 *
 * WHY THIS EXISTS (2026-09-14, wk 2026-09-06, all measured)
 * ---------------------------------------------------------
 * 27 people QC scored above zero had no applied row at all: 12 were leavers the
 * Offboarded strip could add one click at a time, 15 had transferred to HSL
 * after the week and NOTHING in the UI reached them. Jackie's sheet listed 73
 * more lines Compare refused as `unmatched`, because a pasted WORK email cannot
 * bridge to a PERSONAL-keyed QC row when the person is not on the table to
 * bridge through. Carla: a button so staff stop hand-entering them. Kane:
 * "add that button where we can add them into the thing as externals" and
 * "if one of those people doesnt appear on the global master list then they
 * should be marked as problems".
 *
 * COUNTS: the sheet wins. A person on both the sheet and the first pass takes
 * the pasted count (Override's own rule — the officers cannot see her sheet).
 * A person only QC scored takes the QC count; QC-scored at ZERO and not on the
 * sheet is NOT added (nothing to pay, and it would only lengthen the table) —
 * counted in `skippedZeroQc` so the number is visible, never silent.
 *
 * PROBLEMS: a person no record knows (not active on the master list, not a
 * recent leaver), an address two people share, or a second sheet line for the
 * same person. Named, with the reason, never added, never guessed.
 */

import type { PastedCount, QcSubmissionLite } from './compare';

export interface KnownPerson {
  name: string;
  /** Every address this person is known under — work, personal, Hubstaff, alternates. */
  emails: readonly (string | null | undefined)[];
  /** The email the applied row is keyed on: the one the wizard resolves for this
   *  source. Non-empty; the caller filters people it cannot key. */
  payKey: string;
  source: 'offboarded' | 'active';
  /** Where they are NOW (active) or were (offboarded) — display only. */
  department: string | null;
}

export interface TableMember {
  canonical: string;
  emails: readonly string[];
}

export interface MissingAdd {
  name: string;
  payKey: string;
  source: KnownPerson['source'];
  department: string | null;
  count: number;
  countSource: 'sheet' | 'qc';
  /** Sheet line, when the count came from the sheet. */
  line: number | null;
  /** The officer who scored them, when QC did. */
  scoredBy: string | null;
}

export type MissingProblemKind = 'not_on_master_list' | 'ambiguous' | 'duplicate_person' | 'no_bonus';

export interface MissingProblem {
  who: string;
  email: string;
  kind: MissingProblemKind;
  reason: string;
  line: number | null;
}

export interface MissingResult {
  add: MissingAdd[];
  problems: MissingProblem[];
  /** QC-scored at zero, not on the sheet, not on the table — deliberately not added. */
  skippedZeroQc: number;
}

function norm(e: string | null | undefined): string {
  return (e ?? '').trim().toLowerCase();
}

function readVar(vars: Record<string, number> | null, name: string): number | null {
  if (!vars) return null;
  const v = vars[name];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function findMissingPeople(input: {
  members: readonly TableMember[];
  pasted: readonly PastedCount[];
  qcRows: readonly QcSubmissionLite[];
  known: readonly KnownPerson[];
  /** The department's formula variable (e.g. `Appts_Set`). Null ⇒ nothing can be scored. */
  varName: string | null;
}): MissingResult {
  const { members, pasted, qcRows, known, varName } = input;

  const onTable = new Set<string>();
  for (const m of members) {
    for (const e of [m.canonical, ...m.emails]) {
      const k = norm(e);
      if (k) onTable.add(k);
    }
  }

  // email → every known person holding it. A Set so a collision is DETECTED and
  // refused as ambiguous rather than resolved by whoever was listed last.
  const knownByEmail = new Map<string, Set<KnownPerson>>();
  for (const p of known) {
    if (!norm(p.payKey)) continue;
    for (const e of [p.payKey, ...p.emails]) {
      const k = norm(e);
      if (!k) continue;
      const set = knownByEmail.get(k) ?? new Set<KnownPerson>();
      set.add(p);
      knownByEmail.set(k, set);
    }
  }

  const problems: MissingProblem[] = [];
  const planned = new Map<string, MissingAdd>(); // by payKey
  const lineByPayKey = new Map<string, number>();
  let skippedZeroQc = 0;

  const resolve = (email: string, who: string, line: number | null): KnownPerson | null => {
    const set = knownByEmail.get(norm(email));
    if (!set || set.size === 0) {
      problems.push({
        who,
        email,
        line,
        kind: 'not_on_master_list',
        reason: 'Not on the Global Master List as active, and not a recent leaver — fix the master list, or add them by hand with Add External Member',
      });
      return null;
    }
    if (set.size > 1) {
      problems.push({
        who,
        email,
        line,
        kind: 'ambiguous',
        reason: `That email belongs to ${set.size} people on record — fix the master list before adding`,
      });
      return null;
    }
    return [...set][0]!;
  };

  if (!varName) {
    const seen = new Set<string>();
    const flag = (who: string, email: string) => {
      const k = norm(email);
      if (!k || seen.has(k)) return;
      seen.add(k);
      problems.push({ who, email, line: null, kind: 'no_bonus', reason: 'This department has no formula bonus to score this week' });
    };
    for (const p of pasted) if (!onTable.has(norm(p.email))) flag(p.displayName || p.email, p.email);
    for (const r of qcRows) if (!onTable.has(norm(r.employee_email))) flag(r.employee_name || r.employee_email, r.employee_email);
    return { add: [], problems, skippedZeroQc: 0 };
  }

  // Pass A — the sheet. Everyone Jackie listed who is not on the table.
  for (const p of pasted) {
    if (onTable.has(norm(p.email))) continue; // Compare's business, not ours
    const person = resolve(p.email, p.displayName || p.email, p.line);
    if (!person) continue;
    const key = norm(person.payKey);
    if (onTable.has(key)) continue; // on the table under their pay key already
    const seenAt = lineByPayKey.get(key);
    if (seenAt !== undefined) {
      problems.push({
        who: p.displayName || p.email,
        email: p.email,
        line: p.line,
        kind: 'duplicate_person',
        reason: `Resolves to the same person as line ${seenAt}`,
      });
      continue;
    }
    lineByPayKey.set(key, p.line);
    planned.set(key, {
      name: person.name,
      payKey: key,
      source: person.source,
      department: person.department,
      count: p.count,
      countSource: 'sheet',
      line: p.line,
      scoredBy: null,
    });
  }

  // Pass B — the QC first pass. Anyone the officers scored who is not on the
  // table. The sheet's count stands where both exist; QC fills the rest.
  for (const r of qcRows) {
    const e = norm(r.employee_email);
    if (!e || onTable.has(e)) continue;
    const value = readVar(r.vars, varName);
    if (value === null) continue; // scored under a different variable — not ours to read
    const who = r.employee_name || r.employee_email;
    const set = knownByEmail.get(e);
    const already = set && set.size === 1 ? planned.get(norm([...set][0]!.payKey)) : undefined;
    if (already) {
      already.scoredBy = norm(r.scored_by) || null;
      continue;
    }
    if (value === 0) {
      skippedZeroQc += 1;
      continue;
    }
    const person = resolve(r.employee_email, who, null);
    if (!person) continue;
    const key = norm(person.payKey);
    if (onTable.has(key) || planned.has(key)) continue;
    planned.set(key, {
      name: person.name,
      payKey: key,
      source: person.source,
      department: person.department,
      count: value,
      countSource: 'qc',
      line: null,
      scoredBy: norm(r.scored_by) || null,
    });
  }

  const add = [...planned.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { add, problems, skippedZeroQc };
}
