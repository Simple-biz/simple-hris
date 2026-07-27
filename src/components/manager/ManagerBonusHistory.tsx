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
  X,
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
import { DEPARTMENTS, MANAGER_BONUS_DEPT_KEYS } from '@/lib/payroll/department-bonus';
import { normalizeDeptToKey } from '@/lib/payroll/normalize-dept-key';
import { slugifyDeptKey } from '@/lib/departments/registry';
import HslBonusReadyPreview from './HslBonusReadyPreview';
import { toast } from 'sonner';

// Bonus History spans two systems that share the same period model:
//   - HSL branches  -> hsl_bonus_entries (per-employee KPI rows)   [kind 'hsl']
//   - Catalog depts -> bonus_catalog_applied (applied catalog rows) [kind 'catalog']
// Status (draft/ready/locked) for BOTH lives in hsl_bonus_period_status.

type RowKind = 'hsl' | 'catalog';

interface UnifiedRow {
  kind: RowKind;
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
  // Catalog-only attribution: who applied the bonuses for this dept-week and
  // when. Null for HSL rows (the HSL schema doesn't track a per-week author).
  applied_by: string | null;
  applied_at: string | null;
}

interface HslSummaryRow {
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

interface ManagerBonusHistoryProps {
  viewerEmail: string | null;
  managedDepts: string[];
  isElevated: boolean;
}

// Catalog department colours (mirror DeptBonusCalculator's identity palette).
const CATALOG_DEPT_COLOR: Record<string, string> = {
  accounting: '#10b981',
  edit: '#3b82f6',
  devs: '#8b5cf6',
  lead_gen: '#f59e0b',
  callback: '#06b6d4',
  qc: '#f97316',
  discovery: '#14b8a6',
  hr: '#ec4899',
  sales: '#ef4444', // keep in lockstep with DeptBonusCalculator's DEPT_COLOR
  sales_assistant: '#6366f1',
  smm: '#d946ef',
  pm_team: '#0ea5e9',
  client_va: '#84cc16',
  site_building: '#64748b',
};

/** Unknown keys are in-app (Payment Catalog -> Department) departments whose
 *  slug derives from the label -- humanize it back ("executive_assistants" ->
 *  "Executive Assistants"). Already-human labels pass through unchanged. */
function humanizeDeptKey(key: string): string {
  return key.replace(/_+/g, ' ').replace(/(^|\s)[a-z]/g, (c) => c.toUpperCase());
}

function deptDisplay(kind: RowKind, department: string): { name: string; color: string | undefined } {
  if (kind === 'hsl') {
    const d = HSL_DEPTS[department as HslDeptKey];
    return { name: d?.name ?? department, color: d?.color };
  }
  const d = DEPARTMENTS.find((x) => x.key === department);
  return { name: d?.name ?? humanizeDeptKey(department), color: CATALOG_DEPT_COLOR[department] };
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
  if (!start) return '-';
  const s = new Date(start + 'T00:00:00');
  const e = end ? new Date(end + 'T00:00:00') : null;
  const sLabel = s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const yLabel = s.toLocaleDateString('en-US', { year: 'numeric' });
  if (!e) return `${sLabel}, ${yLabel}`;
  const eLabel = e.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${sLabel} - ${eLabel}, ${yLabel}`;
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

/** Absolute "when it was applied" stamp, e.g. "Jun 14, 3:42 PM". */
function formatAppliedAt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

/** Short, human name for an applier email (the part before @). */
function applierName(email: string | null): string {
  if (!email) return '';
  return email.split('@')[0];
}

export default function ManagerBonusHistory({
  viewerEmail: _viewerEmail,
  managedDepts,
  isElevated,
}: ManagerBonusHistoryProps) {
  const visibleHslDepts = useMemo<HslDeptKey[]>(
    () => HSL_DEPT_KEYS.filter((k) => canAccessHslDept(managedDepts, k, isElevated)),
    [managedDepts, isElevated],
  );

  const visibleCatalogDepts = useMemo<string[]>(() => {
    if (isElevated) return MANAGER_BONUS_DEPT_KEYS;
    const keys = new Set<string>();
    for (const d of managedDepts) {
      const k = normalizeDeptToKey(d);
      if (k && MANAGER_BONUS_DEPT_KEYS.includes(k)) {
        keys.add(k);
      } else if (!k && d && !d.includes(':')) {
        // Managed in-app (Payment Catalog -> Department) departments: their
        // applied rows are keyed by the slug of the label.
        const slug = slugifyDeptKey(d);
        if (slug) keys.add(slug);
      }
    }
    return Array.from(keys);
  }, [managedDepts, isElevated]);

  const [rows, setRows] = useState<UnifiedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<BonusStatus | 'all'>('all');

  const [viewing, setViewing] = useState<UnifiedRow | null>(null);
  const [viewingEntries, setViewingEntries] = useState<PreviewEntry[]>([]);
  const [hslEntries, setHslEntries] = useState<HslPreviewEntry[]>([]);
  const [viewingLoading, setViewingLoading] = useState(false);

  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  const fetchSummary = useMemo(() => {
    return async (showSpinner: boolean) => {
      if (visibleHslDepts.length === 0 && visibleCatalogDepts.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }
      if (showSpinner) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        // Status map (shared table) keyed by `${dept}::${period_start}`.
        const statusMap = new Map<string, { status: BonusStatus; locked_by: string | null; locked_at: string | null; updated_at: string | null }>();

        const [hslRes, catRes, statusRes] = await Promise.all([
          visibleHslDepts.length > 0
            ? fetch(`/api/hsl-bonus/period-summary?depts=${visibleHslDepts.join(',')}`, { cache: 'no-store' })
            : Promise.resolve(null),
          visibleCatalogDepts.length > 0
            ? fetch(`/api/bonus-catalog-applied?summary=1&depts=${visibleCatalogDepts.join(',')}`, { cache: 'no-store' })
            : Promise.resolve(null),
          fetch('/api/hsl-bonus/period-status', { cache: 'no-store' }),
        ]);

        if (statusRes) {
          const sj = (await statusRes.json()) as {
            rows?: { department: string; period_start: string; status: BonusStatus; locked_by: string | null; locked_at: string | null; updated_at: string | null }[];
          };
          for (const r of sj.rows ?? []) {
            statusMap.set(`${r.department}::${r.period_start}`, {
              status: r.status,
              locked_by: r.locked_by,
              locked_at: r.locked_at,
              updated_at: r.updated_at,
            });
          }
        }

        const out: UnifiedRow[] = [];

        if (hslRes) {
          const hj = (await hslRes.json()) as { rows?: HslSummaryRow[]; error?: string };
          if (hj.error) setError(hj.error);
          for (const r of hj.rows ?? []) out.push({ kind: 'hsl', ...r, applied_by: null, applied_at: null });
        }

        if (catRes) {
          const cj = (await catRes.json()) as {
            rows?: {
              department: string;
              period_start: string;
              period_end: string;
              employee_count: number;
              total_bonus: number;
              applied_by: string | null;
              applied_at: string | null;
            }[];
            error?: string;
          };
          if (cj.error) setError(cj.error);
          for (const r of cj.rows ?? []) {
            const st = statusMap.get(`${r.department}::${r.period_start}`);
            out.push({
              kind: 'catalog',
              department: r.department,
              period_type: 'weekly',
              period_start: r.period_start,
              period_end: r.period_end,
              status: st?.status ?? 'draft',
              updated_at: st?.updated_at ?? null,
              locked_by: st?.locked_by ?? null,
              locked_at: st?.locked_at ?? null,
              employee_count: r.employee_count,
              scored_count: r.employee_count,
              total_bonus: r.total_bonus,
              applied_by: r.applied_by ?? null,
              applied_at: r.applied_at ?? null,
            });
          }
        }

        out.sort((a, b) => (a.period_start < b.period_start ? 1 : a.period_start > b.period_start ? -1 : 0));
        setRows(out);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load history');
      } finally {
        if (showSpinner) setLoading(false);
        else setRefreshing(false);
      }
    };
  }, [visibleHslDepts, visibleCatalogDepts]);

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

  const handleDelete = async (row: UnifiedRow) => {
    const key = `${row.department}::${row.period_start}`;
    setDeletingKey(key);
    try {
      const url =
        row.kind === 'catalog'
          ? `/api/bonus-catalog-applied?dept=${row.department}&period_start=${row.period_start}`
          : `/api/hsl-bonus/period?dept=${row.department}&period_start=${row.period_start}`;
      const res = await fetch(url, { method: 'DELETE' });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? 'Delete failed');
      const { name } = deptDisplay(row.kind, row.department);
      toast.success(`${name} · ${formatRange(row.period_start, row.period_end)} deleted`);
      setConfirmDeleteKey(null);
      void fetchSummary(false);
    } catch (e) {
      toast.error('Delete failed', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setDeletingKey(null);
    }
  };

  const openView = async (row: UnifiedRow) => {
    setViewing(row);
    setViewingEntries([]);
    setViewingLoading(true);
    try {
      if (row.kind === 'catalog') {
        const res = await fetch(
          `/api/bonus-catalog-applied?dept=${row.department}&period_start=${row.period_start}`,
          { cache: 'no-store' },
        );
        const json = (await res.json()) as {
          rows?: {
            employee_email: string;
            employee_name: string | null;
            bonus_name: string;
            kind: 'flat' | 'formula';
            vars: Record<string, number> | null;
            amount: number | string | null;
          }[];
        };
        // Group applied rows by employee.
        const byEmail = new Map<string, PreviewEntry>();
        for (const r of json.rows ?? []) {
          const em = r.employee_email;
          let e = byEmail.get(em);
          if (!e) {
            e = { employee_email: em, employee_name: r.employee_name ?? em, items: [], total: 0 };
            byEmail.set(em, e);
          }
          const amt = r.amount == null ? 0 : Number(r.amount);
          e.items.push({ bonusName: r.bonus_name, kind: r.kind, vars: r.vars, amount: amt });
          e.total += amt;
        }
        const entries = Array.from(byEmail.values()).sort((a, b) =>
          a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }),
        );
        setViewingEntries(entries);
      } else {
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
        const entries: HslPreviewEntry[] = (json.rows ?? []).map((r) => ({
          employee_email: r.employee_email,
          employee_name: r.employee_name ?? r.employee_email,
          is_manager: r.is_manager,
          kpi_data: r.kpi_data ?? {},
          calculated_bonus: r.calculated_bonus ?? 0,
        }));
        entries.sort((a, b) =>
          a.employee_name.localeCompare(b.employee_name, undefined, { sensitivity: 'base' }),
        );
        setHslEntries(entries);
      }
    } catch {
      setViewingEntries([]);
      setHslEntries([]);
    } finally {
      setViewingLoading(false);
    }
  };

  if (visibleHslDepts.length === 0 && visibleCatalogDepts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
        <HistoryIcon className="h-10 w-10 text-zinc-300 dark:text-zinc-700" aria-hidden />
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          No bonus departments assigned to you.
        </p>
        <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">
          Once an admin assigns you, your past KPI weeks will show up here.
        </p>
      </div>
    );
  }

  const filterChips: { key: string; label: string; color?: string }[] = [
    ...visibleHslDepts.map((k) => ({ key: k, label: HSL_DEPTS[k].name, color: HSL_DEPTS[k].color })),
    ...visibleCatalogDepts.map((k) => ({
      key: k,
      label: DEPARTMENTS.find((d) => d.key === k)?.name ?? humanizeDeptKey(k),
      color: CATALOG_DEPT_COLOR[k],
    })),
  ];

  return (
    <div className="flex min-h-0 flex-col bg-gradient-to-b from-white via-blue-50/20 to-white text-zinc-900 dark:from-black dark:via-blue-950/15 dark:to-black dark:text-zinc-100">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 bg-white/90 px-5 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/90">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            Bonus History
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
            <FilterChip label="All depts" active={deptFilter === 'all'} onClick={() => setDeptFilter('all')} />
            {filterChips.map((c) => (
              <FilterChip
                key={c.key}
                label={c.label}
                active={deptFilter === c.key}
                onClick={() => setDeptFilter(c.key)}
                color={c.color}
              />
            ))}
          </div>
          <span className="hidden h-4 w-px bg-zinc-200 dark:bg-zinc-700 sm:block" />
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip label="All status" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
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
                const { name, color } = deptDisplay(row.kind, row.department);
                const palette = STATUS_PALETTE[row.status];
                const StatusIcon = palette.Icon;
                const rowKey = `${row.kind}-${row.department}-${row.period_start}`;
                return (
                  <motion.li
                    key={rowKey}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(idx * 0.018, 0.18), ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-950/60 dark:hover:border-zinc-700"
                    style={color ? { borderLeft: `3px solid ${color}` } : undefined}
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
                          <span className="font-medium" style={color ? { color } : undefined}>
                            {name}
                          </span>
                          <span className="text-zinc-300 dark:text-zinc-700">·</span>
                          <span>
                            {row.scored_count}/{row.employee_count} scored
                          </span>
                          {row.applied_by && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span>
                                added by{' '}
                                <span className="font-medium text-zinc-700 dark:text-zinc-300">
                                  {applierName(row.applied_by)}
                                </span>
                                {row.applied_at && ` · ${formatAppliedAt(row.applied_at)}`}
                              </span>
                            </>
                          )}
                          {row.updated_at && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span>updated {formatLastUpdated(row.updated_at)}</span>
                            </>
                          )}
                          {row.locked_by && row.status === 'locked' && (
                            <>
                              <span className="text-zinc-300 dark:text-zinc-700">·</span>
                              <span className="font-mono text-[10px]">locked by {row.locked_by.split('@')[0]}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="font-mono text-[15px] font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatPeso(row.total_bonus)}
                        </div>
                        <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">total bonus</div>
                      </div>

                      <RowActions
                        confirmingDelete={confirmDeleteKey === `${row.department}::${row.period_start}`}
                        deleting={deletingKey === `${row.department}::${row.period_start}`}
                        onView={() => void openView(row)}
                        onAskDelete={() => setConfirmDeleteKey(`${row.department}::${row.period_start}`)}
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

      {/* HSL preview (existing) */}
      <HslBonusReadyPreview
        open={viewing !== null && viewing.kind === 'hsl'}
        dept={viewing && viewing.kind === 'hsl' ? HSL_DEPTS[viewing.department as HslDeptKey] ?? null : null}
        status={
          viewing && viewing.kind === 'hsl'
            ? viewing.status === 'draft'
              ? 'ready'
              : (viewing.status as 'ready' | 'locked')
            : 'ready'
        }
        periodLabel={viewing ? formatRange(viewing.period_start, viewing.period_end) : ''}
        entries={viewingLoading ? [] : hslEntries}
        onClose={() => {
          setViewing(null);
          setHslEntries([]);
        }}
      />

      {/* Catalog preview (new) */}
      <CatalogBonusPreview
        open={viewing !== null && viewing.kind === 'catalog'}
        deptName={viewing && viewing.kind === 'catalog' ? deptDisplay('catalog', viewing.department).name : ''}
        color={viewing && viewing.kind === 'catalog' ? deptDisplay('catalog', viewing.department).color : undefined}
        periodLabel={viewing ? formatRange(viewing.period_start, viewing.period_end) : ''}
        appliedBy={viewing && viewing.kind === 'catalog' ? viewing.applied_by : null}
        appliedAt={viewing && viewing.kind === 'catalog' ? viewing.applied_at : null}
        loading={viewingLoading}
        entries={viewingEntries}
        onClose={() => {
          setViewing(null);
          setViewingEntries([]);
        }}
      />
    </div>
  );
}

// -- Preview types --------------------------------------------------------------

interface HslPreviewEntry {
  employee_email: string;
  employee_name: string;
  is_manager: boolean;
  kpi_data: KpiData;
  calculated_bonus: number;
}

interface PreviewItem {
  bonusName: string;
  kind: 'flat' | 'formula';
  vars: Record<string, number> | null;
  amount: number;
}

interface PreviewEntry {
  employee_email: string;
  employee_name: string;
  items: PreviewItem[];
  total: number;
}

// -- Catalog preview modal ------------------------------------------------------

function CatalogBonusPreview({
  open,
  deptName,
  color,
  periodLabel,
  appliedBy,
  appliedAt,
  loading,
  entries,
  onClose,
}: {
  open: boolean;
  deptName: string;
  color: string | undefined;
  periodLabel: string;
  appliedBy: string | null;
  appliedAt: string | null;
  loading: boolean;
  entries: PreviewEntry[];
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const grand = entries.reduce((s, e) => s + e.total, 0);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-[2px] sm:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl dark:bg-zinc-950 sm:rounded-2xl"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex items-start justify-between gap-3 border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800"
              style={color ? { borderTop: `3px solid ${color}` } : undefined}
            >
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">{deptName}</h3>
                <p className="mt-0.5 text-[11px] text-zinc-500">{periodLabel} · applied catalog bonuses</p>
                {appliedBy && (
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    added by{' '}
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{applierName(appliedBy)}</span>
                    {appliedAt && ` · ${formatAppliedAt(appliedAt)}`}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              {loading ? (
                <p className="py-8 text-center text-sm text-zinc-400">Loading...</p>
              ) : entries.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-400">No bonuses applied this week.</p>
              ) : (
                <ul className="space-y-2">
                  {entries.map((e) => (
                    <li key={e.employee_email} className="rounded-lg border border-zinc-100 px-3 py-2 dark:border-zinc-800/70">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{e.employee_name}</span>
                        <span className="shrink-0 font-mono text-[13px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {formatPeso(e.total)}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {e.items.map((it, i) => (
                          <li key={i} className="flex items-center justify-between gap-2 text-[11.5px] text-zinc-500 dark:text-zinc-400">
                            <span className="truncate">
                              {it.bonusName}
                              {it.kind === 'formula' && it.vars && Object.keys(it.vars).length > 0 && (
                                <span className="ml-1 font-mono text-[10px] text-zinc-400">
                                  ({Object.entries(it.vars).map(([k, v]) => `${k}=${v}`).join(', ')})
                                </span>
                              )}
                            </span>
                            <span className="shrink-0 font-mono tabular-nums">{formatPeso(it.amount)}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
              <span className="text-[11px] uppercase tracking-wide text-zinc-500">{entries.length} employees</span>
              <span className="font-mono text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{formatPeso(grand)}</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Row-level action group: View + Delete with inline delete confirmation. */
function RowActions({
  confirmingDelete,
  deleting,
  onView,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
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
            <span className="text-[11px] font-medium text-rose-700 dark:text-rose-400">Delete this week?</span>
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={onCancelDelete} disabled={deleting}>
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
              {deleting ? 'Deleting...' : 'Yes, delete'}
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
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onView}>
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
    emerald: 'border-emerald-200/70 from-white to-emerald-50/40 dark:border-emerald-950/40 dark:from-zinc-950 dark:to-emerald-950/20',
    amber: 'border-amber-200/70 from-white to-amber-50/40 dark:border-amber-950/40 dark:from-zinc-950 dark:to-amber-950/20',
    zinc: 'border-zinc-200 from-white to-zinc-50/60 dark:border-zinc-800 dark:from-zinc-950 dark:to-zinc-900/40',
  };
  return (
    <div className={cn('rounded-lg border bg-gradient-to-br px-3 py-2 shadow-sm', toneCls[tone])}>
      <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
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
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />}
      {label}
    </button>
  );
}

function HistorySkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="flex items-center gap-3">
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-40 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" style={{ animationDelay: `${i * 60}ms` }} />
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
