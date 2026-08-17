/**
 * Autosave policy for the Manager KPI Calculator.
 *
 * Both calculators behind the "KPI Calculator" tab (`HslBonusCalculator` for HSL
 * branches, `DeptBonusCalculator` for departments) persist a manager's scoring
 * as they type instead of behind a Save button. What must NOT change is every
 * guard the manual Save carried, so the decision lives here as one pure function
 * with a test rather than as an `if` scattered through two 3–4k-line components.
 *
 * Non-negotiables encoded below (each has a governing rule):
 *
 *  - **Draft only.** `ready`/`locked` weeks are read-only so an edit can't
 *    silently fail to reach Accounting
 *    (`docs/features/hsl-kpi-calculator-2026-07.md` — "Draft-only editing").
 *  - **Never before the payroll week resolves.** `(department, period_start)` is
 *    the only address a KPI row has, and the seed week is a local-clock guess;
 *    writing before the Hubstaff batch resolves it strands rows under a key no
 *    reader asks for. Both `saveDept`s already refuse — autosave must too.
 *  - **Never while payroll is processing.** The server rejects score writes with
 *    423 (`src/lib/payroll/processing-guard.ts`); autosave must not queue work
 *    that is guaranteed to fail.
 *  - **Never a load-seeded value.** A fresh draft week arrives with common
 *    bonuses pre-ticked and QC first-pass values seeded, and that state is
 *    flagged dirty on load (`DeptBonusCalculator`). Persisting it would mean
 *    merely OPENING the tab writes applied rows attributed to whoever opened it.
 *    "Every field entered" means entered by a person.
 *  - **No retry storm.** A failed write leaves the dept dirty, so a naive
 *    debounce would re-fire forever. Autosave retries only once the manager
 *    changes something, which is also what keeps `dirty` honest for the
 *    Mark Ready / Lock gates.
 *
 * Autosave deliberately does NOT touch submission: Mark Ready (HSL) and
 * Lock → Submit to Payroll (departments) stay manual, because the
 * `hsl_bonus_period_status` row — not the entries — is what tells Accounting a
 * week is done (see memory `hsl-bonus-weeks-never-submitted`).
 */

/** Idle time after the last edit before the write fires. Long enough that
 *  nudging a stepper or typing a 3-digit count is one write, short enough that
 *  a manager switching tabs mid-thought has already been saved. */
export const KPI_AUTOSAVE_DEBOUNCE_MS = 1000;

export type KpiAutosaveBlockReason =
  /** The dept's first fetch hasn't settled — there is nothing trustworthy to write. */
  | 'not-loaded'
  /** Hubstaff hasn't resolved the real payroll week yet. */
  | 'week-unresolved'
  /** Week is `ready`/`locked`, or the values were locked for submission. */
  | 'not-draft'
  /** Accounting is mid-run; the server would reject the write with 423. */
  | 'payroll-locked'
  /** A write is already in flight for this dept. */
  | 'in-flight'
  /** Nothing to save. */
  | 'clean'
  /** Dirty only because the load seeded defaults — not a manager's entry. */
  | 'seeded-only'
  /** This exact state already failed; wait for the manager's next edit. */
  | 'failed-unchanged';

export interface KpiAutosaveInput {
  /** The dept's initial load has settled. */
  loaded: boolean;
  /** The Hubstaff batch has resolved the real payroll week. */
  weekResolved: boolean;
  /** `true` when the period is a draft AND the values aren't locked for submit. */
  editable: boolean;
  /** Accounting's "Start processing" lock is on for this viewer. */
  payrollLocked: boolean;
  /** A save is already running for this dept. */
  saving: boolean;
  /** Unpersisted local state exists. */
  dirty: boolean;
  /**
   * `true` when `dirty` came only from load-seeded defaults (pre-applied common
   * bonuses, QC first-pass seed) and the manager has not entered anything in
   * this dept yet.
   */
  seededOnly: boolean;
  /** The state currently on screen is byte-for-byte what a previous autosave
   *  failed on, so re-sending it would just fail again. */
  failedUnchanged: boolean;
}

export type KpiAutosaveGate =
  | { save: true }
  | { save: false; reason: KpiAutosaveBlockReason };

/**
 * Whether a dept may autosave right now. Ordered most-fundamental first so the
 * reason reported is the one worth showing a manager.
 */
export function kpiAutosaveGate(i: KpiAutosaveInput): KpiAutosaveGate {
  if (!i.loaded) return { save: false, reason: 'not-loaded' };
  if (!i.weekResolved) return { save: false, reason: 'week-unresolved' };
  if (i.payrollLocked) return { save: false, reason: 'payroll-locked' };
  if (!i.editable) return { save: false, reason: 'not-draft' };
  if (i.saving) return { save: false, reason: 'in-flight' };
  if (!i.dirty) return { save: false, reason: 'clean' };
  if (i.seededOnly) return { save: false, reason: 'seeded-only' };
  if (i.failedUnchanged) return { save: false, reason: 'failed-unchanged' };
  return { save: true };
}

/**
 * Whether a dept's debounce timer should be (re)armed.
 *
 * **The debounce is per DEPARTMENT, not per calculator.** Both calculators hold
 * every visible dept in ONE state object, so editing dept A re-runs the autosave
 * effect for dept B as well. Re-arming unconditionally there would push B's
 * pending write further out on every keystroke in A — a manager working steadily
 * in one department would starve another department's write for as long as they
 * kept typing, with the footer cheerfully showing "Saving…" throughout.
 *
 * So a timer is left alone while it is already counting down for the state it was
 * armed for, and re-armed only when that dept's own state object changed.
 *
 * @param armedFor the dept state the pending timer was armed for (identity)
 * @param current  the dept state now on screen (identity)
 * @param hasTimer whether a timer is actually still pending for this dept
 */
export function shouldRearmAutosave(
  armedFor: unknown,
  current: unknown,
  hasTimer: boolean,
): boolean {
  if (!hasTimer) return true; // nothing counting down — arm it
  return armedFor !== current; // only reset the countdown if THIS dept changed
}

/**
 * SSD Medical Records only: whether a sub-team has NO team-level input at all.
 *
 * `ssd_medical_records` scores from team-level accuracy %, record count and RFC
 * count that live in component state and are deliberately NOT persisted (see
 * memory `ssd-medical-records-rfc-pool` and `recomputeSsdEntries`) — only the
 * per-employee share they derive is saved. After a reload those three fields are
 * blank while the saved shares are not, so any recompute triggered before the
 * manager re-enters them recomputes every member of the team to ₱0.
 *
 * Under a manual Save that needed a deliberate click. Under autosave it would
 * land by itself, so `recomputeSsdEntries` refuses to overwrite an existing
 * non-zero share when the team it belongs to has no inputs on screen. A typed
 * `0` is an input — only an untouched field counts as blank.
 */
export function subTeamInputsBlank(st: {
  pct: string;
  records: string;
  rfc: string;
}): boolean {
  return !st.pct.trim() && !st.records.trim() && !st.rfc.trim();
}
