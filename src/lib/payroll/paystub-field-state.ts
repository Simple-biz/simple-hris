/**
 * Per-field load state for the Payroll Wizard's Step-8 Paystubs preview.
 *
 * ## Why this exists
 *
 * The wizard's "Preview Emails" dialog renders the SHARED `PayStubStatement`
 * off a `dispatchData` row (`paystub-dispatch.md` § Preview Paystubs). That row
 * is assembled from a dozen independent fetches, and every one of them
 * initialises to the same empty value its `catch` resets to — so *in flight*,
 * *failed* and *genuinely none* are one indistinguishable state, and the
 * statement prints `₱0.00` for all three.
 *
 * The wizard already knows those rows are not judgeable in that window:
 * `publishFinalPaySnapshot` REFUSES to write while the additions blob or either
 * KPI marker is unresolved, with the comment *"dispatchData would still carry
 * zeroed adjustments/orphanage/bonus toggles"*. The preview read the same rows
 * and printed them as a pay document anyway. This module is that same judgement,
 * expressed per line.
 *
 * ## The two rules that shape it
 *
 * 1. **Resolved from the LOADER, never from the amount.** A zero is not evidence
 *    of anything. `payroll-wizard-pab-step.md` § — *"An empty array is not
 *    evidence that nobody failed; it is evidence that nobody failed **or** that
 *    nothing was measured."* Keying off `amount === 0` would shimmer every
 *    policy-settled zero (a non-final PAB week, weeks 4–5 for Tech, the Lead Gen
 *    exclusion, the no-rates cohort) and tell a clerk to wait for money that is
 *    never coming.
 *
 * 2. **Three states, not two.** `payroll-wizard-step-load.md` § — *"Every flag
 *    used here settles in a `finally`, so a stalled fetch that rejects still ends
 *    the animation. The line cannot become the forever-spinner a terminal
 *    skeleton once was."* A loader that has FAILED is terminal, and a terminal
 *    state is `unavailable`, never an eternal shimmer — the same ruling as
 *    [[kpi-calculator-week-unresolved-hang]] (*"an unresolvable payroll week is
 *    TERMINAL, not pending"*) and [[wizard-first-paycheck-label]] (*"a failed
 *    read says unavailable, never zero"*).
 *
 * ## What it deliberately is not
 *
 * It is **not** part of `PayStubView`. The view is what
 * `renderPayStubEmailHtml`, `buildPayStubsWorkbook` and the staged
 * `paystub_dispatch_queue` payload are all built from, so anything added there
 * reaches an inbox, a PDF and a row that is re-rendered days later. These states
 * travel as a React prop on the one wizard call site and cannot reach any of
 * those three by signature. That is a structural guarantee, not a discipline.
 */

/**
 * One line's state.
 *
 * - `settled` — the loaders behind it have landed. The amount is the answer,
 *   including when the answer is ₱0.00.
 * - `pending` — at least one loader is still in flight. The amount currently
 *   computes to something, but it is not an answer yet.
 * - `unavailable` — at least one loader FAILED. Terminal: no amount will arrive
 *   without a reload, so this must never animate.
 */
export type PayStubFieldState = 'settled' | 'pending' | 'unavailable';

/**
 * The asynchronous inputs behind the statement. One per independent fetch, named
 * for the data rather than the state variable, so the wizard's internals can be
 * renamed without touching the mapping below.
 */
export type PayStubSourceKey =
  /** The active week's Hubstaff hours (`calcSourceFileLoading` / the unfiltered fallback). */
  | 'weekHours'
  /** `employee_hourly_rates` + the Payment Catalog overlay. Every peso is hours × this. */
  | 'rates'
  /** The all-weeks PAB merge — one fetch per archived upload, the documented straggler. */
  | 'pabMerge'
  /** The PAB month range itself, which decides whether this week can pay PAB at all. */
  | 'pabPeriod'
  /** `payroll.wizard.additions.<file>` — the Adjustment column and the Orphanage column. */
  | 'additions'
  /** Manager KPI submissions for the pinned week. */
  | 'managerKpi'
  /** HSL KPI entries for the pinned week. */
  | 'hslKpi'
  /** Approved time-adjustment rows for the PAB period. */
  | 'timeAdjustments'
  /** Accounting-approved MESA disbursements not yet paid through Urgent Payments. */
  | 'mesaDisbursements'
  /** The MESA ledger's opted-out set. Absent, it reads as "nobody opted out". */
  | 'mesaOptOut'
  /** The master roster — start dates, which gate the Tech Allowance's 30 days of service. */
  | 'masterRoster'
  /** The per-cycle USD→PHP rate. Absent, the view falls back to a hardcoded 58. */
  | 'fx';

/** Every asynchronous input, keyed. */
export type PayStubSourceStates = Readonly<Record<PayStubSourceKey, PayStubFieldState>>;

/**
 * The statement lines that can carry a state. Named for the line as it prints,
 * not for the `PayStubView` prop, because one line reads several props (the
 * Regular row reads `weekdayPay ?? mfPay` plus hours plus rate).
 */
export type PayStubFieldKey =
  | 'regular'
  | 'overtime'
  | 'weekend'
  | 'timeAdjustment'
  | 'techBonus'
  | 'attendanceBonus'
  | 'performanceBonus'
  | 'adjustment'
  | 'orphanage'
  | 'mesaDisbursement'
  | 'mesaDeduction'
  | 'totalUsd'
  | 'totalCop'
  | 'total';

/** Every statement line, keyed. Omitted from `PayStubStatement` ⇒ all `settled`. */
export type PayStubFieldStates = Readonly<Record<PayStubFieldKey, PayStubFieldState>>;

export const PAY_STUB_SOURCE_KEYS: readonly PayStubSourceKey[] = [
  'weekHours',
  'rates',
  'pabMerge',
  'pabPeriod',
  'additions',
  'managerKpi',
  'hslKpi',
  'timeAdjustments',
  'mesaDisbursements',
  'mesaOptOut',
  'masterRoster',
  'fx',
] as const;

export const PAY_STUB_FIELD_KEYS: readonly PayStubFieldKey[] = [
  'regular',
  'overtime',
  'weekend',
  'timeAdjustment',
  'techBonus',
  'attendanceBonus',
  'performanceBonus',
  'adjustment',
  'orphanage',
  'mesaDisbursement',
  'mesaDeduction',
  'totalUsd',
  'totalCop',
  'total',
] as const;

/**
 * Which fetches each printed line depends on.
 *
 * `rates` appears on nearly every money line on purpose and it is not padding:
 * `dispatchData` gates almost every bonus on `hasRates` (`const pabBonus =
 * hasRates && …`), so while rates are in flight those lines compute to a hard
 * zero for a reason that has nothing to do with the bonus itself.
 */
const FIELD_SOURCES: Readonly<Record<PayStubFieldKey, readonly PayStubSourceKey[]>> = {
  regular: ['weekHours', 'rates'],
  overtime: ['weekHours', 'rates'],
  weekend: ['weekHours', 'rates'],
  // The delta is (approved day hours − raw tracked hours), so it needs both the
  // approved rows AND the hours they are differenced against, then a rate to price it.
  timeAdjustment: ['timeAdjustments', 'weekHours', 'rates'],
  // All three bonus lines also ride `additions`, and missing that was a real gap
  // (Kane, 2026-09-22: "performance bonus is not showing a loading animation").
  // The dispatch row reads `const toggles = employeeBonuses[r.email] ?? {}` for
  // every one of them, and `employeeBonuses` IS the additions blob — so until it
  // hydrates every toggle is absent, which reads as "off", which is ₱0.00. The
  // KPI markers settle long before the blob does, so Performance Bonus sat at a
  // confident zero while Adjustment and Orphanage beside it shimmered.
  // The 30-days-of-service gate reads `start_date` off the master roster.
  techBonus: ['rates', 'masterRoster', 'additions'],
  attendanceBonus: ['rates', 'pabPeriod', 'pabMerge', 'additions'],
  // "Performance Bonus" is `other_bonuses` — the department/KPI amounts, which
  // arrive from the manager submissions and the HSL entries on separate clocks,
  // and are then summed by `bonusTotals`, whose deps include `employeeBonuses`.
  performanceBonus: ['rates', 'managerKpi', 'hslKpi', 'additions'],
  adjustment: ['rates', 'additions'],
  orphanage: ['rates', 'additions'],
  mesaDisbursement: ['mesaDisbursements'],
  // Membership rides the rate row; the opt-out set can only SUPPRESS a charge, so
  // an unread ledger produces a confident −₱100.00 on someone who has left MESA.
  mesaDeduction: ['rates', 'mesaOptOut'],
  totalUsd: [],
  totalCop: [],
  total: [],
};

/**
 * Lines whose pesos land in Net. `totalUsd` / `totalCop` add the FX read on top —
 * `mapPayloadToPayStub` falls back to a hardcoded **58** when the cycle rate is
 * absent (`paystub-view.ts`), so the dollar figure is plausible, wrong, and
 * indistinguishable from a real one.
 */
const NET_CONTRIBUTORS: readonly PayStubFieldKey[] = [
  'regular',
  'overtime',
  'weekend',
  'timeAdjustment',
  'techBonus',
  'attendanceBonus',
  'performanceBonus',
  'adjustment',
  'orphanage',
  'mesaDisbursement',
  'mesaDeduction',
] as const;

/**
 * Worst-wins. `unavailable` outranks `pending` because it is terminal: a field
 * with one failed input can never become fully settled, so animating it would be
 * the forever-spinner `payroll-wizard-step-load.md` § forbids.
 */
export function worstState(states: readonly PayStubFieldState[]): PayStubFieldState {
  let seenPending = false;
  for (const s of states) {
    if (s === 'unavailable') return 'unavailable';
    if (s === 'pending') seenPending = true;
  }
  return seenPending ? 'pending' : 'settled';
}

/** Every source `settled` — the all-clear, and what a replayed/paid week resolves to. */
export function allSourcesSettled(): PayStubSourceStates {
  const out = {} as Record<PayStubSourceKey, PayStubFieldState>;
  for (const k of PAY_STUB_SOURCE_KEYS) out[k] = 'settled';
  return out;
}

/** Every field `settled` — what `PayStubStatement` assumes when the prop is omitted. */
export function allFieldsSettled(): PayStubFieldStates {
  const out = {} as Record<PayStubFieldKey, PayStubFieldState>;
  for (const k of PAY_STUB_FIELD_KEYS) out[k] = 'settled';
  return out;
}

export interface ResolveOptions {
  /**
   * Lines whose value is already decided by a rule that needs none of the
   * outstanding fetches, and which must therefore NOT shimmer.
   *
   * This is the guard against the fix's own worst failure mode: Attendance
   * Incentive is ₱0.00 on every non-final week of a PAB month, Tech Allowance is
   * ₱0.00 in weeks 4–5, Lead Gen is excluded from bonuses by policy, and a person
   * with no resolved rate is forced to ₱0 on every PHP bonus. Shimmering those
   * tells a clerk to wait for money that will never arrive — a new confusion in
   * place of the old one.
   *
   * The caller decides membership, because only the caller knows the week and the
   * row. It may only ever move a field TOWARDS `settled`, never away.
   */
  readonly settledByPolicy?: Iterable<PayStubFieldKey>;
}

/**
 * Fold the asynchronous inputs into one state per printed line.
 *
 * Fail-closed by construction: a field's state is the worst of its inputs, and an
 * input this function was not given is a TypeScript error rather than a silent
 * `settled`. `total` is the worst of every line that moves pesos — a shimmering
 * line under a confident Net would re-open exactly the defect closed on
 * 2026-09-22, when a statement printed lines summing ₱14,188.29 under a Net of
 * ₱14,211.62 (`paystub-dispatch.md` § — *"A pay document that does not add up to
 * its own total is the defect"*).
 */
export function resolvePayStubFieldStates(
  sources: PayStubSourceStates,
  opts: ResolveOptions = {},
): PayStubFieldStates {
  const forced = new Set<PayStubFieldKey>(opts.settledByPolicy ?? []);
  const out = {} as Record<PayStubFieldKey, PayStubFieldState>;

  for (const field of PAY_STUB_FIELD_KEYS) {
    if (field === 'total' || field === 'totalUsd' || field === 'totalCop') continue;
    out[field] = forced.has(field)
      ? 'settled'
      : worstState(FIELD_SOURCES[field].map((s) => sources[s]));
  }

  // Net is the sum of every line above it, so it inherits the worst of them. A
  // policy-settled zero contributes `settled` and correctly does not hold Net back.
  const net = worstState(NET_CONTRIBUTORS.map((f) => out[f]));
  out.total = forced.has('total') ? 'settled' : net;

  // The USD and COP figures are Net × an FX rate that is itself read, so they are
  // never better than Net and never better than the rate.
  const fxDerived = worstState([net, sources.fx]);
  out.totalUsd = forced.has('totalUsd') ? 'settled' : fxDerived;
  out.totalCop = forced.has('totalCop') ? 'settled' : fxDerived;

  return out as PayStubFieldStates;
}

/** Whether anything on the statement is still moving. Drives the preview's banner. */
export function anyFieldUnsettled(states: PayStubFieldStates): boolean {
  return PAY_STUB_FIELD_KEYS.some((k) => states[k] !== 'settled');
}

/** Whether any line failed outright — the preview says so in words, not a spinner. */
export function anyFieldUnavailable(states: PayStubFieldStates): boolean {
  return PAY_STUB_FIELD_KEYS.some((k) => states[k] === 'unavailable');
}

/**
 * The three optional lines are ABSENT rather than ₱0.00 when they carry no money
 * (`hasWeekend` / `showsTimeAdjustmentLine` / `showsOrphanageLine` in
 * `paystub-view.ts`). Unloaded, that absence is a claim — *"there is no money
 * here"* — that the data cannot support, and a vanished row is less visible than
 * a zeroed one, not more.
 *
 * Kane ruled 2026-09-22 that the preview renders the row while its state is
 * unsettled and lets the shared predicate decide once the data lands. The
 * predicate still owns the SETTLED answer, which is what keeps the three
 * renderers in agreement about every statement anyone is ever sent.
 */
export function showsWhileUnsettled(
  settledVisibility: boolean,
  state: PayStubFieldState,
): boolean {
  return settledVisibility || state !== 'settled';
}
