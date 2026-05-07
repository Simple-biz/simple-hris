import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
import type { EmployeeIdRow } from '@/lib/supabase/employee-ids';
import type { CurrentPayEntry } from '@/lib/payroll/current-pay';

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
 * A row that can't be dispatched this cycle. Surfaced in the "No Bank Preferred /
 * No Current Pay / No Hours" tab so Lenny can see why someone is missing from
 * the active queue rather than them silently disappearing.
 */
export type ExclusionReason = 'no_bank' | 'no_pay' | 'no_hours';

export interface ExcludedRow {
  id: string;
  name: string;
  email: string;
  totalHours: number | null;
  amountUSD: number | null;
  amountPHP: number | null;
  bankPreferredRaw: string | null;
  reasons: ExclusionReason[];
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
      excluded.push({
        id: email.toLowerCase(),
        name,
        email,
        totalHours: pay?.totalHours ?? null,
        amountUSD: pay?.totalPayUSD ?? pay?.initialPayUSD ?? null,
        amountPHP: pay?.totalPayPHP ?? pay?.initialPayPHP ?? null,
        bankPreferredRaw: r.bank_preferred,
        reasons,
      });
      continue;
    }
    // From here on, processor is non-null because reasons would have caught
    // it. Narrow the type so TypeScript stops complaining.
    const activeProcessor: ProcessorId = processor!;
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
      initialPayUSD: pay?.initialPayUSD ?? null,
      initialPayPHP: pay?.initialPayPHP ?? null,
      pabBonusPHP: pay?.pabBonusPHP ?? 0,
      techBonusPHP: pay?.techBonusPHP ?? 0,
      bonusTotalPHP: pay?.bonusTotalPHP ?? 0,
      totalHours: pay?.totalHours ?? null,
      otHours: pay?.otHours ?? null,
      bankPreferredRaw: r.bank_preferred,
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
