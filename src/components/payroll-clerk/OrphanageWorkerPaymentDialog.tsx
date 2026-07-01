'use client';

import React, { useEffect, useState } from 'react';
import { Hammer, Music, User, Loader2, Building2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type {
  OrphanageWorkerPaymentRow,
  OrphanageWorkerType,
} from '@/lib/orphanage/worker-payment';

const TYPE_OPTIONS: { value: OrphanageWorkerType; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'handyman', label: 'Handyman / Carpenter', Icon: Hammer },
  { value: 'musician', label: 'Musician', Icon: Music },
  { value: 'other', label: 'Other', Icon: User },
];

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
    </label>
  );
}

const inputCls =
  'flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:ring-emerald-900/30';

export interface WorkerPaymentDialogProps {
  /** Open when non-null. `null` closed; an object (possibly empty edit target) open. */
  open: boolean;
  /** When set, the dialog edits this row; otherwise it adds a new one. */
  editing: OrphanageWorkerPaymentRow | null;
  onClose: () => void;
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void;
}

export default function OrphanageWorkerPaymentDialog({
  open,
  editing,
  onClose,
  onSaved,
}: WorkerPaymentDialogProps) {
  const [name, setName] = useState('');
  const [workerType, setWorkerType] = useState<OrphanageWorkerType>('handyman');
  const [typeLabel, setTypeLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [payWeek, setPayWeek] = useState('');
  const [note, setNote] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [swiftCode, setSwiftCode] = useState('');
  const [bankOpen, setBankOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editing?.recipient_name ?? '');
    setWorkerType(editing?.worker_type ?? 'handyman');
    setTypeLabel(editing?.type_label ?? '');
    setAmount(editing?.amount_php != null ? String(editing.amount_php) : '');
    setPayWeek(editing?.pay_week ?? '');
    setNote(editing?.note ?? '');
    setBankName(editing?.bank_name ?? '');
    setBankAccountName(editing?.bank_account_name ?? '');
    setBankAccountNumber(editing?.bank_account_number ?? '');
    setSwiftCode(editing?.swift_code ?? '');
    // Open the bank panel if the row already carries bank info.
    setBankOpen(
      Boolean(
        editing?.bank_name ||
          editing?.bank_account_name ||
          editing?.bank_account_number ||
          editing?.swift_code,
      ),
    );
  }, [open, editing]);

  const amountNum = Number(amount.replace(/,/g, ''));
  const valid = name.trim().length > 0 && Number.isFinite(amountNum) && amountNum > 0;

  const handleSave = async () => {
    if (!valid) {
      toast.error('Name and a positive amount are required.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        recipient_name: name.trim(),
        worker_type: workerType,
        type_label: workerType === 'other' ? typeLabel.trim() || null : null,
        pay_week: payWeek.trim() || null,
        amount_php: amountNum,
        bank_name: bankName.trim() || null,
        bank_account_name: bankAccountName.trim() || null,
        bank_account_number: bankAccountNumber.trim() || null,
        swift_code: swiftCode.trim() || null,
        note: note.trim() || null,
      };
      const url = editing
        ? `/api/orphanage-worker-payments?id=${encodeURIComponent(editing.id)}`
        : '/api/orphanage-worker-payments';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { row?: unknown; error?: string };
      if (!res.ok || json.error) {
        toast.error(json.error ?? 'Could not save payment');
        return;
      }
      toast.success(editing ? `Updated ${name.trim()}` : `Added ${name.trim()}`, { icon: '💚' });
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save payment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
            <Hammer className="h-4 w-4" />
          </span>
          {editing ? 'Edit orphanage payment' : 'Add orphanage payment'}
        </DialogTitle>
        <DialogDescription className="text-xs text-zinc-500 dark:text-zinc-400">
          Pay orphanage staff who aren&apos;t on payroll — carpenters, handymen, or musicians. They&apos;ll
          appear in this queue until you mark them paid.
        </DialogDescription>

        <div className="mt-2 flex flex-col gap-3">
          {/* Worker type pills */}
          <Field label="Type">
            <div className="flex flex-wrap gap-1.5">
              {TYPE_OPTIONS.map(({ value, label, Icon }) => {
                const active = workerType === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setWorkerType(value)}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition',
                      active
                        ? 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-500/50 dark:bg-emerald-900/30 dark:text-emerald-200'
                        : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>
          </Field>

          {workerType === 'other' && (
            <Field label="Custom type" hint="What kind of worker is this? (e.g. Gardener, Cook)">
              <input
                className={inputCls}
                value={typeLabel}
                onChange={(e) => setTypeLabel(e.target.value)}
                placeholder="Gardener"
              />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Joji Arancis"
                autoFocus
              />
            </Field>
            <Field label="Amount (₱)">
              <input
                className={inputCls}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="3600.00"
                inputMode="decimal"
              />
            </Field>
          </div>

          <Field label="Pay period" hint="Optional label — which week/period this covers.">
            <input
              className={inputCls}
              value={payWeek}
              onChange={(e) => setPayWeek(e.target.value)}
              placeholder="Jun 8–14"
            />
          </Field>

          {/* Bank details (collapsible; optional here — can also be entered at Mark Paid) */}
          <div>
            <button
              type="button"
              onClick={() => setBankOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-900 dark:text-emerald-400 dark:hover:text-emerald-300"
            >
              <Building2 className="h-3 w-3" />
              {bankOpen ? 'Hide' : 'Add'} bank details (optional)
              {bankOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            {bankOpen && (
              <div className="mt-2 grid grid-cols-1 gap-3 rounded-xl border border-emerald-100 bg-emerald-50/50 p-3 sm:grid-cols-2 dark:border-emerald-900/30 dark:bg-emerald-950/20">
                <Field label="Bank">
                  <input className={inputCls} value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="BDO" />
                </Field>
                <Field label="Account holder">
                  <input className={inputCls} value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} placeholder="Joji Arancis" />
                </Field>
                <Field label="Account number">
                  <input className={inputCls} value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} placeholder="0000 0000 0000" />
                </Field>
                <Field label="SWIFT / routing">
                  <input className={inputCls} value={swiftCode} onChange={(e) => setSwiftCode(e.target.value)} placeholder="Optional" />
                </Field>
              </div>
            )}
          </div>

          <Field label="Note" hint="Optional — what the work was for.">
            <textarea
              className={cn(inputCls, 'h-16 resize-none py-2')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Roof repair, week of Jun 8"
            />
          </Field>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!valid || saving}
            className="gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-600 text-white hover:brightness-110"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {editing ? 'Save changes' : 'Add payment'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
