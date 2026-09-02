'use client';

import { Loader2, Lock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatInternPHP } from '@/lib/interns/intern-types';

/**
 * "Lock in values" confirmation for the Interns mini wizard — the
 * LockToggleConfirmDialog / PabDecisionConfirmDialog vocabulary (icon-in-title,
 * verb+object confirm, outline Cancel, undismissable in flight), never
 * window.confirm. Display-only: the write stays in the wizard's handler.
 */
export default function InternLockConfirmDialog({
  open,
  busy,
  weekLabel,
  internCount,
  totals,
  relock,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  weekLabel: string;
  internCount: number;
  totals: { payPhp: number; pabPhp: number; grossPhp: number; orphanagePhp: number; internPhp: number };
  /** True when this replaces a rejected week. */
  relock: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Lock className="h-5 w-5 text-pink-500" />
            {relock ? 'Lock in this week again?' : 'Lock in this week?'}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Sends {internCount} intern{internCount === 1 ? '' : 's'} for <span className="font-medium">{weekLabel}</span> to
            Accounting&apos;s Payroll Wizard → Interns. They accept it there and pay it from Payment Dispatch.
            {relock ? ' The rejected values are replaced.' : ''} You can withdraw until Accounting accepts.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-pink-100 bg-pink-50/50 px-4 py-3 text-xs dark:border-pink-900/40 dark:bg-pink-950/10">
          <dt className="text-zinc-500">Pay</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.payPhp)}</dd>
          <dt className="text-zinc-500">PAB</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.pabPhp)}</dd>
          <dt className="font-semibold text-zinc-800 dark:text-zinc-200">Gross</dt><dd className="text-right font-mono font-semibold tabular-nums">{formatInternPHP(totals.grossPhp)}</dd>
          <dt className="text-zinc-500">To the orphanage</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.orphanagePhp)}</dd>
          <dt className="text-zinc-500">To the interns</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.internPhp)}</dd>
        </dl>
        <DialogFooter className="mt-3 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy} className="gap-2 bg-pink-600 text-white hover:bg-pink-700">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
            Lock in values
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
