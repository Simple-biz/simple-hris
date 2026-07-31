/**
 * Which pay period does a contractor invoice belong to?
 *
 * A contractor invoice carries no pay-week of its own — approval sets a status,
 * not a cycle — so the only thing tying one to a payroll run is the date the
 * contractor billed. That date is compared against the run's Sun–Sat window.
 *
 * `invoice_date` is the billing date the contractor typed; `created_at` is the
 * fallback for an invoice filed with the date left blank. Compared as
 * `YYYY-MM-DD` strings, never as Dates: `created_at` is a UTC timestamp and
 * parsing it into a local Date shifts a Saturday-evening invoice into Sunday,
 * i.e. straight out of its own pay period.
 */
export interface InvoiceDatedRow {
  invoice_date?: string | null;
  created_at?: string | null;
}

/** `YYYY-MM-DD` the invoice bills for, or '' when it carries neither date. */
export function invoicePeriodKey(inv: InvoiceDatedRow): string {
  return (inv.invoice_date || inv.created_at || '').slice(0, 10);
}

/**
 * Does this invoice belong to the `startKey`–`endKey` pay period (inclusive)?
 *
 * An unparseable window (either key null) returns TRUE for everything: a window
 * we failed to derive must not become a filter that hides money. A dated invoice
 * outside the window is false; an invoice with no date at all is false, because
 * nothing places it inside this run.
 */
export function isInvoiceInPeriod(
  inv: InvoiceDatedRow,
  startKey: string | null | undefined,
  endKey: string | null | undefined,
): boolean {
  if (!startKey || !endKey) return true;
  const key = invoicePeriodKey(inv);
  if (!key) return false;
  return key >= startKey && key <= endKey;
}
