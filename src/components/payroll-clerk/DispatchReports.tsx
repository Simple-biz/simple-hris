'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Clock,
  Coins,
  Download,
  FileSpreadsheet,
  Gauge,
  Gift,
  Heart,
  Loader2,
  Search,
  Send,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import type { OrphanageDispatchRow } from '@/lib/supabase/orphanage-dispatches';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatPHP, formatUSD, PROCESSORS, type ProcessorId } from './mock-queue';
import type {
  PaymentDispatchRow,
  PaymentDispatchStatus,
} from '@/lib/supabase/payment-dispatches';
import AnimatedNumber from './AnimatedNumber';

interface ReportTotals {
  paidCount: number;
  paidUSD: number;
  paidPHP: number;
  notPaidCount: number;
  thresholdCount: number;
  problemCount: number;
  pendingDispatchedUSD: number;
  sentCount: number;
  totalDispatchedUSD: number;
}

export interface ReportRecipient {
  email: string;
  name: string | null;
  amountUSD: number;
}

export interface ReportSummary {
  cycleId: string;
  periodStart: string | null;
  periodEnd: string | null;
  sourceFile: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  rowCount: number | null;
  isCurrent: boolean;
  reportName: string;
  totals: ReportTotals;
  byProcessor: Record<string, { count: number; usd: number }>;
  /** Every recipient with status='paid' for this cycle, sorted by name. */
  paidRecipients: ReportRecipient[];
}

export interface ReportDetail extends ReportSummary {
  dispatches: PaymentDispatchRow[];
  outstanding: Array<{
    email: string;
    amountUSD: number | null;
    amountPHP: number | null;
  }>;
  outstandingUSD: number;
}

const STATUS_PRESENTATION: Record<
  PaymentDispatchStatus,
  { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  paid: {
    label: 'Paid',
    Icon: CheckCircle2,
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
  not_paid: {
    label: 'Not Paid',
    Icon: CircleDashed,
    className:
      'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
  },
  threshold: {
    label: 'Threshold',
    Icon: Gauge,
    className:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  },
  problem: {
    label: 'Problem',
    Icon: AlertTriangle,
    className:
      'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300',
  },
};

function StatusBadge({ status }: { status: PaymentDispatchStatus }) {
  const meta = STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.paid;
  const { Icon } = meta;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        meta.className,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  );
}

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

const REPORTS_PER_PAGE = 6;

export default function DispatchReports() {
  const [summaries, setSummaries] = useState<ReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReportDetail | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [orphanageRows, setOrphanageRows] = useState<OrphanageDispatchRow[]>([]);
  const [orphanageLoading, setOrphanageLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/payment-dispatches/reports', {
          cache: 'no-store',
          signal: controller.signal,
        });
        const json = (await res.json()) as { reports?: ReportSummary[]; error?: string };
        if (controller.signal.aborted) return;
        if (json.error) {
          setError(json.error);
          setSummaries([]);
        } else {
          setSummaries(json.reports ?? []);
          setPage(0);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Could not load reports');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  // Fetch paid orphanage dispatches for the reports panel
  useEffect(() => {
    (async () => {
      setOrphanageLoading(true);
      try {
        const res = await fetch('/api/orphanage-dispatches?paid=1', { cache: 'no-store' });
        const json = (await res.json()) as { rows?: OrphanageDispatchRow[]; error?: string };
        if (!json.error) setOrphanageRows(json.rows ?? []);
      } catch {
        // non-fatal — orphanage section silently omitted
      } finally {
        setOrphanageLoading(false);
      }
    })();
  }, []);

  const filteredSummaries = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return summaries;
    return summaries.filter(
      (s) =>
        s.reportName.toLowerCase().includes(q) ||
        (s.sourceFile ?? '').toLowerCase().includes(q) ||
        (s.periodStart ?? '').includes(q) ||
        (s.periodEnd ?? '').includes(q),
    );
  }, [summaries, search]);

  const openReport = async (cycleId: string) => {
    setSelectedLoading(true);
    setSelectedError(null);
    setSelected(null);
    try {
      const res = await fetch(
        `/api/payment-dispatches/reports/${encodeURIComponent(cycleId)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { report?: ReportDetail; error?: string };
      if (json.error || !json.report) {
        setSelectedError(json.error ?? 'Could not load report');
      } else {
        setSelected(json.report);
      }
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : 'Could not load report');
    } finally {
      setSelectedLoading(false);
    }
  };

  const closeDetail = () => {
    setSelected(null);
    setSelectedError(null);
  };

  if (selected || selectedLoading || selectedError) {
    return (
      <ReportDetailView
        report={selected}
        loading={selectedLoading}
        error={selectedError}
        onBack={closeDetail}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              Disbursement reports
            </h1>
            <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
              Weekly payroll cycles and orphanage payments.
            </p>
          </div>
          <div className="hidden items-center gap-1.5 rounded-full border border-orange-200/80 bg-white/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/30 dark:text-orange-300 sm:inline-flex">
            <Sparkles className="h-3 w-3" />
            {summaries.length} {summaries.length === 1 ? 'report' : 'reports'}
          </div>
        </div>
        {/* Search bar */}
        {summaries.length > 0 && (
          <div className="relative mt-3">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
              <Search className="h-3.5 w-3.5 text-zinc-400" />
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search by period, file name…"
              className="w-full rounded-lg border border-zinc-200 bg-zinc-50 py-1.5 pl-8 pr-8 text-xs placeholder:text-zinc-400 focus:border-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-300/60 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-600 dark:focus:border-orange-700/60"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute inset-y-0 right-2 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-3 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {/* Orphanage payments panel */}
        {(orphanageRows.length > 0 || orphanageLoading) && (
          <OrphanageReportsPanel rows={orphanageRows} loading={orphanageLoading} />
        )}

        {/* Payroll reports */}
        {loading ? (
          <ReportListSkeleton />
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white shadow-lg shadow-rose-500/30">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-white">
              Couldn&apos;t load reports
            </h2>
            <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{error}</p>
          </div>
        ) : filteredSummaries.length === 0 ? (
          <div className={cn('flex items-center justify-center text-center', orphanageRows.length > 0 ? 'mt-6' : 'h-full')}>
            <div>
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                {search ? <Search className="h-5 w-5" /> : <FileSpreadsheet className="h-5 w-5" />}
              </div>
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {search ? `No reports match "${search}"` : 'No disbursement reports yet'}
              </h2>
              <p className="mt-1 text-xs text-[#71717a] dark:text-zinc-500">
                {search
                  ? 'Try a different search term.'
                  : 'Upload a Hubstaff cycle in the Payroll Wizard to start a new report.'}
              </p>
            </div>
          </div>
        ) : (
          <PaginatedReportGrid
            summaries={filteredSummaries}
            page={page}
            onPageChange={setPage}
            onOpen={openReport}
          />
        )}
      </div>
    </div>
  );
}

function ReportListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-44 animate-pulse rounded-2xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950"
        />
      ))}
    </div>
  );
}

function PaginatedReportGrid({
  summaries,
  page,
  onPageChange,
  onOpen,
}: {
  summaries: ReportSummary[];
  page: number;
  onPageChange: (next: number) => void;
  onOpen: (cycleId: string) => void;
}) {
  const total = summaries.length;
  const pageCount = Math.max(1, Math.ceil(total / REPORTS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * REPORTS_PER_PAGE;
  const visible = summaries.slice(start, start + REPORTS_PER_PAGE);

  return (
    <div className="flex flex-col gap-4">
      <motion.ul
        key={safePage}
        initial="hidden"
        animate="visible"
        variants={{
          hidden: { opacity: 0 },
          visible: {
            opacity: 1,
            transition: { staggerChildren: 0.04, delayChildren: 0.02 },
          },
        }}
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {visible.map((s) => (
          <ReportCard key={s.cycleId} report={s} onOpen={() => onOpen(s.cycleId)} />
        ))}
      </motion.ul>

      {pageCount > 1 && (
        <Pagination
          page={safePage}
          pageCount={pageCount}
          total={total}
          rangeStart={start + 1}
          rangeEnd={start + visible.length}
          onPageChange={onPageChange}
        />
      )}
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  onPageChange: (next: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#ececec] bg-white/70 px-3 py-2 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className="text-[11px] text-[#71717a] dark:text-zinc-500">
        Showing <span className="font-semibold text-zinc-700 dark:text-zinc-300">{rangeStart}</span>
        –
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">{rangeEnd}</span> of{' '}
        <span className="font-semibold text-zinc-700 dark:text-zinc-300">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={page === 0}
          className="h-7 px-2 text-[11px]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span className="ml-1 hidden sm:inline">Prev</span>
        </Button>
        <div className="flex items-center gap-1">
          {Array.from({ length: pageCount }, (_, i) => i).map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => onPageChange(i)}
              className={cn(
                'flex h-7 min-w-[1.75rem] items-center justify-center rounded-md px-1.5 text-[11px] font-semibold tabular-nums transition-colors',
                i === page
                  ? 'bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-sm'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
              )}
              aria-current={i === page ? 'page' : undefined}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount - 1}
          className="h-7 px-2 text-[11px]"
        >
          <span className="mr-1 hidden sm:inline">Next</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ReportCard({
  report,
  onOpen,
}: {
  report: ReportSummary;
  onOpen: () => void;
}) {
  const { totals } = report;
  return (
    <motion.li
      variants={{
        hidden: { opacity: 0, y: 8 },
        visible: {
          opacity: 1,
          y: 0,
          transition: { type: 'spring', stiffness: 280, damping: 24 },
        },
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'group relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-2xl border bg-white p-4 text-left shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08)] transition-shadow hover:shadow-[0_10px_28px_-12px_rgba(255,138,76,0.25)] dark:border-zinc-800 dark:bg-zinc-950',
          report.isCurrent
            ? 'border-orange-200 ring-1 ring-orange-100/60 dark:border-orange-900/40 dark:ring-orange-900/20'
            : 'border-[#ececec]',
        )}
      >
        {report.isCurrent && (
          <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full border border-orange-200 bg-gradient-to-br from-orange-50 to-rose-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-orange-700 dark:border-orange-900/40 dark:from-orange-950/40 dark:to-rose-950/30 dark:text-orange-300">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-orange-500" />
            </span>
            Current
          </span>
        )}

        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-md">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
              {report.reportName}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[#71717a] dark:text-zinc-500">
              <Clock className="h-3 w-3" />
              <span>Uploaded {formatTimestamp(report.uploadedAt)}{report.uploadedBy ? ` by ${report.uploadedBy}` : ''}</span>
            </div>
            {report.sourceFile && (
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-400 dark:text-zinc-500">
                <FileSpreadsheet className="h-3 w-3" />
                <span className="truncate">{report.sourceFile}</span>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <MiniStat
            label="Paid"
            value={totals.paidCount}
            tone="emerald"
            Icon={CheckCircle2}
          />
          <MiniStat
            label="Sent"
            value={totals.sentCount}
            tone="violet"
            Icon={Send}
          />
          <MiniStat
            label="Pending"
            value={totals.notPaidCount + totals.thresholdCount + totals.problemCount}
            tone="amber"
            Icon={Clock}
          />
        </div>

        <div className="mt-auto flex items-center justify-between rounded-xl border border-[#ececec] bg-[#fafaf8] px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex flex-col">
            <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              Total paid out
            </span>
            <span className="font-mono text-sm font-bold tracking-tight text-emerald-700 tabular-nums dark:text-emerald-400">
              {formatUSD(totals.paidUSD)}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[11px] font-medium text-orange-600 transition-transform group-hover:translate-x-1 dark:text-orange-400">
            View report
            <span aria-hidden>→</span>
          </div>
        </div>
      </button>
    </motion.li>
  );
}

function MiniStat({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'violet' | 'amber';
  Icon: React.ComponentType<{ className?: string }>;
}) {
  const palette = {
    emerald: 'text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-500/10',
    violet: 'text-violet-700 bg-violet-50 dark:text-violet-300 dark:bg-violet-500/10',
    amber: 'text-amber-700 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10',
  }[tone];
  return (
    <div className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', palette)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 leading-tight">
        <div className="text-[9px] font-semibold uppercase tracking-[0.1em] opacity-70">
          {label}
        </div>
        <div className="text-sm font-bold tabular-nums">
          <AnimatedNumber value={value} />
        </div>
      </div>
    </div>
  );
}

function ReportDetailView({
  report,
  loading,
  error,
  onBack,
}: {
  report: ReportDetail | null;
  loading: boolean;
  error: string | null;
  onBack: () => void;
}) {
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
          {error ?? 'Unknown error'}
        </p>
        <Button variant="outline" size="sm" onClick={onBack} className="mt-2">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back to reports
        </Button>
      </div>
    );
  }

  return <ReportDetail report={report} onBack={onBack} />;
}

function ReportDetail({
  report,
  onBack,
}: {
  report: ReportDetail;
  onBack: () => void;
}) {
  const { totals } = report;
  const totalPending =
    totals.notPaidCount + totals.thresholdCount + totals.problemCount;
  const sortedDispatches = useMemo(
    () =>
      [...report.dispatches].sort((a, b) => {
        // Paid first, then by sent_date desc.
        if (a.status === 'paid' && b.status !== 'paid') return -1;
        if (a.status !== 'paid' && b.status === 'paid') return 1;
        return (b.sent_date ?? '').localeCompare(a.sent_date ?? '');
      }),
    [report.dispatches],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-[#ececec] bg-white px-4 py-3 sm:px-6 sm:py-5 dark:border-zinc-800 dark:bg-zinc-950">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="-ml-2 mb-2 h-7 px-2 text-[11px]"
        >
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight text-zinc-900 sm:text-xl dark:text-white">
              {report.reportName}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#71717a] dark:text-zinc-500">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3 w-3" />
                {formatDateLong(report.periodStart)} → {formatDateLong(report.periodEnd)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Uploaded {formatTimestamp(report.uploadedAt)}{report.uploadedBy ? ` by ${report.uploadedBy}` : ''}
              </span>
              {report.sourceFile && (
                <span className="inline-flex items-center gap-1">
                  <FileSpreadsheet className="h-3 w-3" />
                  <span className="max-w-[280px] truncate">{report.sourceFile}</span>
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {report.isCurrent && (
              <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-gradient-to-br from-orange-50 to-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-orange-700 dark:border-orange-900/40 dark:from-orange-950/40 dark:to-rose-950/30 dark:text-orange-300">
                Current cycle
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={
                report.totals.sentCount === 0 &&
                report.outstanding.length === 0 &&
                report.paidRecipients.length === 0
              }
              onClick={() => {
                window.location.href = `/api/payment-dispatches/reports/${encodeURIComponent(report.cycleId)}/export`;
              }}
              className="h-8 gap-1.5 border-emerald-200 bg-white px-3 text-[11px] font-medium text-emerald-700 hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
              title={
                report.totals.sentCount === 0 &&
                report.outstanding.length === 0 &&
                report.paidRecipients.length === 0
                  ? 'No recipients in this cycle'
                  : 'Download CSV of every recipient in this report'
              }
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#fafaf8] px-3 py-3 sm:px-6 sm:py-6 dark:bg-[#0d1117]">
        {/* Headline stats */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
          <DetailStat
            label="Paid"
            value={totals.paidCount}
            sub={formatUSD(totals.paidUSD)}
            tone="emerald"
            Icon={CheckCircle2}
          />
          <DetailStat
            label="Sent"
            value={totals.sentCount}
            sub={`${totals.sentCount} dispatch${totals.sentCount === 1 ? '' : 'es'} logged`}
            tone="violet"
            Icon={Send}
          />
          <DetailStat
            label="Pending"
            value={totalPending + (report.outstanding.length ?? 0)}
            sub={
              report.outstandingUSD > 0
                ? `${formatUSD(report.outstandingUSD)} not yet dispatched`
                : `${formatUSD(totals.pendingDispatchedUSD)} blocked`
            }
            tone="amber"
            Icon={Clock}
          />
          <DetailStat
            label="Total Paid"
            value={null}
            sub={formatPHP(totals.paidPHP)}
            tone="orange"
            currencyValue={totals.paidUSD}
            Icon={Coins}
          />
        </div>

        {/* Per-processor breakdown of paid dispatches */}
        <section className="mt-5 rounded-2xl border border-[#ececec] bg-white p-3 sm:p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              Paid by processor
            </h2>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
              status = paid only
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {PROCESSORS.map((p) => {
              const stats = report.byProcessor[p.id] ?? { count: 0, usd: 0 };
              return (
                <div
                  key={p.id}
                  className={cn(
                    'rounded-xl border px-2.5 py-2 transition-colors',
                    stats.count > 0
                      ? 'border-orange-100 bg-gradient-to-br from-orange-50/40 to-rose-50/30 dark:border-orange-900/30 dark:from-orange-950/20 dark:to-rose-950/10'
                      : 'border-[#ececec] bg-[#fafaf8] dark:border-zinc-800 dark:bg-zinc-900/40',
                  )}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500 dark:text-zinc-400">
                    {p.label}
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between">
                    <span className="text-lg font-bold tabular-nums text-zinc-900 dark:text-white">
                      {stats.count}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-zinc-600 dark:text-zinc-400">
                      {formatUSD(stats.usd)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Outstanding (current cycle only) */}
        {report.outstanding.length > 0 && (
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50/50 p-3 sm:p-4 dark:border-amber-500/20 dark:bg-amber-500/5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-800 dark:text-amber-300">
                Not yet dispatched
              </h2>
              <span className="font-mono text-xs font-semibold tabular-nums text-amber-800 dark:text-amber-300">
                {formatUSD(report.outstandingUSD)}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-amber-700 dark:text-amber-400">
              {report.outstanding.length} recipient
              {report.outstanding.length === 1 ? '' : 's'} owed pay this cycle but no
              dispatch row yet.
            </p>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-white/70 dark:bg-zinc-950/40">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-amber-100 dark:divide-amber-500/10">
                  {report.outstanding.slice(0, 50).map((o) => (
                    <tr key={o.email}>
                      <td className="px-3 py-1.5 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                        {o.email}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-zinc-900 dark:text-zinc-100">
                        {formatUSD(o.amountUSD)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.outstanding.length > 50 && (
                <div className="border-t border-amber-100 px-3 py-1.5 text-center text-[10px] text-amber-700 dark:border-amber-500/10 dark:text-amber-400">
                  + {report.outstanding.length - 50} more
                </div>
              )}
            </div>
          </section>
        )}

        {/* Paid this week — every employee whose dispatch landed in 'paid' status. */}
        {report.paidRecipients.length > 0 && (
          <PaidRecipientsPanel recipients={report.paidRecipients} />
        )}

        {/* Dispatches table */}
        <section className="mt-4 rounded-2xl border border-[#ececec] bg-white dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between border-b border-[#ececec] px-4 py-2.5 dark:border-zinc-800">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              Dispatch detail
            </h2>
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
              {sortedDispatches.length} record{sortedDispatches.length === 1 ? '' : 's'}
            </span>
          </div>
          {sortedDispatches.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-[#71717a] dark:text-zinc-500">
              No dispatches logged for this cycle yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[920px] text-xs">
                <thead className="bg-[#fafaf8] text-[10px] uppercase tracking-wide text-[#71717a] dark:bg-zinc-900 dark:text-zinc-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Recipient</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-left font-medium">Processor</th>
                    <th className="px-4 py-2 text-right font-medium">USD</th>
                    <th className="px-4 py-2 text-right font-medium">PHP</th>
                    <th className="px-4 py-2 text-left font-medium">Bank used</th>
                    <th className="px-4 py-2 text-left font-medium">Txn ID</th>
                    <th className="px-4 py-2 text-left font-medium">Sent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#ececec] dark:divide-zinc-800">
                  {sortedDispatches.map((rec) => {
                    const meta = PROCESSORS.find((p) => p.id === rec.processor);
                    return (
                      <tr key={rec.id} className="hover:bg-[#fafaf8] dark:hover:bg-zinc-900/50">
                        <td className="px-4 py-2">
                          <div className="font-medium text-zinc-900 dark:text-zinc-100">
                            {rec.recipient_name ?? rec.recipient_email}
                          </div>
                          <div className="font-mono text-[10px] text-[#71717a] dark:text-zinc-500">
                            {rec.recipient_email}
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <StatusBadge status={rec.status} />
                        </td>
                        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                          {meta?.label ?? rec.processor}
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                          {formatUSD(rec.amount_usd)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
                          {formatPHP(rec.amount_php)}
                        </td>
                        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                          {rec.bank_used}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                          {rec.transaction_id}
                        </td>
                        <td className="px-4 py-2 text-zinc-700 dark:text-zinc-300">
                          {rec.sent_date}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const RECIPIENTS_PER_PAGE = 6;

function PaidRecipientsPanel({ recipients }: { recipients: ReportRecipient[] }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter(
      (r) =>
        (r.name ?? '').toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q),
    );
  }, [recipients, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / RECIPIENTS_PER_PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * RECIPIENTS_PER_PAGE;
  const visible = filtered.slice(start, start + RECIPIENTS_PER_PAGE);

  const handleQuery = (v: string) => {
    setQuery(v);
    setPage(0);
  };

  return (
    <section className="mt-4 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-emerald-50/60 to-white p-3 sm:p-4 dark:border-emerald-500/20 dark:from-emerald-500/5 dark:to-zinc-950">
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-800 dark:text-emerald-300">
          <Users className="h-3.5 w-3.5" />
          Paid this week
        </h2>
        <span className="font-mono text-[10px] tabular-nums text-emerald-800/80 dark:text-emerald-300/80">
          {recipients.length} employee{recipients.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* search */}
      <div className="relative mt-2.5">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <svg
            className="h-3.5 w-3.5 text-emerald-600/60 dark:text-emerald-400/50"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
              clipRule="evenodd"
            />
          </svg>
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => handleQuery(e.target.value)}
          placeholder="Search by name or email…"
          className="w-full rounded-lg border border-emerald-200/80 bg-white/90 py-1.5 pl-7 pr-3 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-emerald-400/60 dark:border-emerald-500/20 dark:bg-zinc-950/60 dark:placeholder:text-zinc-600 dark:focus:ring-emerald-500/40"
        />
        {query && (
          <button
            type="button"
            onClick={() => handleQuery('')}
            className="absolute inset-y-0 right-2 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
            aria-label="Clear search"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        )}
      </div>

      {/* grid */}
      {filtered.length === 0 ? (
        <p className="mt-3 text-center text-[11px] text-zinc-500 dark:text-zinc-500">
          No results for &ldquo;{query}&rdquo;
        </p>
      ) : (
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((r) => (
            <li
              key={r.email}
              className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200/70 bg-white/80 px-2.5 py-1.5 dark:border-emerald-500/20 dark:bg-zinc-950/60"
            >
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-zinc-900 dark:text-zinc-100">
                  {r.name?.trim() || r.email}
                </div>
                <div className="truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                  {r.email}
                </div>
              </div>
              <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
                {formatUSD(r.amountUSD)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* pagination */}
      {pageCount > 1 && (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-emerald-100 bg-white/60 px-3 py-1.5 dark:border-emerald-500/10 dark:bg-zinc-950/40">
          <span className="text-[10px] text-zinc-500 dark:text-zinc-500">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{start + 1}</span>
            {' – '}
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">
              {start + visible.length}
            </span>
            {' of '}
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">{filtered.length}</span>
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-emerald-200/70 bg-white text-zinc-600 transition-colors hover:bg-emerald-50 disabled:pointer-events-none disabled:opacity-40 dark:border-emerald-500/20 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-emerald-500/10"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[4rem] text-center text-[10px] font-semibold tabular-nums text-zinc-700 dark:text-zinc-300">
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-emerald-200/70 bg-white text-zinc-600 transition-colors hover:bg-emerald-50 disabled:pointer-events-none disabled:opacity-40 dark:border-emerald-500/20 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:bg-emerald-500/10"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function DetailStat({
  label,
  value,
  sub,
  tone,
  Icon,
  currencyValue,
}: {
  label: string;
  value: number | null;
  sub: string;
  tone: 'emerald' | 'violet' | 'amber' | 'orange';
  Icon: React.ComponentType<{ className?: string }>;
  /** When set, render this as a USD currency headline instead of `value`. */
  currencyValue?: number;
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
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-br opacity-60',
          palette.ring,
        )}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('text-[9px] font-semibold uppercase tracking-[0.14em]', palette.text)}>
            {label}
          </div>
          <div className="mt-0.5 flex items-baseline gap-0.5">
            {currencyValue != null ? (
              <>
                <span className="text-base font-semibold text-zinc-500 dark:text-zinc-400">$</span>
                <span className="text-xl font-bold tabular-nums tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
                  <AnimatedNumber
                    value={currencyValue}
                    formatter={(n) =>
                      n.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    }
                  />
                </span>
              </>
            ) : (
              <span className="text-xl font-bold tabular-nums tracking-tight text-zinc-900 dark:text-white sm:text-2xl">
                {value == null ? '—' : <AnimatedNumber value={value} />}
              </span>
            )}
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

// ─── Orphanage Reports Panel ─────────────────────────────────────────────────

function formatOrphanagePHP(v: number | null | undefined) {
  if (v == null) return '—';
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateShort(iso: string | null | undefined) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function OrphanageReportsPanel({
  rows,
  loading,
}: {
  rows: OrphanageDispatchRow[];
  loading: boolean;
}) {
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.submitter_email.toLowerCase().includes(q) ||
        (r.bank_name ?? '').toLowerCase().includes(q) ||
        (r.transaction_id ?? '').toLowerCase().includes(q),
    );
  }, [rows, search]);

  const totalPHP = useMemo(() => rows.reduce((s, r) => s + (r.amount_php ?? 0), 0), [rows]);

  return (
    <section className="mb-6 rounded-2xl border border-teal-200/70 bg-gradient-to-br from-teal-50/60 to-white p-3 sm:p-4 dark:border-teal-500/20 dark:from-teal-500/5 dark:to-zinc-950">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-teal-800 dark:text-teal-300">
          <Heart className="h-3.5 w-3.5" fill="currentColor" />
          Orphanage Payments
        </h2>
        <div className="flex items-center gap-2">
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-500" />}
          <span className="font-mono text-[10px] tabular-nums text-teal-800/80 dark:text-teal-300/80">
            {rows.length} record{rows.length === 1 ? '' : 's'} · {formatOrphanagePHP(totalPHP)}
          </span>
        </div>
      </div>

      {/* Search */}
      <div className="relative mt-2.5">
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center">
          <Search className="h-3.5 w-3.5 text-teal-600/60 dark:text-teal-400/50" />
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by label, email, bank, or txn ID…"
          className="w-full rounded-lg border border-teal-200/80 bg-white/90 py-1.5 pl-7 pr-7 text-[12px] placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-teal-400/60 dark:border-teal-500/20 dark:bg-zinc-950/60 dark:placeholder:text-zinc-600"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute inset-y-0 right-2 flex items-center text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <p className="mt-3 text-center text-[11px] text-zinc-500 dark:text-zinc-500">
          {search ? `No results for "${search}"` : 'No paid orphanage dispatches yet.'}
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-xl border border-teal-100/80 bg-white/80 dark:border-teal-900/30 dark:bg-zinc-950/60">
          <table className="w-full min-w-[640px] text-xs">
            <thead className="bg-teal-50/80 text-[10px] uppercase tracking-wide text-teal-800 dark:bg-teal-950/40 dark:text-teal-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-left font-medium">Destination bank</th>
                <th className="px-3 py-2 text-right font-medium">Amount (PHP)</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Txn ID</th>
                <th className="px-3 py-2 text-left font-medium">Sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-teal-100/60 dark:divide-teal-900/20">
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-teal-50/40 dark:hover:bg-teal-950/20">
                  <td className="px-3 py-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      r.dispatch_type === 'budget_request'
                        ? 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300'
                        : 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300',
                    )}>
                      {r.dispatch_type === 'budget_request'
                        ? <><Banknote className="h-2.5 w-2.5" /> Budget</>
                        : <><Gift className="h-2.5 w-2.5" /> Gift</>}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.label}</div>
                    <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-500">{r.submitter_email}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-zinc-900 dark:text-zinc-100">{r.bank_name || '—'}</div>
                    {r.bank_account_number && (
                      <div className="font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                        {r.bank_account_name} · {r.bank_account_number}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-teal-800 dark:text-teal-300">
                    {formatOrphanagePHP(r.amount_php)}
                  </td>
                  <td className="px-3 py-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      r.status === 'paid'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                        : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
                    )}>
                      {r.status === 'paid' ? <CheckCircle2 className="h-2.5 w-2.5" /> : null}
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                    {r.transaction_id || '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">
                    {r.sent_date ? formatDateShort(r.sent_date) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
