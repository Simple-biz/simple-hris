'use client';

import { Lock } from 'lucide-react';

/**
 * Full-panel takeover shown on KPI Calculator / QC surfaces while the Payroll
 * Wizard's "Start processing" lock (`payroll.dispatch_locked`) is on. Score
 * inputs feed payroll directly, so once Accounting starts paying people these
 * dashboards go fully hands-off until processing is stopped. State arrives via
 * `useDispatchLock` (Realtime + poll), so the takeover appears/clears live
 * without a refresh. The matching server-side guard rejects writes with 423.
 */
export default function PayrollProcessingLock({
  surface,
  lockedAt,
}: {
  /** What the viewer is locked out of, e.g. "The KPI Calculator". */
  surface: string;
  lockedAt?: string | null;
}) {
  const since = (() => {
    if (!lockedAt) return null;
    const d = new Date(lockedAt);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  })();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-20 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-200/80 bg-rose-50 text-rose-500 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-400">
        <Lock className="h-6 w-6" aria-hidden />
      </span>
      <div className="space-y-1.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-rose-500/80 dark:text-rose-400/70">
          Payroll processing
        </p>
        <h2 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
          Payroll is being processed
        </h2>
        <p className="mx-auto max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          {surface} is locked while Accounting pays people — scores and bonuses can&rsquo;t
          change mid-cycle. It reopens automatically as soon as processing is complete.
        </p>
        {since && (
          <p className="font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
            Processing since {since}
          </p>
        )}
      </div>
    </div>
  );
}
