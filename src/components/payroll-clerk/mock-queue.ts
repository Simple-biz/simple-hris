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
    id: 'hurupay',
    label: 'Hurupay',
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
export type ExclusionReason = 'no_bank' | 'no_pay' | 'no_hours' | 'do_not_pay' | 'no_rate';

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
  /** Native COP amount (whole pesos), derived from the USD anchor. Only
   *  meaningful when `payCurrency === 'COP'`; null otherwise. */
  amountCOP: number | null;
  /**
   * Currency this employee is actually PAID in (from their effective Payment
   * Catalog rate). 'USD'/'COP' people are routed to Payment Dispatch's dedicated
   * tab and shown/paid natively (`amountUSD`/`amountCOP`); 'PHP' people stay in
   * the processor tabs. Defaults to 'PHP' for legacy/unknown rows.
   */
  payCurrency: PayCurrency;
  /** Regular + OT only (no bonuses). For the breakdown tooltip / chip. */
  initialPayUSD: number | null;
  initialPayPHP: number | null;
  /** PAB ₱5,000 when this is the final week of the PAB month and the employee qualifies. */
  pabBonusPHP: number;
  /** Tech ₱1,850 on the salary-falls-in-3rd-week paycheck with 30 days of service. */
  techBonusPHP: number;
  /** Sum of all bonuses included in amountUSD/PHP. */
  bonusTotalPHP: number;
  /** Hours worked in the current period; null when not present in Hubstaff. */
  totalHours: number | null;
  /** Overtime hours (total – regular). `null` when no Hubstaff entry. */
  otHours: number | null;
  /** Raw bank_preferred string from the rates row (e.g. "x1161") for surfaces that need it. */
  bankPreferredRaw: string | null;
  /**
   * Payroll department this person belongs to, carried from the rates row so the
   * dispatch queue + Mark Paid dialog can show accounting which team each payee
   * is in. `departmentKey` is the normalized key (null when the raw value can't
   * be mapped to a known department); `departmentName` is the human label to
   * display — the canonical name when resolved, else the raw string, else null.
   */
  departmentKey: string | null;
  departmentName: string | null;
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

/** Map the free-text "Bank Preferred" cell to one of our processor tabs. */
export function processorIdFromBankPreferred(raw: string | null | undefined): ProcessorId | null {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!v) return null;
  if (v === 'hurupay' || v === 'huru' || v === 'huropay') return 'hurupay';
  if (v === 'wepay') return 'wepay';
  if (v === 'higlobe' || v === 'higloble' || v === 'higlobel') return 'higlobe';
  if (v === 'wise' || v === 'transferwise') return 'wise';
  if (v === 'jeeves') return 'jeeves';
  // Account-suffix codes ("x1161", "x1153", etc.) are manually-keyed wires.
  if (/^x?\d{3,5}$/.test(v) || v === 'wire' || v === 'wires' || v.startsWith('wire')) return 'wires';
  return null;
}

/**
 * Bucket every employee with a recognised processor into a dispatch row.
 * Joins per-employee pay (computed server-side from the latest Hubstaff
 * upload) onto each row by lowercased work email.
 *
 * `idsByEmail` is the lowercased-email → EmployeeIdRow map. When the row
 * has a valid `preferred_processor`, it wins over the legacy `bank_preferred`
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

    // Prefer the employee's explicit choice; fall back to the rates-side
    // legacy field for anyone who hasn't picked yet.
    const choseProcessor = (idsRow?.preferred_processor ?? '').trim().toLowerCase();
    const chosen = isKnownProcessor(choseProcessor) ? choseProcessor : null;
    const processor = chosen ?? processorIdFromBankPreferred(r.bank_preferred);
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
      const dept = resolveDept(r.department);
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
    // Resolve the payroll department for this payee. Fall back to the raw
    // rates-row value so accounting still sees *something* when the department
    // isn't in the canonical list (rather than a blank).
    const dept = resolveDept(r.department);
    const departmentName = dept.name ?? (r.department?.trim() || null);
    const bankSlot = preferredBankSlot(idsRow);
    const preferredBankName = bankSlot === 'alternative'
      ? pickFirst(idsRow?.alt_bank_name, idsRow?.bank_name)
      : pickFirst(idsRow?.bank_name, idsRow?.alt_bank_name);
    const preferredAccountHolder = bankSlot === 'alternative'
      ? pickFirst(idsRow?.alt_account_holder_name, idsRow?.account_holder_name)
      : pickFirst(idsRow?.account_holder_name, idsRow?.alt_account_holder_name);
    const preferredAccountNumber = bankSlot === 'alternative'
      ? pickFirst(idsRow?.alt_account_number, idsRow?.account_number)
      : pickFirst(idsRow?.account_number, idsRow?.alt_account_number);
    const preferredSwiftCode = bankSlot === 'alternative'
      ? pickFirst(idsRow?.alt_routing_number, idsRow?.swift_code, idsRow?.routing_number)
      : pickFirst(idsRow?.swift_code, idsRow?.routing_number, idsRow?.alt_routing_number);

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
      initialPayUSD: pay?.initialPayUSD ?? null,
      initialPayPHP: pay?.initialPayPHP ?? null,
      pabBonusPHP: pay?.pabBonusPHP ?? 0,
      techBonusPHP: pay?.techBonusPHP ?? 0,
      bonusTotalPHP: pay?.bonusTotalPHP ?? 0,
      totalHours: pay?.totalHours ?? null,
      otHours: pay?.otHours ?? null,
      bankPreferredRaw: r.bank_preferred,
      departmentKey: dept.key,
      departmentName,
      details: {
        email,
        // Employee-provided values (employee_ids) win over rates-side ones.
        hurupay_email: pickFirst(idsRow?.hurupay_email, r.hurupay_email),
        wepay_email: pickFirst(idsRow?.wepay_email),
        higlobe_email: pickFirst(idsRow?.higlobe_email, r.higlobe_email),
        higlobe_account_name: pickFirst(idsRow?.higlobe_account_name, r.higlobe_account_name),
        wise_email: pickFirst(idsRow?.wise_email),
        wise_tag: pickFirst(idsRow?.wise_tag),
        phone_number: pickFirst(idsRow?.phone_number, r.phone_number),
        full_address: pickFirst(idsRow?.full_address, r.full_address),
        city: pickFirst(r.city),
        province_state: pickFirst(r.province_state),
        // Wire-only fields live solely on employee_ids (employee-provided).
        bank_name: preferredBankName,
        account_holder_name: preferredAccountHolder,
        account_number: preferredAccountNumber,
        swift_code: preferredSwiftCode,
      },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  excluded.sort((a, b) => a.name.localeCompare(b.name));
  return { active: out, excluded };
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
