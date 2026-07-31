'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  Search,
  Send,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DISPATCH_PROCESSORS, PROCESSORS, formatPHP, formatUSD } from '@/components/payroll-clerk/mock-queue';
import ContractorChip from '@/components/payroll-clerk/ContractorChip';
import {
  buildPayCycleReportExport,
  downloadPayCycleReportCsv,
  downloadPayCycleReportPdf,
  downloadPayCycleReportXlsx,
} from '@/lib/accounting/pay-cycle-report-export';
import type { PayCycleReportPayee, PayCycleReportSnapshot } from '@/lib/accounting/pay-cycle-report-snapshot';

/**
 * Accounting → Documents → Reports → report detail.
 *
 * The "who got paid" view for one published, frozen pay-cycle report (see
 * pay-cycle-report-snapshot.ts). Renders the identity/meta line, four
 * headline stats, a per-processor breakdown, a searchable + paginated payee
 * table, and the three export buttons (CSV / XLSX / PDF, built by Task 4's
 * pay-cycle-report-export.ts). Unpublish lives in the header too, edit-gated.
 *
 * Visual and structural language mirrors DispatchReports.tsx's own detail
 * view (Payment Dispatch → Reports) — the loading/error shells, the header
 * shape, the DetailStat cards, the per-processor grid, and the searchable
 * paginated panel all follow that file's patterns, reskinned in this tab's
 * orange → rose accent (established by the list view, PayCycleReports.tsx).
 *
 * Two things worth a reviewer's attention:
 *  - The processor band renders one cell per DISPATCH_PROCESSORS entry PLUS a
 *    trailing cell for any `byProcessor` key that ISN'T one of those ids.
 *    buildPayCycleReportSnapshot writes the literal 'unknown' when a paid
 *    dispatch had no processor, so a stray/legacy key's money still shows up
 *    on screen (labelled by its raw key) instead of silently disappearing.
 *  - Every export is built from `filtered` — the current search result — not
 *    report.payees, so a CSV/XLSX/PDF pulled mid-search matches what's on
 *    screen, and `filterLabel` records what it was filtered by.
 */

const PAYEES_PER_PAGE = 25;

function formatDateLong(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function PayCycleReportDetail({
  report,
  loading,
  error,
  canEdit,
  onBack,
  onUnpublish,
}: {
  report: PayCycleReportSnapshot | null;
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  onBack: () => void;
  onUnpublish: (sourceFile: string) => void | Promise<void>;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
        <p className="text-xs text-zinc-500 dark:text-zinc-500">Loading report…</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
          Couldn&apos;t load report
        </h2>
        <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">
          {error ?? 'Report not found'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onBack} className="mt-2">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back to reports
        </Button>
      </div>
    );
  }

  // Keyed by source_file so a hypothetical future direct swap between two
  // loaded reports resets search/page/export-busy state instead of leaking it
  // from the previous report — today's call sites always route back through
  // `loading`/`null` first, but this costs nothing and removes the footgun.
  return (
    <ReportDetailBody
      key={report.source_file}
      report={report}
      canEdit={canEdit}
      onBack={onBack}
      onUnpublish={onUnpublish}
    />
  );
}

function ReportDetailBody({
  report,
  canEdit,
  onBack,
  onUnpublish,
}: {
  report: PayCycleReportSnapshot;
  canEdit: boolean;
  onBack: () => void;
  onUnpublish: (sourceFile: string) => void | Promise<void>;
}) {
  const { totals } = report;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [unpublishBusy, setUnpublishBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return report.payees;
    return report.payees.filter(
      (p) => (p.name ?? '').toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [report.payees, query]);

  const handleQueryChange = (v: string) => {
    setQuery(v);
    setPage(0);
  };

  // Built from the FILTERED rows (the search result), never report.payees
  // directly, so an export always matches what's currently on screen.
  const exportModel = () =>
    buildPayCycleReportExport(report, {
      rows: filtered,
      filterLabel: query.trim()
        ? `${report.label} — matching "${query.trim()}"`
        : report.label,
    });

  const handleExportPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      await downloadPayCycleReportPdf(exportModel());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the PDF report');
    } finally {
      setPdfBusy(false);
    }
  };

  const handleUnpublish = async () => {
    setUnpublishBusy(true);
    try {
      await onUnpublish(report.source_file);
    } finally {
      setUnpublishBusy(false);
    }
  };

  const exportDisabled = filtered.length === 0;
  const exportTitle = exportDisabled ? 'Nothing to export' : undefined;
  const exportButtonClass =
    'h-8 gap-1.5 border-orange-200 bg-white px-3 text-[11px] font-medium text-orange-700 hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50 dark:border-orange-900/40 dark:bg-zinc-950 dark:text-orange-300 dark:hover:bg-orange-500/10';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-orange-100/80 bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-orange-950/40 dark:bg-[#0d1117]">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 mb-2 h-7 gap-1.5 px-2 text-[11px]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              {report.label}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-500">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {formatDateLong(report.period_start)} → {formatDateLong(report.period_end)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Published {formatTimestamp(report.published_at)} by {report.published_by}
              </span>
              <span className="inline-flex items-center gap-1">
                <FileSpreadsheet className="h-3 w-3" />
                <span className="max-w-[280px] truncate">{report.source_file}</span>
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadPayCycleReportCsv(exportModel())}
              disabled={exportDisabled}
              title={exportTitle}
              className={exportButtonClass}
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadPayCycleReportXlsx(exportModel())}
              disabled={exportDisabled}
              title={exportTitle}
              className={exportButtonClass}
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              Export XLSX
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExportPdf()}
              disabled={exportDisabled || pdfBusy}
              title={exportTitle}
              className={exportButtonClass}
            >
              {pdfBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              Export PDF
            </Button>
            {canEdit && (
              <UnpublishAction busy={unpublishBusy} onConfirm={() => void handleUnpublish()} />
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-4 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          <DetailStat
            label="Payees"
            value={totals.payeeCount.toLocaleString('en-US')}
            sub={`${totals.employeeCount.toLocaleString('en-US')} employees · ${totals.contractorCount.toLocaleString('en-US')} contractor invoices`}
            tone="violet"
            Icon={Users}
          />
          <DetailStat
            label="Payments"
            value={totals.dispatchCount.toLocaleString('en-US')}
            sub="dispatches paid"
            tone="amber"
            Icon={Send}
          />
          <DetailStat
            label="Total paid"
            value={formatUSD(totals.paidUSD)}
            sub="across all processors"
            tone="emerald"
            Icon={Coins}
          />
          <DetailStat
            label="In pesos"
            value={formatPHP(totals.paidPHP)}
            sub="across all processors"
            tone="orange"
            Icon={Banknote}
          />
        </div>

        <ProcessorBand byProcessor={report.byProcessor} />

        <PayeesPanel
          totalCount={report.payees.length}
          filtered={filtered}
          query={query}
          onQueryChange={handleQueryChange}
          page={page}
          onPageChange={setPage}
        />
      </div>
    </div>
  );
}

// ─── Headline stat cards ──────────────────────────────────────────────────────

function DetailStat({
  label,
  value,
  sub,
  tone,
  Icon,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'emerald' | 'violet' | 'amber' | 'orange';
  Icon: React.ComponentType<{ className?: string }>;
}) {
  const palette = {
    emerald: {
      ring: 'from-emerald-200/40 to-teal-200/40 dark:from-emerald-900/30 dark:to-teal-900/30',
      icon: 'from-emerald-500 to-teal-500',
      text: 'text-emerald-700 dark:text-emerald-300',
    },
    violet: {
      ring: 'from-violet-200/40 to-fuchsia-200/40 dark:from-violet-900/30 dark:to-fuchsia-900/30',
      icon: 'from-violet-500 to-fuchsia-500',
      text: 'text-violet-700 dark:text-violet-300',
    },
    amber: {
      ring: 'from-amber-200/40 to-orange-200/40 dark:from-amber-900/30 dark:to-orange-900/30',
      icon: 'from-amber-500 to-orange-500',
      text: 'text-amber-700 dark:text-amber-300',
    },
    orange: {
      ring: 'from-orange-200/40 to-rose-200/40 dark:from-orange-900/30 dark:to-rose-900/30',
      icon: 'from-orange-500 to-rose-500',
      text: 'text-orange-700 dark:text-orange-300',
    },
  }[tone];

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/60 bg-white/70 p-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60 sm:p-4">
      <div className={cn('absolute inset-0 bg-gradient-to-br opacity-60', palette.ring)} aria-hidden />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em]', palette.text)}>
            {label}
          </div>
          <div className="mt-0.5 text-xl font-bold tabular-nums tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
            {value}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-zinc-500 dark:text-zinc-400">{sub}</div>
        </div>
        <div
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md',
            palette.icon,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

// ─── Per-processor breakdown ──────────────────────────────────────────────────

function ProcessorBand({
  byProcessor,
}: {
  byProcessor: Record<string, { count: number; usd: number; php: number }>;
}) {
  // Known ids get their own always-present cell (even at zero, so a processor
  // with nothing paid this cycle still reads as "checked, not skipped"). Any
  // OTHER key — 'unknown', or a retired id like 'wepay' on an older cycle —
  // still gets a cell, labelled by its raw key, so its money is never quietly
  // dropped from the on-screen total.
  const knownIds = new Set<string>(DISPATCH_PROCESSORS.map((p) => p.id));
  const extra = Object.entries(byProcessor).filter(([key]) => !knownIds.has(key));

  return (
    <section className="mt-5 rounded-2xl border border-orange-100/80 bg-white p-3 sm:p-4 dark:border-orange-950/40 dark:bg-zinc-950">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
        Paid by processor
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {DISPATCH_PROCESSORS.map((p) => (
          <ProcessorCell
            key={p.id}
            label={p.label}
            stats={byProcessor[p.id] ?? { count: 0, usd: 0, php: 0 }}
          />
        ))}
        {extra.map(([key, stats]) => (
          <ProcessorCell key={key} label={key} stats={stats} />
        ))}
      </div>
    </section>
  );
}

function ProcessorCell({
  label,
  stats,
}: {
  label: string;
  stats: { count: number; usd: number; php: number };
}) {
  return (
    <div
      className={cn(
        'rounded-xl border px-2.5 py-2 transition-colors',
        stats.count > 0
          ? 'border-orange-100 bg-gradient-to-br from-orange-50/40 to-rose-50/30 dark:border-orange-900/30 dark:from-orange-950/20 dark:to-rose-950/10'
          : 'border-orange-100/60 bg-[#fafaf8] dark:border-orange-950/30 dark:bg-zinc-900/40',
      )}
    >
      <div
        className="truncate text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500 dark:text-zinc-400"
        title={label}
      >
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="text-lg font-bold tabular-nums text-zinc-900 dark:text-white">
          {stats.count}
        </span>
        <div className="flex flex-col items-end leading-tight">
          <span className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
            {formatUSD(stats.usd)}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-zinc-500 dark:text-zinc-500">
            {formatPHP(stats.php)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Who-got-paid table — searchable, paginated at 25 rows ───────────────────

function PayeesPanel({
  totalCount,
  filtered,
  query,
  onQueryChange,
  page,
  onPageChange,
}: {
  /** Full, unfiltered row count — always shown in the header regardless of search. */
  totalCount: number;
  /** Already search-filtered rows (case-insensitive name/email match). */
  filtered: PayCycleReportPayee[];
  query: string;
  onQueryChange: (v: string) => void;
  page: number;
  onPageChange: (p: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAYEES_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAYEES_PER_PAGE;
  const visible = filtered.slice(start, start + PAYEES_PER_PAGE);

  return (
    <section className="mt-4 rounded-2xl border border-orange-100/80 bg-white dark:border-orange-950/40 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-100/80 px-4 py-2.5 dark:border-orange-950/40">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
          <Users className="h-3.5 w-3.5" />
          Who got paid
        </h2>
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
          {totalCount} payment{totalCount === 1 ? '' : 's'}
        </span>
      </div>

      <div className="px-4 pt-3">
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-zinc-400 dark:text-zinc-600">
            <Search className="h-3.5 w-3.5" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full rounded-lg border border-orange-200/80 bg-white/90 py-1.5 pl-7 pr-8 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-orange-400/60 dark:border-orange-900/40 dark:bg-zinc-900/60 dark:placeholder:text-zinc-600 dark:focus:ring-orange-500/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              className="absolute inset-y-0 right-2 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="px-4 py-8 text-center text-[11px] text-zinc-500 dark:text-zinc-500">
          No results for &ldquo;{query}&rdquo;
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[860px] text-xs">
            <thead className="bg-[#fafaf8] text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Processor</th>
                <th className="px-4 py-2 text-right font-medium">USD</th>
                <th className="px-4 py-2 text-right font-medium">PHP</th>
                <th className="px-4 py-2 text-left font-medium">Txn ID</th>
                <th className="px-4 py-2 text-left font-medium">Bank used</th>
                <th className="px-4 py-2 text-left font-medium">Date sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-orange-100/70 dark:divide-orange-950/30">
              {visible.map((p, i) => {
                const meta = PROCESSORS.find((x) => x.id === p.processor);
                return (
                  <tr key={`${start + i}-${p.email}`} className="hover:bg-[#fafaf8] dark:hover:bg-zinc-900/50">
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {p.name ?? p.email}
                        </span>
                        {p.payeeType === 'contractor' && <ContractorChip />}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                      {p.email}
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                      {meta?.label ?? p.processor}
                    </td>
                    <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {formatUSD(p.amountUSD)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatPHP(p.amountPHP)}
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                      {p.transactionId ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{p.bankUsed ?? '—'}</td>
                    <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">{p.dateSent ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 && pageCount > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-orange-100/70 px-4 py-2 dark:border-orange-950/30">
          <span className="text-[10px] text-zinc-500 dark:text-zinc-500">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{start + 1}</span>
            {' – '}
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{start + visible.length}</span>
            {' of '}
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{filtered.length}</span>
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-orange-200/70 bg-white text-zinc-600 transition-colors hover:bg-orange-50 disabled:pointer-events-none disabled:opacity-40 dark:border-orange-900/40 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-orange-500/10"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[4rem] text-center text-[10px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => onPageChange(Math.min(pageCount - 1, safePage + 1))}
              disabled={safePage >= pageCount - 1}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-orange-200/70 bg-white text-zinc-600 transition-colors hover:bg-orange-50 disabled:pointer-events-none disabled:opacity-40 dark:border-orange-900/40 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-orange-500/10"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Unpublish — edit-gated, two-step arm-then-confirm ───────────────────────

function UnpublishAction({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          onConfirm();
        }}
        className={cn(
          'h-8 gap-1.5 px-3 text-[11px] font-medium',
          armed &&
            'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-950/30 dark:text-rose-300',
        )}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        {armed ? 'Confirm unpublish' : 'Unpublish'}
      </Button>
      {armed && !busy && (
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="text-[10px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
