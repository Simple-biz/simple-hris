/**
 * When the money actually turns up, as told to the employee on
 * Profile → Compensation → Current Paycycle.
 *
 * DISPLAY COPY ONLY (Kane, 2026-09-22: *"These are just documentation and text
 * which are to be displayed not a code issue"*). Nothing in here is read by
 * `scheduledPayDateIso`, by the wizard, or by Payment Dispatch, and nothing in
 * here may appear on a pay stub (*"this should not show in PAYSTUB"*). The real
 * disbursement date is still `src/lib/payroll/pay-schedule.ts` and is still the
 * only thing a statement prints.
 *
 * It is a module rather than a string in the component for one reason: this is
 * a claim about people's money, and when a rail's day changes it must change in
 * ONE place. A second copy in JSX is how the employee's screen and the
 * accountant's schedule would drift apart without either being edited.
 *
 * ── Why the days here differ from `pay-schedule.ts`, deliberately ────────────
 * `pay-schedule.ts` computes two buckets: wires → Thursday, everything else →
 * Tuesday. The copy below says wires → WEDNESDAY, because that is what Kane
 * wrote and he ruled twice that this note is text, not the schedule. The two
 * are allowed to differ BECAUSE this module never prints a date: it describes a
 * typical week in words, while the Pay Stubs section one pane away prints the
 * real `payDate`. If this module ever starts printing an actual date, that
 * exemption dies and the days must be reconciled first.
 */
import { PROCESSOR_OPTIONS, type ProcessorId } from '@/lib/employee-payment-processors';

/** Day-of-week indices, matching `Date.getDay()` so a caller can compare directly. */
export const TUESDAY = 2;
export const WEDNESDAY = 3;
export const FRIDAY = 5;

export type ArrivalDay = typeof TUESDAY | typeof WEDNESDAY;

/**
 * The rail → typical-arrival-day map.
 *
 * Keyed on `ProcessorId` and NOT partial, so adding a seventh rail to
 * `PROCESSOR_OPTIONS` is a compile error here rather than a person silently
 * inheriting someone else's day. `paycycle-arrival.test.ts` pins the same
 * property at runtime for the case where the union is widened by inference.
 *
 * Kane's ruling named Wise on BOTH Tuesday and Thursday ("if they are Higlobe
 * or Wise they should expect their payout on Tuesday … if Wise on Thursday").
 * The first clause is kept — it names Wise explicitly alongside Higlobe — and
 * the trailing duplicate is dropped, because keeping it would contradict his
 * own sentence. Kolan, Wepay and Jeeves were not named and take the Tuesday
 * default, which is also what `pay-schedule.ts` computes for them.
 */
export const ARRIVAL_DAY_BY_RAIL: Record<ProcessorId, ArrivalDay> = {
  hurupay: TUESDAY, // labelled "Kolan" since the 2026-08-24 rebrand; the id never moves
  higlobe: TUESDAY,
  wise: TUESDAY,
  wepay: TUESDAY,
  jeeves: TUESDAY,
  wires: WEDNESDAY,
};

/** Day names, indexed by `Date.getDay()`. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function arrivalDayName(day: ArrivalDay): string {
  return DAY_NAMES[day] ?? '';
}

/**
 * The arrival day for one rail. An unknown or absent rail returns null rather
 * than guessing Tuesday — a person whose payout method is not set yet should be
 * told the Friday promise and nothing more specific, because the specific
 * answer would be invented.
 */
export function arrivalDayForRail(rail: ProcessorId | null | undefined): ArrivalDay | null {
  if (!rail) return null;
  return ARRIVAL_DAY_BY_RAIL[rail] ?? null;
}

/** One row of the note's small rail table. */
export interface ArrivalRow {
  /** Display label, from `PROCESSOR_OPTIONS` so a rebrand reaches this too. */
  label: string;
  day: ArrivalDay;
  dayName: string;
}

/**
 * The note's rows, grouped so identical days render as one line rather than
 * five. Order follows `PROCESSOR_OPTIONS`, and RETIRED rails are included on
 * purpose: someone is still being paid through them, and this note is for the
 * person being paid, not for the picker.
 */
export function arrivalRows(): ArrivalRow[] {
  return PROCESSOR_OPTIONS.map((p) => {
    const day = ARRIVAL_DAY_BY_RAIL[p.id];
    return { label: p.label, day, dayName: arrivalDayName(day) };
  });
}

/** `[{ dayName, labels }]` — one entry per distinct day, in day order. */
export function arrivalGroups(): { day: ArrivalDay; dayName: string; labels: string[] }[] {
  const byDay = new Map<ArrivalDay, string[]>();
  for (const row of arrivalRows()) {
    const list = byDay.get(row.day);
    if (list) list.push(row.label);
    else byDay.set(row.day, [row.label]);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, labels]) => ({ day, dayName: arrivalDayName(day), labels }));
}

/**
 * The promise, and the hedge, in the register the rest of the employee surfaces
 * already use (`getMyPaySchedule`'s field_notes). Exported as data so the test
 * can assert what it claims — a string built inline in JSX cannot be pinned.
 *
 * It states Friday FIRST and last. An earlier arrival is described as a
 * consequence of processing time, never as an entitlement, because a person who
 * reads "Tuesday" as a promise and is paid on Friday has been told a lie by
 * this screen.
 */
export const ARRIVAL_NOTE = {
  headline: 'Payday is Friday.',
  body:
    'Depending on how you are paid, the transfer is often released earlier in the week — that is ' +
    'processing lead time, not an earlier payday. If it takes the full time, it arrives on Friday.',
  expect: 'Expect your pay on Friday.',
} as const;
