/**
 * The eight-step payroll track on Profile → Compensation → Current Paycycle:
 * where the employee's pay week has got to, from the Hubstaff upload to the
 * money leaving.
 *
 * PURE — no I/O, no `server-only`, no Supabase — so `node:test` can walk every
 * branch. This is the same split `src/lib/payroll/wizard-setup-steps.ts` uses
 * for the accountant's checklist (its header, :15-16): one pure decision module
 * with a test per branch, one server assembler that does all the reads. The
 * route hands this plain booleans; this decides what the employee is told.
 *
 * ── Why the status vocabulary is not a boolean ───────────────────────────────
 * The request describes "a green dot per Level". A green dot implies its
 * opposite is "not yet" — but on this pipeline an absent row means "has not
 * happened", "does not apply to you", OR "we could not read it", and those are
 * routinely indistinguishable at the source. `listAllOrphanagePayHours` breaks
 * out of its paging loop on error and returns `{rows: [], error: null}`; a
 * person with no tracked time gets no Hubstaff row at all; "awaiting payout" is
 * the ABSENCE of a paid dispatch. Memory `catalog-visible-dispatch-absent-means
 * -no-hours`, `kpi-departed-guard-hides-working-people` and
 * `orphanage-source-file-drift-hides-a-week` are three separate occasions this
 * pipeline shipped a wrong answer by reading an absence as a zero.
 *
 * So there are three statuses, and a failed read is `pending` with a detail
 * that SAYS the read failed. There is no code path in this module that turns a
 * degraded read into `done`.
 *
 * The accountant's checklist has four (`done | attention | blocked | pending`);
 * this has three, because `attention` and `blocked` mean *you must go and fix
 * this* and the employee has nothing to fix. Dropping them is deliberate, not
 * an omission — see `statusFor`.
 */

export type PaycycleStepKey =
  | 'hubstaff'
  | 'fx'
  | 'orphanage'
  | 'kpi'
  | 'adjustments'
  | 'locked'
  | 'dispatch'
  | 'payout';

/**
 * `done` — it has happened, for THIS person, and we read it successfully.
 * `pending` — not yet, or we could not tell. Neutral. Never a warning: the
 *   employee is a spectator here and nothing on this screen is their to-do.
 * `not_applicable` — it provably does not apply to this person (Kane's Q7
 *   ruling for orphanage: the week's data landed AND this person has no hours).
 *   It requires POSITIVE evidence; "we haven't looked yet" is `pending`.
 */
export type PaycycleStepStatus = 'done' | 'pending' | 'not_applicable';

export interface PaycycleStep {
  key: PaycycleStepKey;
  /** The step's own ordinal, 1-8. NOT a wizard step number — the wizard's rail
   *  has been renumbered three times and an employee-facing number that moves
   *  with someone else's UI is a number that lies. */
  stepNo: number;
  label: string;
  status: PaycycleStepStatus;
  /** One short line under the label. Never names another employee, never a
   *  fleet-wide count — the accountant's checklist details ("3 people locked
   *  in", "2/5 departments ready") are scoped to the whole company and must not
   *  reach an employee. */
  detail: string;
}

export interface PaycycleTrack {
  steps: PaycycleStep[];
  /** Steps that are `done`. `not_applicable` does NOT count as done — it is not
   *  progress, it is an exemption. */
  doneCount: number;
  /** Steps that can ever be done: total minus the not-applicable ones, so the
   *  "3 of 7" an employee reads can actually reach its ceiling. */
  totalCount: number;
}

/** What the server measured. Every field is a fact about THIS caller's week. */
export interface PaycycleTrackInput {
  /** The Hubstaff upload for the week exists. */
  hubstaffLoaded: boolean;
  /** This caller has an hours row in that upload. False when the upload landed
   *  but they are not in it (no tracked time, or an alias the CSV missed). */
  hasHoursRow: boolean;
  /** Both FX legs of `payroll.wizard.fx.<sourceFile>` are > 0. A broken leg
   *  parses to 0 and so reads UNSET, never set (`parseCycleFxRecord`). */
  fxSet: boolean;
  /** The week's orphanage data is KNOWN to have landed: rows exist for the
   *  week, or the clerk wrote the confirm-none marker. This is what makes
   *  `not_applicable` sayable at all. */
  orphanageWeekKnown: boolean;
  /** This caller has orphanage hours in that week. */
  hasOrphanageHours: boolean;
  /** A ready/locked KPI bonus is visible for this caller. Drafts are excluded
   *  upstream — the employee sees it the moment a manager marks it ready
   *  (Kane, Q6), and never before. */
  kpiCredited: boolean;
  /** This caller has an adjustment on this week's additions blob. */
  hasAdjustment: boolean;
  /** The clerk has finished the adjustments pass for the week — i.e. the week
   *  is locked, which is the only moment the additions blob stops moving.
   *  Before that, "no adjustment for you" is not yet a settled fact. */
  adjustmentsSettled: boolean;
  /** `payroll.dispatch_lock.<sourceFile>` is locked. */
  wizardLocked: boolean;
  /** A staged `paystub_dispatch_queue` row exists for this caller and is not
   *  `excluded`. Presence alone is not payability. */
  stagedForDispatch: boolean;
  /** A paid `payment_dispatches` row exists for this caller's week. */
  paid: boolean;
  /** Steps whose backing read threw. These read `pending` with a "couldn't
   *  read" detail — never `done`, never `not_applicable`. */
  degradedKeys?: ReadonlySet<PaycycleStepKey>;
}

const DEGRADED_DETAIL = "Couldn't read this just now — it will refresh on its own.";

/**
 * `done` when the fact is true, otherwise `pending`. A degraded read short-
 * circuits to `pending` BEFORE the fact is consulted, which is the single
 * invariant this module exists to guarantee.
 */
function statusFor(
  key: PaycycleStepKey,
  isDone: boolean,
  degraded: ReadonlySet<PaycycleStepKey>,
): PaycycleStepStatus {
  if (degraded.has(key)) return 'pending';
  return isDone ? 'done' : 'pending';
}

export function derivePaycycleSteps(input: PaycycleTrackInput): PaycycleTrack {
  const degraded = input.degradedKeys ?? new Set<PaycycleStepKey>();
  const steps: PaycycleStep[] = [];

  const push = (
    key: PaycycleStepKey,
    label: string,
    status: PaycycleStepStatus,
    detail: string,
  ) => {
    steps.push({ key, stepNo: steps.length + 1, label, status, detail });
  };

  // 1 — Hubstaff hours loaded.
  // The upload landing is the per-CYCLE fact; being IN it is the per-person
  // one. Both must hold, because a green dot on someone who is not in the file
  // would be telling them their hours are counted when they are not.
  {
    const status = statusFor('hubstaff', input.hubstaffLoaded && input.hasHoursRow, degraded);
    const detail = degraded.has('hubstaff')
      ? DEGRADED_DETAIL
      : !input.hubstaffLoaded
        ? "This week's hours haven't been uploaded yet."
        : input.hasHoursRow
          ? 'Your tracked hours are in this week’s upload.'
          : "The upload is in, but there are no tracked hours for you yet.";
    push('hubstaff', 'Hubstaff hours loaded', status, detail);
  }

  // 2 — USD rate conversion.
  // Per-cycle by nature: one FX pair serves everyone. Nothing per-person to say.
  {
    const status = statusFor('fx', input.fxSet, degraded);
    const detail = degraded.has('fx')
      ? DEGRADED_DETAIL
      : input.fxSet
        ? 'This week’s USD rate has been set.'
        : 'Accounting hasn’t set this week’s USD rate yet.';
    push('fx', 'USD rate conversion added', status, detail);
  }

  // 3 — Orphanage hours. The only step that can be `not_applicable`.
  //
  // Kane, Q7: *"If the Orphanage was already added but that person has no
  // hours"*. So N/A needs POSITIVE evidence the week's orphanage data landed.
  // Until then it is `pending`, because lock-in accumulates — "no row for me"
  // can still become a row from a later paste, and printing "Not applicable" at
  // someone who is owed orphanage money is this step's failure mode.
  {
    let status: PaycycleStepStatus;
    let detail: string;
    if (degraded.has('orphanage')) {
      status = 'pending';
      detail = DEGRADED_DETAIL;
    } else if (input.hasOrphanageHours) {
      status = 'done';
      detail = 'Your orphanage hours are in.';
    } else if (input.orphanageWeekKnown) {
      status = 'not_applicable';
      detail = 'No orphanage hours for you this week.';
    } else {
      status = 'pending';
      detail = 'Orphanage hours haven’t been logged yet.';
    }
    push('orphanage', 'Orphanage hours logged', status, detail);
  }

  // 4 — KPI bonuses credited.
  {
    const status = statusFor('kpi', input.kpiCredited, degraded);
    const detail = degraded.has('kpi')
      ? DEGRADED_DETAIL
      : input.kpiCredited
        ? 'Your KPI bonus has been scored and credited.'
        : 'Your manager hasn’t marked this week’s KPI as ready yet.';
    push('kpi', 'KPI bonuses credited', status, detail);
  }

  // 5 — Adjustments.
  //
  // The honest version of a step that is vacuously green otherwise. Most people
  // have no adjustment in any given week, so "no adjustment found" cannot mean
  // done on its own — it only becomes a settled fact once the week is locked
  // and the additions blob stops moving. Before that: pending.
  {
    const isDone = input.hasAdjustment || input.adjustmentsSettled;
    const status = statusFor('adjustments', isDone, degraded);
    const detail = degraded.has('adjustments')
      ? DEGRADED_DETAIL
      : input.hasAdjustment
        ? 'An adjustment has been added to your pay this week.'
        : input.adjustmentsSettled
          ? 'No adjustments on your pay this week.'
          : 'Accounting is still working through this week’s adjustments.';
    push('adjustments', 'Adjustments filled', status, detail);
  }

  // 6 — Payroll wizard locked.
  {
    const status = statusFor('locked', input.wizardLocked, degraded);
    const detail = degraded.has('locked')
      ? DEGRADED_DETAIL
      : input.wizardLocked
        ? 'This week’s figures are final.'
        : 'Payroll is still being finalised.';
    push('locked', 'Payroll wizard locked', status, detail);
  }

  // 7 — Sent to dispatch.
  //
  // In the wizard these are ONE button (`dispatch-button-state.ts:47-48` —
  // "Lock in Values & Send to Payment Dispatch" stages the queue AND sets the
  // lock). They are separated here because step 7 is measured PER PERSON: your
  // staged row, not the fleet's lock. A held/excluded person therefore stops at
  // 6 rather than marching to 8 behind a lock that was never about them.
  {
    const status = statusFor('dispatch', input.stagedForDispatch, degraded);
    const detail = degraded.has('dispatch')
      ? DEGRADED_DETAIL
      : input.stagedForDispatch
        ? 'Your payment is queued with Payment Dispatch.'
        : 'Not queued for payment yet.';
    push('dispatch', 'Sent to dispatch', status, detail);
  }

  // 8 — Awaiting payout → paid.
  //
  // Kane, Q3: *"Awaiting Payout is when it is sent to Dispatch already where it
  // is awaiting Payout"*. So this step's PENDING state is the meaningful one —
  // it is the "awaiting" — and it resolves when the paid dispatch row lands.
  // `payment_dispatches` has no 'pending' status (its union is
  // paid|not_paid|threshold|problem and a row is inserted only once money is
  // logged), so "awaiting" is necessarily the absence of a paid row — which is
  // exactly why it is gated behind `stagedForDispatch` rather than standing on
  // an absence by itself.
  {
    const status = statusFor('payout', input.paid, degraded);
    const detail = degraded.has('payout')
      ? DEGRADED_DETAIL
      : input.paid
        ? 'Paid. Check your Pay Stubs for the statement.'
        : input.stagedForDispatch
          ? 'Awaiting payout — your payment is with the processor.'
          : 'Not sent for payout yet.';
    push('payout', input.paid ? 'Paid' : 'Awaiting payout', status, detail);
  }

  const applicable = steps.filter((s) => s.status !== 'not_applicable');
  return {
    steps,
    doneCount: applicable.filter((s) => s.status === 'done').length,
    totalCount: applicable.length,
  };
}
