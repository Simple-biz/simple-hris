'use client';

/**
 * The PAB step's Forgive / Ignore confirmation — the in-app dialog that replaced the
 * browser's `window.confirm` (Kane 2026-09-01: "wrapped properly in Tailwind,
 * not the generic"). Same vocabulary as `LockToggleConfirmDialog`: shadcn
 * Dialog, icon-in-title, verb+object confirm button wearing the action's
 * color, outline Cancel.
 *
 * Display-only: the WRITE stays in the wizard's forgive/ignore handlers, which
 * this dialog merely triggers. It cannot be dismissed while the write is in
 * flight, so a half-done decision can't be hidden behind a closed dialog.
 *
 * The bulk Ignore (2026-10-05) NAMES every person it is about to zero. A count
 * alone ("Ignore 14 people?") hides who they are, and each one is ₱0 PAB for the
 * month plus a notification to them.
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

export type PabDecisionTarget =
  | { action: 'forgive' | 'ignore'; row: PabIneligibleRow }
  | { action: 'ignore-bulk'; rows: PabIneligibleRow[] };

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
  const bulkRows = target?.action === 'ignore-bulk' ? target.rows : null;
  const single = target && target.action !== 'ignore-bulk' ? target.row : null;
  const name = single?.name ?? 'this person';
  const dayCount = single?.failedDays.length ?? 0;
  const bulkCount = bulkRows?.length ?? 0;
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o && !busy) onCancel();
      }}
    >
      <DialogContent showCloseButton={!busy} className={cn(bulkRows ? 'sm:max-w-[520px]' : 'sm:max-w-[440px]')}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            {forgive ? (
              <Check className="h-5 w-5 text-emerald-500" />
            ) : (
              <EyeOff className="h-5 w-5 text-amber-500" />
            )}
            {bulkRows
              ? `Ignore PAB for ${bulkCount} ${bulkCount === 1 ? 'person' : 'people'}?`
              : forgive
                ? `Forgive ${name}'s month?`
                : `Ignore ${name}'s PAB?`}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {bulkRows ? (
              <>
                Each of them will earn <span className="font-medium">₱0 Perfect Attendance Bonus</span>{' '}
                for {monthLabel} regardless of attendance, and each will be notified. Saved in one
                write: everyone below is ignored, or nobody is. Lift any one of them in System Bonus →
                PAB settings.
              </>
            ) : forgive ? (
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
        {bulkRows && (
          // Every name, scrollable — never "and 9 more". The id disambiguates two
          // people who share a nickname; the address is never rendered (the step's
          // rule), only offered on hover for an unknown name.
          <ul className="max-h-[40vh] divide-y divide-zinc-100 overflow-y-auto rounded-lg border border-zinc-200 text-xs dark:divide-zinc-800 dark:border-zinc-800">
            {bulkRows.map((r) => (
              <li key={r.email} className="flex items-center justify-between gap-3 px-3 py-1.5">
                {r.name ? (
                  <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">{r.name}</span>
                ) : (
                  <span title={r.email} className="truncate font-medium italic text-amber-700 dark:text-amber-400">
                    Unknown — not on the master list
                  </span>
                )}
                <span className="shrink-0 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
                  {r.employeeId ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
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
            {bulkRows
              ? `Ignore ${bulkCount} for ${monthLabel}`
              : forgive
                ? `Forgive ${dayCount} day${dayCount === 1 ? '' : 's'}`
                : `Ignore for ${monthLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
