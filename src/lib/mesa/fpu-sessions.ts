/**
 * An FPU class's weekly SESSIONS — derived, never stored.
 *
 * Kane, 2026-09-17 (Q7): sessions are the weeks between `class_starts_on` and
 * `class_ends_on`, and a class with no end date cannot be grouped or attended
 * until HR sets one.
 *
 * WHY DERIVED. The class row already carries the two dates a session list would
 * restate, and a second stored copy drifts from them the first time HR edits the
 * class — the repo's other weekly grids are all derived per render. The cost is
 * accepted and explicit: `class_ends_on` is nullable ("not announced" is a real
 * state), so a class without one has NO sessions and the UI says so rather than
 * inventing a count.
 *
 * Dates are Manila calendar dates as `YYYY-MM-DD` strings, compared lexically —
 * the same convention the enrollment window uses, so nothing here constructs a
 * Date for comparison and nothing shifts a day west of UTC.
 */

/** Sessions beyond this are a typo in the class dates, not a year-long course. */
export const FPU_MAX_SESSIONS = 52;

export interface FpuSession {
  /** 1-based. This is what an attendance row stores. */
  no: number;
  /** The session's calendar date, `YYYY-MM-DD`. */
  date: string;
}

export type FpuSessionList =
  | { ok: true; sessions: FpuSession[] }
  | { ok: false; reason: 'no_end_date' | 'bad_dates' | 'too_many'; detail: string };

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Every session of the class, weekly from the start date through the end date
 * INCLUSIVE.
 *
 * A span that is not a whole number of weeks simply stops at the last session
 * that fits: start Thu Oct 1 with end Sun Nov 8 yields the six Thursdays through
 * Nov 5, not a seventh partial week. The trailing days are not a session because
 * nobody meets in them.
 */
export function fpuSessions(cls: { class_starts_on: string; class_ends_on?: string | null }): FpuSessionList {
  const start = (cls.class_starts_on ?? '').trim();
  const end = (cls.class_ends_on ?? '').trim();
  if (!start) return { ok: false, reason: 'bad_dates', detail: 'This class has no start date.' };
  if (!end) {
    return {
      ok: false,
      reason: 'no_end_date',
      detail: 'Set the class end date before dividing groups — the number of weekly sessions comes from it.',
    };
  }
  if (end < start) return { ok: false, reason: 'bad_dates', detail: 'This class ends before it starts.' };

  const sessions: FpuSession[] = [];
  let cursor = start;
  while (cursor <= end) {
    sessions.push({ no: sessions.length + 1, date: cursor });
    if (sessions.length > FPU_MAX_SESSIONS) {
      return { ok: false, reason: 'too_many', detail: `That is more than ${FPU_MAX_SESSIONS} weekly sessions — check the class dates.` };
    }
    cursor = addDays(cursor, 7);
  }
  return { ok: true, sessions };
}

/** How many sessions the class has, or 0 when it cannot say yet. */
export function fpuSessionCount(cls: { class_starts_on: string; class_ends_on?: string | null }): number {
  const list = fpuSessions(cls);
  return list.ok ? list.sessions.length : 0;
}

/**
 * The sessions that have actually happened by `today` — the only ones a leader
 * can mark. Marking a future session would record attendance at a meeting that
 * has not occurred, which no correction path could distinguish later from a real
 * one.
 */
export function elapsedFpuSessions(
  cls: { class_starts_on: string; class_ends_on?: string | null },
  today: string,
): FpuSession[] {
  const list = fpuSessions(cls);
  if (!list.ok) return [];
  return list.sessions.filter((s) => s.date <= today);
}

/** Is `sessionNo` a real session of this class that has already happened? */
export function isMarkableSession(
  cls: { class_starts_on: string; class_ends_on?: string | null },
  sessionNo: number,
  today: string,
): boolean {
  return elapsedFpuSessions(cls, today).some((s) => s.no === sessionNo);
}
