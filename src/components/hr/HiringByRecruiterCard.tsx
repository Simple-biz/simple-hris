'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, RefreshCw, Users } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * HR Overview card: a leaderboard of who hired how many people (from the New
 * Hire Checklist `hired_by` column, across all weeks) and how many of those
 * hires they interviewed (rows carrying a `date_of_interview`). A Copy CSV
 * button drops the whole table on the clipboard for a spreadsheet.
 */

type Recruiter = { recruiter: string; hires: number; interviewed: number };

// RFC-4180-ish escaping: quote when the value carries a comma, quote, or newline.
function csvCell(v: string | number | null | undefined): string {
  const s = (v ?? '').toString();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function HiringByRecruiterCard() {
  const [recruiters, setRecruiters] = useState<Recruiter[]>([]);
  const [totalHires, setTotalHires] = useState(0);
  const [totalInterviewed, setTotalInterviewed] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetch('/api/hr/new-hire-checklist/recruiters', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { recruiters?: Recruiter[]; totalHires?: number; totalInterviewed?: number; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setRecruiters(j.recruiters ?? []);
        setTotalHires(j.totalHires ?? 0);
        setTotalInterviewed(j.totalInterviewed ?? 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load hiring by recruiter'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const maxHires = useMemo(() => Math.max(1, ...recruiters.map((r) => r.hires)), [recruiters]);
  const namedHires = useMemo(() => recruiters.reduce((s, r) => s + r.hires, 0), [recruiters]);

  const copyCsv = async () => {
    const header = ['Hired By', 'Hires', 'Interviewed'];
    const lines = [
      header.join(','),
      ...recruiters.map((r) => [r.recruiter, r.hires, r.interviewed].map(csvCell).join(',')),
    ];
    const csv = lines.join('\r\n');
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      toast.success(`Copied ${recruiters.length} ${recruiters.length === 1 ? 'recruiter' : 'recruiters'} to clipboard`);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-100/70 bg-white shadow-sm dark:border-emerald-950/40 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-5 py-4 dark:border-zinc-900 sm:px-6">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-emerald-700/80 dark:text-emerald-400/70">
            New Hire Checklist
          </p>
          <h2 className="mt-0.5 flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            <Users className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            Hiring by recruiter
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Who hired how many — and how many they interviewed.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={copyCsv}
            disabled={loading || recruiters.length === 0}
            title="Copy the recruiter table as CSV"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" /> Copy CSV
              </>
            )}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            aria-label="Refresh hiring by recruiter"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading hiring by recruiter…
        </div>
      ) : error ? (
        <div className="px-6 py-12 text-center text-sm text-rose-600">{error}</div>
      ) : recruiters.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Users className="h-8 w-8 text-emerald-200 dark:text-emerald-900" />
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No hires credited yet. Fill the <strong>Hired By</strong> column in the New Hire
            Checklist and recruiters&apos; tallies will appear here.
          </p>
        </div>
      ) : (
        <div className="px-5 py-4 sm:px-6">
          <div className="overflow-hidden rounded-xl border border-zinc-100 dark:border-zinc-800">
            <table className="table-keep w-full text-[13px]">
              <thead>
                <tr className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                  <th className="px-3 py-2">Hired by</th>
                  <th className="px-3 py-2 text-right">Hires</th>
                  <th className="px-3 py-2 text-right">Interviewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recruiters.map((r) => (
                  <tr key={r.recruiter} className="transition-colors hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20">
                    <td className="px-3 py-2">
                      {/* Name over a hires-proportional bar so the leaderboard reads at a glance. */}
                      <div className="flex flex-col gap-1">
                        <span className="truncate text-zinc-800 dark:text-zinc-200">{r.recruiter}</span>
                        <span className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <span
                            className="block h-full rounded-full bg-emerald-500"
                            style={{ width: `${Math.max((r.hires / maxHires) * 100, 4)}%` }}
                          />
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right align-top font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {r.hires}
                    </td>
                    <td className="px-3 py-2 text-right align-top tabular-nums text-zinc-500 dark:text-zinc-400">
                      {r.interviewed}
                      <span className="ml-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                        ({r.hires > 0 ? Math.round((r.interviewed / r.hires) * 100) : 0}%)
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-900/60">
                  <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">
                    {recruiters.length} {recruiters.length === 1 ? 'recruiter' : 'recruiters'}
                    {namedHires < totalHires ? (
                      <span className="ml-1 font-normal text-zinc-400">
                        ({totalHires - namedHires} unattributed)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-900 dark:text-zinc-100">{totalHires}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500 dark:text-zinc-400">{totalInterviewed}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
