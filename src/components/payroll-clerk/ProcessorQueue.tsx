'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Copy, Download, Eye, Receipt, RefreshCw, Search, SearchX, Send, Sparkles, X } from 'lucide-react';
import QueuePagination from './QueuePagination';
import ContractorChip, { showsContractorBadge } from './ContractorChip';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { PROCESSORS, formatPHP, formatUSD, formatCOP, type ProcessorId, type QueueRow } from './mock-queue';
import type { PayCurrency } from '@/lib/payment-catalog/pay-structure';
import type { PaymentDispatchRow, PaymentDispatchStatus } from '@/lib/supabase/payment-dispatches';
import PaidRecordsPanel from './PaidRecordsPanel';

/**
 * The sub-views the queue table can show. 'pending' is the live payable queue;
 * the rest are dispatch-log views, one per recorded outcome. The strings for the
 * log views deliberately match {@link PaymentDispatchStatus} so a view maps
 * straight onto a status filter.
 */
type QueueView = 'pending' | PaymentDispatchStatus;

/** Primary (native) amount string for a row: COP people show COP, everyone else
 *  shows USD (the PHP-equivalent is always the secondary line). */
function rowPrimaryAmount(row: QueueRow): string {
  return row.payCurrency === 'COP' ? formatCOP(row.amountCOP) : formatUSD(row.amountUSD);
}
function rowPrimaryNull(row: QueueRow): boolean {
  return row.payCurrency === 'COP' ? row.amountCOP == null : row.amountUSD == null;
}
import {
  buildPendingRows,
  dispatchClientFilename,
  downloadCsv,
  pendingRowsToCsv,
} from '@/lib/payroll/dispatch-client-csv';

/** Sibling context lets the dispatch dialog navigate the queue with arrow keys. */
export interface QueueRowContext {
  siblings: QueueRow[];
  index: number;
}

interface ProcessorQueueProps {
  /** `null` means "All pending". */
  processor: ProcessorId | null;
  rows: QueueRow[];
  /**
   * Opens the dispatch dialog for `row`. The optional context carries the
   * current (search-filtered) sibling list + the row's index so the dialog
   * can slide left/right between payments.
   */
  onMarkPaid: (row: QueueRow, ctx?: QueueRowContext) => void;
  /** Open this row's employee pay statement in a modal (accounting view). */
  onViewPaystub?: (row: QueueRow) => void;
  /** Period info from the parent — used for CSV filename. */
  periodStart?: string | null;
  periodEnd?: string | null;
  /** Silent re-pull of the queue (e.g. to surface a row sent back from Done). */
  onRefresh?: () => void | Promise<void>;
  /**
   * Overrides the heading + subheading shown in the "All" view (processor ===
   * null). The USD tab uses this so it reads "USD payments" instead of the
   * generic "All pending payments".
   */
  allLabel?: { title: string; subtitle: string };
  /** Native currency of this tab's headline total. 'COP' shows the COP total;
   *  anything else (default) shows the USD total. Per-row amounts always follow
   *  each row's own `payCurrency`. */
  nativeCurrency?: PayCurrency;
  /**
   * Paid dispatch rows for THIS processor. When provided, the queue shows a
   * "Pending / Paid" toggle and a Paid sub-view (with multi-select bulk Undo)
   * scoped to this processor. Omit (undefined) to hide the toggle entirely —
   * e.g. on the "All pending" / currency tabs, where the global Done tab already
   * covers everything paid.
   */
  paidRecords?: PaymentDispatchRow[];
}

/** Sentinel filter value for rows with no known department (real names can't
 *  collide with it — departments never start with "__"). */
const NO_DEPT = '__none__';

const FIELD_LABELS: Record<string, string> = {
  email: 'Work email',
  hurupay_email: 'Hurupay email',
  higlobe_email: 'Higlobe email',
  higlobe_account_name: 'Higlobe account name',
  phone_number: 'Phone',
  full_address: 'Address',
  city: 'City',
  province_state: 'Province / State',
};

function copy(value: string) {
  void navigator.clipboard
    .writeText(value)
    .then(() => toast.success('Copied'))
    .catch(() => toast.error('Could not copy'));
}

function ProcessorBadge({ id }: { id: ProcessorId }) {
  const meta = PROCESSORS.find((p) => p.id === id);
  return (
    <span className="inline-flex items-center rounded-full border border-orange-100 bg-orange-50/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
      {meta?.label ?? id}
    </span>
  );
}

const PROCESSOR_DOT: Record<ProcessorId, string> = {
  hurupay: 'bg-orange-500',
  wepay: 'bg-sky-500',
  higlobe: 'bg-emerald-500',
  wise: 'bg-green-500',
  jeeves: 'bg-pink-500',
  wires: 'bg-zinc-700 dark:bg-zinc-300',
};

/**
 * Inline breakdown chip for rows that include a PAB or Tech bonus on top of
 * regular + OT pay. Renders nothing when there's no bonus, so the queue stays
 * quiet on regular weeks. Tooltip exposes the per-bonus split.
 */
function BonusChip({ row }: { row: QueueRow }) {
  if (row.bonusTotalPHP <= 0) return null;
  const parts: string[] = [];
  if (row.pabBonusPHP > 0) parts.push(`PAB ₱${row.pabBonusPHP.toLocaleString('en-PH')}`);
  if (row.techBonusPHP > 0) parts.push(`Tech ₱${row.techBonusPHP.toLocaleString('en-PH')}`);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-emerald-100/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      title={`Bonus already included in the total above (${parts.join(' + ')})`}
    >
      {`incl. ₱${row.bonusTotalPHP.toLocaleString('en-PH')}`}
      <span className="text-[8px] uppercase tracking-[0.14em] opacity-80">bonus</span>
    </span>
  );
}

/** Small muted pill showing the payee's payroll department. Renders nothing
 *  when the row has no known department (e.g. MESA urgent payments). */
function DeptChip({ name }: { name: string | null }) {
  if (!name) return null;
  return (
    <span
      className="inline-flex max-w-full items-center truncate rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400"
      title={`Department: ${name}`}
    >
      {name}
    </span>
  );
}

function BankCell({
  processor,
  bankPreferredRaw,
}: {
  processor: ProcessorId;
  bankPreferredRaw: string | null;
}) {
  const meta = PROCESSORS.find((p) => p.id === processor);
  const isWireSuffix = bankPreferredRaw && /^x?\d{3,5}$/i.test(bankPreferredRaw.trim());
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100/80 px-2 py-0.5 text-[11px] font-semibold text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-200">
        <span className={cn('h-1.5 w-1.5 rounded-full', PROCESSOR_DOT[processor])} aria-hidden />
        {meta?.label ?? processor}
      </span>
      {isWireSuffix && (
        <span className="ml-2 font-mono text-[10px] text-amber-700 dark:text-amber-400" title="Account suffix in source">
          {bankPreferredRaw}
        </span>
      )}
    </div>
  );
}

function avatarColors(seed: string) {
  // Deterministic gradient picker based on the row id so a row keeps its colour.
  const palettes = [
    'from-orange-400 to-rose-500',
    'from-violet-500 to-fuchsia-500',
    'from-sky-500 to-blue-600',
    'from-emerald-500 to-teal-500',
    'from-amber-500 to-orange-500',
    'from-pink-500 to-rose-500',
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palettes[h % palettes.length];
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  if (parts[0]?.length >= 2) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0]?.[0] || '?').toUpperCase();
}

function ProcessorQueue({ processor, rows, onMarkPaid, onViewPaystub, periodStart, periodEnd, onRefresh, allLabel, nativeCurrency, paidRecords }: ProcessorQueueProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  // '' = all departments; NO_DEPT = rows without a department; else exact name.
  const [deptFilter, setDeptFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Which sub-view is active. 'pending' is the live queue; the other four are
  // dispatch-log views keyed by the recorded outcome. Only meaningful when
  // `paidRecords` is provided; the tab strip is hidden otherwise.
  const [view, setView] = useState<QueueView>('pending');
  const hasPaidView = paidRecords != null;
  // One count per dispatch outcome, from the records handed to this scope.
  const statusCounts = useMemo(() => {
    const c: Record<PaymentDispatchStatus, number> = { paid: 0, not_paid: 0, threshold: 0, problem: 0 };
    for (const r of paidRecords ?? []) c[r.status] += 1;
    return c;
  }, [paidRecords]);
  // The queue-log views (everything except the live pending queue). The active
  // one is rendered by PaidRecordsPanel with the matching status filter.
  const logStatus = view === 'pending' ? null : view;

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  // Stable toggle so memoized rows aren't invalidated on every parent render.
  const handleToggleExpand = useCallback((id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
  }, []);

  // True while the user is still typing (or the debounce timer is in flight).
  const isSearching = query.trim() !== debouncedQuery.trim();

  const meta = processor ? PROCESSORS.find((p) => p.id === processor) ?? null : null;
  const isAllView = processor === null;
  // Seven columns when "All pending" (Bank gets its own column); six otherwise.
  // Order: avatar / identity / department / [bank] / pay (USD+PHP) / hours (total + OT) / action
  const rowGrid = isAllView
    ? 'grid-cols-[auto_minmax(0,1.2fr)_minmax(0,130px)_140px_140px_120px_auto]'
    : 'grid-cols-[auto_minmax(0,1fr)_minmax(0,130px)_140px_120px_auto]';

  // Distinct departments present in THIS queue, for the filter dropdown. A
  // "No department" bucket appears only when some rows actually lack one.
  const deptOptions = useMemo(() => {
    const names = new Set<string>();
    let hasNone = false;
    for (const r of rows) {
      if (r.departmentName) names.add(r.departmentName);
      else hasNone = true;
    }
    const opts = [
      { value: '', label: 'All departments' },
      ...[...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n })),
    ];
    if (hasNone) opts.push({ value: NO_DEPT, label: 'No department' });
    return opts;
  }, [rows]);

  // Drop a stale department filter when switching tabs re-scopes the queue.
  useEffect(() => { setDeptFilter(''); }, [processor]);

  const filtered = useMemo(() => {
    let list = rows;
    if (deptFilter) {
      list =
        deptFilter === NO_DEPT
          ? list.filter((r) => !r.departmentName)
          : list.filter((r) => r.departmentName === deptFilter);
    }
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q) ||
        (r.bankPreferredRaw ?? '').toLowerCase().includes(q) ||
        (r.departmentName ?? '').toLowerCase().includes(q) ||
        // Let the clerk pull up contractor rows by typing "contractor" or an
        // invoice number.
        (showsContractorBadge(r) && 'contractor'.includes(q)) ||
        (r.invoiceNumber ?? '').toLowerCase().includes(q),
    );
  }, [rows, debouncedQuery, deptFilter]);

  // Keep the live filtered list in a ref so `handleOpenRow` stays referentially
  // stable — otherwise every keystroke would invalidate the memoized rows and
  // re-render all ~1000 of them. The ref is read lazily, only on click.
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const handleOpenRow = useCallback(
    (row: QueueRow) => {
      const list = filteredRef.current;
      const index = list.findIndex((r) => r.id === row.id);
      onMarkPaid(row, { siblings: list, index: index < 0 ? 0 : index });
    },
    [onMarkPaid],
  );

  const totalUSD = filtered.reduce((sum, r) => sum + (r.amountUSD ?? 0), 0);
  const totalPHP = filtered.reduce((sum, r) => sum + (r.amountPHP ?? 0), 0);
  const totalCOP = filtered.reduce((sum, r) => sum + (r.amountCOP ?? 0), 0);
  const totalOT = filtered.reduce((sum, r) => sum + (r.otHours ?? 0), 0);
  const isCop = nativeCurrency === 'COP';
  const headlineTotal = isCop ? formatCOP(totalCOP) : formatUSD(totalUSD);
  const allAmountsNull =
    filtered.length > 0 && filtered.every((r) => (isCop ? r.amountCOP == null : r.amountUSD == null));

  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => { setPage(1); }, [debouncedQuery, processor, deptFilter]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const pagedRows = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-orange-100/80 bg-gradient-to-r from-white via-orange-50/40 to-white px-4 py-3 sm:px-6 sm:py-4 dark:border-zinc-800 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-white">
              {processor ? meta?.label : allLabel?.title ?? 'All pending payments'}
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              {view === 'paid'
                ? `Payments already sent via ${meta?.label ?? 'this processor'} this cycle. Undo sends them back to pending.`
                : view === 'not_paid'
                  ? 'Dispatches logged as not paid this cycle — these people are still payable in the pending queue.'
                  : view === 'threshold'
                    ? 'Dispatches held below the payout threshold — still payable once cleared.'
                    : view === 'problem'
                      ? 'Dispatches flagged with a problem — pulled out of the pending queue. Clear one to send it back.'
                      : processor
                        ? `${meta?.blurb ?? ''} · send via ${meta?.label}, then mark paid`
                        : allLabel?.subtitle ?? 'Everything Lenny still has to dispatch this cycle.'}
            </p>
            {hasPaidView && (
              <div className="mt-2">
                <QueueViewTabs
                  view={view}
                  onChange={setView}
                  pendingCount={rows.length}
                  statusCounts={statusCounts}
                />
              </div>
            )}
          </div>
          {view === 'pending' && (
          <div className="flex flex-wrap items-center gap-2 text-xs sm:gap-3">
            <motion.span
              key={`count-${filtered.length}`}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-full border border-orange-100 bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-orange-700 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/20 dark:text-orange-300"
            >
              {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
            </motion.span>
            {!allAmountsNull && (
              <div className="flex items-baseline gap-2 rounded-md border border-orange-100 bg-white/80 px-2 py-0.5 backdrop-blur-md dark:border-orange-900/40 dark:bg-orange-950/20">
                <span className="font-mono text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                  {headlineTotal}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">
                  {formatPHP(totalPHP)}
                </span>
                {totalOT > 0 && (
                  <span className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    {totalOT.toFixed(1)} OT
                  </span>
                )}
              </div>
            )}
            {allAmountsNull && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400">
                Amounts pending pay calc
              </span>
            )}
            {onRefresh && (
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 text-[11px] font-semibold text-zinc-600 shadow-sm transition-colors hover:border-zinc-300 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800"
                title="Refresh this queue — surfaces rows sent back from Done"
              >
                <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
                Refresh
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (filtered.length === 0) return;
                const csv = pendingRowsToCsv(buildPendingRows(filtered));
                const filename = dispatchClientFilename({
                  prefix: 'pending',
                  processor: processor ?? 'all',
                  periodStart,
                  periodEnd,
                });
                downloadCsv(filename, csv);
                toast.success(`Exported ${filtered.length} ${filtered.length === 1 ? 'row' : 'rows'}`);
              }}
              disabled={filtered.length === 0}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-2.5 text-[11px] font-semibold text-emerald-700 shadow-sm transition-colors hover:border-emerald-300 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
              title={
                filtered.length === 0
                  ? 'Nothing to export — queue is empty for the current filter'
                  : `Export ${filtered.length} ${filtered.length === 1 ? 'row' : 'rows'} as CSV`
              }
            >
              <Download className="h-3 w-3" />
              Export CSV
            </button>
          </div>
          )}
        </div>

        {view === 'pending' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SearchBar
              value={query}
              onChange={setQuery}
              isSearching={isSearching}
              resultCount={filtered.length}
            />
            {deptOptions.length > 1 && (
              <SmoothSelect
                aria-label="Filter by department"
                value={deptFilter}
                onChange={setDeptFilter}
                triggerClassName="h-8 w-[13rem] text-[11px]"
                searchable={deptOptions.length > 8}
                searchPlaceholder="Search departments…"
                options={deptOptions}
              />
            )}
          </div>
        )}
      </div>

      {logStatus ? (
        <div className="min-h-0 flex-1">
          <PaidRecordsPanel
            records={paidRecords ?? []}
            statusFilter={logStatus}
            periodStart={periodStart}
            periodEnd={periodEnd}
            onRefresh={onRefresh ?? (() => {})}
            showProcessorColumn={false}
            csvPrefix="paid"
            csvProcessor={processor ?? undefined}
            emptyTitle={
              logStatus === 'paid'
                ? `No ${meta?.label ?? 'payments'} paid yet`
                : `Nothing logged here yet`
            }
            emptyHint={
              logStatus === 'paid'
                ? 'Mark a row paid in the Pending tab to see it here.'
                : 'Log a dispatch with this outcome from the Mark Paid dialog to see it here.'
            }
          />
        </div>
      ) : (
      <>
      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-white via-orange-50/10 to-white dark:from-[#0d1117] dark:via-[#0d1117] dark:to-[#0d1117]">
        {filtered.length > 0 && (
          <div
            className={cn(
              'sticky top-0 z-10 hidden items-center gap-3 border-b border-orange-100/80 bg-white/90 px-6 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90 dark:text-zinc-500 md:grid',
              rowGrid,
            )}
          >
            <span className="w-9" aria-hidden />
            <span>Person</span>
            <span>Department</span>
            {isAllView && <span>Bank Preferred</span>}
            <span className="text-right">Current pay</span>
            <span className="text-right">Hours</span>
            <span className="w-[9.875rem] text-right">Action</span>
          </div>
        )}

        <AnimatePresence mode="popLayout">
          {filtered.length === 0 ? (
            debouncedQuery.trim() || deptFilter ? (
              <NoMatchesState
                key="no-match"
                query={
                  debouncedQuery.trim() ||
                  (deptFilter === NO_DEPT ? 'No department' : deptFilter)
                }
                onClear={() => {
                  setQuery('');
                  setDeptFilter('');
                }}
              />
            ) : (
              <EmptyQueueState key="empty" processorLabel={meta?.label ?? null} />
            )
          ) : (
            <motion.ul
              key="list"
              initial="hidden"
              animate="visible"
              variants={{
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { staggerChildren: 0.025 } },
              }}
              className="divide-y divide-orange-100/70 dark:divide-zinc-800"
            >
              <AnimatePresence initial={false}>
                {pagedRows.map((row) => (
                  <QueueRowItem
                    key={row.id}
                    row={row}
                    isOpen={expanded === row.id}
                    isAllView={isAllView}
                    rowGrid={rowGrid}
                    onToggleExpand={handleToggleExpand}
                    onMarkPaid={handleOpenRow}
                    onViewPaystub={onViewPaystub}
                  />
                ))}
              </AnimatePresence>
            </motion.ul>
          )}
        </AnimatePresence>
        <QueuePagination
          page={page}
          pageCount={pageCount}
          total={filtered.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          label="people"
        />
      </div>
      </>
      )}
    </div>
  );
}

/**
 * Single queue row, memoized so the table doesn't re-render every row when
 * sibling parent state changes (e.g. opening Mark Paid dialog, the search
 * input typing, etc). Heavy: at ~1000 rows this is the difference between
 * a 16ms frame and a 200ms hitch when the modal opens.
 */
interface QueueRowItemProps {
  row: QueueRow;
  isOpen: boolean;
  isAllView: boolean;
  rowGrid: string;
  onToggleExpand: (id: string) => void;
  onMarkPaid: (row: QueueRow) => void;
  onViewPaystub?: (row: QueueRow) => void;
}

const QueueRowItem = React.memo(function QueueRowItem({
  row,
  isOpen,
  isAllView,
  rowGrid,
  onToggleExpand,
  onMarkPaid,
  onViewPaystub,
}: QueueRowItemProps) {
  const detailFields =
    PROCESSORS.find((p) => p.id === row.processor)?.detailFields ?? ['email'];

  return (
    <motion.li
      variants={{
        hidden: { opacity: 0, y: 6 },
        visible: {
          opacity: 1,
          y: 0,
          transition: { type: 'spring' as const, stiffness: 320, damping: 26 },
        },
      }}
      exit={{
        opacity: 0,
        x: 60,
        scale: 0.96,
        transition: { duration: 0.22 },
      }}
      className="bg-white/90 backdrop-blur-sm transition-colors hover:bg-orange-50/40 dark:bg-zinc-950/90 dark:hover:bg-zinc-900/50"
    >
      {/* Mobile: stacked card layout */}
      <div className="flex flex-col gap-2.5 px-3 py-3 md:hidden">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-sm',
              avatarColors(row.id),
            )}
            aria-hidden
          >
            {initials(row.name)}
          </div>
          <button
            type="button"
            onClick={() => onToggleExpand(row.id)}
            className="flex min-w-0 flex-1 items-start justify-between gap-2 text-left"
            aria-expanded={isOpen}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {row.name}
                </span>
                <motion.span
                  animate={{ rotate: isOpen ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="shrink-0 text-zinc-400"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </motion.span>
              </div>
              <div className="truncate font-mono text-[11px] text-zinc-500">{row.email}</div>
              {/* Badge must render even with no department, so the wrapper is
                  gated on either chip having something to show. */}
              {(row.departmentName || showsContractorBadge(row)) && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {showsContractorBadge(row) && <ContractorChip invoiceNumber={row.invoiceNumber} />}
                  <DeptChip name={row.departmentName} />
                </div>
              )}
            </div>
            <div className="shrink-0 text-right">
              <div
                className={cn(
                  'font-mono text-sm font-semibold tabular-nums',
                  rowPrimaryNull(row) ? 'text-zinc-400' : 'text-zinc-900 dark:text-zinc-100',
                )}
              >
                {rowPrimaryAmount(row)}
              </div>
              <div
                className={cn(
                  'font-mono text-[10.5px] tabular-nums',
                  row.amountPHP == null ? 'text-zinc-400' : 'text-zinc-500 dark:text-zinc-400',
                )}
              >
                {formatPHP(row.amountPHP)}
              </div>
              {row.bonusTotalPHP > 0 && (
                <div className="mt-1 flex justify-end">
                  <BonusChip row={row} />
                </div>
              )}
            </div>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pl-[2.875rem]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <BankCell processor={row.processor} bankPreferredRaw={row.bankPreferredRaw} />
            {row.totalHours != null && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className="font-mono tabular-nums text-zinc-600 dark:text-zinc-300">
                  {row.totalHours.toFixed(2)} hrs
                </span>
              </>
            )}
            {row.otHours != null && row.otHours > 0 && (
              <>
                <span className="text-zinc-300 dark:text-zinc-600">·</span>
                <span className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                  {row.otHours.toFixed(2)} OT
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {onViewPaystub && (
              <button
                type="button"
                onClick={() => onViewPaystub(row)}
                title="View pay statement"
                aria-label="View pay statement"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 active:scale-95 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
              >
                <Receipt className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onMarkPaid(row)}
              title="View payment details"
              aria-label="View payment details"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 active:scale-95 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            <Button
              size="sm"
              onClick={() => onMarkPaid(row)}
              className="h-8 gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-600 px-3 text-[11px] font-medium text-white shadow-sm shadow-emerald-500/30 hover:from-emerald-600 hover:to-teal-700 active:scale-95"
            >
              <Send className="h-3 w-3" />
              Mark paid
            </Button>
          </div>
        </div>
      </div>

      {/* Desktop: 5/6-column grid */}
      <div className={cn('hidden items-center gap-3 px-6 py-3 md:grid', rowGrid)}>
        <div
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br text-[11px] font-bold text-white shadow-sm',
            avatarColors(row.id),
          )}
          aria-hidden
        >
          {initials(row.name)}
        </div>

        <button
          type="button"
          onClick={() => onToggleExpand(row.id)}
          className="min-w-0 text-left"
          aria-expanded={isOpen}
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {row.name}
            </span>
            <motion.span
              animate={{ rotate: isOpen ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="shrink-0 text-zinc-400"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </motion.span>
          </div>
          <div className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-500">
            {row.email}
          </div>
        </button>

        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {showsContractorBadge(row) && <ContractorChip invoiceNumber={row.invoiceNumber} />}
          {row.departmentName ? (
            <DeptChip name={row.departmentName} />
          ) : (
            !showsContractorBadge(row) && (
              <span className="text-[11px] text-zinc-300 dark:text-zinc-600">—</span>
            )
          )}
        </div>

        {isAllView && (
          <div className="min-w-0">
            <BankCell processor={row.processor} bankPreferredRaw={row.bankPreferredRaw} />
          </div>
        )}

        <div className="text-right">
          <div
            className={cn(
              'font-mono text-sm font-semibold tabular-nums',
              rowPrimaryNull(row) ? 'text-zinc-400' : 'text-zinc-900 dark:text-zinc-100',
            )}
          >
            {rowPrimaryAmount(row)}
          </div>
          <div
            className={cn(
              'font-mono text-[11px] tabular-nums',
              row.amountPHP == null ? 'text-zinc-400' : 'text-zinc-500 dark:text-zinc-400',
            )}
          >
            {formatPHP(row.amountPHP)}
          </div>
          {row.bonusTotalPHP > 0 && (
            <div className="mt-1 flex justify-end">
              <BonusChip row={row} />
            </div>
          )}
        </div>

        <div className="text-right">
          <div
            className={cn(
              'font-mono text-sm font-semibold tabular-nums',
              row.totalHours == null ? 'text-zinc-400' : 'text-zinc-900 dark:text-zinc-100',
            )}
          >
            {row.totalHours != null ? row.totalHours.toFixed(2) : '—'}
            <span className="ml-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
              {row.totalHours != null ? 'hrs' : ''}
            </span>
          </div>
          <div
            className={cn(
              'font-mono text-[11px] tabular-nums',
              row.otHours != null && row.otHours > 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-zinc-400',
            )}
          >
            {row.otHours != null ? `${row.otHours.toFixed(2)} OT` : '—'}
          </div>
        </div>

        <div className="flex items-center justify-self-end gap-1.5">
          {onViewPaystub && (
            <button
              type="button"
              onClick={() => onViewPaystub(row)}
              title="View pay statement"
              aria-label="View pay statement"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 active:scale-95 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
            >
              <Receipt className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onMarkPaid(row)}
            title="View payment details"
            aria-label="View payment details"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 active:scale-95 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-orange-300"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <Button
            size="sm"
            onClick={() => onMarkPaid(row)}
            className="h-8 w-[7.5rem] gap-1.5 bg-gradient-to-br from-emerald-500 to-teal-600 px-3 text-[11px] font-medium text-white shadow-sm shadow-emerald-500/30 transition-transform hover:from-emerald-600 hover:to-teal-700 active:scale-95"
          >
            <Send className="h-3 w-3" />
            Mark paid
          </Button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="details"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-dashed border-orange-100 bg-gradient-to-b from-orange-50/40 to-white dark:border-zinc-800 dark:from-zinc-900/60 dark:to-zinc-950"
          >
            <div className="px-6 py-3">
              <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {detailFields.map((field) => {
                  const value =
                    field === 'email'
                      ? row.email
                      : ((row.details as Record<string, string | undefined>)[field] ?? '');
                  return (
                    <div key={field} className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                          {FIELD_LABELS[field] ?? field}
                        </div>
                        <div
                          className={cn(
                            'mt-0.5 truncate text-xs text-zinc-900 dark:text-zinc-100',
                            field === 'phone_number' && 'font-mono',
                          )}
                        >
                          {value || '—'}
                        </div>
                      </div>
                      {value && (
                        <button
                          type="button"
                          onClick={() => copy(String(value))}
                          className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-orange-100 hover:text-orange-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                          aria-label="Copy"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {row.bankPreferredRaw && /^x?\d{3,5}$/i.test(row.bankPreferredRaw.trim()) && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-400">
                  Account suffix in source:&nbsp;
                  <span className="font-mono">{row.bankPreferredRaw}</span>
                  &nbsp;· treat as manual wire
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
});

/**
 * Compact segmented control switching a processor tab between its Pending queue
 * and its Paid sub-view. Each segment carries a live count badge.
 */
/** Per-view color coding for the queue tab strip. Active text + count-pill
 *  colors mirror the status pills in the Mark Paid dialog so a clerk reads the
 *  same color for "problem" everywhere. */
const VIEW_TAB_STYLES: Record<
  QueueView,
  { label: string; activeText: string; activePill: string }
> = {
  pending: {
    label: 'Pending',
    activeText: 'bg-white text-orange-700 shadow-sm dark:bg-zinc-800 dark:text-orange-300',
    activePill: 'bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300',
  },
  paid: {
    label: 'Paid',
    activeText: 'bg-white text-emerald-700 shadow-sm dark:bg-zinc-800 dark:text-emerald-300',
    activePill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
  },
  not_paid: {
    label: 'Not paid',
    activeText: 'bg-white text-zinc-700 shadow-sm dark:bg-zinc-800 dark:text-zinc-200',
    activePill: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-600/40 dark:text-zinc-200',
  },
  threshold: {
    label: 'Threshold',
    activeText: 'bg-white text-amber-700 shadow-sm dark:bg-zinc-800 dark:text-amber-300',
    activePill: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  },
  problem: {
    label: 'Problem',
    activeText: 'bg-white text-rose-700 shadow-sm dark:bg-zinc-800 dark:text-rose-300',
    activePill: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  },
};

const VIEW_TAB_ORDER: QueueView[] = ['pending', 'paid', 'not_paid', 'threshold', 'problem'];

function QueueViewTabs({
  view,
  onChange,
  pendingCount,
  statusCounts,
}: {
  view: QueueView;
  onChange: (next: QueueView) => void;
  pendingCount: number;
  statusCounts: Record<PaymentDispatchStatus, number>;
}) {
  const countFor = (id: QueueView): number => (id === 'pending' ? pendingCount : statusCounts[id]);
  return (
    <div
      role="tablist"
      aria-label="Dispatch queue view"
      className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-orange-100 bg-orange-50/40 p-0.5 dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      {VIEW_TAB_ORDER.map((id) => {
        const active = view === id;
        const s = VIEW_TAB_STYLES[id];
        const count = countFor(id);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors',
              active
                ? s.activeText
                : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {s.label}
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                active ? s.activePill : 'bg-zinc-200/70 text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400',
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SearchBar({
  value,
  onChange,
  isSearching,
  resultCount,
}: {
  value: string;
  onChange: (next: string) => void;
  isSearching: boolean;
  resultCount: number;
}) {
  const hasQuery = value.length > 0;
  return (
    <div className="relative max-w-sm flex-1">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
      <Input
        placeholder="Search name, email, or bank"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 border-orange-100 bg-white pl-8 pr-20 text-xs focus-visible:ring-orange-200 dark:border-zinc-800 dark:bg-zinc-900"
        aria-label="Search dispatch queue"
      />

      {/* Right-side affordance: typing dots → result count → clear button */}
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <AnimatePresence mode="wait" initial={false}>
          {isSearching ? (
            <motion.div
              key="typing"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.15 }}
              className="flex items-center gap-1.5 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
              aria-live="polite"
              aria-label="Searching"
            >
              <TypingDots />
            </motion.div>
          ) : hasQuery ? (
            <motion.div
              key="count"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="font-mono text-[10px] tabular-nums text-zinc-400"
              aria-live="polite"
            >
              {resultCount}
            </motion.div>
          ) : null}
        </AnimatePresence>
        {hasQuery && (
          <button
            type="button"
            onClick={() => onChange('')}
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Three motion-driven dots used inside the search bar while debouncing. */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1 w-1 rounded-full bg-orange-500 dark:bg-orange-400"
          animate={{ y: [0, -2, 0], opacity: [0.4, 1, 0.4] }}
          transition={{
            duration: 0.9,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.12,
          }}
        />
      ))}
    </span>
  );
}

function NoMatchesState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-full items-center justify-center px-6 py-16 text-center"
    >
      <div>
        <motion.div
          initial={{ scale: 0.85 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 240, damping: 18 }}
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-200 to-zinc-300 text-zinc-600 shadow-sm dark:from-zinc-800 dark:to-zinc-700 dark:text-zinc-300"
        >
          <SearchX className="h-6 w-6" />
        </motion.div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">No matches</h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Nothing in this queue matches{' '}
          <span className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {query}
          </span>
          .
        </p>
        <button
          type="button"
          onClick={onClear}
          className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-white px-3 py-1 text-xs font-medium text-orange-700 transition-colors hover:bg-orange-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-orange-300 dark:hover:bg-zinc-800"
        >
          <X className="h-3 w-3" />
          Clear filters
        </button>
      </div>
    </motion.div>
  );
}

function EmptyQueueState({ processorLabel }: { processorLabel: string | null }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex h-full items-center justify-center px-6 py-16 text-center"
    >
      <div>
        <motion.div
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 240, damping: 18 }}
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md shadow-emerald-500/30"
        >
          <Sparkles className="h-6 w-6" />
        </motion.div>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Queue clear</h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          No pending payments {processorLabel ? `for ${processorLabel}` : ''}.
        </p>
      </div>
    </motion.div>
  );
}

export default React.memo(ProcessorQueue);
