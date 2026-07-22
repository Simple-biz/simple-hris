'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, Clock, Landmark, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  bankPreferredLabelForProcessor,
  isBankPreferredTransitionAllowed,
  type ProcessorId,
} from '@/lib/employee-payment-processors';
import type { BankPreferredRequestRow } from '@/lib/supabase/bank-preferred-requests';

function label(v: string | null): string {
  if (!v) return 'None';
  return bankPreferredLabelForProcessor(v as ProcessorId) || v;
}

function timeAgo(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Accounting review queue for pending Bank Preferred change requests. Rendered at
 * the top of the Issues tab, above the PAB dispute queue. Approve writes the value
 * to employee_ids.bank_preferred (and notifies the employee); Deny leaves it.
 */
export function BankPreferredApprovals() {
  const [rows, setRows] = useState<BankPreferredRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bank-preferred-requests?status=pending', { cache: 'no-store' });
      const json = (await res.json()) as { rows?: BankPreferredRequestRow[]; error?: string | null };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Failed to load requests');
      setRows(json.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load requests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (row: BankPreferredRequestRow, status: 'approved' | 'denied') => {
      setActingId(row.id);
      try {
        const res = await fetch(`/api/bank-preferred-requests/${row.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        const json = (await res.json()) as { success?: boolean; error?: string };
        if (!res.ok || json.error) throw new Error(json.error ?? 'Action failed');
        toast.success(
          status === 'approved'
            ? `Approved — ${label(row.to_value)} is now active for ${row.employee_name || row.work_email}.`
            : `Denied ${row.employee_name || row.work_email}'s Bank Preferred change.`,
        );
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Action failed');
      } finally {
        setActingId(null);
      }
    },
    [],
  );

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
            <Landmark className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-white">
              Bank Preferred change requests
            </h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              Employees can&apos;t change where their salary routes until you approve it here.
            </p>
          </div>
          {rows.length > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">
              {rows.length}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-lg text-[12px]"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-[12.5px] text-zinc-500 dark:text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading requests…
        </div>
      ) : rows.length === 0 && !error ? (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-200 px-3 py-6 text-[12.5px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          No pending Bank Preferred changes.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const acting = actingId === row.id;
            const wiresLocked = !isBankPreferredTransitionAllowed(row.from_value, row.to_value);
            return (
              <li
                key={row.id}
                className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 px-3.5 py-3 dark:border-zinc-800 dark:bg-zinc-900/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-zinc-900 dark:text-white">
                    {row.employee_name || row.work_email}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
                    <span className="rounded-md bg-zinc-200/70 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      {label(row.from_value)}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-zinc-400" />
                    <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      {label(row.to_value)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-400">
                    <Clock className="h-3 w-3" />
                    Requested {timeAgo(row.created_at)}
                  </div>
                  {wiresLocked && (
                    <div className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                      WIRES employee — Hurupay/HiGlobe not possible. Deny this request.
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 rounded-lg border-rose-200 text-[12px] text-rose-700 hover:bg-rose-50 dark:border-rose-900/40 dark:text-rose-300 dark:hover:bg-rose-950/30"
                    disabled={acting}
                    onClick={() => void decide(row, 'denied')}
                  >
                    {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                    Deny
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg bg-emerald-600 text-[12px] text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-emerald-500 dark:hover:bg-emerald-400"
                    disabled={acting || wiresLocked}
                    title={
                      wiresLocked
                        ? 'This employee is set to WIRES and cannot be paid via Hurupay/HiGlobe. Deny this request.'
                        : undefined
                    }
                    onClick={() => void decide(row, 'approved')}
                  >
                    {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Approve
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
