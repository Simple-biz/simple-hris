'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Search, Download, CheckCircle2, MinusCircle, AlertTriangle, ChevronLeft, ChevronRight, BadgeCheck, Plane,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TeamAvatar } from '@/components/team/team-ui';
import { cn } from '@/lib/utils';
import {
  type HubstaffMasterRow,
  HUBSTAFF_RECON_TONE,
  filterHubstaffReconRows,
  downloadHubstaffReconCsv,
} from '@/lib/payroll/hubstaff-reconciliation';

import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
/** Rows shown per page in the drill-down list. */
const PAGE_SIZE = 10;

/** The status buckets, in display order, with their tile styling. */
const STATUS_META: Array<{
  key: string;
  short: string;
  Icon: typeof CheckCircle2;
  chip: string;
  chipActive: string;
  badge: string;
}> = [
  {
    key: 'On Master & worked',
    short: 'Worked',
    Icon: CheckCircle2,
    chip: 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
    chipActive: 'border-emerald-400 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-200',
    badge: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900/50',
  },
  {
    key: 'On Master, no hours',
    short: 'No hours',
    Icon: MinusCircle,
    chip: 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900',
    chipActive: 'border-zinc-400 bg-zinc-100 text-zinc-800 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100',
    badge: 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  },
  {
    // No-hours but EXPECTED (no-Hubstaff dept or just hired) — not a gap.
    key: 'Exception',
    short: 'Exceptions',
    Icon: BadgeCheck,
    chip: 'border-indigo-200 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-900/50 dark:text-indigo-300 dark:hover:bg-indigo-950/40',
    chipActive: 'border-indigo-400 bg-indigo-50 text-indigo-800 dark:border-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200',
    badge: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200/70 dark:bg-indigo-950/40 dark:text-indigo-300 dark:ring-indigo-900/50',
  },
  {
    // No hours but excused by an APPROVED leave (current or upcoming).
    key: 'On Leave',
    short: 'On Leave',
    Icon: Plane,
    chip: 'border-sky-200 text-sky-700 hover:bg-sky-50 dark:border-sky-900/50 dark:text-sky-300 dark:hover:bg-sky-950/40',
    chipActive: 'border-sky-400 bg-sky-50 text-sky-800 dark:border-sky-700 dark:bg-sky-950/60 dark:text-sky-200',
    badge: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200/70 dark:bg-sky-950/40 dark:text-sky-300 dark:ring-sky-900/50',
  },
  {
    key: 'In Hubstaff, not on Master',
    short: 'Not on Master',
    Icon: AlertTriangle,
    chip: 'border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/40',
    chipActive: 'border-rose-400 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950/60 dark:text-rose-200',
    badge: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900/50',
  },
];

const BADGE_BY_STATUS = new Map(STATUS_META.map((m) => [m.key, m]));

function StatusBadge({ status }: { status: string }) {
  const meta = BADGE_BY_STATUS.get(status);
  const tone = HUBSTAFF_RECON_TONE[status] ?? 'neutral';
  const cls =
    meta?.badge ??
    (tone === 'ok'
      ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70 dark:bg-emerald-950/40 dark:text-emerald-300'
      : tone === 'warn'
        ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200/70 dark:bg-rose-950/40 dark:text-rose-300'
        : 'bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium',
        cls,
      )}
    >
      {meta?.short ?? status}
    </span>
  );
}

/**
 * Searchable drill-down modal behind the "Hubstaff ↔ Master matches" tile.
 * Shows the same reconciliation rows the CSV export produces — who's on the
 * master list and worked, who's on the list with no hours (and why), and who
 * logged hours but isn't on the directory — with a live search + status filter,
 * and an Export CSV button so the modal is a superset of the old ↓ shortcut.
 */
export default function HubstaffMasterMatchesModal({
  open,
  onOpenChange,
  rows,
  counts,
  periodLabel,
  csvFilename = 'hubstaff-master-reconciliation.csv',
  emptyHint,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: HubstaffMasterRow[];
  counts: {
    matched: number | null;
    masterOnly: number | null;
    hubstaffOnly: number | null;
    /** Expected no-hours rows (no-Hubstaff dept / just hired / on leave). Optional
     *  — derived from the rows when a caller doesn't supply it. */
    exceptions?: number | null;
  };
  /** Pay-period label for the header subtitle, e.g. "Jun 14 – 21, 2026". */
  periodLabel?: string | null;
  /** Filename used by the in-modal Export CSV button. */
  csvFilename?: string;
  /** Message shown when there are no rows at all (e.g. CEO snapshot not published yet). */
  emptyHint?: string;
}) {
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const scoped = useMemo(
    () => (statusFilter ? rows.filter((r) => r.status === statusFilter) : rows),
    [rows, statusFilter],
  );
  const list = useMemo(() => filterHubstaffReconRows(scoped, q), [scoped, q]);

  // 10 rows per page. Reset to page 1 whenever the filtered set changes (new
  // search, status chip, or fresh data) so we never land on an empty page.
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  useEffect(() => { setPage(1); }, [q, statusFilter, rows]);
  const pageRows = useMemo(
    () => list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [list, safePage],
  );

  // `counts.exceptions` is the TOTAL expected-no-hours tally (dept-exempt + just
  // hired + on leave). The modal splits that into two chips — "Exceptions" and
  // "On Leave" — so each chip's number must equal the rows it actually filters to.
  // Derive both from the rows by exact status, gated on the loaded state (null
  // exceptions count ⇒ payroll scope not loaded yet ⇒ show "—").
  const exceptionsFromRows = useMemo(
    () => rows.filter((r) => r.status === 'Exception').length,
    [rows],
  );
  const onLeaveFromRows = useMemo(
    () => rows.filter((r) => r.status === 'On Leave').length,
    [rows],
  );

  const countFor = (key: string): number | null => {
    if (key === 'On Master & worked') return counts.matched;
    if (key === 'On Master, no hours') return counts.masterOnly;
    if (key === 'In Hubstaff, not on Master') return counts.hubstaffOnly;
    if (key === 'Exception') return counts.exceptions == null ? null : exceptionsFromRows;
    if (key === 'On Leave') return counts.exceptions == null ? null : onLeaveFromRows;
    return null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex max-h-[88vh] flex-col">
          <DialogHeader className="shrink-0 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
            <DialogTitle className="text-lg">Hubstaff ↔ Master reconciliation</DialogTitle>
            <DialogDescription>
              Who&apos;s on the Global Master List and logged hours this payroll{periodLabel ? ` · ${periodLabel}` : ''}.
            </DialogDescription>
          </DialogHeader>

          {/* Status filter chips — click to scope the list; counts mirror the tile tooltip. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setStatusFilter(null)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                statusFilter === null
                  ? 'border-zinc-400 bg-zinc-100 text-zinc-800 dark:border-zinc-500 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900',
              )}
            >
              All
              <span className="font-mono tabular-nums opacity-70">{rows.length}</span>
            </button>
            {STATUS_META.map((m) => {
              const active = statusFilter === m.key;
              const c = countFor(m.key);
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setStatusFilter(active ? null : m.key)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                    active ? m.chipActive : m.chip,
                  )}
                >
                  <m.Icon className="h-3.5 w-3.5" />
                  {m.short}
                  <span className="font-mono tabular-nums opacity-70">
                    {c == null ? '—' : c.toLocaleString('en-US')}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search + export. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, email, department, reason…"
                className="h-9 pl-8 text-[13px]"
              />
            </div>
            <button
              type="button"
              onClick={() => downloadHubstaffReconCsv(list, csvFilename)}
              disabled={list.length === 0}
              title="Export the current view as CSV"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-3 text-[12.5px] font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-emerald-900/50 dark:bg-zinc-900 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {rows.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">
                {emptyHint ?? 'No reconciliation data for this cycle yet.'}
              </p>
            ) : list.length === 0 ? (
              <p className="py-12 text-center text-sm text-zinc-500">No one matches your search.</p>
            ) : (
              <ul className="space-y-1.5">
                {pageRows.map((r, i) => (
                  <li
                    key={`${r.workEmail || r.name}-${(safePage - 1) * PAGE_SIZE + i}`}
                    className="flex items-start gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
                  >
                    <TeamAvatar name={r.name} email={r.workEmail || r.personalEmail} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-zinc-900 dark:text-zinc-100">
                          {r.name || r.workEmail || '—'}
                        </span>
                        <StatusBadge status={r.status} />
                      </div>
                      <div className="truncate text-[11px] text-zinc-400">
                        {r.workEmail || r.personalEmail || '—'}
                        {r.department ? ` · ${formatDeptLabel(r.department)}` : ''}
                      </div>
                      {r.reason && (
                        <div className="mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                          {r.reason}
                        </div>
                      )}
                    </div>
                    <span className="w-16 shrink-0 pt-0.5 text-right text-[13px] font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                      {r.hours ? `${r.hours} h` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-200 px-5 py-3 text-[11px] text-zinc-400 dark:border-zinc-800">
            <span>
              {list.length === 0
                ? 'No rows'
                : `${(safePage - 1) * PAGE_SIZE + 1}–${Math.min(safePage * PAGE_SIZE, list.length)} of ${list.length}`}
              {list.length !== rows.length ? ` (of ${rows.length})` : ''} · hours logged this pay period.
            </span>
            {totalPages > 1 && (
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={safePage <= 1}
                  aria-label="Previous page"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="tabular-nums">{safePage} / {totalPages}</span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage >= totalPages}
                  aria-label="Next page"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-900"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
