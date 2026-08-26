/**
 * Shift windows, stored and compared as INTEGER MINUTES from local midnight.
 *
 * This module exists because of one measured failure mode. The only shift value
 * anywhere in the system today is `fpu_enrollments.shift_schedule_est`, which is
 * free text and holds exactly one row: `"9 AM TO 5 PM EST"`. The moment a second
 * person types `"9:00 AM - 5:00 PM"` for the same shift, a free-text column has
 * two categories where there is one shift, and every "headcount per shift window"
 * number splits down the middle.
 *
 * So the canonical form is not a string at all — it is `{ startMinute, endMinute }`,
 * and `shiftWindowKey` is what groups by. `"8AM-4PM"`, `"8:00 AM – 4:00 PM"` and
 * `"08:00-16:00"` all resolve to `480-960` and count as one window.
 *
 * `parseShiftWindow` is deliberately a REJECTING parser, not a guessing one — it
 * returns null rather than storing an interpretation it had to invent. That is the
 * same discipline `payrollWeekFilenameError` applies to Hubstaff batch names
 * (`calendar-column-dedupe.ts`): a value that cannot be addressed unambiguously is
 * refused at the point of entry, because a wrong value stored silently degrades
 * everywhere at once instead of failing once, loudly, in front of the person who
 * typed it.
 *
 * Client-safe: constants and pure functions only, no I/O.
 */

/** A shift window as minutes from local midnight. `end < start` spans midnight. */
export interface ShiftWindow {
  /** 0–1439. Minutes from local midnight. */
  startMinute: number;
  /** 0–1439. Less than `startMinute` for an overnight shift. */
  endMinute: number;
}

export const MINUTES_IN_DAY = 1440;

/** Separators a human writes between the two halves of a range. */
const SEPARATOR = /\s*(?:-{1,2}|–|—|\bto\b|\buntil\b|\btill\b)\s*/i;

/** Timezone suffixes we strip before parsing — they qualify the window, they are
 *  not part of it. The zone itself is stored in its own column. */
const TZ_SUFFIX =
  /\s*\(?\b(?:EST|EDT|ET|CST|CDT|CT|MST|MDT|PST|PDT|PT|UTC|GMT|PHT|PHST|SGT|IST)\b\)?\s*$/i;

/** `8`, `8:30`, `0830` is NOT accepted — a bare 4-digit clump is too easy to
 *  misread as a year or a duration. Minutes require an explicit separator. */
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i;

function clampMinute(m: number): number {
  // Normalize 24:00 to 0 so a "to midnight" window is representable, and keep
  // every stored value inside a single day.
  return ((m % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
}

interface ParsedClock {
  minute: number;
  /** True when the source carried an explicit AM/PM. Drives the ambiguity rule. */
  hadMeridiem: boolean;
}

/**
 * Parse one half of a range. Returns null when the text is not a clock time, when
 * the hour/minute is out of range, or when a 12-hour reading is impossible
 * (`13 PM`).
 */
function parseClock(raw: string): ParsedClock | null {
  const m = CLOCK.exec(raw.trim());
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3]?.toUpperCase() as 'AM' | 'PM' | undefined;

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute > 59) return null;

  if (meridiem) {
    // 12-hour clock: 12 AM is midnight, 12 PM is noon, and 0 is not a valid hour.
    if (hour < 1 || hour > 12) return null;
    const base = hour === 12 ? 0 : hour * 60;
    return { minute: clampMinute(base + minute + (meridiem === 'PM' ? 720 : 0)), hadMeridiem: true };
  }

  // 24-hour clock. 24:00 is accepted and normalized to 0.
  if (hour > 24) return null;
  if (hour === 24 && minute !== 0) return null;
  return { minute: clampMinute(hour * 60 + minute), hadMeridiem: false };
}

/**
 * Normalize a free-text shift window into minutes, or null when it cannot be read
 * unambiguously.
 *
 * Two rules carry the ambiguity, and both are deliberate:
 *
 *  - **Both halves carry AM/PM** → 12-hour reading. `"8AM-4PM"` → `480–960`.
 *  - **Neither half carries AM/PM** → 24-hour reading. `"08:00-16:00"` → `480–960`;
 *    `"22:00-06:00"` → `1320–360`, an overnight window.
 *  - **Exactly one half carries AM/PM** → **rejected.** `"8-4PM"` could mean
 *    08:00–16:00 or 16:00–16:00 depending on what the writer meant, and there is no
 *    honest way to pick. Refusing sends it back to a human who knows.
 *
 * A zero-length window (`"9AM-9AM"`) is also rejected: it is never a real shift and
 * it is the shape a half-filled form produces.
 */
export function parseShiftWindow(raw: string | null | undefined): ShiftWindow | null {
  if (!raw) return null;

  const cleaned = raw
    // Non-breaking spaces arrive from pasted spreadsheet cells and would
    // otherwise survive the collapse below and break the separator match.
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(TZ_SUFFIX, '')
    .trim();
  if (!cleaned) return null;

  const parts = cleaned.split(SEPARATOR);
  if (parts.length !== 2) return null;

  const start = parseClock(parts[0]!);
  const end = parseClock(parts[1]!);
  if (!start || !end) return null;

  // The ambiguity rule: a one-sided meridiem is a guess we decline to make.
  if (start.hadMeridiem !== end.hadMeridiem) return null;

  if (start.minute === end.minute) return null;

  return { startMinute: start.minute, endMinute: end.minute };
}

/** Stable grouping key. Two windows share a key iff they are the same shift. */
export function shiftWindowKey(w: ShiftWindow): string {
  return `${w.startMinute}-${w.endMinute}`;
}

/** True when the window runs past local midnight into the next day. */
export function spansMidnight(w: ShiftWindow): boolean {
  return w.endMinute < w.startMinute;
}

/** Length of the window in minutes, correct across midnight. */
export function shiftDurationMinutes(w: ShiftWindow): number {
  return spansMidnight(w)
    ? MINUTES_IN_DAY - w.startMinute + w.endMinute
    : w.endMinute - w.startMinute;
}

function formatMinute(min: number): string {
  const h24 = Math.floor(min / 60);
  const m = min % 60;
  const meridiem = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

/**
 * The ONE display form. Every surface renders a window through this, so a shift
 * never appears two ways in the same view — which is the whole point of storing
 * minutes rather than the string someone typed.
 */
export function formatShiftWindow(w: ShiftWindow): string {
  const base = `${formatMinute(w.startMinute)} – ${formatMinute(w.endMinute)}`;
  return spansMidnight(w) ? `${base} (+1d)` : base;
}

/** Ordered display buckets, derived from the window's START. */
export const SHIFT_BUCKETS = [
  { key: 'overnight', label: 'Overnight', fromMinute: 0 },
  { key: 'early', label: 'Early', fromMinute: 5 * 60 },
  { key: 'morning', label: 'Morning', fromMinute: 8 * 60 },
  { key: 'midday', label: 'Midday', fromMinute: 11 * 60 },
  { key: 'afternoon', label: 'Afternoon', fromMinute: 14 * 60 },
  { key: 'evening', label: 'Evening', fromMinute: 18 * 60 },
  { key: 'night', label: 'Night', fromMinute: 22 * 60 },
] as const;

export type ShiftBucketKey = (typeof SHIFT_BUCKETS)[number]['key'];

/**
 * Which coarse bucket a window falls in, by start time. Buckets are for scanning a
 * roster at a glance; `shiftWindowKey` remains the identity used for counting, so
 * bucketing can be re-cut later without re-deriving anyone's shift.
 */
export function shiftBucket(w: ShiftWindow): ShiftBucketKey {
  let hit: ShiftBucketKey = 'overnight';
  for (const b of SHIFT_BUCKETS) {
    if (w.startMinute >= b.fromMinute) hit = b.key;
  }
  return hit;
}

export function shiftBucketLabel(key: ShiftBucketKey): string {
  return SHIFT_BUCKETS.find((b) => b.key === key)?.label ?? key;
}
