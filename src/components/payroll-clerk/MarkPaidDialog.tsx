'use client';

import React, { useEffect, useMemo, useState } from 'react';
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
import { AlertTriangle, CheckCircle2, CircleDashed, Gauge, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUSD, type ProcessorId, type QueueRow } from './mock-queue';

export type DispatchStatus = 'paid' | 'not_paid' | 'threshold' | 'problem';

const STATUS_OPTIONS: Array<{
  value: DispatchStatus;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active: string;
}> = [
  { value: 'paid', label: 'Paid', Icon: CheckCircle2, active: 'border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-200' },
  { value: 'not_paid', label: 'Not Paid', Icon: CircleDashed, active: 'border-zinc-300 bg-zinc-100 text-zinc-800 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200' },
  { value: 'threshold', label: 'Threshold', Icon: Gauge, active: 'border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/20 dark:text-amber-200' },
  { value: 'problem', label: 'Problem', Icon: AlertTriangle, active: 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-500/40 dark:bg-rose-500/20 dark:text-rose-200' },
];

export interface MarkPaidPayload {
  rowId: string;
  transactionId: string;
  bankUsed: string;
  sentDate: string;
  arrivalDate: string;
  /** Snapshotted recipient banking — where the money went TO. */
  recipientPreferredBank: string;
  recipientAccountNumber: string;
  recipientAccountHolder: string;
  recipientSwiftCode: string;
  /** Outcome of this dispatch attempt. */
  status: DispatchStatus;
  /** Optional free-text note. */
  note: string;
}

interface MarkPaidDialogProps {
  row: QueueRow | null;
  onClose: () => void;
  onConfirm: (payload: MarkPaidPayload) => Promise<void> | void;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Per-processor smart defaults for the recipient banking fields. We pre-fill
 * what we can from the rates row so Lenny only has to type values that
 * weren't already known. The shapes mirror what each processor needs (per
 * Carla's meeting): Hurupay/Wepay = email; HiGlobe = email + account name;
 * Wires = account + holder + SWIFT.
 */
function deriveDefaults(row: QueueRow): {
  preferredBank: string;
  accountNumber: string;
  accountHolder: string;
  swiftCode: string;
} {
  const processor = row.processor as ProcessorId;
  const details = row.details ?? {};
  switch (processor) {
    case 'hurupay':
      // Per Carla / Itachi: do NOT fall back to work email — the employee's
      // Hurupay account may be registered to a personal address. If they
      // haven't filled it in Settings, leave blank for Lenny to verify.
      return {
        preferredBank: 'Hurupay',
        accountNumber: details.hurupay_email ?? '',
        accountHolder: row.name,
        swiftCode: '',
      };
    case 'wepay':
      return {
        preferredBank: 'Wepay',
        accountNumber: details.wepay_email ?? '',
        accountHolder: row.name,
        swiftCode: '',
      };
    case 'higlobe':
      return {
        preferredBank: 'HiGlobe',
        accountNumber: details.higlobe_email ?? '',
        accountHolder: details.higlobe_account_name ?? row.name,
        swiftCode: '',
      };
    case 'wise':
      return {
        preferredBank: 'Wise',
        accountNumber: details.wise_email ?? details.wise_tag ?? '',
        accountHolder: details.account_holder_name ?? row.name,
        swiftCode: '',
      };
    case 'jeeves':
      return {
        preferredBank: details.bank_name ?? 'Jeeves',
        accountNumber: details.account_number ?? details.phone_number ?? '',
        accountHolder: details.account_holder_name ?? row.name,
        swiftCode: details.swift_code ?? '',
      };
    case 'wires':
      return {
        // Prefer the bank name the employee typed in Settings; fall back to
        // the raw "x1xxx" CSV suffix so Lenny still has a hint to verify.
        preferredBank: details.bank_name ?? row.bankPreferredRaw ?? '',
        accountNumber: details.account_number ?? '',
        accountHolder: details.account_holder_name ?? row.name,
        swiftCode: details.swift_code ?? '',
      };
    default:
      return { preferredBank: '', accountNumber: '', accountHolder: row.name, swiftCode: '' };
  }
}

export default function MarkPaidDialog({ row, onClose, onConfirm }: MarkPaidDialogProps) {
  const defaults = useMemo(() => (row ? deriveDefaults(row) : null), [row]);

  const [transactionId, setTransactionId] = useState('');
  const [bankUsed, setBankUsed] = useState('');
  const [sentDate, setSentDate] = useState(todayISO());
  const [arrivalDate, setArrivalDate] = useState('');
  const [recipientPreferredBank, setRecipientPreferredBank] = useState('');
  const [recipientAccountNumber, setRecipientAccountNumber] = useState('');
  const [recipientAccountHolder, setRecipientAccountHolder] = useState('');
  const [recipientSwiftCode, setRecipientSwiftCode] = useState('');
  const [status, setStatus] = useState<DispatchStatus>('paid');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset whenever a new row is selected — pre-fill recipient banking from
  // the per-processor defaults so Lenny can confirm rather than re-type.
  useEffect(() => {
    if (!row || !defaults) return;
    setTransactionId('');
    setBankUsed('');
    setSentDate(todayISO());
    setArrivalDate('');
    setRecipientPreferredBank(defaults.preferredBank);
    setRecipientAccountNumber(defaults.accountNumber);
    setRecipientAccountHolder(defaults.accountHolder);
    setRecipientSwiftCode(defaults.swiftCode);
    setStatus('paid');
    setNote('');
    setSubmitting(false);
  }, [row?.id, defaults, row]);

  const open = row != null;
  const valid = transactionId.trim().length > 0 && bankUsed.trim().length > 0 && sentDate.length > 0;
  const isWires = row?.processor === 'wires';

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
        recipientPreferredBank: recipientPreferredBank.trim(),
        recipientAccountNumber: recipientAccountNumber.trim(),
        recipientAccountHolder: recipientAccountHolder.trim(),
        recipientSwiftCode: recipientSwiftCode.trim(),
        status,
        note: note.trim(),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
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

        <div className="grid max-h-[60vh] gap-3 overflow-y-auto py-2 pr-1">
          <Field label="Transaction ID / details" htmlFor="txn">
            <Input
              id="txn"
              placeholder="Paste from processor"
              value={transactionId}
              onChange={(e) => setTransactionId(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
          <Field label="Bank used (sent from)" htmlFor="bank">
            <Input
              id="bank"
              placeholder="e.g. BPI corporate, Wise USD"
              value={bankUsed}
              onChange={(e) => setBankUsed(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date sent" htmlFor="sent">
              <Input id="sent" type="date" value={sentDate} onChange={(e) => setSentDate(e.target.value)} />
            </Field>
            <Field label={<>Arrival date <span className="text-zinc-400">(optional)</span></>} htmlFor="arrival">
              <Input
                id="arrival"
                type="date"
                value={arrivalDate}
                onChange={(e) => setArrivalDate(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Preferred bank" htmlFor="rcpt-bank">
              <Input
                id="rcpt-bank"
                placeholder="e.g. BPI, UnionBank, Wise wallet"
                value={recipientPreferredBank}
                onChange={(e) => setRecipientPreferredBank(e.target.value)}
              />
            </Field>
            <Field label="Account holder" htmlFor="rcpt-holder">
              <Input
                id="rcpt-holder"
                placeholder="Name on the account"
                value={recipientAccountHolder}
                onChange={(e) => setRecipientAccountHolder(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label={
              <>
                Account number / wallet ID
                {row && row.processor !== 'wires' && (
                  <span className="text-zinc-400"> (often the email for digital wallets)</span>
                )}
              </>
            }
            htmlFor="rcpt-acct"
          >
            <Input
              id="rcpt-acct"
              placeholder={isWires ? '0098-2231-7710' : 'recipient@example.com'}
              value={recipientAccountNumber}
              onChange={(e) => setRecipientAccountNumber(e.target.value)}
              className="font-mono text-xs"
            />
          </Field>
          {isWires && (
            <Field label="SWIFT code" htmlFor="rcpt-swift">
              <Input
                id="rcpt-swift"
                placeholder="e.g. BOPIPHMM"
                value={recipientSwiftCode}
                onChange={(e) => setRecipientSwiftCode(e.target.value.toUpperCase())}
                className="font-mono text-xs uppercase"
              />
            </Field>
          )}

          <Field label="Status" htmlFor="status">
            <div id="status" className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Dispatch status">
              {STATUS_OPTIONS.map((opt) => {
                const isActive = status === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => setStatus(opt.value)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                      isActive
                        ? opt.active
                        : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800',
                    )}
                  >
                    <opt.Icon className="h-3 w-3" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={<>Note <span className="text-zinc-400">(optional)</span></>} htmlFor="note">
            <textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="e.g. Bank rejected, will retry tomorrow morning."
              className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-400"
            />
          </Field>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!valid || submitting}
            className={cn(
              'gap-2 text-white',
              status === 'paid'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : status === 'threshold'
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : status === 'problem'
                    ? 'bg-rose-600 hover:bg-rose-700'
                    : 'bg-zinc-700 hover:bg-zinc-800',
            )}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {status === 'paid' ? 'Confirm sent' : 'Log dispatch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </Label>
      {children}
    </div>
  );
}
