// Bonus Library versioning + change history — the pure part.
//
// A bonus definition carries a version number; each save that changes a TRACKED
// field snapshots a new version row with the date it takes effect. Assignment
// changes (added / removed / exclusions / shared-team) land as events. Both are
// DISPLAY + AUDIT only: the KPI Calculator keeps paying the live definition and
// bonus_catalog_applied keeps its own apply-time snapshot. Nothing here reads
// the database; src/lib/supabase/bonus-catalog-db.ts calls these when it saves.

import type { BonusAssignment, BonusCadence, BonusDef, BonusKind } from './types';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';

/** The fields whose change mints a new version. `starred` is deliberately NOT
 *  here — it is a display-only highlight (bonus-catalog.md "star/highlight"). */
export const TRACKED_BONUS_FIELDS = [
  'name',
  'description',
  'kind',
  'amount',
  'formula',
  'currency',
  'cadence',
] as const;
export type TrackedBonusField = (typeof TRACKED_BONUS_FIELDS)[number];

export const TRACKED_FIELD_LABELS: Record<TrackedBonusField, string> = {
  name: 'Name',
  description: 'Description',
  kind: 'Type',
  amount: 'Amount',
  formula: 'Formula',
  currency: 'Currency',
  cadence: 'Frequency',
};

/** A saved version of a bonus, as the history route returns it. */
export interface BonusVersion {
  id: number;
  bonusId: string;
  version: number;
  name: string;
  description?: string;
  kind: BonusKind;
  amount?: number;
  formula?: string;
  currency: PayCurrency;
  cadence: BonusCadence;
  changedFields: TrackedBonusField[];
  /** YYYY-MM-DD — the day this version takes effect. */
  effectiveFrom: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export type AssignmentEventKind = 'added' | 'removed' | 'exclusions_changed' | 'shared_team_changed';

/** One assignment change, as the history route returns it. */
export interface AssignmentEvent {
  id: number;
  bonusId: string;
  assignmentId: string;
  event: AssignmentEventKind;
  scope: BonusAssignment['scope'];
  departmentKey: string;
  employeeEmail?: string;
  employeeName?: string;
  excludedBefore: string[];
  excludedAfter: string[];
  sharedTeam: boolean | null;
  effectiveFrom: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

// ── Normalisation ─────────────────────────────────────────────────────────────
// Two definitions that differ only in representation (undefined vs '', 'PHP' vs
// absent, "1500" vs 1500) are the SAME version — otherwise every re-save of a
// legacy row would mint a phantom version.

function normText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normAmount(kind: BonusKind, v: unknown): number | null {
  if (kind !== 'flat') return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function normalizedTracked(
  b: Pick<BonusDef, TrackedBonusField>,
): Record<TrackedBonusField, string | number | null> {
  const kind: BonusKind = b.kind === 'formula' ? 'formula' : 'flat';
  return {
    name: normText(b.name),
    description: normText(b.description),
    kind,
    amount: normAmount(kind, b.amount),
    formula: kind === 'formula' ? normText(b.formula) : '',
    currency: b.currency ?? 'PHP',
    cadence: b.cadence === 'monthly' ? 'monthly' : 'weekly',
  };
}

/** Which tracked fields differ between the stored definition and the incoming
 *  one. Empty ⇒ no new version. `prev === null` (a brand-new bonus) ⇒ every
 *  non-empty field, so v1 lists what it was created with. */
export function diffBonusFields(
  prev: Pick<BonusDef, TrackedBonusField> | null,
  next: Pick<BonusDef, TrackedBonusField>,
): TrackedBonusField[] {
  const n = normalizedTracked(next);
  if (!prev) {
    return TRACKED_BONUS_FIELDS.filter((f) => n[f] !== '' && n[f] !== null);
  }
  const p = normalizedTracked(prev);
  return TRACKED_BONUS_FIELDS.filter((f) => p[f] !== n[f]);
}

/** Lower-cased, trimmed, de-duplicated, sorted — so two exclusion lists compare
 *  by membership, not by the order someone ticked the boxes. */
export function normalizeEmailList(list: readonly string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const e of list ?? []) {
    const k = typeof e === 'string' ? e.trim().toLowerCase() : '';
    if (k) out.add(k);
  }
  return Array.from(out).sort();
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The events an assignment upsert produces. A new assignment is `added`; an
 *  existing one yields one event per changed facet (both can fire on one save).
 *  Employee-scope assignments have no exclusions/shared-team, so an edit that
 *  changes nothing tracked yields []. */
export function diffAssignment(prev: BonusAssignment | null, next: BonusAssignment): AssignmentEventKind[] {
  if (!prev) return ['added'];
  const events: AssignmentEventKind[] = [];
  if (next.scope === 'department') {
    if (!sameList(normalizeEmailList(prev.excludedEmails), normalizeEmailList(next.excludedEmails))) {
      events.push('exclusions_changed');
    }
    if (!!prev.sharedTeam !== !!next.sharedTeam) events.push('shared_team_changed');
  }
  return events;
}

// ── Effective date ────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar date as YYYY-MM-DD (no UTC shift — a Manila-evening save must
 *  not be dated tomorrow or yesterday). */
export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Validates a client-supplied effective date. Absent ⇒ today (the save is
 *  effective immediately). Anything present must be a REAL YYYY-MM-DD date —
 *  "2026-02-30" and "09/14/2026" are rejected, not coerced. */
export function parseEffectiveDate(
  input: unknown,
  now: Date = new Date(),
): { ok: true; iso: string } | { ok: false; error: string } {
  if (input == null || input === '') return { ok: true, iso: todayIso(now) };
  if (typeof input !== 'string') return { ok: false, error: 'effectiveDate must be a YYYY-MM-DD string' };
  const m = ISO_DATE.exec(input.trim());
  if (!m) return { ok: false, error: 'effectiveDate must be YYYY-MM-DD' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return { ok: false, error: `effectiveDate ${input} is not a real calendar date` };
  }
  return { ok: true, iso: `${m[1]}-${m[2]}-${m[3]}` };
}

/** The effective date a bonus row reports: its stored `effective_from`, else the
 *  day it was created (rows that pre-date the migration have no stored date). */
export function bonusEffectiveFrom(b: Pick<BonusDef, 'effectiveFrom' | 'createdAt'>): string | null {
  if (b.effectiveFrom) return b.effectiveFrom;
  if (!b.createdAt) return null;
  const d = new Date(b.createdAt);
  return Number.isNaN(d.getTime()) ? null : todayIso(d);
}
