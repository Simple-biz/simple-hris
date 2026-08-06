/**
 * Maps a staged `paystub_dispatch_queue.payload` (the exact per-employee
 * `DispatchEmployee` object the Payroll Wizard sends to n8n) into the flat field
 * set the paystub email template renders — the n8n `pay_vars` node
 * (`references/n8n/Paystub Automation.json`) and `docs/features/paystub.html`.
 *
 * This is the single source of truth so the in-app Pay Stub modal shows the
 * IDENTICAL numbers and layout the employee received by email. Keep this mapping
 * in lockstep with the n8n `pay_vars` Set node if the email template changes.
 */

export interface PayStubView {
  name: string;
  department: string;
  weekStart: string | null;
  weekEnd: string | null;
  /** "Jul 7 – Jul 13, 2026" — the email's `week_human`. */
  weekHuman: string;
  salaryDate: string | null;
  mfHours: number;
  mfOtHours: number;
  mfRate: number;
  otRate: number;
  mfPay: number;
  otPay: number;
  /**
   * HSL weekend (Sat+Sun) itemization. `mfHours`/`mfPay` (and the OT pair) stay
   * the FULL week totals — weekend included — exactly as staged/paid, so every
   * total-summing consumer (lists, exports, the Net figure) is untouched. When
   * `hasWeekend` is true the statement splits the earnings rows instead:
   * Regular/Overtime render the weekday-only figures and two Weekend rows carry
   * the Sat+Sun hours at the premium rate (base + ₱15/h). Weekend hours can sit
   * in EITHER bucket — a weekend day past the 40h cap is weekend OT — which is
   * why both a regular and an OT weekend line exist. Non-HSL payloads (and
   * payloads staged before this field existed) have `hasWeekend: false` and all
   * weekend fields zero; weekday === mf then.
   */
  hasWeekend: boolean;
  weekendHours: number;
  weekendOtHours: number;
  /** Effective weekend rates = displayed base rate + the per-hour premium. */
  weekendRate: number;
  weekendOtRate: number;
  weekendPay: number;
  weekendOtPay: number;
  weekdayHours: number;
  weekdayOtHours: number;
  weekdayPay: number;
  weekdayOtPay: number;
  techBonus: number;
  attendanceBonus: number;
  performanceBonus: number;
  adjustment: number;
  adjustmentNote: string | null;
  /** Accounting orphanage pay — a positive amount added on top of pay, its own line. */
  orphanagePay: number;
  mesaDisbursement: number;
  mesaDeduction: number;
  totalPayPhp: number;
  fxRate: number;
  /** `total_pay_php / fx_rate`, already rounded to 2dp like the email. */
  totalPayUsd: number;
  /**
   * Native COP equivalent for a COP-country payee (Colombian staff riding the
   * PHP rails): `round(totalPayUsd × usd_to_cop_rate)` — whole pesos, the same
   * derivation Payment Dispatch pays from, so statement and dispatch can never
   * disagree. Null for everyone else (the statement renders no COP line).
   * The payload doesn't carry this; the serving routes decorate it via
   * {@link applyCopEquivalent} after resolving the payee's onboarding country.
   */
  totalPayCop: number | null;
  /**
   * Mid-week rate-change proration (a department transfer, a dated raise) —
   * per-LINE previous→current rates + the per-rate hour basis, derived from the
   * payload's `proration` block. Null for the overwhelming majority of stubs
   * (no block, or every line paid at a single rate): those render the classic
   * lines untouched. When a line's entry is non-null the statement shows the
   * "Prorated" chip + `₱old → ₱new` + the basis in that line's EXISTING cells —
   * never an extra row. Weekend line rates are premium-inclusive, like
   * `weekendRate`. See `deriveProrationFields`.
   */
  proration: ProrationView | null;
}

type Json = Record<string, unknown> | null | undefined;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Parse a plain "YYYY-MM-DD" without TZ drift (server + client agree). */
function parseYmd(iso: string | null): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "Jul 7 – Jul 13, 2026" (mirrors the email's `week_human`). */
export function formatWeekHuman(start: string | null, end: string | null): string {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (s && e) {
    const left = `${MONTHS[s.m - 1] ?? ''} ${s.d}`;
    const right = `${MONTHS[e.m - 1] ?? ''} ${e.d}, ${e.y}`;
    return `${left} – ${right}`;
  }
  if (e) return `${MONTHS[e.m - 1] ?? ''} ${e.d}, ${e.y}`;
  if (s) return `${MONTHS[s.m - 1] ?? ''} ${s.d}, ${s.y}`;
  return '';
}

/**
 * "Jul 28, 2026" — a DATE-only column rendered as a calendar day, no TZ drift.
 * The paid-pill date on every statement surface.
 */
export function formatStatementDate(iso: string | null | undefined): string | null {
  const d = parseYmd(iso ?? null);
  return d ? `${MONTHS[d.m - 1] ?? ''} ${d.d}, ${d.y}` : null;
}

/* ───────────────────────── shared money formatting ─────────────────────────
 * Every statement surface — the wizard preview, the in-app modal, the emailed
 * HTML — prints a figure through these and only these. A second `toLocaleString`
 * call written inline anywhere is how the same peso amount ends up in two
 * different shapes on two documents describing one payment.
 */

/** `₱5,927.20` — always 2dp, en-US grouping. */
export function formatPhp(n: number): string {
  return `₱${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `$96.11 USD` — thousands separators like every other figure here. */
export function formatUsd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

/** `$COP526.686` — whole pesos, es-CO dot grouping, exactly as Payment Dispatch
 *  renders it, so one figure never appears in two shapes. */
export function formatCop(n: number): string {
  return `$COP${n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** `33.87` — hours, always 2dp. */
export function formatHours(n: number): string {
  return n.toFixed(2);
}

/* ─────────────────────── shared line visibility rules ───────────────────────
 * Which optional lines a statement shows. Kept here, beside the view, so the
 * three renderers cannot answer the question differently for the same week.
 */

/** Amounts under half a centavo are rounding dust, not money on the statement. */
const MONEY_EPSILON = 0.005;

/**
 * Whether the Orphanage line renders. It's an accounting extra almost nobody
 * receives, so a `₱0.00` row was noise on every other person's statement — the
 * line now appears only when there is money on it.
 *
 * The Weekend pair follows the same "only when it applies" rule, carried by
 * {@link PayStubView.hasWeekend} (HSL/Hogan weeks only). Every other line —
 * Regular, Overtime, Tech, Attendance, Performance, Adjustment, and the MESA
 * pair — always renders, ₱0.00 included, so the breakdown reconciles to Net the
 * same way on every document.
 */
export function showsOrphanageLine(view: Pick<PayStubView, 'orphanagePay'>): boolean {
  return Math.abs(view.orphanagePay) >= MONEY_EPSILON;
}

/** Default HSL weekend premium (₱/h) for payloads that predate carrying it. */
export const WEEKEND_PREMIUM_PHP_PER_HOUR = 15;

/** Normalized weekend figures as staged on a payload / snapshot. */
export interface WeekendFigures {
  hours: number;
  otHours: number;
  pay: number;
  otPay: number;
  premiumPerHour: number;
}

/**
 * The weekday/weekend split every renderer shares. Weekend amounts are the
 * staged truth; the weekday lines are derived by SUBTRACTION from the full
 * totals, so the four earnings lines always sum back to exactly
 * `mfPay + otPay` no matter how the two sides were rounded when staged.
 */
export function deriveWeekendFields(
  base: { mfHours: number; mfOtHours: number; mfRate: number; otRate: number; mfPay: number; otPay: number },
  weekend: WeekendFigures | null,
): Pick<
  PayStubView,
  | 'hasWeekend'
  | 'weekendHours'
  | 'weekendOtHours'
  | 'weekendRate'
  | 'weekendOtRate'
  | 'weekendPay'
  | 'weekendOtPay'
  | 'weekdayHours'
  | 'weekdayOtHours'
  | 'weekdayPay'
  | 'weekdayOtPay'
> {
  if (!weekend) {
    return {
      hasWeekend: false,
      weekendHours: 0,
      weekendOtHours: 0,
      weekendRate: 0,
      weekendOtRate: 0,
      weekendPay: 0,
      weekendOtPay: 0,
      weekdayHours: base.mfHours,
      weekdayOtHours: base.mfOtHours,
      weekdayPay: base.mfPay,
      weekdayOtPay: base.otPay,
    };
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    hasWeekend: true,
    weekendHours: weekend.hours,
    weekendOtHours: weekend.otHours,
    weekendRate: round2(base.mfRate + weekend.premiumPerHour),
    weekendOtRate: round2(base.otRate + weekend.premiumPerHour),
    weekendPay: weekend.pay,
    weekendOtPay: weekend.otPay,
    weekdayHours: Math.max(0, round2(base.mfHours - weekend.hours)),
    weekdayOtHours: Math.max(0, round2(base.mfOtHours - weekend.otHours)),
    weekdayPay: round2(base.mfPay - weekend.pay),
    weekdayOtPay: round2(base.otPay - weekend.otPay),
  };
}

/**
 * Raw payload-shaped `proration` block (snake_case), exactly as the wizard
 * stages it / the snapshot stores it. `parseProrationBlock` is the tolerant
 * reader; this type is for writers (the wizard's payload + snapshot build,
 * the freshness merge) so every producer emits the same shape.
 */
export interface ProrationBlockRaw {
  effective_date: string | null;
  old_rates_php: { regular: number | null; ot: number | null };
  new_rates_php: { regular: number | null; ot: number | null };
  segments: {
    regular: Array<{ rate_php: number; hours: number; pay_php: number }>;
    ot: Array<{ rate_php: number; hours: number; pay_php: number }>;
    weekend_regular: Array<{ rate_php: number; hours: number; pay_php: number }>;
    weekend_ot: Array<{ rate_php: number; hours: number; pay_php: number }>;
  };
}

/** One rate's share of a prorated line, as staged on the payload. */
export interface ProrationSegmentFig {
  ratePhp: number;
  hours: number;
  payPhp: number;
}

/** Normalized `proration` block as staged on a payload / snapshot. */
export interface ProrationFigures {
  /** First mid-period change date (YYYY-MM-DD), null when the block omits it. */
  effectiveDate: string | null;
  oldRates: { regular: number | null; ot: number | null };
  newRates: { regular: number | null; ot: number | null };
  /** Per-rate itemization in pay order. `regular`/`ot` are FULL-week; the
   *  `weekend*` pairs carve the Sat+Sun portion out per rate (HSL only). */
  segments: {
    regular: ProrationSegmentFig[];
    ot: ProrationSegmentFig[];
    weekendRegular: ProrationSegmentFig[];
    weekendOt: ProrationSegmentFig[];
  };
}

/** A statement line that genuinely paid at 2+ rates: what its cells display. */
export interface ProratedLineView {
  previousRate: number;
  currentRate: number;
  /** The hour basis, in pay order — "16.25h @ ₱175.00 · 23.75h @ ₱225.00". */
  segments: Array<{ ratePhp: number; hours: number }>;
}

/** Per-line proration display data; a null line renders classic (no chip). */
export interface ProrationView {
  effectiveDate: string | null;
  /** "Jul 22" — for the basis line's "effective …" suffix; '' when undated. */
  effectiveHuman: string;
  regular: ProratedLineView | null;
  ot: ProratedLineView | null;
  weekendRegular: ProratedLineView | null;
  weekendOt: ProratedLineView | null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function parseSegmentList(v: unknown): ProrationSegmentFig[] {
  if (!Array.isArray(v)) return [];
  const out: ProrationSegmentFig[] = [];
  for (const raw of v) {
    const s = obj(raw);
    const ratePhp = numOrNull(s.rate_php);
    const hours = numOrNull(s.hours);
    const payPhp = numOrNull(s.pay_php);
    // A segment missing any leg can't state a basis — drop it rather than
    // rendering a claim the arithmetic can't back.
    if (ratePhp == null || hours == null || payPhp == null) continue;
    out.push({ ratePhp, hours, payPhp });
  }
  return out;
}

/**
 * Parse a payload's `proration` block (mid-week transfers / dated rate changes
 * — see `DispatchEmployee` in PayrollWizard). Absent/null → null: payloads
 * staged before the block existed render exactly as before.
 */
export function parseProrationBlock(payload: Json): ProrationFigures | null {
  const p = obj(payload);
  if (!p.proration || typeof p.proration !== 'object') return null;
  const pr = obj(p.proration);
  const oldRates = obj(pr.old_rates_php);
  const newRates = obj(pr.new_rates_php);
  const segs = obj(pr.segments);
  return {
    effectiveDate: typeof pr.effective_date === 'string' && pr.effective_date ? pr.effective_date : null,
    oldRates: { regular: numOrNull(oldRates.regular), ot: numOrNull(oldRates.ot) },
    newRates: { regular: numOrNull(newRates.regular), ot: numOrNull(newRates.ot) },
    segments: {
      regular: parseSegmentList(segs.regular),
      ot: parseSegmentList(segs.ot),
      weekendRegular: parseSegmentList(segs.weekend_regular),
      weekendOt: parseSegmentList(segs.weekend_ot),
    },
  };
}

/** Hours below this are rounding dust, not a payable share of a line. */
const PRORATION_HOURS_EPSILON = 0.005;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-07-22" → "Jul 22" (statement-style, no year — the header carries it). */
function formatEffectiveHuman(iso: string | null): string {
  const d = parseYmd(iso);
  return d ? `${MONTHS[d.m - 1] ?? ''} ${d.d}` : '';
}

/** ≥2 real segments → a prorated line view; otherwise null (classic render). */
function toLineView(
  segs: Array<{ ratePhp: number; hours: number }>,
): ProratedLineView | null {
  const real = segs.filter((s) => s.hours > PRORATION_HOURS_EPSILON);
  if (real.length < 2) return null;
  return {
    previousRate: real[0].ratePhp,
    currentRate: real[real.length - 1].ratePhp,
    segments: real.map((s) => ({ ratePhp: s.ratePhp, hours: round2(s.hours) })),
  };
}

/**
 * Derive the per-line proration display from the staged block. Mirrors the
 * statement's line structure exactly:
 *  - with a weekend carve-out, Regular/Overtime show the WEEKDAY portion, so
 *    their basis is weekday-scoped too — full segments minus the weekend
 *    segments, matched per rate;
 *  - the weekend lines display premium-inclusive rates (`weekendRate`), so
 *    their basis rates carry the premium as well.
 * Null when no line paid at 2+ rates — the whole statement renders classic.
 */
export function deriveProrationFields(
  pror: ProrationFigures | null,
  weekend: WeekendFigures | null,
): ProrationView | null {
  if (!pror) return null;

  const minusWeekend = (
    full: ProrationSegmentFig[],
    wknd: ProrationSegmentFig[],
  ): Array<{ ratePhp: number; hours: number }> =>
    full.map((s) => ({
      ratePhp: s.ratePhp,
      hours: s.hours - (wknd.find((w) => w.ratePhp === s.ratePhp)?.hours ?? 0),
    }));

  const premium = weekend ? weekend.premiumPerHour : WEEKEND_PREMIUM_PHP_PER_HOUR;
  const plusPremium = (segs: ProrationSegmentFig[]) =>
    segs.map((s) => ({ ratePhp: round2(s.ratePhp + premium), hours: s.hours }));

  // Without a weekend block the statement's Regular/Overtime rows are the full
  // week, so the full segments ARE the basis; with one they show weekday-only.
  const regular = toLineView(
    weekend ? minusWeekend(pror.segments.regular, pror.segments.weekendRegular) : pror.segments.regular,
  );
  const ot = toLineView(
    weekend ? minusWeekend(pror.segments.ot, pror.segments.weekendOt) : pror.segments.ot,
  );
  const weekendRegular = toLineView(plusPremium(pror.segments.weekendRegular));
  const weekendOt = toLineView(plusPremium(pror.segments.weekendOt));

  if (!regular && !ot && !weekendRegular && !weekendOt) return null;
  return {
    effectiveDate: pror.effectiveDate,
    effectiveHuman: formatEffectiveHuman(pror.effectiveDate),
    regular,
    ot,
    weekendRegular,
    weekendOt,
  };
}

/**
 * Parse a payload's `weekend` block (HSL rows only — see `DispatchEmployee` in
 * PayrollWizard). Absent/null → null, which renders the classic two-line
 * earnings section, so payloads staged before this field existed are untouched.
 */
export function parseWeekendBlock(payload: Json): WeekendFigures | null {
  const p = obj(payload);
  if (!p.weekend || typeof p.weekend !== 'object') return null;
  const w = obj(p.weekend);
  const hours = obj(w.hours);
  const pay = obj(w.pay_php);
  const premium = num(w.premium_php_per_hour);
  return {
    hours: num(hours.regular),
    otHours: num(hours.ot),
    pay: num(pay.regular),
    otPay: num(pay.ot),
    premiumPerHour: premium > 0 ? premium : WEEKEND_PREMIUM_PHP_PER_HOUR,
  };
}

/**
 * Build the paystub view from a staged payload. `payPeriod` is the queue row's
 * `pay_period` column; the payload also carries its own `pay_period`, so we fall
 * back to whichever resolves the week + fx rate.
 */
export function mapPayloadToPayStub(payload: Json, payPeriod?: Json): PayStubView {
  const p = obj(payload);
  const hours = obj(p.hours);
  const rates = obj(p.rates_php);
  const pay = obj(p.pay_php);
  // Prefer the payload's own pay_period; fall back to the queue row's column.
  const period = obj(p.pay_period ?? payPeriod);
  const week = obj(period.week);

  const weekStart = week.start ? str(week.start) : null;
  const weekEnd = week.end ? str(week.end) : null;
  const fxRateRaw = num(period.fx_rate);
  const fxRate = fxRateRaw > 0 ? fxRateRaw : 58;
  const totalPayPhp = num(pay.final);

  const baseFigures = {
    mfHours: num(hours.regular),
    mfOtHours: num(hours.ot),
    mfRate: num(rates.regular),
    otRate: num(rates.ot),
    mfPay: num(pay.regular),
    otPay: num(pay.ot),
  };

  const weekendFigures = parseWeekendBlock(payload);

  return {
    name: str(p.name),
    department: str(p.department_name) || '—',
    weekStart,
    weekEnd,
    weekHuman: formatWeekHuman(weekStart, weekEnd),
    salaryDate: period.salary_date ? str(period.salary_date) : null,
    ...baseFigures,
    ...deriveWeekendFields(baseFigures, weekendFigures),
    proration: deriveProrationFields(parseProrationBlock(payload), weekendFigures),
    techBonus: num(pay.tech_bonus),
    attendanceBonus: num(pay.perfect_attendance_bonus),
    performanceBonus: num(pay.other_bonuses),
    adjustment: num(pay.adjustment),
    adjustmentNote: p.adjustment_note ? str(p.adjustment_note) : null,
    orphanagePay: num(pay.orphanage_pay),
    mesaDisbursement: num(pay.mesa_disbursement),
    mesaDeduction: num(pay.mesa_deduction),
    totalPayPhp,
    fxRate,
    totalPayUsd: Math.round((totalPayPhp / fxRate) * 100) / 100,
    totalPayCop: null,
  };
}

/**
 * Stamp the native COP equivalent onto a built view — for COP-country payees
 * only (the caller resolves that from the onboarding paperwork). Whole pesos
 * off the USD anchor, exactly like the dispatch queue's `amountCOP`
 * (`Math.round(totalPayUSD × usdToCop)`). A non-positive rate leaves the view
 * untouched rather than stamping a zero.
 */
export function applyCopEquivalent(view: PayStubView, usdToCop: number): PayStubView {
  if (!(usdToCop > 0)) return view;
  return { ...view, totalPayCop: Math.round(view.totalPayUsd * usdToCop) };
}
