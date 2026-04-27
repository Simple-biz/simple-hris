'use client';

import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { formatUSD, type QueueRow } from './mock-queue';

export interface MarkPaidPayload {
  rowId: string;
  transactionId: string;
  bankUsed: string;
  sentDate: string;
  arrivalDate: string;
}

interface MarkPaidDialogProps {
  row: QueueRow | null;
  onClose: () => void;
  onConfirm: (payload: MarkPaidPayload) => Promise<void> | void;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function MarkPaidDialog({ row, onClose, onConfirm }: MarkPaidDialogProps) {
  const [transactionId, setTransactionId] = useState('');
  const [bankUsed, setBankUsed] = useState('');
  const [sentDate, setSentDate] = useState(todayISO());
  const [arrivalDate, setArrivalDate] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset form whenever a new row is selected.
  useEffect(() => {
    if (!row) return;
    setTransactionId('');
    setBankUsed('');
    setSentDate(todayISO());
    setArrivalDate('');
    setSubmitting(false);
  }, [row?.id]);

  const open = row != null;
  const valid = transactionId.trim().length > 0 && bankUsed.trim().length > 0 && sentDate.length > 0;

  const handleConfirm = async () => {
    if (!row || !valid) return;
    setSubmitting(true);
    try {
      await onConfirm({
        rowId: row.id,
        transactionId: transactionId.trim(),
        bankUsed: bankUsed.trim(),
        sentDate,
        arrivalDate,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Mark payment as sent
          </DialogTitle>
          <DialogDescription className="text-xs">
            {row ? (
              <>
                Logging dispatch for <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</span>{' '}
                via <span className="uppercase tracking-wide">{row.processor}</span> ·{' '}
                <span className="font-mono">{formatUSD(row.amountUSD)}</span>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <Label htmlFor="txn" className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Transaction ID / details
            </Label>
            <Input
              id="txn"
              placeholder="Paste from processor"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              className="font-mono text-xs"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="bank" className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
              Bank used
            </Label>
            <Input
              id="bank"
              placeholder="e.g. BPI corporate, Wise USD"
              value={bankUsed}
              onChange={(e) => setBankUsed(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sent" className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Date sent
              </Label>
              <Input id="sent" type="date" value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="arrival" className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Arrival date <span className="text-zinc-400">(optional)</span>
              </Label>
              <Input
                id="arrival"
                type="date"
                value={arrivalDate}
                onChange={(e) => setArrivalDate(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!valid || submitting}
            className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            Confirm sent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
