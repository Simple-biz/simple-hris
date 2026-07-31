'use client';

import { useEffect, useState } from 'react';
import { FileWarning, Loader2 } from 'lucide-react';
import { InvoiceViewDialog, type SavedInvoice } from '@/components/contractor/InvoiceReceiptDialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The document behind a Payment Dispatch CONTRACTOR row.
 *
 * A contractor row is not hourly payroll — it settles one approved
 * `contractor_invoices` row — so the clerk's "View" opens that invoice rather
 * than a pay statement. Contractors have no rates row and no staged paystub, so
 * the paystub modal could only ever have answered "no pay statement available"
 * for them.
 *
 * Fetched by the row's own invoice id, one invoice per open. That is what keeps
 * this from becoming a history browser: Claire has nine invoices going back to
 * May, and the document for THIS payment is the single one the row settles.
 * (The queue is already scoped to the pay period upstream — see
 * loadContractorDispatchRows — so the invoice reachable here is this week's.)
 *
 * Rendering is delegated to {@link InvoiceViewDialog}, the same zoomable receipt
 * the contractor sees in their own dashboard and Accounting sees in the Payroll
 * Wizard's Contractors step. Loading and failure get their own small dialog
 * because that component renders nothing without an invoice.
 */
export default function ContractorInvoiceDialog({
  invoiceId,
  /** Row name/number, shown while the document is still loading. */
  name,
  invoiceNumber,
  onClose,
}: {
  invoiceId: string | null;
  name?: string | null;
  invoiceNumber?: string | null;
  onClose: () => void;
}) {
  const [invoice, setInvoice] = useState<SavedInvoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoiceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setInvoice(null);
    fetch(`/api/contractor/invoices/${encodeURIComponent(invoiceId)}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = (await res.json()) as { invoice?: SavedInvoice; error?: string };
        if (cancelled) return;
        if (!res.ok || !json.invoice) {
          setError(json.error || 'Could not load this invoice.');
          return;
        }
        setInvoice(json.invoice);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load this invoice.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invoiceId]);

  const open = invoiceId != null;
  if (!open) return null;

  if (invoice) {
    return <InvoiceViewDialog invoice={invoice} open onClose={onClose} />;
  }

  const heading = invoiceNumber ? `Invoice ${invoiceNumber}` : 'Contractor invoice';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[420px] rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{heading}</DialogTitle>
          <DialogDescription>{name || 'Contractor'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-[140px] flex-col items-center justify-center gap-3 text-center">
          {loading ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
              <span className="text-sm text-zinc-500 dark:text-zinc-400">Loading invoice…</span>
            </>
          ) : (
            <>
              <FileWarning className="h-8 w-8 text-amber-500" />
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                {error ?? 'This invoice could not be found.'}
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
