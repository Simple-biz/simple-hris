/**
 * Who may enroll in an FPU class — the ONE definition, browser-safe.
 *
 * Kane, 2026-09-16: "only people Promoted to Global Master List and are Active
 * should be able to Opt in here … Eligible being 3 months of service from Start
 * date. so even if they miss 1 day thats already unqualified."
 *
 * Rulings (2026-09-16):
 *  - Tenure is measured against the CLASS START DATE, not the day they click:
 *    eligible iff start_date + 3 calendar months <= class_starts_on. The
 *    verdict is therefore fixed for the whole window.
 *  - A missing or unparseable roster Start Date is INELIGIBLE (fails closed).
 *    The old form failed open.
 *
 * The server (`POST /api/fpu-enroll`) re-derives this verdict from its own
 * reads. The UI only paints what it was handed.
 */

import { fpuClassPhase, type FpuClass } from './fpu-class';

export const FPU_TENURE_MONTHS = 3;

/**
 * Parse the roster's Start Date cell — `YYYY-MM-DD`, `MM/DD/YY`, `MM/DD/YYYY`,
 * or anything `Date` can read — into a calendar ISO date. Returns null on
 * garbage; the caller treats null as ineligible.
 */
export function parseRosterStartDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return d.getUTCMonth() === +iso[2] - 1 && d.getUTCDate() === +iso[3] ? d.toISOString().slice(0, 10) : null;
  }
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
  if (slash) {
    let y = +slash[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const m = +slash[1];
    const day = +slash[2];
    const d = new Date(Date.UTC(y, m - 1, day));
    return d.getUTCMonth() === m - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null;
  }
  const fallback = new Date(s);
  if (Number.isNaN(fallback.getTime())) return null;
  return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, '0')}-${String(fallback.getDate()).padStart(2, '0')}`;
}

/** `iso` plus N calendar months, clamped to the target month's last day. */
export function addCalendarMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** The first day this person qualifies: start + 3 calendar months. */
export function fpuEligibleFrom(startIso: string): string {
  return addCalendarMonths(startIso, FPU_TENURE_MONTHS);
}

export type FpuIneligibleReason =
  | 'no_class'
  | 'already_enrolled'
  | 'already_completed'
  | 'off_roster'
  | 'no_start_date'
  | 'tenure'
  | 'not_open_yet'
  | 'closed';

export type FpuVerdict =
  | { ok: true; startDate: string; eligibleFrom: string }
  | { ok: false; reason: FpuIneligibleReason; detail: string; eligibleFrom?: string };

export interface FpuVerdictInput {
  /** Today in Manila, YYYY-MM-DD. */
  today: string;
  cls: Pick<FpuClass, 'opens_on' | 'closes_on' | 'class_starts_on'> | null;
  /** Active on the Global Master List (not offboarded). */
  onActiveRoster: boolean;
  /** Raw roster Start Date cell. */
  startDate: string | null | undefined;
  /** `mesa_fpu_completed_on` set, or already a MESA member. */
  alreadyCompletedFpu: boolean;
  /** This person's existing enrollment in THIS class, if any. */
  existingStatus: string | null;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The verdict, in a fixed order so the sentence the employee reads is the one
 * that actually blocks them:
 *   no class → already enrolled → already completed → off roster → no start
 *   date → tenure → not open yet → closed.
 * Tenure sits before the window on purpose: "you qualify from Dec 16" is more
 * useful to someone who would not qualify anyway than "enrollment is closed".
 */
export function fpuVerdict(input: FpuVerdictInput): FpuVerdict {
  const { today, cls } = input;
  if (!cls) return { ok: false, reason: 'no_class', detail: 'No FPU class is scheduled yet.' };
  if (input.existingStatus) {
    return { ok: false, reason: 'already_enrolled', detail: 'You already enrolled in this class.' };
  }
  if (input.alreadyCompletedFpu) {
    return { ok: false, reason: 'already_completed', detail: 'You have already completed FPU.' };
  }
  if (!input.onActiveRoster) {
    return { ok: false, reason: 'off_roster', detail: 'Only active employees on the Global Master List can enroll.' };
  }
  const startIso = parseRosterStartDate(input.startDate);
  if (!startIso) {
    return {
      ok: false,
      reason: 'no_start_date',
      detail: 'Your start date is missing from the roster. Ask HR to fix it before enrolling.',
    };
  }
  const eligibleFrom = fpuEligibleFrom(startIso);
  if (eligibleFrom > cls.class_starts_on) {
    return {
      ok: false,
      reason: 'tenure',
      eligibleFrom,
      detail: `You need ${FPU_TENURE_MONTHS} months of service by class start (${longDate(cls.class_starts_on)}). You qualify from ${longDate(eligibleFrom)}.`,
    };
  }
  const phase = fpuClassPhase(cls, today);
  if (phase === 'upcoming') {
    return { ok: false, reason: 'not_open_yet', eligibleFrom, detail: `Enrollment opens ${longDate(cls.opens_on)}.` };
  }
  if (phase === 'closed') {
    return { ok: false, reason: 'closed', eligibleFrom, detail: `Enrollment closed ${longDate(cls.closes_on)}.` };
  }
  return { ok: true, startDate: startIso, eligibleFrom };
}
