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
import type { InternLockSummary } from '@/lib/interns/intern-lock-summary';

/**
 * "Lock in values" confirmation for the Interns mini wizard — the
 * LockToggleConfirmDialog / PabDecisionConfirmDialog vocabulary (icon-in-title,
 * verb+object confirm, outline Cancel, undismissable in flight), never
 * window.confirm. Display-only: the write stays in the wizard's handler.
 *
 * The interns' figure is ONE week for every intern, so it says "this week",
 * how many interns, and each intern's line under it (Open item 396: on
 * 2026-10-07 the bare "To the interns" total was read as every week so far).
 * The header and footer are pinned and only the lines scroll, so Lock in stays
 * reachable however many interns there are (responsive-design.md § Dialogs).
 */
export default function InternLockConfirmDialog({
  open,
  busy,
  weekLabel,
  summary,
  totals,
  relock,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  weekLabel: string;
  /** `internLockSummary` of the rows being locked in — the same figure Step 4 shows. */
  summary: InternLockSummary;
  totals: { payPhp: number; pabPhp: number; grossPhp: number; orphanagePhp: number };
  /** True when this replaces a rejected week. */
  relock: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = summary.internCount;
  const interns = `${n} intern${n === 1 ? '' : 's'}`;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent
        showCloseButton={!busy}
        className="flex max-h-[calc(100dvh-1.5rem)] flex-col sm:max-h-[92dvh] sm:max-w-[520px]"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Lock className="h-5 w-5 text-pink-500" />
            {relock ? 'Lock in this week again?' : 'Lock in this week?'}
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Sends {interns} for <span className="font-medium">{weekLabel}</span> to
            Accounting&apos;s Payroll Wizard → Interns. They accept it there and pay it from Payment Dispatch.
            {relock ? ' The rejected values are replaced.' : ''} You can withdraw until Accounting accepts.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-pink-100 bg-pink-50/50 px-4 py-3 text-xs dark:border-pink-900/40 dark:bg-pink-950/10">
          <dt className="text-zinc-500">Pay</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.payPhp)}</dd>
          <dt className="text-zinc-500">PAB</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.pabPhp)}</dd>
          <dt className="font-semibold text-zinc-800 dark:text-zinc-200">Gross</dt><dd className="text-right font-mono font-semibold tabular-nums">{formatInternPHP(totals.grossPhp)}</dd>
          <dt className="text-zinc-500">To the orphanage</dt><dd className="text-right font-mono tabular-nums">{formatInternPHP(totals.orphanagePhp)}</dd>
        </dl>
        <section
          aria-labelledby="intern-lock-to-interns"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-emerald-200/80 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/15"
        >
          <div className="shrink-0 px-4 py-3">
            <p id="intern-lock-to-interns" className="text-sm font-semibold text-emerald-950 dark:text-emerald-50">
              To the interns, this week:{' '}
              <span className="font-mono tabular-nums">{formatInternPHP(summary.totalPhp)}</span> across {interns}
            </p>
            <p className="mt-1 text-[11px] leading-snug text-emerald-900/75 dark:text-emerald-100/70">
              One week ({weekLabel}), not a running total. Each intern&apos;s share is below.
              {summary.hoursCapped > 0
                ? ` ${summary.internsCapped} logged more than the caps allow: ${summary.hoursCapped.toFixed(2)} h capped, shown and not paid.`
                : ''}
            </p>
          </div>
          {n > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t border-emerald-200/80 dark:border-emerald-900/40">
              <table className="table-keep w-full text-xs">
                <thead className="sticky top-0 bg-emerald-50 text-[10px] uppercase tracking-wider text-emerald-900/70 dark:bg-[#0c1a16] dark:text-emerald-200/70">
                  <tr>
                    <th scope="col" className="px-4 py-1.5 text-left font-semibold">Intern</th>
                    <th scope="col" className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">Paid h</th>
                    <th scope="col" className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">Capped h</th>
                    <th scope="col" className="px-4 py-1.5 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-emerald-100 dark:divide-emerald-900/30">
                  {summary.lines.map((l) => (
                    <tr key={l.key}>
                      <td className="w-full max-w-0 truncate px-4 py-1.5 text-emerald-950 dark:text-emerald-50" title={l.name}>{l.name}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">{l.hoursPaid.toFixed(2)}</td>
                      <td className={`px-2 py-1.5 text-right font-mono tabular-nums ${l.hoursCapped > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-900/45 dark:text-emerald-100/40'}`}>
                        {l.hoursCapped.toFixed(2)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-1.5 text-right font-mono font-semibold tabular-nums">{formatInternPHP(l.amountPhp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <DialogFooter className="mt-3 shrink-0 gap-2">
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
