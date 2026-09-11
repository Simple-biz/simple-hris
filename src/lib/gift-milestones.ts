/**
 * Single source of truth for 6-month tenure milestones used by the Gift
 * Tracker and by the employee dashboard's shipping-form notification.
 * milestone_index = 1 → first 6-month gift, 2 → 12-month, etc.
 */

export interface GiftMilestone {
  index: number;
  date: Date;
}

/** Months between tenure gifts. milestone_index N is the (N x 6)-month gift. */
export const MONTHS_PER_MILESTONE = 6;

/**
 * "6-month" / "12-month" / … The ONE spelling of a milestone's name.
 *
 * Lived in `gift-tracker/shipping-export.ts` alone until 2026-09-11, when the
 * receipts ledger needed it too; the export's own wrapper still owns the
 * "None yet" display case and delegates here for the rest, so the roster, the
 * export and the ledger cannot label the same milestone differently.
 */
export function milestoneLabel(index: number): string {
  return `${index * MONTHS_PER_MILESTONE}-month`;
}

export function parseStartDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  const targetMonth = out.getMonth() + months;
  out.setMonth(targetMonth);
  if (out.getMonth() !== ((targetMonth % 12) + 12) % 12) out.setDate(0);
  return out;
}

function startOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

export function diffDays(a: Date, b: Date): number {
  const ms = startOfDay(a).getTime() - startOfDay(b).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/** Format a Date as YYYY-MM-DD (local) — DB date column wants ISO date. */
export function fmtDateIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Build all 6-month milestones from `start` up through `today` (history),
 * plus the very next future one.
 */
export function buildMilestones(
  start: Date,
  today: Date,
): { history: GiftMilestone[]; next: GiftMilestone | null } {
  const history: GiftMilestone[] = [];
  let next: GiftMilestone | null = null;
  for (let i = 1; i <= 60; i += 1) {
    const date = addMonths(start, i * MONTHS_PER_MILESTONE);
    if (startOfDay(date).getTime() <= startOfDay(today).getTime()) {
      history.push({ index: i, date });
    } else {
      next = { index: i, date };
      break;
    }
  }
  return { history, next };
}

/** Days within which the shipping form should be visible to the employee. */
export const SHIPPING_FORM_WINDOW_DAYS = 30;

/**
 * The milestone the employee should currently fill in, or null when none is
 * open. Returns the highest-indexed milestone whose window has opened (date
 * is within SHIPPING_FORM_WINDOW_DAYS in the future, on the milestone day,
 * or any number of days in the past). A milestone stays "current" until
 * the next one's window opens, regardless of approval state — the caller
 * checks the row's status to decide whether the form is locked.
 */
export function getCurrentShippingMilestone(
  start: Date | null,
  today: Date,
): GiftMilestone | null {
  if (!start) return null;
  let active: GiftMilestone | null = null;
  for (let i = 1; i <= 60; i += 1) {
    const date = addMonths(start, i * MONTHS_PER_MILESTONE);
    const daysUntil = diffDays(date, today);
    if (daysUntil <= SHIPPING_FORM_WINDOW_DAYS) {
      active = { index: i, date };
    } else {
      break;
    }
  }
  return active;
}
