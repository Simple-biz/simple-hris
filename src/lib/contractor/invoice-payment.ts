// Payment rails a contractor can attach to an invoice so Accounting knows how to
// pay it. Grouped by region: "Global" rails (Hurupay, Higlobe, manual Wires) and
// "US" rails (ACH).
//
// This is deliberately its OWN small model, kept separate from the employee
// payout-processor registry in `@/lib/employee-payment-processors`. ACH is an
// invoice-only rail — folding it into the shared `ProcessorId` union would leak it
// into the employee picker and every exhaustive dispatch switch. Keeping it here
// means the contractor invoice feature is fully self-contained.

import { Wallet, Banknote, Landmark, type LucideIcon } from 'lucide-react';

export type PaymentRegion = 'global' | 'us';
export type InvoiceProcessorId = 'hurupay' | 'higlobe' | 'wires' | 'ach';

export interface InvoiceProcessorOption {
  id: InvoiceProcessorId;
  label: string;
  blurb: string;
  region: PaymentRegion;
  Icon: LucideIcon;
  logoSrc?: string;
}

export const INVOICE_PROCESSOR_OPTIONS: InvoiceProcessorOption[] = [
  { id: 'hurupay', label: 'Hurupay', blurb: 'Email transfer',        region: 'global', Icon: Wallet,   logoSrc: '/hurupay.png' },
  { id: 'higlobe', label: 'Higlobe', blurb: 'Email + account holder', region: 'global', Icon: Wallet,   logoSrc: '/higlobe.png' },
  { id: 'wires',   label: 'Wires',   blurb: 'International bank wire',  region: 'global', Icon: Banknote },
  { id: 'ach',     label: 'ACH',     blurb: 'US bank transfer',        region: 'us',     Icon: Landmark },
];

export const PAYMENT_REGIONS: { id: PaymentRegion; label: string }[] = [
  { id: 'global', label: 'Global' },
  { id: 'us', label: 'US' },
];

export function regionLabel(region: PaymentRegion): string {
  return region === 'us' ? 'US' : 'Global';
}

export function invoiceProcessorsForRegion(region: PaymentRegion): InvoiceProcessorOption[] {
  return INVOICE_PROCESSOR_OPTIONS.filter((p) => p.region === region);
}

export function invoiceProcessor(id: InvoiceProcessorId): InvoiceProcessorOption | undefined {
  return INVOICE_PROCESSOR_OPTIONS.find((p) => p.id === id);
}

export function isInvoiceProcessorId(v: unknown): v is InvoiceProcessorId {
  return typeof v === 'string' && INVOICE_PROCESSOR_OPTIONS.some((p) => p.id === v);
}

// ─── Per-processor field specs ──────────────────────────────────────────────
// One source of truth for the fields each rail needs. Drives BOTH the builder
// inputs (ContractorInvoices) and the rendered receipt lines (InvoiceReceiptDialog),
// so labels never drift between the two surfaces.

export interface PaymentFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  mono?: boolean;
  kind?: 'text' | 'email' | 'select';
  options?: string[];
}

export function paymentFieldSpecs(processor: InvoiceProcessorId): PaymentFieldSpec[] {
  switch (processor) {
    case 'hurupay':
      return [
        { key: 'email', label: 'Hurupay Email', kind: 'email', placeholder: 'you@example.com', required: true },
      ];
    case 'higlobe':
      return [
        { key: 'email', label: 'Higlobe Email', kind: 'email', placeholder: 'you@example.com', required: true },
        { key: 'accountName', label: 'Account Holder Name', placeholder: 'Juan Dela Cruz', required: true },
      ];
    case 'wires':
      return [
        { key: 'accountHolder', label: 'Account Holder Name', placeholder: 'Juan Dela Cruz', required: true },
        { key: 'bankName', label: 'Bank Name', placeholder: 'Bank name', required: true },
        { key: 'accountNumber', label: 'Account Number', placeholder: '1234-5678-9012', required: true, mono: true },
        { key: 'swift', label: 'SWIFT / BIC Code', placeholder: 'BOPIPHMM', required: true, mono: true },
        { key: 'address', label: 'Bank Address', placeholder: 'Full bank address' },
      ];
    case 'ach':
      return [
        { key: 'accountHolder', label: 'Account Holder Name', placeholder: 'John Smith', required: true },
        { key: 'bankName', label: 'Bank Name', placeholder: 'Chase, Bank of America…', required: true },
        { key: 'accountNumber', label: 'Account Number', placeholder: '000123456789', required: true, mono: true },
        { key: 'routingNumber', label: 'Routing Number (ABA)', placeholder: '021000021', required: true, mono: true },
        { key: 'accountType', label: 'Account Type', kind: 'select', options: ['Checking', 'Savings'] },
      ];
  }
}

// ─── Stored value + display ─────────────────────────────────────────────────

export interface InvoicePaymentMethod {
  region: PaymentRegion;
  processor: InvoiceProcessorId;
  fields: Record<string, string>;
}

/** Display-ready label/value pairs for the receipt, empty fields dropped. */
export function paymentMethodLines(m: InvoicePaymentMethod | null | undefined): { label: string; value: string }[] {
  if (!m || !isInvoiceProcessorId(m.processor)) return [];
  return paymentFieldSpecs(m.processor)
    .map((s) => ({ label: s.label, value: (m.fields?.[s.key] ?? '').trim() }))
    .filter((l) => l.value);
}

/**
 * Best-effort prefill of a processor's fields from the contractor's saved
 * profile row (the /api/contractor/profile shape). Global rails reuse the
 * payout details already on file; ACH has no profile columns yet, so it starts
 * blank (bar a sensible default account type).
 */
export function prefillFieldsFromProfile(
  processor: InvoiceProcessorId,
  row: Record<string, string | null> | null | undefined,
): Record<string, string> {
  const g = (k: string) => (row?.[k] ?? '').toString().trim();
  switch (processor) {
    case 'hurupay':
      return { email: g('hurupay_email') };
    case 'higlobe':
      return { email: g('higlobe_email'), accountName: g('higlobe_account_name') };
    case 'wires':
      return {
        accountHolder: g('account_holder_name'),
        bankName: g('bank_name'),
        accountNumber: g('account_number'),
        swift: g('swift_code'),
        address: g('full_address'),
      };
    case 'ach':
      return {
        accountHolder: g('ach_account_holder'),
        bankName: g('ach_bank_name'),
        accountNumber: g('ach_account_number'),
        routingNumber: g('ach_routing_number'),
        accountType: g('ach_account_type') || 'Checking',
      };
  }
}
