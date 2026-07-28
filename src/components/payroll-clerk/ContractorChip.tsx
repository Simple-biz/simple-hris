'use client';

import { FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Marks a Payment Dispatch payee as a contractor.
 *
 * Two sources feed it:
 *  • a pending/excluded row built from an approved `contractor_invoices` row
 *    (`QueueRow.payeeKind === 'contractor'`), and
 *  • an already-logged payment, off `payment_dispatches.payee_type` — which is
 *    why that is a real column: a client-only flag would vanish the moment the
 *    row moved to Done / Reports / Sent-payments history / the CSV export.
 *
 * Fuchsia is the tone this codebase already assigns contractors (see
 * `contractor.decided` in AuditTrailPanel).
 *
 * Lives in its own module rather than inside ProcessorQueue because both
 * ProcessorQueue and PaidRecordsPanel render it, and ProcessorQueue already
 * imports PaidRecordsPanel — importing it the other way would be a cycle.
 */
/**
 * Should a queue row wear the badge?
 *
 * TWO independent reasons, and keeping them separate is load-bearing:
 *  • `payeeKind === 'contractor'` — this row settles an invoice (SETTLEMENT)
 *  • `contractorRole` — the person holds the contractor role but this payment is
 *    ordinary hourly payroll (DISPLAY)
 *
 * Badge state must never be read back as settlement state; see QueueRow.payeeKind.
 */
export function showsContractorBadge(row: {
  payeeKind?: 'employee' | 'contractor';
  contractorRole?: boolean;
}): boolean {
  return row.payeeKind === 'contractor' || row.contractorRole === true;
}

export default function ContractorChip({
  invoiceNumber,
  className,
  /** `hero` renders for a coloured gradient background (the Mark Paid header). */
  variant = 'default',
}: {
  invoiceNumber?: string | null;
  className?: string;
  variant?: 'default' | 'hero';
}) {
  const title = invoiceNumber
    ? `Contractor — paid from approved invoice ${invoiceNumber}, not hourly payroll`
    : 'Contractor — holds the contractor role';

  if (variant === 'hero') {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-white backdrop-blur-sm',
          className,
        )}
        title={title}
      >
        <FileText className="h-2.5 w-2.5" />
        Contractor
        {invoiceNumber ? <span className="font-mono normal-case tracking-normal">· {invoiceNumber}</span> : null}
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border border-fuchsia-200 bg-fuchsia-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-fuchsia-700 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-300',
        className,
      )}
      title={title}
    >
      <FileText className="h-2.5 w-2.5" />
      Contractor
    </span>
  );
}
