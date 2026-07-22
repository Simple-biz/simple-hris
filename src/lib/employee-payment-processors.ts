import type { LucideIcon } from 'lucide-react';
import { Banknote, Wallet } from 'lucide-react';

/**
 * Company-approved payout processors. Keep in sync with mock-queue.ts ProcessorId
 * and references/add_preferred_processor.sql.
 */
export const PROCESSOR_OPTIONS = [
  { id: 'hurupay', label: 'Hurupay', blurb: 'Email only', Icon: Wallet, logoSrc: '/hurupay.png' },
  { id: 'wepay', label: 'Wepay', blurb: 'Email only', Icon: Wallet },
  { id: 'higlobe', label: 'Higlobe', blurb: 'Email + account holder', Icon: Wallet, logoSrc: '/higlobe.png' },
  { id: 'wise', label: 'Wise', blurb: 'Email or Wise tag', Icon: Wallet, logoSrc: '/wise.png' },
  { id: 'jeeves', label: 'Jeeves', blurb: 'Phone + wire details', Icon: Wallet, logoSrc: '/jeeves.png' },
  { id: 'wires', label: 'Wires', blurb: 'Manual bank wire', Icon: Banknote },
] as const;

export type ProcessorId = (typeof PROCESSOR_OPTIONS)[number]['id'];

/**
 * Processors retired from the selection UI. They stay in PROCESSOR_OPTIONS /
 * ProcessorId so existing records (and the dispatch pipeline) keep resolving
 * their labels and detail fields — they're just no longer offered for new
 * selections in the employee/contractor pickers.
 */
export const RETIRED_PROCESSOR_IDS: ProcessorId[] = ['wepay', 'wise', 'jeeves'];

/** PROCESSOR_OPTIONS minus retired ones — use this to render pickers. */
export const SELECTABLE_PROCESSOR_OPTIONS = PROCESSOR_OPTIONS.filter(
  (p) => !RETIRED_PROCESSOR_IDS.includes(p.id),
);

export type ProcessorOption = {
  id: ProcessorId;
  label: string;
  blurb: string;
  Icon: LucideIcon;
  logoSrc?: string;
};

export function isProcessorId(v: string): v is ProcessorId {
  return PROCESSOR_OPTIONS.some((p) => p.id === v);
}

/**
 * "Bank Preferred" dropdown (Employee Profile → Payment). This is a SEPARATE
 * field from the Disbursement picker (`preferred_processor`): it stores the
 * processor Payment Dispatch should route the salary through, in its own
 * `employee_ids.bank_preferred` column. Each option maps to a processor id.
 *
 * `x1153` is a specific wire account, not a distinct processor, so it maps to
 * `wires`. Because `wires` has no dedicated non-x1153 option here, a saved
 * `wires` value displays as "x1153" in this dropdown. See the design doc.
 */
export const BANK_PREFERRED_OPTIONS: { label: string; id: ProcessorId }[] = [
  { label: 'HiGlobe', id: 'higlobe' },
  { label: 'Hurupay', id: 'hurupay' },
  { label: 'Jeeves', id: 'jeeves' },
  { label: 'Wise', id: 'wise' },
  { label: 'x1153', id: 'wires' },
];

/** The dropdown label to show for a saved `preferred_processor` value. Returns
 *  '' when nothing is selected or the value isn't one of the offered options. */
export function bankPreferredLabelForProcessor(p: ProcessorId | ''): string {
  if (!p) return '';
  return BANK_PREFERRED_OPTIONS.find((o) => o.id === p)?.label ?? '';
}

/** The `preferred_processor` id for a chosen dropdown label. */
export function processorForBankPreferredLabel(label: string): ProcessorId | undefined {
  return BANK_PREFERRED_OPTIONS.find((o) => o.label === label)?.id;
}

export function processorDescription(p: ProcessorId): string {
  switch (p) {
    case 'hurupay':
      return 'Tell us which email Hurupay should deposit to.';
    case 'wepay':
      return 'Tell us which email Wepay should deposit to.';
    case 'higlobe':
      return 'HiGlobe needs the email and the name on your account.';
    case 'wise':
      return 'Wise needs the email registered to your account; the @tag is optional.';
    case 'jeeves':
      return 'Jeeves needs your phone plus full bank wire details.';
    case 'wires':
      return 'Manual bank wires need your account, SWIFT code, and full address.';
  }
}
