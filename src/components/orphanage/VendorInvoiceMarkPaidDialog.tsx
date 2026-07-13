'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatVendorPHP, type OrphanageVendorInvoiceRow } from '@/lib/orphanage/vendor';

export interface VendorInvoicePaidPayload {
  paid_transaction_id: string;
  paid_bank_used: string;
  paid_sent_date: string;
  paid_note: string;
}

/** Records that the Orphanage Manager has sent the money for an invoice. On
 *  confirm the parent PATCHes the invoice to `paid`, which stamps the PAID
 *  watermark on its rendered document. No automation fires — this is a manual
 *  record, deliberately separate from Payment Dispatch. */
export default function VendorInvoiceMarkPaidDialog({
  invoice,
  onClose,
  onConfirm,
}: {
  invoice: OrphanageVendorInvoiceRow | null;
  onClose: () => void;
  onConfirm: (invoice: OrphanageVendorInvoiceRow, payload: VendorInvoicePaidPayload) => Promise<void>;
}) {
  const [transactionId, setTransactionId] = useState('');
  const [bankUsed, setBankUsed] = useState('');
  const [sentDate, setSentDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!invoice) return;
    setTransactionId('');
    setBankUsed('');
    setSentDate(new Date().toISOString().slice(0, 10));
    setNote('');
  }, [invoice]);

  const handleConfirm = async () => {
    if (!invoice) return;
    if (!transactionId.trim()) {
      toast.error('Transaction / reference number is required.');
      return;
    }
    setSaving(true);
    try {
      await onConfirm(invoice, {
        paid_transaction_id: transactionId.trim(),
        paid_bank_used: bankUsed.trim(),
        paid_sent_date: sentDate,
        paid_note: note.trim(),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!invoice} onOpenChange={(o) => !saving && !o && onClose()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="relative overflow-hidden bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 px-6 py-5 text-left">
          <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-white/10 blur-3xl" />
          <DialogTitle className="flex items-center gap-2 text-white">
            <CheckCircle2 className="h-5 w-5" />
            Mark invoice paid
          </DialogTitle>
          <DialogDescription className="text-white/80">
            {invoice?.invoice_number} · {invoice?.vendor_name} ·{' '}
            <span className="font-semibold text-white">{formatVendorPHP(invoice?.total_amount ?? null)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 bg-white px-6 py-5 dark:bg-zinc-950">
          <FieldRow id="p-txn" label="Transaction / reference" required>
            <Input
              id="p-txn"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              placeholder="Confirmation number"
              className="font-mono text-xs"
              disabled={saving}
            />
          </FieldRow>
          <FieldRow id="p-bank" label="Paid from (bank used)">
            <Input
              id="p-bank"
              value={bankUsed}
              onChange={(e) => setBankUsed(e.target.value)}
              placeholder="e.g. BPI corporate"
              disabled={saving}
            />
          </FieldRow>
          <FieldRow id="p-date" label="Date sent">
            <DatePicker
              id="p-date"
              value={sentDate}
              onChange={setSentDate}
              disabled={saving}
            />
          </FieldRow>
          <FieldRow id="p-note" label="Note (optional)">
            <Input
              id="p-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Anything worth recording"
              disabled={saving}
            />
          </FieldRow>
        </div>

        <DialogFooter className="gap-2 border-t border-zinc-100 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={saving || !transactionId.trim()}
            className={cn('gap-2 bg-gradient-to-br from-emerald-500 to-teal-600 text-white hover:brightness-110')}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Mark paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({
  id,
  label,
  required,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[10.5px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
        {label}
        {required && <span className="ml-0.5 text-rose-500">*</span>}
      </Label>
      {children}
    </div>
  );
}
