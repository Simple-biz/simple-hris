import type { LucideIcon } from 'lucide-react';
import { Banknote, Coins, Globe2, Wallet, Wallet2, Wifi } from 'lucide-react';

/**
 * Company-approved payout processors. Keep in sync with mock-queue.ts ProcessorId
 * and references/add_preferred_processor.sql.
 */
export const PROCESSOR_OPTIONS = [
  { id: 'hurupay', label: 'Hurupay', blurb: 'Email only', Icon: Coins },
  { id: 'wepay', label: 'Wepay', blurb: 'Email only', Icon: Wallet },
  { id: 'higlobe', label: 'Higlobe', blurb: 'Email + account holder', Icon: Globe2 },
  { id: 'wise', label: 'Wise', blurb: 'Email or Wise tag', Icon: Wallet2 },
  { id: 'jeeves', label: 'Jeeves', blurb: 'Phone + wire details', Icon: Wifi },
  { id: 'wires', label: 'Wires', blurb: 'Manual bank wire', Icon: Banknote },
] as const;

export type ProcessorId = (typeof PROCESSOR_OPTIONS)[number]['id'];

export type ProcessorOption = {
  id: ProcessorId;
  label: string;
  blurb: string;
  Icon: LucideIcon;
};

export function isProcessorId(v: string): v is ProcessorId {
  return PROCESSOR_OPTIONS.some((p) => p.id === v);
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
