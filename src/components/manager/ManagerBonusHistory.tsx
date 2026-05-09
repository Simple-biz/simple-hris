'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CalendarDays,
  CheckCircle2,
  Eye,
  History as HistoryIcon,
  Lock,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  BonusStatus,
  HSL_DEPTS,
  HSL_DEPT_KEYS,
  HslDeptKey,
  KpiData,
  canAccessHslDept,
  formatPeso,
} from '@/lib/hsl-bonus/schema';
import HslBonusReadyPreview from './HslBonusReadyPreview';
import { toast } from 'sonner';

interface SummaryRow {
  department: string;
  period_type: string;
  period_start: string;
  period_end: string;
  status: BonusStatus;
  updated_at: string | null;
  locked_by: string | null;
  locked_at: string | null;
  employee_count: number;
  scored_count: number;
  total_bonus: number;
}

interface PreviewEntry {
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

interface ManagerBonusHistoryProps {
  viewerEmail: string | null;
  managedDepts: string[];
  isElevated: boolean;
}

const STATUS_PALETTE: Record<
  BonusStatus,
  { label: string; bg: string; text: string; ring: string; Icon: typeof CheckCircle2 }
> = {
  draft: {
    label: 'Draft',
    bg: 'bg-zinc-100 dark:bg-zinc-800/60',
    text: 'text-zinc-600 dark:text-zinc-300',
    ring: 'ring-zinc-200/70 dark:ring-zinc-700/70',
    Icon: HistoryIcon,
  },
  ready: {
    label: 'Ready',
    bg: 'bg-amber-100 dark:bg-amber-950/40',
    text: 'text-amber-800 dark:text-amber-300',
    ring: 'ring-amber-300/60 dark:ring-amber-700/40',
    Icon: CheckCircle2,
  },
  locked: {
    label: 'Locked',
    bg: 'bg-emerald-100 dark:bg-emerald-950/40',
    text: 'text-emerald-800 dark:text-emerald-300',
    ring: 'ring-emerald-300/60 dark:ring-emerald-700/40',
    Icon: Lock,
  },
};

function formatRange(start: string, end: string): string {
  if (!start) return '—';
  const s = new Date(start + 'T00:00:00');
  const e = end ? new Date(end + 'T00:00:00') : null;
  const sLabel = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const yLabel = s.toLocaleDateString('en-US', { year: 'numeric' });
  if (!e) return `${sLabel}, ${yLabel}`;
  // Same month → "Apr 28 – May 4, 2026" stripped to "Apr 28 – May 4"
  const eLabel = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${sLabel} – ${eLabel}, ${yLabel}`;
}

function formatLastUpdated(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ManagerBonusHistory({
  viewerEmail,
  managedDepts,
  isElevated,
}: ManagerBonusHistoryProps) {
  const visibleDepts = useMemo<HslDeptKey[]>(
    () => HSL_DEPT_KEYS.filter((k) => canAccessHslDept(managedDepts, k, isElevated)),
    [managedDepts, isElevated],
  );

  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deptFilter, setDeptFilter] = useState<HslDeptKey | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<BonusStatus | 'all'>('all');

  const [viewing, setViewing] = useState<SummaryRow | null>(null);
  const [viewingEntries, setViewingEntries] = useState<PreviewEntry[]>([]);
  const [viewingLoading, setViewingLoading] = useState(false);

  // Inline delete confirmation per-row (keyed by `${dept}::${period_start}`).
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchSummary = useMemo(() => {
    return async (showSpinner: boolean) => {
      if (visibleDepts.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }
      if (showSpinner) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/hsl-bonus/period-summary?depts=${visibleDepts.join(',')}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as { rows?: SummaryRow[]; error?: string };
        if (json.error) setError(json.error);
        setRows(json.rows ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load history');
      } finally {
        if (showSpinner) setLoading(false);
        else setRefreshing(false);
      }
    };
  }, [visibleDepts]);

  useEffect(() => {
    void fetchSummary(true);
  }, [fetchSummary]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (deptFilter !== 'all' && r.department !== deptFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      return true;
    });
  }, [rows, deptFilter, statusFilter]);

  const stats = useMemo(() => {
    const ready = rows.filter((r) => r.status === 'ready').length;
    const locked = rows.filter((r) => r.status === 'locked').length;
    const draft = rows.filter((r) => r.status === 'draft').length;
    const total = rows.reduce((s, r) => s + r.total_bonus, 0);
    return { ready, locked, draft, total, count: rows.length };
  }, [rows]);

  const handleDelete = async (row: SummaryRow) => {
    const key = `${row.department}::${row.period_start}`;
    setDeletingKey(key);
    try {
      const res = await fetch(
        `/api/hsl-bonus/period?dept=${row.department}&period_start=${row.period_start}`,
        { method: 'DELETE' },
      );
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Delete failed');
      toast.success(
        `${HSL_DEPTS[row.department as HslDeptKey]?.name ?? row.department} · ${formatRange(
          row.period_start,
          row.period_end,
        )} deleted`,
      );
      setConfirmDeleteKey(null);
      void fetchSummary(false);
    } catch (e) {
      toast.error('Delete failed', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDeletingKey(null);
    }
  };

  const openView = async (row: SummaryRow) => {
    setViewing(row);
    setViewingEntries([]);
    setViewingLoading(true);
    try {
      const res = await fetch(
        `/api/hsl-bonus/entries?dept=${row.department}&period_start=${row.period_start}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as {
        rows?: {
          employee_email: string;
          employee_name: string | null;
          is_manager: boolean;
          kpi_data: KpiData | null;
          calculated_bonus: number | null;
        }[];
      };
      const entries: PreviewEntry[] = (json.rows ?? []).map((r) => ({
        employee_email: r.employee_email,
        employee_name: r.employee_name ?? r.employee_email,
        is_manager: r.is_manager,
        kpi_data: r.kpi_data ?? {},
        calculated_bonus: r.calculated_bonus ?? 0,
      }));
      // Sort employees alphabetically for stable presentation
      entries.sort((a, b) =>
        a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }),
      );
      setViewingEntries(entries);
    } catch {
      setViewingEntries([]);
    } finally {
      setViewingLoading(false);
    }
  };

  if (visibleDepts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <HistoryIcon className="h-10 w-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          No HSL bonus departments assigned to you.
        </p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          Once an admin assigns you, your past KPI weeks will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white text-zinc-900 dark:from-black dark:via-blue-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Bonus History · HSL
          </p>
          <h2 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Past KPI weeks
            <span className="ml-2 font-mono text-xs font-normal text-zinc-500">
              {stats.count} {stats.count === 1 ? 'period' : 'periods'} · {formatPeso(stats.total)} total
            </span>
          </h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void fetchSummary(false)}
          disabled={loading || refreshing}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <div className="flex flex-col gap-4 px-4 py-5 sm:px-6">
        {/* Stat strip */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Total" value={String(stats.count)} hint="weeks" />
          <StatTile label="Locked" value={String(stats.locked)} hint="finalized" tone="emerald" />
          <StatTile label="Ready" value={String(stats.ready)} hint="sent to accounting" tone="amber" />
          <StatTile label="Drafts" value={String(stats.draft)} hint="in progress" tone="zinc" />
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/40">
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
            Filters
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              label="All depts"
              active={deptFilter === 'all'}
              onClick={() => setDeptFilter('all')}
            />
            {visibleDepts.map((k) => (
              <FilterChip
                key={k}
                label={HSL_DEPTS[k].name}
                active={deptFilter === k}
                onClick={() => setDeptFilter(k)}
                color={HSL_DEPTS[k].color}
              />
            ))}
          </div>
          <span className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 sm:block" />
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip
              label="All status"
              active={statusFilter === 'all'}
              onClick={() => setStatusFilter('all')}
            />
            {(['draft', 'ready', 'locked'] as BonusStatus[]).map((s) => (
              <FilterChip
                key={s}
                label={STATUS_PALETTE[s].label}
                active={statusFilter === s}
                onClick={() => setStatusFilter(s)}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <HistorySkeleton />
        ) : error ? (
          <div className="rounded-xl border border-rose-200/80 bg-rose-50/60 px-4 py-6 text-center text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
            {error}
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/50 px-4 py-12 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
            <CalendarDays className="h-6 w-6 text-zinc-400" />
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              {rows.length === 0 ? 'No KPI weeks recorded yet' : 'No periods match the current filters'}
            </p>
            <p className="max-w-md text-[11.5px] text-zinc-500 dark:text-zinc-400">
              {rows.length === 0
                ? 'Open the KPI Calculator and save a week to start your history.'
                : 'Loosen the dept or status filter to see more.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {filteredRows.map((row, idx) => {
                const dept = HSL_DEPTS[row.department as HslDeptKey];
                const palette = STATUS_PALETTE[row.status];
                const StatusIcon = palette.Icon;
                return (
                  <motion.li
                    key={`${row.department}-${row.period_start}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.2,
                      delay: Math.min(idx * 0.018, 0.18),
                      ease: [0.22, 1, 0.36, 1],
                    }}
                    className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700"
                    style={dept ? { borderLeft: `3px solid ${dept.color}` } : undefined}
                  >
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                            {formatRange(row.period_start, row.period_end)}
                          </span>
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider ring-1 ring-inset',
                              palette.bg,
                              palette.text,
                              palette.ring,
                            )}
                          >
                            <StatusIcon className="h-2.5 w-2.5" />
                            {palette.label}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                          <span
                            className="font-medium"
                            style={dept ? { color: dept.color } : undefined}
                          >
                            {dept?.name ?? row.department}
                          </span>
                          <span className="text-zinc-300 dark:text-zinc-700">·</span>
                          <span>
                            {row.scored_count}/{row.employee_count} scored
                          </span>
                          {row.updated_at && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span>updated {formatLastUpdated(row.updated_at)}</span>
                            </>
                          )}
                          {row.locked_by && row.status === 'locked' && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span className="font-mono text-[10px]">
                                locked by {row.locked_by.split('@')[0]}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="font-mono text-[15px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatPeso(row.total_bonus)}
                        </div>
                        <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                          total bonus
                        </div>
                      </div>

                      <RowActions
                        row={row}
                        confirmingDelete={
                          confirmDeleteKey === `${row.department}::${row.period_start}`
                        }
                        deleting={deletingKey === `${row.department}::${row.period_start}`}
                        onView={() => void openView(row)}
                        onAskDelete={() =>
                          setConfirmDeleteKey(`${row.department}::${row.period_start}`)
                        }
                        onCancelDelete={() => setConfirmDeleteKey(null)}
                        onConfirmDelete={() => void handleDelete(row)}
                      />
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <HslBonusReadyPreview
        open={viewing !== null}
        dept={viewing ? HSL_DEPTS[viewing.department as HslDeptKey] ?? null : null}
        status={
          viewing
            ? viewing.status === 'draft'
              ? 'ready'
              : (viewing.status as 'ready' | 'locked')
            : 'ready'
        }
        periodLabel={viewing ? formatRange(viewing.period_start, viewing.period_end) : ''}
        entries={viewingLoading ? [] : viewingEntries}
        onClose={() => {
          setViewing(null);
          setViewingEntries([]);
        }}
      />

    </div>
  );
}

/** Row-level action group: View + Delete on every row regardless of status.
 *  Inline delete confirmation slides in to replace the buttons with Cancel /
 *  Yes-delete so the destructive action requires a deliberate second tap. */
function RowActions({
  row: _row,
  confirmingDelete,
  deleting,
  onView,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  row: SummaryRow;
  confirmingDelete: boolean;
  deleting: boolean;
  onView: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <AnimatePresence initial={false} mode="wait">
        {confirmingDelete ? (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14 }}
            className="flex items-center gap-1.5"
          >
            <span className="text-[11px] font-medium text-rose-700 dark:text-rose-400">
              Delete this week?
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={onCancelDelete}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 gap-1.5 bg-rose-600 text-xs text-white hover:bg-rose-500"
              onClick={onConfirmDelete}
              disabled={deleting}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleting ? 'Deleting…' : 'Yes, delete'}
            </Button>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.14 }}
            className="flex items-center gap-1.5"
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              onClick={onView}
            >
              <Eye className="h-3.5 w-3.5" />
              View
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 border-rose-200 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-950/30"
              onClick={onAskDelete}
              title="Delete this period"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  tone = 'blue',
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'blue' | 'emerald' | 'amber' | 'zinc';
}) {
  const toneCls: Record<NonNullable<typeof tone>, string> = {
    blue: 'border-blue-200/70 from-white to-blue-50/40 dark:border-blue-950/40 dark:from-zinc-950 dark:to-blue-950/20',
    emerald:
      'border-emerald-200/70 from-white to-emerald-50/40 dark:border-emerald-950/40 dark:from-zinc-950 dark:to-emerald-950/20',
    amber:
      'border-amber-200/70 from-white to-amber-50/40 dark:border-amber-950/40 dark:from-zinc-950 dark:to-amber-950/20',
    zinc: 'border-zinc-200 from-white to-zinc-50/60 dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900/40',
  };
  return (
    <div
      className={cn(
        'rounded-lg border bg-gradient-to-br px-3 py-2 shadow-sm',
        toneCls[tone],
      )}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
      <div className="font-mono text-[10px] text-zinc-500">{hint}</div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  color,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors',
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'bg-white text-zinc-600 ring-1 ring-zinc-200 hover:text-zinc-900 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800 dark:hover:text-zinc-200',
      )}
    >
      {color && (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      {label}
    </button>
  );
}

function HistorySkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, i) => (
        <li
          key={i}
          className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60"
        >
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1.5">
              <div
                className="h-3.5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800"
                style={{ animationDelay: `${i * 60}ms` }}
              />
              <div className="h-2.5 w-56 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
            </div>
            <div className="h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
            <div className="h-7 w-14 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />
          </div>
        </li>
      ))}
    </ul>
  );
}
