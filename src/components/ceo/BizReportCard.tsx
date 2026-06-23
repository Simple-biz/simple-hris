'use client';

import { useState } from 'react';
import { Download, FileText, Loader2, Check } from 'lucide-react';
import type { BizReport } from '@/lib/ceo/biz-report';

/**
 * Renders a Penny AI report as a compact "download card" inside the chat. The
 * report spec was emitted inline by the assistant (a ```biz-report block) and
 * parsed client-side; clicking Download POSTs it to the stateless PDF endpoint
 * and saves the returned file. Used in both the bubble and the full-page tab.
 */

function sectionSummary(report: BizReport): string {
  const tables = report.sections.filter((s) => s.type === 'table').length;
  const rows = report.sections.reduce(
    (n, s) => n + (s.type === 'table' ? s.rows.length : 0),
    0,
  );
  const bits: string[] = [];
  if (tables) bits.push(`${tables} table${tables > 1 ? 's' : ''}`);
  if (rows) bits.push(`${rows} row${rows > 1 ? 's' : ''}`);
  const metrics = report.sections.filter((s) => s.type === 'metrics').length;
  if (metrics) bits.push(`${metrics} metric block${metrics > 1 ? 's' : ''}`);
  const people = report.sections.reduce(
    (n, s) => n + (s.type === 'roster' ? s.people.length : 0),
    0,
  );
  if (people) bits.push(`${people} ${people > 1 ? 'people' : 'person'}`);
  return bits.join(' · ') || `${report.sections.length} section${report.sections.length > 1 ? 's' : ''}`;
}

export default function BizReportCard({ report }: { report: BizReport }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (state === 'loading') return;
    setState('loading');
    setError(null);
    try {
      const res = await fetch('/api/ceo/reports/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error((j && typeof j.error === 'string' && j.error) || 'Could not generate the PDF.');
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m?.[1] ?? 'penny-ai-report.pdf';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-fuchsia-200/80 bg-gradient-to-br from-violet-50 to-fuchsia-50 shadow-sm dark:border-fuchsia-900/40 dark:from-violet-950/30 dark:to-fuchsia-950/20">
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-sm">
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
            {report.title}
          </p>
          {report.subtitle && (
            <p className="truncate text-[11.5px] text-zinc-500 dark:text-zinc-400">{report.subtitle}</p>
          )}
          <p className="mt-0.5 text-[11px] text-fuchsia-700/80 dark:text-fuchsia-300/80">
            PDF report · {sectionSummary(report)}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-fuchsia-200/70 bg-white/60 px-3.5 py-2 dark:border-fuchsia-900/40 dark:bg-black/20">
        {state === 'error' ? (
          <span className="truncate text-[11px] text-red-600 dark:text-red-400">{error}</span>
        ) : (
          <span className="text-[11px] text-zinc-400">Generated from live payroll data</span>
        )}
        <button
          type="button"
          onClick={download}
          disabled={state === 'loading'}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-600 px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition hover:from-violet-700 hover:to-fuchsia-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === 'loading' ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Building…
            </>
          ) : state === 'done' ? (
            <>
              <Check className="h-3.5 w-3.5" aria-hidden />
              Downloaded
            </>
          ) : (
            <>
              <Download className="h-3.5 w-3.5" aria-hidden />
              {state === 'error' ? 'Retry' : 'Download PDF'}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
