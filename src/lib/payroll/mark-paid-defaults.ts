import type { ProcessorId, QueueRow } from '@/components/payroll-clerk/mock-queue';

/**
 * The recipient (receiving-end) defaults the Mark as Paid modal pre-fills.
 * `showSwiftField` tells the dialog whether to reveal the SWIFT input — true
 * whenever the payee is actually paid into a bank account (a wire, OR a
 * wallet-routed employee whose Employee Dashboard payout info is their own
 * bank).
 */
export interface MarkPaidDefaults {
  preferredBank: string;
  accountNumber: string;
  accountHolder: string;
  swiftCode: string;
  showSwiftField: boolean;
}

/** The row fields the resolver needs — a structural subset of QueueRow. */
type MarkPaidRow = Pick<QueueRow, 'processor' | 'name' | 'details'> & {
  bankPreferredRaw?: QueueRow['bankPreferredRaw'];
};

function hasWireDetails(d: MarkPaidRow['details']): boolean {
  return Boolean((d.bank_name ?? '').trim() || (d.account_number ?? '').trim());
}

function wireDefaults(row: MarkPaidRow): MarkPaidDefaults {
  const d = row.details;
  return {
    preferredBank: d.bank_name ?? row.bankPreferredRaw ?? '',
    accountNumber: d.account_number ?? '',
    accountHolder: d.account_holder_name ?? row.name,
    swiftCode: d.swift_code ?? '',
    showSwiftField: true,
  };
}

/**
 * Resolve the recipient defaults for a dispatch row.
 *
 * Routing (the processor tab) is decided by Bank Preferred and is intentionally
 * NOT changed here. But the receiving-end details shown to accounting follow the
 * Employee Dashboard: a Wise-routed employee whose dashboard payout is their own
 * bank (wire) details is paid INTO that bank, so we surface the bank details and
 * reveal the SWIFT field. When they have a genuine Wise wallet (no bank on file),
 * we fall back to the Wise email/tag as before.
 */
export function resolveMarkPaidDefaults(row: MarkPaidRow): MarkPaidDefaults {
  const p = row.processor as ProcessorId;
  const d = row.details ?? {};
  switch (p) {
    case 'hurupay':
      // 'Kolan' is PERSISTED to payment_dispatches.recipient_preferred_bank on
      // every mark-paid. Dispatch rows written before 2026-08-24 keep saying
      // 'Hurupay' and are deliberately NOT backfilled: the ledger records what
      // the rail was called when the money moved. Read back for display only.
      return { preferredBank: 'Kolan', accountNumber: d.hurupay_email ?? '', accountHolder: row.name, swiftCode: '', showSwiftField: false };
    case 'wepay':
      return { preferredBank: 'Wepay', accountNumber: d.wepay_email ?? '', accountHolder: row.name, swiftCode: '', showSwiftField: false };
    case 'higlobe':
      return { preferredBank: 'HiGlobe', accountNumber: d.higlobe_email ?? '', accountHolder: d.higlobe_account_name ?? row.name, swiftCode: '', showSwiftField: false };
    case 'wise':
      // Receiving end follows the dashboard: if the employee's payout info is
      // their own bank, show the bank details (+ SWIFT) even though dispatch
      // routes them through Wise. Otherwise it's a real Wise wallet.
      if (hasWireDetails(d)) return wireDefaults(row);
      return { preferredBank: 'Wise', accountNumber: d.wise_email ?? d.wise_tag ?? '', accountHolder: d.account_holder_name ?? row.name, swiftCode: '', showSwiftField: false };
    case 'jeeves':
      return { preferredBank: d.bank_name ?? 'Jeeves', accountNumber: d.account_number ?? d.phone_number ?? '', accountHolder: d.account_holder_name ?? row.name, swiftCode: d.swift_code ?? '', showSwiftField: true };
    case 'wires':
      return wireDefaults(row);
    default:
      return { preferredBank: '', accountNumber: '', accountHolder: row.name, swiftCode: '', showSwiftField: false };
  }
}
