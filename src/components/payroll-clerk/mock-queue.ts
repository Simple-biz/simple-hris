import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { CurrentPayEntry } from '@/lib/payroll/current-pay';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';
import { DEPARTMENTS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';

/** Resolve a rates-row Department string to a { key, name } payroll department. */
function resolveDept(raw: string | null | undefined): { key: string | null; name: string | null } {
  const key = normalizeDeptToKey(raw);
  const name = key ? (DEPARTMENTS.find((d) => d.key === key)?.name ?? null) : null;
  return { key, name };
}

/**
 * Department for a queue payee, preferring the pay-layer resolution (which draws
 * from the Global Master List first, then the rates row — so it's populated for
 * EVERY payee, not just HSL) and falling back to the rates-row "Department"
 * string when pay carries nothing. The name is the canonical label when known,
 * else the raw source string so an unmapped-but-present department still shows.
 */
function resolvePayeeDept(
  pay: CurrentPayEntry | undefined,
  ratesDeptRaw: string | null | undefined,
): { key: string | null; name: string | null } {
  const payKey = pay?.departmentKey ?? null;
  const payName = pay?.departmentName ?? null;
  if (payKey || payName) {
    return { key: payKey, name: payName };
  }
  // Nothing from pay — fall back to the rates-row department (canonicalize, but
  // keep the raw string when it maps to no known department).
  const dept = resolveDept(ratesDeptRaw);
  return { key: dept.key, name: dept.name ?? (ratesDeptRaw?.trim() || null) };
}

export type ProcessorId = 'hurupay' | 'wepay' | 'higlobe' | 'wise' | 'jeeves' | 'wires';

export interface ProcessorMeta {
  id: ProcessorId;
  label: string;
  blurb: string;
  /** Fields Lenny needs visible when she clicks the row, per Carla's spec. */
  detailFields: string[];
}

export const PROCESSORS: ProcessorMeta[] = [
  {
    // id + detailFields are STORED keys (employee_ids.bank_preferred,
    // employee_ids.hurupay_email) and never move; only `label` follows the
    // 2026-08-24 Hurupay -> Kolan rebrand.
    id: 'hurupay',
    label: 'Kolan',
    blurb: 'Email only',
    detailFields: ['hurupay_email'],
  },
  {
    id: 'wepay',
    label: 'Wepay',
    blurb: 'Email only',
    detailFields: ['email'],
  },
  {
    id: 'higlobe',
    label: 'Higlobe',
    blurb: 'Email + account holder name',
    detailFields: ['higlobe_email', 'higlobe_account_name'],
  },
  {
    id: 'wise',
    label: 'Wise',
    blurb: 'Email + Wise tag',
    detailFields: ['email', 'phone_number'],
  },
  {
    id: 'jeeves',
    label: 'Jeeves',
    blurb: 'Phone + wire details',
    detailFields: ['phone_number', 'full_address'],
  },
  {
    id: 'wires',
    label: 'Wires',
    blurb: 'Name + address (manual wire — verify SWIFT/account)',
    detailFields: ['phone_number', 'full_address', 'city', 'province_state'],
  },
];

/**
 * Processors retired from the dispatch tabs / pickers. They intentionally stay
 * in PROCESSORS and the ProcessorId type so historical dispatch records still
 * resolve their label + visuals in Reports / Done / Sent-payments history —
 * they're simply no longer shown as a pending-queue tab or offered as a new
 * dispatch destination. Mirrors RETIRED_PROCESSOR_IDS in
 * src/lib/employee-payment-processors.ts (where 'wepay' is likewise retired).
 */
export const RETIRED_DISPATCH_PROCESSOR_IDS: readonly ProcessorId[] = ['wepay'];

/**
 * PROCESSORS minus retired ones. Render dispatch tabs, filter rails, and
 * processor pickers from this; keep using PROCESSORS for `.find()` label/visual
 * lookups so old records still resolve.
 */
export const DISPATCH_PROCESSORS: ProcessorMeta[] = PROCESSORS.filter(
  (p) => !RETIRED_DISPATCH_PROCESSOR_IDS.includes(p.id),
);

/**
 * A row that can't be dispatched this cycle. Surfaced in the "No Bank Preferred /
 * No Current Pay / No Hours" tab so Lenny can see why someone is missing from
 * the active queue rather than them silently disappearing.
 */
export type ExclusionReason =
  | 'no_bank'
  | 'no_pay'
  | 'no_hours'
  | 'do_not_pay'
  /**
   * RETIRED — nothing emits this any more. It used to mean "no
   * `employee_hourly_rates` row", which stopped being a problem when the Payment
   * Catalog became the rate source of truth: catalog-paid people legitimately have
   * no rates row, and {@link buildStagedOnlyPlacement} now routes them on their
   * actual bank pick instead of flagging them.
   *
   * KEPT in the union (and in ExcludedQueue's label map) deliberately: the
   * dispatch queue is cached in sessionStorage, which survives a page reload, so
   * a queue cached before this change can still contain 'no_rate' rows. Dropping
   * the member would leave those rows without a label.
   */
  | 'no_rate'
  /**
   * A contractor invoice whose Mark Paid stamped the claim but then failed to
   * write the payment row AND failed to release it. Deliberately NOT payable
   * (a dispatch row may or may not exist) but visible, so an owed invoice can
   * never quietly vanish. Investigate before paying out of band.
   */
  | 'claim_stuck'
  /**
   * A contractor invoice still awaiting Accounting approval. NOT payable —
   * a pending invoice is money Accounting has not authorized — but visible,
   * so the current week's filed invoices show up in Payment Dispatch instead
   * of silently waiting in the Payroll Wizard's Contractors step.
   */
  | 'pending_approval'
  /**
   * A USD-denominated payee (US-based staff on a USD pay structure). NOT payable
   * from this screen — US staff settle on their own track, outside the peso
   * payroll — but visible, so the money is auditable rather than vanishing.
   *
   * These used to sit in a dedicated USD queue tab, which meant they counted
   * against the pending total and held the Dispatch Progress strip below 100%
   * for a week that was, as far as this screen is concerned, fully paid. They
   * are now held here instead (2026-08-07).
   */
  | 'usd_paid';

export interface ExcludedRow {
  id: string;
  name: string;
  email: string;
  totalHours: number | null;
  amountUSD: number | null;
  amountPHP: number | null;
  /** Native COP amount (whole pesos); only meaningful for COP-paid people. */
  amountCOP: number | null;
  bankPreferredRaw: string | null;
  reasons: ExclusionReason[];
  /**
   * Department key + human name carried from the wizard-staged paystub row, so
   * the Excluded tab can offer a per-department filter. Null when unknown (e.g.
   * a no_bank/no_pay/no_hours row or a prior-cycle arrears row with no staged
   * department).
   */
  departmentKey?: string | null;
  departmentName?: string | null;
  /** See {@link QueueRow.payeeKind}. Absent means 'employee'. */
  payeeKind?: 'employee' | 'contractor';
  /** See {@link QueueRow.contractorRole} — display only. */
  contractorRole?: boolean;
  /** The `contractor_invoices.id` behind this row, when it came from an invoice. */
  contractorInvoiceId?: string | null;
  invoiceNumber?: string | null;
  /**
   * Present when this person was excluded from pay in the Payroll Wizard
   * ('do_not_pay') but is otherwise dispatchable (has bank + pay + hours). The
   * Excluded tab can still pay them — which logs the dispatch and sends their
   * staged paystub — once accounting clears them.
   */
  payable?: QueueRow | null;
  /** ISO timestamp the paystub for this person was last sent (from staging). */
  paystubSentAt?: string | null;
  /**
   * Cumulative pending pay across every UNPAID held cycle (the arrears ledger).
   * Present for 'do_not_pay' rows. `amountUSD/PHP` on the row mirror the total.
   */
  arrears?: ArrearsInfo | null;
}

/** One unpaid held cycle in the arrears breakdown (client view). */
export interface ArrearsCycleView {
  sourceFile: string;
  label: string;
  amountPHP: number | null;
  amountUSD: number | null;
  amountCOP: number | null;
  paystubSentAt: string | null;
  lastError: string | null;
}

/** An employee's cumulative pending across all unpaid held cycles. */
export interface ArrearsInfo {
  totalPHP: number;
  totalUSD: number;
  totalCOP: number;
  cycles: ArrearsCycleView[];
}

/**
 * ISO period start/end parsed from a Hubstaff source filename
 * (`..._2026-06-08_to_2026-06-14.csv`). Nulls when the range can't be parsed —
 * used to stamp prior-cycle arrears payments with real cycle dates.
 */
export function parseCyclePeriodFromFile(sourceFile: string): { start: string | null; end: string | null } {
  const m = /(\d{4}-\d{2}-\d{2})_to_(\d{4}-\d{2}-\d{2})/.exec(sourceFile);
  return m ? { start: m[1], end: m[2] } : { start: null, end: null };
}

/**
 * Human cycle label from a Hubstaff source filename
 * (`..._2026-06-08_to_2026-06-14.csv` → "Jun 8 – 14, 2026"). Falls back to the
 * filename minus `.csv` when the date range can't be parsed.
 */
export function formatCycleLabelFromFile(sourceFile: string): string {
  const m = /(\d{4})-(\d{2})-(\d{2})_to_(\d{4})-(\d{2})-(\d{2})/.exec(sourceFile);
  const fallback = sourceFile.replace(/\.csv$/i, '');
  if (!m) return fallback;
  const s = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const e = new Date(Date.UTC(+m[4], +m[5] - 1, +m[6]));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return fallback;
  const mon = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = (d: Date) => d.getUTCDate();
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${mon(s)} ${day(s)} – ${day(e)}, ${e.getUTCFullYear()}`;
  }
  if (s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${mon(s)} ${day(s)} – ${mon(e)} ${day(e)}, ${e.getUTCFullYear()}`;
  }
  return `${mon(s)} ${day(s)}, ${s.getUTCFullYear()} – ${mon(e)} ${day(e)}, ${e.getUTCFullYear()}`;
}

export interface QueueRow {
  id: string;
  processor: ProcessorId;
  name: string;
  email: string;
  /** USD amount Lenny should pay = regular + OT + bonuses. */
  amountUSD: number | null;
  /** PHP equivalent of amountUSD. */
  amountPHP: number | null;
  /** Native COP amount (whole pesos), derived from the USD anchor. Populated
   *  whenever the pay layer could derive it; the number a clerk actually keys
   *  in when `payCurrency === 'COP'` (COP tab) or `countryCurrency === 'COP'`
   *  (Colombian staff riding the PHP rails). */
  amountCOP: number | null;
  /**
   * Currency this employee is actually PAID in (from their effective Payment
   * Catalog rate). 'USD'/'COP' people are routed to Payment Dispatch's dedicated
   * tab and shown/paid natively (`amountUSD`/`amountCOP`); 'PHP' people stay in
   * the processor tabs. Defaults to 'PHP' for legacy/unknown rows.
   */
  payCurrency: PayCurrency;
  /**
   * Currency of the payee's receiving COUNTRY (onboarding paperwork), distinct
   * from `payCurrency`: Colombian staff carry PHP-denominated rates through the
   * normal processor tabs, but their bank settles in COP — 'COP' here swaps the
   * row's secondary amount (and the Mark Paid dialog's copyable sub-line) to the
   * native COP figure. Optional: contractor rows and legacy payloads omit it.
   */
  countryCurrency?: PayCurrency | null;
  /** Regular + OT only (no bonuses). For the breakdown tooltip / chip. */
  initialPayUSD: number | null;
  initialPayPHP: number | null;
  /** PAB ₱5,000 when this is the final week of the PAB month and the employee qualifies. */
  pabBonusPHP: number;
  /** Tech ₱1,850 on the salary-falls-in-3rd-week paycheck with 30 days of service. */
  techBonusPHP: number;
  /**
   * Everything inside amountUSD/PHP beyond Initial, Orphanage and MESA: PAB +
   * Tech + dept/KPI bonuses + the signed Adj. delta.
   *
   * **Can be NEGATIVE** — the Adj. column is a signed delta on top of the bonus
   * subtotal (docs/features/payroll-wizard-final-pay.md §2), so an adjustment
   * larger than the bonuses makes this negative and money is being WITHHELD.
   * Anything rendering it must not gate on `> 0`.
   */
  bonusTotalPHP: number;
  /**
   * The two halves of {@link bonusTotalPHP} that are neither PAB nor Tech, kept
   * apart because they mean opposite things to whoever reads a worksheet:
   * `otherBonusesPHP` is EARNED dept/KPI money, `adjustmentPHP` is Accounting's
   * SIGNED delta and is frequently money being WITHHELD. Folding them together
   * is exactly the defect the wizard's own exports fixed in
   * `src/lib/payroll-wizard/report-rows.ts` (memory: payroll-exports-itemized).
   *
   * `bonusTotalPHP = pabBonusPHP + techBonusPHP + otherBonusesPHP + adjustmentPHP`.
   */
  otherBonusesPHP: number;
  /** See {@link otherBonusesPHP}. SIGNED — never gate its display on `> 0`. */
  adjustmentPHP: number;
  /** Accounting's manual Orphanage add, as the wizard priced it. Its own paystub
   *  line, so it is NOT part of {@link bonusTotalPHP}. */
  orphanagePayPHP: number;
  /** ₱100 MESA contribution withheld this run. Subtracted inside the amount. */
  mesaDeductionPHP: number;
  /** Approved MESA emergency disbursement released this run. Added inside the amount. */
  mesaDisbursementPHP: number;
  /**
   * WHICH CARRIER priced this row.
   *
   * - `'snapshot'` — the wizard's live final-pay snapshot, which qualified to
   *   speak for this row (newer than the lock, itemized, catalog-consistent).
   * - `'lock'` — the figures `paystub_dispatch_queue` froze at "Lock in Values".
   * - `'recomputed'` — NEITHER carrier could speak for this payee, so the row
   *   carries `computeCurrentPay`'s figure, which knows nothing of the accounting
   *   layer (Adj. / Orphanage / KPI-dept bonuses / MESA). Surfaced, never silent.
   *
   * Absent on rows that don't come from the wizard at all (contractor invoices,
   * Urgent one-offs), where the concept doesn't apply.
   */
  valuesSource?: 'snapshot' | 'lock' | 'recomputed';
  /**
   * TRUE when the bonus/Orphanage/MESA split is genuinely UNKNOWN for this row —
   * no itemization was available from either carrier. The breakdown fields are 0
   * as a type floor; a renderer must show "—", never "₱0", or it states a figure
   * nobody computed.
   */
  breakdownUnavailable?: boolean;
  /** The total the wizard FROZE at lock time, when this row was staged. */
  lockedAmountPHP?: number | null;
  /** The wizard re-priced this person AFTER the values were locked, and the newer
   *  figure is what's shown. Legitimate (a late Adj., a post-lock rate fix) but
   *  never silent — a clerk must be able to see the amount moved. */
  repricedAfterLock?: boolean;
  /** Hours worked in the current period; null when not present in Hubstaff. */
  totalHours: number | null;
  /** Overtime hours (total – regular). `null` when no Hubstaff entry. */
  otHours: number | null;
  /** Raw bank_preferred string from the rates row (e.g. "x1161") for surfaces that need it. */
  bankPreferredRaw: string | null;
  /**
   * TRUE when this row's send rail was temporarily rerouted wires → Wise because
   * the week's PHP amount is under ₱7,000 (owner rule, 2026-07-29 — see
   * {@link applySmallWiresWiseReroute}). Display/audit only: `bankPreferredRaw`
   * still carries the stored wires routing and nothing is written back to
   * `employee_ids`, so a ≥₱7k week routes the person straight back to Wires.
   */
  smallWiresViaWise?: boolean;
  /**
   * Payroll department this person belongs to, carried from the rates row so the
   * dispatch queue + Mark Paid dialog can show accounting which team each payee
   * is in. `departmentKey` is the normalized key (null when the raw value can't
   * be mapped to a known department); `departmentName` is the human label to
   * display — the canonical name when resolved, else the raw string, else null.
   */
  departmentKey: string | null;
  departmentName: string | null;
  /**
   * SETTLEMENT KIND. Absent/undefined means 'employee' — the hourly payroll rows
   * built by {@link buildQueueFromRates}, i.e. every row that existed before
   * contractors joined the queue.
   *
   * 'contractor' is set ONLY by src/lib/contractor/contractor-dispatch-queue.ts,
   * on a row that settles one approved `contractor_invoices` row, and it always
   * travels with {@link contractorInvoiceId}. It is paid through the same
   * processors, the same Mark Paid dialog and the same already-paid filter as
   * anyone else; the flag only selects the invoice-settlement path on the POST.
   *
   * NEVER set this for display purposes — an hourly row that carries it would
   * POST payee_type='contractor' with no invoice id and be rejected 400, making
   * that employee unpayable. Use {@link contractorRole} to badge a person.
   *
   * Deliberately OPTIONAL: three call sites build a QueueRow (here, plus
   * `toQueueRow` / `toQueueRowOneOff` in UrgentPaymentsQueue.tsx), and a required
   * field would break the Urgent adapters.
   */
  payeeKind?: 'employee' | 'contractor';
  /**
   * DISPLAY ONLY: this person holds the `contractor` role, so the Contractor
   * badge shows on their row even when this particular payment is ordinary hourly
   * payroll (e.g. thea@, issa@ — contractors who also log Hubstaff hours).
   * Deliberately has no effect on settlement.
   */
  contractorRole?: boolean;
  /** The `contractor_invoices.id` this row settles. Only set on invoice-derived rows. */
  contractorInvoiceId?: string | null;
  /** Human invoice number (e.g. "circarrst-7-19-26-10"), shown beside the badge. */
  invoiceNumber?: string | null;
  details: {
    email?: string;
    hurupay_email?: string;
    wepay_email?: string;
    higlobe_email?: string;
    higlobe_account_name?: string;
    wise_email?: string;
    wise_tag?: string;
    phone_number?: string;
    full_address?: string;
    city?: string;
    province_state?: string;
    // Wires / Jeeves bank fields (employee-provided via Settings)
    bank_name?: string;
    account_holder_name?: string;
    account_number?: string;
    swift_code?: string;
  };
}

function pickFirst(...values: Array<string | null | undefined>): string | undefined {
  for (const v of values) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function preferredBankSlot(row: EmployeeIdRow | undefined): 'primary' | 'alternative' {
  return row?.preferred_bank_slot === 'alternative' ? 'alternative' : 'primary';
}

/** Canonical name for a payroll department key (null when unknown/blank). */
function deptNameForKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return DEPARTMENTS.find((d) => d.key === key)?.name ?? null;
}

/**
 * The processor the EMPLOYEE picked: their "Bank Preferred" send-from rail wins,
 * then their Disbursement channel (`preferred_processor`). Null when they've
 * picked neither — callers then fall back to the legacy rates-sheet cell.
 *
 * Shared by the rates-driven queue and the wizard-staged safety net so both
 * route a person the same way.
 */
function resolveChosenProcessor(idsRow: EmployeeIdRow | undefined): ProcessorId | null {
  const choseBankPreferred = (idsRow?.bank_preferred ?? '').trim().toLowerCase();
  const choseProcessor = (idsRow?.preferred_processor ?? '').trim().toLowerCase();
  return (
    (isKnownProcessor(choseBankPreferred) ? choseBankPreferred : null) ??
    (isKnownProcessor(choseProcessor) ? choseProcessor : null)
  );
}

/** Rates-row fields that can backfill payout details. Optional — staged-only
 *  payees (catalog-paid, no rates row) simply pass nothing. */
type RatesDetailSource = Pick<
  EmployeeHourlyRateRow,
  | 'hurupay_email'
  | 'higlobe_email'
  | 'higlobe_account_name'
  | 'phone_number'
  | 'full_address'
  | 'city'
  | 'province_state'
>;

/**
 * The payout details Lenny sees on a row (and MarkPaidDialog auto-fills from).
 * Employee-provided `employee_ids` values win over the rates-side equivalents;
 * wire fields live solely on `employee_ids` and follow the preferred bank slot,
 * falling back to the other slot so a person with details in only one slot still
 * shows an account.
 */
function buildPayeeDetails(
  email: string,
  idsRow: EmployeeIdRow | undefined,
  r?: RatesDetailSource | null,
): QueueRow['details'] {
  const bankSlot = preferredBankSlot(idsRow);
  return {
    email,
    hurupay_email: pickFirst(idsRow?.hurupay_email, r?.hurupay_email),
    wepay_email: pickFirst(idsRow?.wepay_email),
    higlobe_email: pickFirst(idsRow?.higlobe_email, r?.higlobe_email),
    higlobe_account_name: pickFirst(idsRow?.higlobe_account_name, r?.higlobe_account_name),
    wise_email: pickFirst(idsRow?.wise_email),
    wise_tag: pickFirst(idsRow?.wise_tag),
    phone_number: pickFirst(idsRow?.phone_number, r?.phone_number),
    full_address: pickFirst(idsRow?.full_address, r?.full_address),
    city: pickFirst(r?.city),
    province_state: pickFirst(r?.province_state),
    // Wire-only fields live solely on employee_ids (employee-provided).
    bank_name:
      bankSlot === 'alternative'
        ? pickFirst(idsRow?.alt_bank_name, idsRow?.bank_name)
        : pickFirst(idsRow?.bank_name, idsRow?.alt_bank_name),
    account_holder_name:
      bankSlot === 'alternative'
        ? pickFirst(idsRow?.alt_account_holder_name, idsRow?.account_holder_name)
        : pickFirst(idsRow?.account_holder_name, idsRow?.alt_account_holder_name),
    account_number:
      bankSlot === 'alternative'
        ? pickFirst(idsRow?.alt_account_number, idsRow?.account_number)
        : pickFirst(idsRow?.account_number, idsRow?.alt_account_number),
    swift_code:
      bankSlot === 'alternative'
        ? pickFirst(idsRow?.alt_routing_number, idsRow?.swift_code, idsRow?.routing_number)
        : pickFirst(idsRow?.swift_code, idsRow?.routing_number, idsRow?.alt_routing_number),
  };
}

/** Map the free-text "Bank Preferred" cell to one of our processor tabs. */
export function processorIdFromBankPreferred(raw: string | null | undefined): ProcessorId | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  // 'kolan' is the post-rebrand spelling of the SAME rail (2026-08-24). A sheet
  // cell saying "Kolan" that resolved to null would drop the person out of the
  // dispatch queue entirely — unrouted people are never queued.
  if (v === 'hurupay' || v === 'huru' || v === 'huropay' || v === 'kolan') return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (v === 'higlobe' || v === 'higloble' || v === 'higlobel') return 'higlobe';
  if (v === 'wise' || v === 'transferwise') return 'wise';
  if (v === 'jeeves') return 'jeeves';
  // Account-suffix codes ("x1161", "x1153", etc.) are manually-keyed wires.
  if (/^x?\d{3,5}$/.test(v) || v === 'wire' || v === 'wires' || v.startsWith('wire')) return 'wires';
  return null;
}

/**
 * Sub-₱7k wires payments go out through Wise for that week (owner rule,
 * 2026-07-29): wire fees dwarf small transfers. STRICTLY under ₱7,000 — a week
 * at exactly ₱7,000 or more stays on Wires. Evaluated per pay cycle against the
 * final amount being sent and never persisted, so the route self-corrects on
 * the next paycheck.
 */
export const SMALL_WIRES_WISE_THRESHOLD_PHP = 7000;

/** True when a wires payment of this PHP amount must go out via Wise instead.
 *  Null/zero amounts never reroute — there's nothing to send. */
export function isSmallWiresAmountPHP(amountPHP: number | null | undefined): boolean {
  return (
    amountPHP != null &&
    Number.isFinite(amountPHP) &&
    amountPHP > 0 &&
    amountPHP < SMALL_WIRES_WISE_THRESHOLD_PHP
  );
}

/**
 * Apply the sub-₱7k wires → Wise reroute to a finished queue row. Only PHP-paid
 * rows on the wires rail move; contractor settlements (Wise is not a contractor
 * gateway) and USD/COP payees never do. Wise pays into the same receiving bank
 * account a wires person already has on file (Wise = wire fields), so the flip
 * changes the send rail only. Call AFTER every amount overlay (wizard final,
 * arrears rollup) — the decision keys on the amount actually being sent.
 */
export function applySmallWiresWiseReroute(row: QueueRow): QueueRow {
  if (row.processor !== 'wires') return row;
  if (row.payeeKind === 'contractor') return row;
  if (row.payCurrency !== 'PHP') return row;
  if (!isSmallWiresAmountPHP(row.amountPHP)) return row;
  return { ...row, processor: 'wise', smallWiresViaWise: true };
}

/**
 * Bucket every employee with a recognised processor into a dispatch row.
 * Joins per-employee pay (computed server-side from the latest Hubstaff
 * upload) onto each row by lowercased work email.
 *
 * `idsByEmail` is the lowercased-email → EmployeeIdRow map. Processor is
 * resolved by precedence: the employee's `bank_preferred` pick wins, then their
 * `preferred_processor` (Disbursement channel), then the legacy `bank_preferred`
 * on the rates row (so an employee picking "Higlobe" in Settings routes to
 * Lenny's Higlobe tab even if their rate row still has a stale "x1161"
 * wire suffix). The per-processor payout fields the employee filled in
 * (hurupay_email, higlobe_email, etc.) also win over the rates-side
 * equivalents — that's how Lenny sees the most current info on each row
 * and how MarkPaidDialog auto-fills.
 */
export function buildQueueFromRates(
  rows: EmployeeHourlyRateRow[],
  payByEmail: Record<string, CurrentPayEntry> = {},
  idsByEmail: Map<string, EmployeeIdRow> = new Map(),
): { active: QueueRow[]; excluded: ExcludedRow[] } {
  // Dedupe by lowercased email — `getEmployeeHourlyRatesRows` returns every
  // row in `employee_hourly_rates` regardless of upload_id, so an employee
  // who appears in multiple historical uploads shows up multiple times here.
  // Without this collapse, we emit two queue rows with the same `id` (which
  // is the email), and React fires "Encountered two children with the same
  // key" inside the dispatch table. Last occurrence wins — the rates ingest
  // upserts by email so the latest row carries the freshest values.
  const dedupedRows: EmployeeHourlyRateRow[] = [];
  {
    const byEmail = new Map<string, EmployeeHourlyRateRow>();
    const withoutEmail: EmployeeHourlyRateRow[] = [];
    for (const r of rows) {
      const e = (r.work_email?.trim() || r.personal_email?.trim() || '').toLowerCase();
      if (!e) {
        withoutEmail.push(r);
        continue;
      }
      byEmail.set(e, r);
    }
    dedupedRows.push(...byEmail.values(), ...withoutEmail);
  }

  const out: QueueRow[] = [];
  const excluded: ExcludedRow[] = [];
  for (const r of dedupedRows) {
    const email = r.work_email?.trim() || r.personal_email?.trim() || '';
    if (!email) continue;
    const lowerEmail = email.toLowerCase();
    const idsRow =
      idsByEmail.get(lowerEmail) ??
      (r.work_email ? idsByEmail.get(r.work_email.trim().toLowerCase()) : undefined) ??
      (r.personal_email ? idsByEmail.get(r.personal_email.trim().toLowerCase()) : undefined);

    // Processor precedence: the employee's "Bank Preferred" pick wins, then
    // their Disbursement channel, then the rates-side legacy field for anyone
    // who hasn't picked either. All three share the ProcessorId value space.
    const processor = resolveChosenProcessor(idsRow) ?? processorIdFromBankPreferred(r.bank_preferred);
    const name =
      idsRow?.name?.trim() ||
      email
        .split('@')[0]!
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()) ||
      email;
    const pay = payByEmail[email.toLowerCase()];

    // Apply the gate the user wants for the active queue: must have a
    // recognized bank/processor, a non-null current-pay amount, and non-null
    // hours. Anything missing → excluded bucket so it's still visible.
    const reasons: ExclusionReason[] = [];
    if (!processor) reasons.push('no_bank');
    if (pay?.totalPayUSD == null && pay?.initialPayUSD == null) reasons.push('no_pay');
    if (pay?.totalHours == null) reasons.push('no_hours');
    if (reasons.length > 0) {
      const dept = resolvePayeeDept(pay, r.department);
      excluded.push({
        id: email.toLowerCase(),
        name,
        email,
        totalHours: pay?.totalHours ?? null,
        amountUSD: pay?.totalPayUSD ?? pay?.initialPayUSD ?? null,
        amountPHP: pay?.totalPayPHP ?? pay?.initialPayPHP ?? null,
        amountCOP: pay?.totalPayCOP ?? null,
        bankPreferredRaw: r.bank_preferred,
        reasons,
        departmentKey: dept.key,
        departmentName: dept.name,
      });
      continue;
    }
    // From here on, processor is non-null because reasons would have caught
    // it. Narrow the type so TypeScript stops complaining.
    const activeProcessor: ProcessorId = processor!;
    // Resolve the payroll department for this payee. The pay layer already
    // picked the best source (master list → rates row) and covers everyone —
    // not just HSL — so prefer it; fall back to the rates-row value only when
    // pay carries nothing.
    const dept = resolvePayeeDept(pay, r.department);
    const departmentName = dept.name;

    out.push({
      id: email.toLowerCase(),
      processor: activeProcessor,
      name,
      email,
      // amountUSD/PHP carry regular + OT + bonuses so the dispatch row shows
      // the full amount Lenny needs to pay. Breakdown fields below let the
      // UI surface a "+ ₱5,000 PAB" chip when there's an addition.
      amountUSD: pay?.totalPayUSD ?? pay?.initialPayUSD ?? null,
      amountPHP: pay?.totalPayPHP ?? pay?.initialPayPHP ?? null,
      amountCOP: pay?.totalPayCOP ?? null,
      payCurrency: pay?.payCurrency ?? 'PHP',
      countryCurrency: pay?.countryCurrency ?? null,
      initialPayUSD: pay?.initialPayUSD ?? null,
      initialPayPHP: pay?.initialPayPHP ?? null,
      pabBonusPHP: pay?.pabBonusPHP ?? 0,
      techBonusPHP: pay?.techBonusPHP ?? 0,
      bonusTotalPHP: pay?.bonusTotalPHP ?? 0,
      // computeCurrentPay knows nothing of the accounting layer, so these are 0
      // here by definition. `applyWizardValues` in useDispatchQueue replaces the
      // whole set — total AND split together — whenever the wizard can speak for
      // this row, which is the only way they carry real figures. 0 keeps the
      // identity honest for carrier C too: its bonus total IS pab + tech.
      otherBonusesPHP: 0,
      adjustmentPHP: 0,
      orphanagePayPHP: 0,
      mesaDeductionPHP: pay?.mesaDeductionPHP ?? 0,
      mesaDisbursementPHP: 0,
      valuesSource: 'recomputed',
      totalHours: pay?.totalHours ?? null,
      otHours: pay?.otHours ?? null,
      bankPreferredRaw: r.bank_preferred,
      departmentKey: dept.key,
      departmentName,
      details: buildPayeeDetails(email, idsRow, r),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { active: out, excluded };
}

/**
 * The wizard-staged paystub fields the safety net needs. Structurally a subset of
 * `PaystubQueueListItem` so a staged row can be passed straight through.
 */
export interface StagedOnlyPayee {
  recipient_email: string;
  personal_email: string | null;
  recipient_name: string | null;
  department_key: string | null;
  amount_php: number | null;
  amount_usd: number | null;
  excluded: boolean;
  sent_at: string | null;
}

/** Where a staged-only payee belongs: the payable queue, or Excluded with reasons. */
export type StagedOnlyPlacement =
  | { kind: 'pending'; row: QueueRow }
  | { kind: 'excluded'; row: ExcludedRow };

/**
 * Build the dispatch row for someone the Payroll Wizard LOCKED IN who has no
 * `employee_hourly_rates` row, so {@link buildQueueFromRates} could never emit
 * them. That's the normal shape now: since the Payment Catalog became the rate
 * source of truth, catalog-paid people have no legacy rates row at all.
 *
 * This used to synthesize a row from the staged paystub alone — no `employee_ids`
 * lookup — which hardcoded `bankPreferredRaw: null` and `payable: null`. A person
 * with complete bank details on the People tab therefore showed in Excluded as
 * "No bank" + "No rate on file" + "Can't pay here", and re-saving their bank
 * details could never fix it (vanessade@simple.biz, 2026-07-29; 7 people /
 * ₱59,911 stranded in that one cycle).
 *
 * So route them exactly like everyone else: processor by the same precedence
 * ({@link resolveChosenProcessor}), payout details from `employee_ids`, hours from
 * the pay layer (which covers catalog-paid people). Only genuinely missing data
 * excludes them, and even then they stay payable when a processor resolves.
 *
 * The staged AMOUNT is authoritative — it's the number on the paystub that went
 * to this person — so it is not recomputed from the pay layer.
 *
 * Deliberately does NOT gate on hours: absent Hubstaff hours is a display gap,
 * not grounds to strand a salary the wizard already computed. Nor does it gate on
 * full payout completeness — that would hold staged payees to a stricter standard
 * than rates-row payees, who reach the queue on a resolvable processor alone.
 */
export function buildStagedOnlyPlacement(params: {
  staged: StagedOnlyPayee;
  idsRow: EmployeeIdRow | undefined;
  pay: CurrentPayEntry | undefined;
  /** DISPLAY ONLY — badges a contractor-role holder. Never sets payeeKind. */
  contractorRole?: boolean;
}): StagedOnlyPlacement {
  const { staged, idsRow, pay } = params;
  const contractorRole = params.contractorRole ?? false;
  const email = staged.recipient_email.trim();
  const id = email.toLowerCase();
  const name = staged.recipient_name?.trim() || idsRow?.name?.trim() || email;
  const processor = resolveChosenProcessor(idsRow);

  // Staged department is the wizard's own assignment; pay is the fallback.
  const departmentKey = staged.department_key ?? pay?.departmentKey ?? null;
  const departmentName = deptNameForKey(departmentKey) ?? pay?.departmentName ?? null;

  const amountPHP = staged.amount_php ?? pay?.totalPayPHP ?? null;
  const amountUSD = staged.amount_usd ?? pay?.totalPayUSD ?? null;
  const payCurrency: PayCurrency = pay?.payCurrency ?? 'PHP';
  const countryCurrency = pay?.countryCurrency ?? null;
  // Native COP rides along for anyone COP-relevant: COP-paid (COP tab) or a
  // COP-country payee on the PHP rails (secondary-line swap).
  const amountCOP =
    payCurrency === 'COP' || countryCurrency === 'COP' ? (pay?.totalPayCOP ?? null) : null;
  // Mirrors contractor-dispatch-queue: non-rates payees carry their employee_ids
  // routing pick here, so the Excluded tab's bank label never reads "No bank" for
  // someone who has one.
  const bankPreferredRaw = pickFirst(idsRow?.bank_preferred, idsRow?.preferred_processor) ?? null;

  const payable: QueueRow | null = processor
    ? {
        id,
        processor,
        name,
        email,
        amountUSD,
        amountPHP,
        amountCOP,
        payCurrency,
        countryCurrency,
        initialPayUSD: pay?.initialPayUSD ?? null,
        initialPayPHP: pay?.initialPayPHP ?? null,
        pabBonusPHP: pay?.pabBonusPHP ?? 0,
        techBonusPHP: pay?.techBonusPHP ?? 0,
        bonusTotalPHP: pay?.bonusTotalPHP ?? 0,
        otherBonusesPHP: 0,
        adjustmentPHP: 0,
        orphanagePayPHP: 0,
        mesaDeductionPHP: pay?.mesaDeductionPHP ?? 0,
        mesaDisbursementPHP: 0,
        // The staged TOTAL already won above (`staged.amount_php`), and
        // `applyWizardValues` runs over this row too — so the split lands with the
        // total rather than staying the engine's. Marked 'recomputed' until then.
        valuesSource: 'recomputed',
        totalHours: pay?.totalHours ?? null,
        otHours: pay?.otHours ?? null,
        bankPreferredRaw,
        departmentKey,
        departmentName,
        contractorRole,
        details: buildPayeeDetails(email, idsRow),
      }
    : null;

  const reasons: ExclusionReason[] = [];
  if (!processor) reasons.push('no_bank');
  if (amountPHP == null && amountUSD == null) reasons.push('no_pay');
  if (staged.excluded) reasons.push('do_not_pay');

  // No blockers → this is an ordinary payable row, not an exception.
  if (payable && reasons.length === 0) return { kind: 'pending', row: payable };

  return {
    kind: 'excluded',
    row: {
      id,
      name,
      email,
      totalHours: pay?.totalHours ?? null,
      amountUSD,
      amountPHP,
      amountCOP,
      bankPreferredRaw,
      reasons,
      departmentKey,
      departmentName,
      contractorRole,
      // Non-null whenever a processor resolves, so a wizard-held person can still
      // be paid from the Excluded tab once accounting clears them.
      payable,
      paystubSentAt: staged.sent_at,
    },
  };
}

const KNOWN_PROCESSOR_IDS: ReadonlySet<string> = new Set([
  'hurupay', 'wepay', 'higlobe', 'wise', 'jeeves', 'wires',
]);
function isKnownProcessor(v: string): v is ProcessorId {
  return KNOWN_PROCESSOR_IDS.has(v);
}

export function formatUSD(n: number | null): string {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPHP(n: number | null): string {
  if (n == null) return '—';
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Native COP — no minor unit, so whole pesos with grouping (e.g. "$COP8,000"). */
export function formatCOP(n: number | null): string {
  if (n == null) return '—';
  return '$COP' + n.toLocaleString('es-CO', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
