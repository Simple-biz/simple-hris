/**
 * Who leaves an FPU class eligible for MESA — the ONE verdict, browser-safe.
 *
 * Kane, 2026-09-17: *"if they miss even once they will no longer be eligible for
 * MESA"*, and the end goal — *"once the class is closed there would be a list of
 * eligible and ineligible people at the end and only then they can have their
 * Deduction of MESA through Payroll Wizard."*
 *
 * Three rulings are baked in here and must not be softened at a call site:
 *
 *  - **Fail closed on UNMARKED** (Q3). A session nobody marked is not a pass. It
 *    is reported separately from a deliberate absence so HR can tell "they did
 *    not come" from "the leader never filled it in" and chase the right person.
 *  - **Failing is per-class** (Q2). This verdict decides THIS class. It never
 *    stamps `mesa_fpu_completed_on`, because that stamp bars every future class
 *    forever and nothing in the app can clear it — so a non-attender stays free
 *    to enroll in a later batch.
 *  - **An HR override is READ, never recomputed over** (Q6). Once HR excuses an
 *    absence the marks stop deciding, so a later edit by a group leader cannot
 *    silently undo the ruling. Same discipline as `start_date_used` freezing the
 *    tenure input at submission.
 *
 * The server re-derives this at class close; a client copy is a painting.
 */

export type FpuOutcome = 'eligible' | 'failed';
export type FpuAttendanceOverride = 'pass' | 'fail';

export interface FpuAttendanceInput {
  /** Sessions the class has, from `fpuSessions`. */
  sessionCount: number;
  /** `session_no` → present. A session with NO entry is unmarked, not absent. */
  marks: ReadonlyMap<number, boolean>;
  /** HR's explicit ruling, when there is one. */
  override?: FpuAttendanceOverride | null;
}

export interface FpuAttendanceVerdict {
  outcome: FpuOutcome;
  /** Sessions deliberately marked absent. */
  absent: number[];
  /** Sessions nobody marked at all. */
  unmarked: number[];
  attended: number;
  sessionCount: number;
  /** What decided it — so the UI can say "HR excused this" rather than imply the marks did. */
  decidedBy: 'override' | 'attendance' | 'no_sessions';
  /** One sentence, the same one the employee and HR both read. */
  reason: string;
}

function list(ns: number[]): string {
  if (ns.length === 1) return `session ${ns[0]}`;
  return `sessions ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
}

export function fpuAttendanceVerdict(input: FpuAttendanceInput): FpuAttendanceVerdict {
  const sessionCount = Math.max(0, Math.floor(input.sessionCount));
  const absent: number[] = [];
  const unmarked: number[] = [];
  for (let no = 1; no <= sessionCount; no += 1) {
    if (!input.marks.has(no)) unmarked.push(no);
    else if (input.marks.get(no) === false) absent.push(no);
  }
  const attended = sessionCount - absent.length - unmarked.length;
  const base = { absent, unmarked, attended, sessionCount };

  // An override outranks the marks entirely — that is the point of it.
  if (input.override === 'pass') {
    return { ...base, outcome: 'eligible', decidedBy: 'override', reason: 'HR passed this person despite the attendance record.' };
  }
  if (input.override === 'fail') {
    return { ...base, outcome: 'failed', decidedBy: 'override', reason: 'HR failed this person for this class.' };
  }

  // No sessions means the class cannot say anyone attended it. Fail closed: the
  // alternative is enrolling a whole class into MESA on no evidence at all.
  if (sessionCount === 0) {
    return { ...base, outcome: 'failed', decidedBy: 'no_sessions', reason: 'This class has no sessions, so attendance cannot be judged.' };
  }

  if (absent.length === 0 && unmarked.length === 0) {
    return { ...base, outcome: 'eligible', decidedBy: 'attendance', reason: `Attended all ${sessionCount} sessions.` };
  }
  if (absent.length > 0 && unmarked.length > 0) {
    return { ...base, outcome: 'failed', decidedBy: 'attendance', reason: `Missed ${list(absent)}; ${list(unmarked)} never marked.` };
  }
  if (absent.length > 0) {
    return { ...base, outcome: 'failed', decidedBy: 'attendance', reason: `Missed ${list(absent)}.` };
  }
  return { ...base, outcome: 'failed', decidedBy: 'attendance', reason: `${list(unmarked)} never marked — ask the group leader to fill it in.` };
}

/** Is this class ready to close: has every session been marked for everyone? */
export function fpuUnmarkedTotal(verdicts: readonly FpuAttendanceVerdict[]): number {
  return verdicts.reduce((n, v) => n + v.unmarked.length, 0);
}
