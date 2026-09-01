'use client';

/**
 * Step 6's Forgive / Ignore confirmation — the in-app dialog that replaced the
 * browser's `window.confirm` (Kane 2026-09-01: "wrapped properly in Tailwind,
 * not the generic"). Same vocabulary as `LockToggleConfirmDialog`: shadcn
 * Dialog, icon-in-title, verb+object confirm button wearing the action's
 * color, outline Cancel.
 *
 * Display-only: the WRITE stays in the wizard's forgive/ignore handlers, which
 * this dialog merely triggers. It cannot be dismissed while the write is in
 * flight, so a half-done decision can't be hidden behind a closed dialog.
 */

import { Check, EyeOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { PabIneligibleRow } from './PabIneligibleTable';

export type PabDecisionTarget = {
  action: 'forgive' | 'ignore';
  row: PabIneligibleRow;
};

export default function PabDecisionConfirmDialog({
  target,
  monthLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  /** null = closed. */
  target: PabDecisionTarget | null;
  monthLabel: string;
  /** The decision write is in flight — buttons lock, dismissal is blocked. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const forgive = target?.action === 'forgive';
  const name = target?.row.name ?? 'this person';
  const dayCount = target?.row.failedDays.length ?? 0;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={!busy} className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            {forgive ? (
              <Check className="h-5 w-5 text-emerald-500" />
            ) : (
              <EyeOff className="h-5 w-5 text-amber-500" />
            )}
            {forgive ? `Forgive ${name}'s month?` : `Ignore ${name}'s PAB?`}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {forgive ? (
              <>
                Forgives all{' '}
                <span className="font-medium">
                  {dayCount} missed day{dayCount === 1 ? '' : 's'}
                </span>{' '}
                in {monthLabel}, restoring their Perfect Attendance Bonus. The forgiven days are
                visible on their own dashboard.
              </>
            ) : (
              <>
                They will earn <span className="font-medium">₱0 Perfect Attendance Bonus</span> for{' '}
                {monthLabel} regardless of attendance, and they will be notified. Forgive stays
                disabled until the exclusion is lifted in System Bonus → PAB settings.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'gap-2 text-white transition-colors',
              forgive ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700',
            )}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : forgive ? (
              <Check className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
            {forgive
              ? `Forgive ${dayCount} day${dayCount === 1 ? '' : 's'}`
              : `Ignore for ${monthLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
