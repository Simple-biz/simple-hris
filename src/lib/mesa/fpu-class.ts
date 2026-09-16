/**
 * FPU classes — the pure half. Browser-safe (no server imports); shared by the
 * HR routes, the employee route and both UIs so the label, the window rule and
 * the "which class is current" pick are ONE definition.
 *
 * A class is (year, batch) — "FPU 2026 · Batch 1". Its enrollment window is
 * `opens_on..closes_on` INCLUSIVE, compared as Manila calendar dates
 * (`YYYY-MM-DD` strings compare lexically). "If they miss it they miss it."
 */

import { isCalendarDate } from './enrollment-date';

export interface FpuClass {
  id: string;
  year: number;
  batch: number;
  opens_on: string;
  closes_on: string;
  class_starts_on: string;
  class_ends_on: string | null;
  schedule_note: string | null;
}

export type FpuClassPhase = 'upcoming' | 'open' | 'closed';

export const FPU_ENROLLMENT_STATUSES = ['pending', 'approved', 'denied', 'completed'] as const;
export type FpuEnrollmentStatus = (typeof FPU_ENROLLMENT_STATUSES)[number];

/** "FPU 2026 · Batch 1" */
export function fpuClassLabel(cls: Pick<FpuClass, 'year' | 'batch'>): string {
  return `FPU ${cls.year} · Batch ${cls.batch}`;
}

/** Stable short key, e.g. "2026-1". */
export function fpuClassKey(cls: Pick<FpuClass, 'year' | 'batch'>): string {
  return `${cls.year}-${cls.batch}`;
}

/** Where `today` (Manila ISO) sits relative to the enrollment window. */
export function fpuClassPhase(cls: Pick<FpuClass, 'opens_on' | 'closes_on'>, today: string): FpuClassPhase {
  if (today < cls.opens_on) return 'upcoming';
  if (today > cls.closes_on) return 'closed';
  return 'open';
}

/** The batch number a new class in `year` should take: one past the highest. */
export function nextFpuBatch(classes: Pick<FpuClass, 'year' | 'batch'>[], year: number): number {
  let max = 0;
  for (const c of classes) if (c.year === year && c.batch > max) max = c.batch;
  return max + 1;
}

/**
 * The class the employee surface shows. Exactly one of:
 *   1. the class whose window contains today (open) — if two overlap, the one
 *      that closes first, since that is the deadline that matters;
 *   2. else the nearest upcoming class;
 *   3. else the most recently closed class (so the page can say "closed");
 *   4. else null — no class has ever been created.
 */
export function pickCurrentFpuClass<T extends Pick<FpuClass, 'opens_on' | 'closes_on'>>(
  classes: T[],
  today: string,
): T | null {
  const open = classes.filter((c) => fpuClassPhase(c, today) === 'open').sort((a, b) => a.closes_on.localeCompare(b.closes_on));
  if (open[0]) return open[0];
  const upcoming = classes.filter((c) => fpuClassPhase(c, today) === 'upcoming').sort((a, b) => a.opens_on.localeCompare(b.opens_on));
  if (upcoming[0]) return upcoming[0];
  const closed = classes.filter((c) => fpuClassPhase(c, today) === 'closed').sort((a, b) => b.closes_on.localeCompare(a.closes_on));
  return closed[0] ?? null;
}

/** Newest first: by year, then batch. */
export function sortFpuClasses<T extends Pick<FpuClass, 'year' | 'batch'>>(classes: T[]): T[] {
  return [...classes].sort((a, b) => b.year - a.year || b.batch - a.batch);
}

export interface FpuClassInput {
  year: number;
  batch: number;
  opens_on: string;
  closes_on: string;
  class_starts_on: string;
  class_ends_on: string | null;
  schedule_note: string | null;
}

export type FpuClassValidation = { ok: true; value: FpuClassInput } | { ok: false; error: string };

/**
 * Validate a create/edit payload at the route boundary, before anything reaches
 * Postgres. Mirrors the table's CHECKs (so the user sees a sentence, not a
 * constraint name) and adds the strict calendar-date rule the DB cannot express.
 */
export function validateFpuClassInput(raw: unknown): FpuClassValidation {
  const b = (raw ?? {}) as Record<string, unknown>;
  const year = Number(b.year);
  const batch = Number(b.batch);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return { ok: false, error: 'Year must be a four-digit year.' };
  if (!Number.isInteger(batch) || batch < 1 || batch > 12) return { ok: false, error: 'Batch must be a whole number from 1 to 12.' };

  const dateField = (key: string, label: string, required: boolean): string | null | { error: string } => {
    const v = b[key];
    if (v == null || v === '') return required ? { error: `${label} is required.` } : null;
    if (typeof v !== 'string' || !isCalendarDate(v)) return { error: `${label} must be a real calendar date (YYYY-MM-DD).` };
    return v;
  };
  const opens = dateField('opens_on', 'Enrollment opens', true);
  if (typeof opens === 'object' && opens) return { ok: false, error: opens.error };
  const closes = dateField('closes_on', 'Enrollment closes', true);
  if (typeof closes === 'object' && closes) return { ok: false, error: closes.error };
  const starts = dateField('class_starts_on', 'Class start', true);
  if (typeof starts === 'object' && starts) return { ok: false, error: starts.error };
  const ends = dateField('class_ends_on', 'Class end', false);
  if (typeof ends === 'object' && ends) return { ok: false, error: ends.error };

  if ((closes as string) < (opens as string)) return { ok: false, error: 'Enrollment cannot close before it opens.' };
  if (ends && (ends as string) < (starts as string)) return { ok: false, error: 'The class cannot end before it starts.' };

  const noteRaw = b.schedule_note;
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim().slice(0, 300) : null;

  return {
    ok: true,
    value: {
      year,
      batch,
      opens_on: opens as string,
      closes_on: closes as string,
      class_starts_on: starts as string,
      class_ends_on: (ends as string | null) ?? null,
      schedule_note: note,
    },
  };
}

export function isFpuEnrollmentStatus(s: unknown): s is FpuEnrollmentStatus {
  return typeof s === 'string' && (FPU_ENROLLMENT_STATUSES as readonly string[]).includes(s);
}
