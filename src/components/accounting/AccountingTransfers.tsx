'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Inbox,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getTabCache, hasFetchedThisSession, markFetchedThisSession, setTabCache, TAB_CACHE_KEYS } from '@/lib/accounting/tab-cache';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import type { AccountingTransferRow, TransferRateChange } from '@/lib/transfers/accounting-transfers';
import type { TransferRequestStatus } from '@/lib/supabase/department-transfer-requests';
import { CURRENCY_SYMBOL, type PayCurrency } from '@/lib/payment-catalog/pay-structure';

/** Format a rate in its own currency (PHP/USD/COP), always with 2 decimals. */
function money(n: number | null, c: PayCurrency | null): string {
  if (n == null) return '—';
  const sym = c ? CURRENCY_SYMBOL[c] : '';
  return `${sym}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_STYLE: Record<TransferRequestStatus, string> = {
  pending: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  approved: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  applied: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};
const STATUS_LABEL: Record<TransferRequestStatus, string> = {
  pending: 'Awaiting release',
  approved: 'Scheduled',
  applied: 'Applied',
  rejected: 'Declined',
  cancelled: 'Cancelled',
};

function RateCell({ rc }: { rc: TransferRateChange | null }) {
  if (!rc || (rc.old_regular == null && rc.new_regular == null)) {
    return <span className="text-[11px] italic text-zinc-400">no catalog rate set</span>;
  }
  const otLine =
    rc.old_ot != null || rc.new_ot != null
      ? `OT ${money(rc.old_ot, rc.old_currency)} → ${money(rc.new_ot, rc.new_currency)}`
      : null;
  // Compare only when both sides are known and in the same currency — a
  // cross-currency numeric compare (e.g. $10 vs ₱500) is meaningless.
  const comparable =
    rc.old_regular != null && rc.new_regular != null && rc.old_currency === rc.new_currency;
  const dir = comparable ? Math.sign(rc.new_regular! - rc.old_regular!) : 0;
  const newClass =
    dir > 0
      ? 'text-emerald-700 dark:text-emerald-300' // increase
      : dir < 0
        ? 'text-rose-600 dark:text-rose-400' // decrease
        : 'text-zinc-700 dark:text-zinc-200'; // no change / not comparable
  return (
    <div className="text-xs" title={otLine ?? undefined}>
      <span className="text-zinc-500 line-through dark:text-zinc-500">
        {money(rc.old_regular, rc.old_currency)}
      </span>
      <ArrowRight className="mx-1 inline h-3 w-3 text-zinc-400" />
      <span className={cn('font-semibold', newClass)}>{money(rc.new_regular, rc.new_currency)}</span>
    </div>
  );
}

/**
 * Accounting → Transfers (read-only). The history of who moved departments, who
 * requested and released them, when it took effect, and the pay-rate change the
 * move triggered (linked from employee_rate_history by the effective date).
 * Gated network-side to rate-visible roles.
 */
export default function AccountingTransfers() {
  const [rows, setRows] = useState<AccountingTransferRow[]>(
    () => getTabCache<AccountingTransferRow[]>(TAB_CACHE_KEYS.transfers) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasFetchedThisSession(TAB_CACHE_KEYS.transfers));
  const [error, setError] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);

  // `silent` refetches (live Realtime events, the poll backstop, tab refocus)
  // must NOT flash the full-page spinner or wipe the visible table on a blip —
  // they swap rows in place and keep the last-good view on error, so an
  // auditing session never goes blank or (worse) silently stale.
  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/accounting/transfers', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: AccountingTransferRow[]; error?: string };
      if (!res.ok || json.error) throw new Error(json.error || `Request failed (${res.status})`);
      setRows(json.rows ?? []);
      setTabCache(TAB_CACHE_KEYS.transfers, json.rows ?? []);
      markFetchedThisSession(TAB_CACHE_KEYS.transfers);
    } catch (e) {
      if (!opts?.silent) setError(e instanceof Error ? e.message : 'Failed to load transfers');
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasFetchedThisSession(TAB_CACHE_KEYS.transfers)) return;
    void fetchAll();
  }, [fetchAll]);

  // Keep the view live so an auditor never chases a manager over an already-
  // handled request. A transfer row flipping pending -> applied/rejected (and
  // the rate-history entry that fills the rate-change column) fires a Realtime
  // event -> in-place refetch. The 60s poll + focus refresh are the backstop if
  // the Realtime socket ever drops silently.
  useLiveRefresh({
    tables: ['department_transfer_requests', 'employee_rate_history'],
    onRefresh: () => void fetchAll({ silent: true }),
    channel: 'accounting-transfers',
    pollMs: 60_000,
  });

  const retrySheet = async (id: string) => {
    setRetryId(id);
    try {
      const res = await fetch('/api/accounting/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'retry_sheet' }),
      });
      const json = (await res.json()) as { error?: string; sheet_synced?: boolean };
      if (!res.ok || json.error) throw new Error(json.error || 'Retry failed');
      toast[json.sheet_synced ? 'success' : 'error'](
        json.sheet_synced ? 'Google Sheet updated' : 'Still could not update the Sheet',
      );
      await fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Retry failed');
    } finally {
      setRetryId(null);
    }
  };

  const sorted = useMemo(() => {
    // Applied/scheduled first, then everything else — each newest-first.
    const rank: Record<TransferRequestStatus, number> = {
      applied: 0,
      approved: 1,
      pending: 2,
      rejected: 3,
      cancelled: 4,
    };
    return [...rows].sort(
      (a, b) => rank[a.status] - rank[b.status] || b.created_at.localeCompare(a.created_at),
    );
  }, [rows]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-orange-100/70 bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-orange-950/40 dark:bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              <ArrowRightLeft className="h-5 w-5 text-orange-600 dark:text-orange-400" />
              Transfers
            </h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
              Who moved departments, who approved it, and the pay-rate change it triggered.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchAll()}
            className="h-8 gap-1.5 border-orange-200 text-orange-700 hover:bg-orange-50 dark:border-orange-800 dark:text-orange-300"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading transfers...
          </div>
        ) : error ? (
          <div className="rounded-xl border border-dashed border-rose-200 bg-white py-10 text-center text-sm text-rose-600 dark:border-rose-500/30 dark:bg-[#0d1117]">
            {error}
          </div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-orange-200 bg-white py-16 text-center dark:border-orange-950/40 dark:bg-[#0d1117]">
            <Inbox className="h-7 w-7 text-orange-300 dark:text-orange-800" />
            <p className="text-sm text-zinc-500">No transfers yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-orange-100/80 bg-white dark:border-orange-950/40 dark:bg-zinc-950">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-orange-50/60 text-xs text-zinc-600 dark:bg-orange-950/20 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Employee</th>
                  <th className="px-3 py-2.5 font-semibold">Move</th>
                  <th className="px-3 py-2.5 font-semibold">Effective</th>
                  <th className="px-3 py-2.5 font-semibold">Requested by</th>
                  <th className="px-3 py-2.5 font-semibold">Released by</th>
                  <th className="px-3 py-2.5 font-semibold">Rate change</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/40">
                {sorted.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-orange-50/30 dark:hover:bg-orange-950/10">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-zinc-900 dark:text-zinc-100">
                        {r.employee_name ?? r.employee_email}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {r.from_department}
                        </span>
                        <ArrowRight className="h-3 w-3 text-zinc-400" />
                        <span className="rounded bg-orange-600 px-1.5 py-0.5 font-semibold text-white">
                          {r.to_department}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">
                      {r.effective_date ?? (r.proposed_effective_date ? `${r.proposed_effective_date} (proposed)` : '—')}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">{r.requested_by}</td>
                    <td className="px-3 py-2.5 text-xs text-zinc-600 dark:text-zinc-300">{r.decided_by ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <RateCell rc={r.rate_change} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col items-end gap-1">
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                            STATUS_STYLE[r.status],
                          )}
                        >
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.status === 'applied' && !r.sheet_synced && (
                          <button
                            type="button"
                            onClick={() => void retrySheet(r.id)}
                            disabled={retryId === r.id}
                            title={r.sheet_sync_error ?? 'The Google Sheet was not updated'}
                            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-200 disabled:opacity-60 dark:bg-amber-500/15 dark:text-amber-300"
                          >
                            {retryId === r.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <AlertTriangle className="h-3 w-3" />
                            )}
                            Sheet not synced · Retry
                          </button>
                        )}
                        {r.status === 'applied' && r.sheet_synced && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3 w-3" />
                            Sheet synced
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
