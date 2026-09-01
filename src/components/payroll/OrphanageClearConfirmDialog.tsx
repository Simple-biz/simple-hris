'use client';

/**
 * The Orphanage step's "Remove all" confirmation — same vocabulary as
 * `PabDecisionConfirmDialog`: shadcn Dialog, icon-in-title, verb+object confirm
 * button wearing the action's color, outline Cancel, undismissable while the
 * write is in flight.
 *
 * Display-only: the WRITE stays in the wizard's `clearAllOrphanageLocked`,
 * which this dialog merely triggers. What it clears is BOTH carriers for the
 * one period — the Additions Orphanage amounts (the money) and the
 * `orphanage_pay` hours records — so a fresh paste starts clean instead of
 * inheriting a red "hours on record" panel and stale PAB coverage.
 */

import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function OrphanageClearConfirmDialog({
  open,
  busy,
  peopleCount,
  totalLabel,
  recordOnlyCount,
  periodLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The wipe is in flight — buttons lock, dismissal is blocked. */
  busy: boolean;
  /** People with an amount on the Additions Orphanage column. */
  peopleCount: number;
  /** Pre-formatted PHP total of those amounts. */
  totalLabel: string;
  /** Hours records with NO amount on the column (the red-panel rows). */
  recordOnlyCount: number;
  periodLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={!busy} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Trash2 className="h-5 w-5 text-rose-500" />
            Remove all orphanage pay for this period?
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Clears{' '}
            <span className="font-medium">
              {peopleCount} {peopleCount === 1 ? 'amount' : 'amounts'} ({totalLabel})
            </span>{' '}
            from the Additions Orphanage column
            {recordOnlyCount > 0 ? (
              <>
                {' '}and deletes{' '}
                <span className="font-medium">
                  {peopleCount + recordOnlyCount} hours {peopleCount + recordOnlyCount === 1 ? 'record' : 'records'}
                </span>{' '}
                (including {recordOnlyCount} with no amount on the column)
              </>
            ) : (
              <> and deletes the matching hours records</>
            )}{' '}
            for {periodLabel}. Other weeks are untouched, and everything deleted is
            snapshotted into the audit log first. Days those hours were forgiving for
            PAB go back to failing until fresh hours are locked in — and if the cycle
            is already locked, unlock and re-lock after re-pasting so the staged
            paystubs pick up the new amounts.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            className="gap-2 bg-rose-600 text-white transition-colors hover:bg-rose-700"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Remove all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
