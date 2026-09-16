'use client';

/**
 * The Orphanage Management System tab's LIVE confirmation — same vocabulary as
 * `OrphanageClearConfirmDialog` / `PabDecisionConfirmDialog`: shadcn Dialog,
 * icon-in-title, verb+object confirm button wearing the action's colour, outline
 * Cancel, undismissable while the write is in flight. Never `window.confirm`.
 *
 * Display-only: the WRITE is the wizard's existing lock-in (additions blob under
 * CAS first, then the `orphanage_pay` records), which this dialog merely triggers.
 * It exists because LIVE is the one thing on the tab that moves money: the amounts
 * land on the Additions Orphanage column and from there reach Final pay and the
 * paystub line — every step after this one sees them.
 */

import { Loader2, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export default function OrphanageOmsLiveConfirmDialog({
  open,
  busy,
  peopleCount,
  totalLabel,
  skippedCount,
  periodLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** The lock-in is in flight — buttons lock, dismissal is blocked. */
  busy: boolean;
  /** Rows that matched a person in this period and priced. */
  peopleCount: number;
  /** Pre-formatted PHP total of those amounts. */
  totalLabel: string;
  /** OMS rows that will NOT be written (unmatched, duplicate, unpriceable). */
  skippedCount: number;
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
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            Lock in OMS hours for real?
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Test mode is <span className="font-medium">off</span>. This writes{' '}
            <span className="font-medium">
              {peopleCount} {peopleCount === 1 ? 'amount' : 'amounts'} ({totalLabel})
            </span>{' '}
            onto the Additions Orphanage column for {periodLabel}, exactly as a paste would.
            Every later step sees them — Additions, Validation, Dispatch, and the paystub&apos;s
            Orphanage line
            {skippedCount > 0 ? (
              <>
                . The <span className="font-medium">{skippedCount} skipped</span>{' '}
                {skippedCount === 1 ? 'row is' : 'rows are'} not written; fix them in OMS and pull again
              </>
            ) : null}
            . Amounts already on the column for these people are replaced. If the cycle is
            already locked, unlock and re-lock afterwards so the staged paystubs pick them up.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={busy}
            className="gap-2 bg-amber-600 text-white transition-colors hover:bg-amber-700"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />}
            Lock in {peopleCount} {peopleCount === 1 ? 'amount' : 'amounts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
