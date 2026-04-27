import type { EmployeeHourlyRateRow } from '@/lib/supabase/employee-hourly-rates';
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

export interface QueueRow {
  id: string;
  processor: ProcessorId;
  name: string;
  email: string;
  /** USD amount for this dispatch. `null` until the pay cycle ties amounts to people. */
  amountUSD: number | null;
  /** PHP amount, kept for tooltip / reference; null when pay can't be computed. */
  amountPHP: number | null;
  /** Hours worked in the current period; null when not present in Hubstaff. */
  totalHours: number | null;
  /** Overtime hours (total – regular). `null` when no Hubstaff entry. */
  otHours: number | null;
  /** Raw bank_preferred string from the rates row (e.g. "x1161") for surfaces that need it. */
  bankPreferredRaw: string | null;
  details: {
    email?: string;
    hurupay_email?: string;
    higlobe_email?: string;
    higlobe_account_name?: string;
    phone_number?: string;
    full_address?: string;
    city?: string;
    province_state?: string;
  };
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
 * Bucket every employee with a recognised "Bank Preferred" into a dispatch
 * row. Joins per-employee pay (computed server-side from the latest Hubstaff
 * upload) onto each row by lowercased work email.
 */
export function buildQueueFromRates(
  rows: EmployeeHourlyRateRow[],
  payByEmail: Record<string, CurrentPayEntry> = {},
): QueueRow[] {
  const out: QueueRow[] = [];
  for (const r of rows) {
    const processor = processorIdFromBankPreferred(r.bank_preferred);
    if (!processor) continue;
    const email = r.work_email?.trim() || r.personal_email?.trim() || '';
    if (!email) continue;
    const name =
      email
        .split('@')[0]!
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()) || email;
    const pay = payByEmail[email.toLowerCase()];
    out.push({
      id: email.toLowerCase(),
      processor,
      name,
      email,
      amountUSD: pay?.initialPayUSD ?? null,
      amountPHP: pay?.initialPayPHP ?? null,
      totalHours: pay?.totalHours ?? null,
      otHours: pay?.otHours ?? null,
      bankPreferredRaw: r.bank_preferred,
      details: {
        email,
        hurupay_email: r.hurupay_email ?? undefined,
        higlobe_email: r.higlobe_email ?? undefined,
        higlobe_account_name: r.higlobe_account_name ?? undefined,
        phone_number: r.phone_number ?? undefined,
        full_address: r.full_address ?? undefined,
        city: r.city ?? undefined,
        province_state: r.province_state ?? undefined,
      },
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function formatUSD(n: number | null): string {
  if (n == null) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPHP(n: number | null): string {
  if (n == null) return '—';
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
