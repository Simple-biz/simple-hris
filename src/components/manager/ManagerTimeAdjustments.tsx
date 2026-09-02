'use client';

/**
 * Manager → Time adjustments: the review workspace.
 *
 * ## Where the design comes from
 *
 * **Structure** is the design handoff in `references/design_handoff_time_adjustments/`:
 * the KPI row, the filter bar, the master-detail split (fixed table + docked detail
 * panel), one merged decision trail, "Showing N of M", the left-aligned filtered
 * empty state, skeleton rows over a live filter bar, and the 2dp hour fix.
 *
 * **Theme** is Accounting → MESA (`src/components/payroll/AccountingMesa.tsx`), in
 * blue instead of teal (Kane, 2026-09-02). That system is:
 *   - a soft tinted page wash in light mode, flat `#0d1117` in dark;
 *   - a gradient icon tile + tracked uppercase eyebrow + `text-2xl` heading;
 *   - stat tiles as separate `rounded-xl` cards with a `from-<hue>-50 to-white`
 *     gradient and a `font-mono tabular-nums` value;
 *   - a segmented control whose active pill is a gradient with white text;
 *   - `Card` + `CardHeader` chrome with hue-tinted borders and header fills;
 *   - a hue-tinted `thead`, hue-tinted row dividers and row hovers;
 *   - inputs focusing to `border-<hue>-500 ring-<hue>-500/20`.
 *
 * The tracked uppercase eyebrow is a defining part of that header and is here on
 * purpose. An earlier pass removed it as generic scaffolding; it came back with the
 * MESA theme, which is Kane's explicit call.
 *
 * ## Deliberate deviations from the handoff
 *
 * Each is forced by how this feature actually works rather than by taste (see
 * `docs/features/time-adjustment-requests.md`):
 *
 *  - **A `Countersign` segment exists.** The comp has no bucket for rows where the
 *    viewer is the NAMED SECOND APPROVER. There is deliberately no notification for
 *    being named (a new `employee_notifications.type` would mean restating a closed
 *    CHECK allowlist), so this tab is the discovery path. `defaultBucketFor` lands
 *    on it when something is owed.
 *  - **"Forward to accounting" is not a third button.** Approving IS forwarding, and
 *    the server refuses `manager_approve` without a `second_approver_email` drawn
 *    from that request's own team. So the picker is required and the approve button
 *    carries it.
 *  - **No bulk actions** (Kane, 2026-09-02). Each approval needs a per-request
 *    approver from that request's own team and there is no bulk endpoint, so a bulk
 *    approve could only work by applying one approver across teams.
 *  - **Evidence renders in true colour.** The design system wraps photography in
 *    `.grayscale`; this is *evidence for a pay decision*, and desaturating it
 *    degrades the thing the manager is being asked to judge.
 *  - **No "Target: under 2 days"** under the median. Nobody set that SLA, so the
 *    sub-line states the sample it is drawn from instead of inventing a policy.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  AlertCircle,
  CalendarClock,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter,
  ImageOff,
  Inbox,
  Loader2,
  Search,
  Undo2,
  X,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatDeptLabel } from '@/lib/departments/hsl-subdept';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SmoothSelect, type SmoothSelectOption } from '@/components/ui/smooth-select';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { useManagerCachedState } from '@/hooks/useManagerCachedState';
import { MANAGER_CACHE_KEYS } from '@/lib/manager/tab-cache';
import type { TimeAdjustmentRow } from '@/lib/supabase/time-adjustments';
import { fmtAdjustmentSegments } from '@/lib/supabase/time-adjustments';
import {
  EMPTY_QUEUE_PAYLOAD,
  EMPTY_TA_FILTERS,
  TA_BUCKET_LABEL,
  TA_BUCKET_ORDER,
  type TaBucket,
  type TaFilters,
  type TimeAdjustmentQueuePayload,
  bucketOfRequest,
  buildQueueKpis,
  countBuckets,
  decisionTrail,
  defaultBucketFor,
  deriveQueue,
  filterRequests,
  fmtAdjustmentHours,
  hasActiveTaFilter,
  periodOf,
  periodOptionsFrom,
  reasonLabel,
  reasonOptionsFrom,
  requestRef,
  rowStatusChip,
  taNeedsMyManagerDecision,
  taNeedsMySecondDecision,
} from '@/lib/manager/time-adjustment-queue';

type ApproverCandidate = { email: string; name: string | null };
type ApproverPool = { list: ApproverCandidate[]; department: string | null; loading: boolean };
const EMPTY_POOL: ApproverPool = { list: [], department: null, loading: true };

type DecideAction = 'manager_approve' | 'manager_deny' | 'second_approve' | 'second_deny';

/**
 * The detail opens in a MODAL (Kane, 2026-09-02), replacing the handoff's docked
 * side panel and the drawer that stood in for it below 1100px.
 *
 * Why this is not the "modal as first thought" reflex: the inline panel was built,
 * shipped and looked at first, and it cost real things. It took 400px out of the
 * table, which forced Reason and Submitted to stand down through the whole
 * 1100-1399px band just to keep the Employee cell legible, and it capped evidence
 * at ~350px on the surface whose entire job is judging a photograph. Every record
 * detail on this dashboard is already a dialog (`ManagerMemberDialog`,
 * `ManagerTransferDialog`, `MesaReceiptDialog`), so the modal is also the
 * consistent choice, not the lazy one. The table now keeps all six columns at every
 * width and the `compact` machinery is gone.
 *
 * The animation is the shared primitive's, not a bespoke one: 320ms on
 * `cubic-bezier(0.22,1,0.36,1)`, fade + `zoom-in-[0.94]` + a 6px rise, closing
 * faster at 180ms. It honours `prefers-reduced-motion` through tw-animate-css.
 *
 * `DialogContent` declares **no max-height** and is centred with
 * `-translate-y-1/2`, so a tall `p-0` dialog is clipped at BOTH ends and its footer
 * becomes unreachable — there is no page scroll to recover it. All four rules from
 * `docs/design/responsive-design.md` § "Dialogs and modals" are applied below: the
 * `dvh` cap, `gap-0`, a width re-declared at `sm:` (the base `sm:max-w-sm` beats any
 * base-only override), and `flex flex-col` with `shrink-0` chrome around one
 * `min-h-0 flex-1 overflow-y-auto` body. See `memory/dialog-content-no-height-cap`.
 */

// ── Small shared pieces ───────────────────────────────────────────────────────

/** MESA's uppercase micro-label. Labels a VALUE, never scaffolds a heading. */
function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * MESA's tinted-pill vocabulary. The accent is reserved for what needs action and
 * everything resolved reads neutral, so the queue triages at a glance.
 */
const CHIP_TONE = {
  action:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200',
  flight:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200',
  resolved:
    'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300',
} as const;

function StatusChip({
  label,
  tone,
  className,
}: {
  label: string;
  tone: keyof typeof CHIP_TONE;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        CHIP_TONE[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}

/**
 * Evidence `<img>` with a shimmer until it actually decodes. Keyed on `src` so
 * switching the featured image re-shows the skeleton rather than flashing the
 * previous photo.
 */
function EvidenceImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
        className={cn(className, !loaded && 'opacity-0')}
      />
    </>
  );
}

// ── Stat tiles ────────────────────────────────────────────────────────────────

/**
 * MESA's `StatCard`, in blue: a `rounded-xl` tile with a hue gradient, an uppercase
 * label at 70% opacity and a `font-mono tabular-nums` value. The `sub` line is this
 * surface's addition — the handoff's KPI cells each carry one and it is real
 * information, not decoration.
 *
 * Only the blue tile is accented. It is the manager's actual to-do number, and it
 * counts BOTH approver hats because that is what the sidebar badge means too.
 */
function StatTile({
  label,
  value,
  sub,
  tone,
  settled,
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'blue' | 'zinc';
  settled: boolean;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const styles = {
    blue: 'border-blue-200 bg-gradient-to-br from-blue-50 to-white text-blue-900 dark:border-blue-700/40 dark:from-blue-950/40 dark:to-zinc-950 dark:text-blue-100',
    zinc: 'border-zinc-200 bg-white text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-100',
  }[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, 'aria-label': ariaLabel } : {})}
      className={cn(
        'rounded-xl border p-4 text-left shadow-sm',
        styles,
        onClick &&
          'transition-colors hover:border-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:hover:border-blue-600/60',
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</p>
      {settled ? (
        <p className="mt-1 font-mono text-2xl font-bold tabular-nums">{value}</p>
      ) : (
        <Skeleton className="mt-1 h-8 w-14" />
      )}
      <p className="mt-0.5 text-[11px] opacity-70">{sub}</p>
    </Tag>
  );
}

// ── Segmented control ────────────────────────────────────────

/** MESA's `ViewTabButton`, in blue: gradient pill, white label when active. */
function SegmentButton({
  active,
  onClick,
  label,
  count,
  accentCount,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  accentCount: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors duration-200',
        active
          ? 'text-white'
          : 'text-zinc-600 hover:bg-blue-50/70 hover:text-blue-700 dark:text-zinc-400 dark:hover:bg-blue-950/40 dark:hover:text-blue-200',
      )}
    >
      {active && (
        <motion.span
          layoutId="mgr-ta-segment-pill"
          aria-hidden
          className="absolute inset-0 rounded-md bg-gradient-to-r from-blue-500 to-sky-500 shadow-sm"
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        />
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5">
        {label}
        {count > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 py-px text-[10px] font-bold tabular-nums',
              active
                ? 'bg-white/25 text-white'
                : accentCount
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200'
                  : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
            )}
          >
            {count}
          </span>
        )}
      </span>
    </button>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

function QueueFilterBar({
  filters,
  onChange,
  counts,
  reasonCodes,
  periods,
}: {
  filters: TaFilters;
  onChange: (next: TaFilters) => void;
  counts: ReturnType<typeof countBuckets>;
  reasonCodes: string[];
  periods: string[];
}) {
  const reasonOptions: SmoothSelectOption[] = [
    { value: 'all', label: 'All reasons' },
    ...reasonCodes.map((c) => ({ value: c, label: reasonLabel(c) })),
  ];
  const periodOptions: SmoothSelectOption[] = [
    { value: 'all', label: 'All periods' },
    ...periods.map((p) => ({ value: p, label: p })),
  ];
  const segments: Array<{ id: TaBucket | 'all'; label: string; count: number }> = [
    { id: 'all', label: 'All', count: counts.all },
    ...TA_BUCKET_ORDER.map((b) => ({ id: b, label: TA_BUCKET_LABEL[b], count: counts[b] })),
  ];

  return (
    <div className="space-y-3">
      {/* MESA's view switcher: a bordered, backdrop-blurred rail whose active pill
          is a blue gradient with a white label. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div
          role="tablist"
          aria-label="Request queues"
          className="inline-flex items-center gap-1 rounded-lg border border-blue-100/80 bg-white/70 p-1 shadow-sm backdrop-blur dark:border-blue-900/40 dark:bg-zinc-900/60"
        >
          {segments.map((seg) => (
            <SegmentButton
              key={seg.id}
              active={filters.bucket === seg.id}
              onClick={() => onChange({ ...filters, bucket: seg.id })}
              label={seg.label}
              count={seg.count}
              accentCount={seg.id === 'needs-you' || seg.id === 'countersign'}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Capped: unbounded, the search stretches the full content width on a wide
            screen and strands the funnel icon against the selects. */}
        <div className="relative min-w-[200px] flex-1 sm:max-w-md">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="search"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Search employee, reason or note"
            aria-label="Search time adjustment requests"
            className="h-9 w-full rounded-lg border border-zinc-200 bg-white pl-9 pr-9 text-sm text-zinc-900 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:placeholder:text-zinc-400"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => onChange({ ...filters, query: '' })}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Filter aria-hidden className="h-3.5 w-3.5 text-zinc-400" />
          <SmoothSelect
            value={filters.reason}
            options={reasonOptions}
            onChange={(v) => onChange({ ...filters, reason: v })}
            aria-label="Filter by reason"
            triggerClassName="h-9 w-44"
          />
          <SmoothSelect
            value={filters.period}
            options={periodOptions}
            onChange={(v) => onChange({ ...filters, period: v })}
            aria-label="Filter by pay period"
            triggerClassName="h-9 w-36"
          />

          {hasActiveTaFilter(filters) && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_TA_FILTERS)}
              className="h-9 rounded-lg px-3 text-xs font-semibold text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────────

function QueueSkeletonRows({ rows = 7 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td className="px-4 py-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-1.5 w-1.5 rounded-full" />
              <Skeleton className="h-3.5 w-40 max-w-full" />
            </div>
          </td>
          <td className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </td>
          <td className="hidden px-4 py-3 md:table-cell">
            <Skeleton className="h-3.5 w-44 max-w-full" />
          </td>
          <td className="px-4 py-3">
            <Skeleton className="ml-auto h-3.5 w-12" />
          </td>
          <td className="hidden px-4 py-3 lg:table-cell">
            <Skeleton className="h-3.5 w-20" />
          </td>
          <td className="px-4 py-3">
            <Skeleton className="h-4 w-28 max-w-full" />
          </td>
        </tr>
      ))}
    </>
  );
}

function RequestTable({
  rows,
  managedIds,
  viewerEmail,
  openId,
  onOpen,
  settled,
  total,
  filtered,
  onClearFilters,
}: {
  rows: TimeAdjustmentRow[];
  managedIds: ReadonlySet<string>;
  viewerEmail: string;
  openId: string | null;
  onOpen: (id: string) => void;
  settled: boolean;
  /** Unfiltered row count, for the "Showing N of M" line in the card header. */
  total: number;
  /** Whether any filter is active — decides WHICH empty state the card shows. */
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const empty = settled && rows.length === 0;
  return (
    <Card className="gap-0 overflow-hidden border border-blue-100/80 py-0 shadow-sm dark:border-blue-900/40">
      <CardHeader className="gap-0 border-b border-blue-100/80 bg-blue-50/30 px-5 py-3 dark:border-blue-900/40 dark:bg-blue-950/20">
        <CardTitle className="text-sm font-semibold text-zinc-900 dark:text-white">
          Requests
          {settled && (
            <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
              Showing {rows.length.toLocaleString()} of {total.toLocaleString()}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {empty ? (
          filtered ? (
            <div className="px-5 py-12">
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                No requests match these filters
              </h3>
              <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
                Try clearing the search or widening the period.
              </p>
              <button
                type="button"
                onClick={onClearFilters}
                className="mt-3 inline-flex items-center rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-center">
              <Inbox aria-hidden className="h-6 w-6 text-zinc-400" />
              <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                No time adjustment requests yet
              </p>
              <p className="max-w-[46ch] text-xs text-zinc-500 dark:text-zinc-400">
                When someone on your team files one from their My Hours calendar, it lands
                here with their evidence attached and waits for your decision.
              </p>
            </div>
          )
        ) : (
      <div className="overflow-x-auto">
        {/*
          Widths live on the header cells, not a `<colgroup>`: a `<col>` carrying a
          responsive `hidden` still reserves its track in some engines.

          Below 640px this table is NOT a table. `src/index.css` collapses every
          `<table>` in the app into stacked label/value cards at that width, taking
          its labels from `data-label` — so each cell carries one, and the columns
          hidden in the middle bands come back on a phone rather than being lost.
          That global rule sets `display:flex` on every `td`, which is why a
          Tailwind `hidden` cannot be relied on to remove a cell down there.
        */}
        <table className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-blue-100/80 bg-blue-50/40 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
            <tr>
              <th scope="col" className="px-4 py-2.5">
                Employee
              </th>
              <th scope="col" className="w-[112px] px-4 py-2.5">
                Work date
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 md:table-cell"
              >
                Reason
              </th>
              <th scope="col" className="w-[84px] px-4 py-2.5 text-right">
                Hours
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2.5 lg:table-cell lg:w-[112px]"
              >
                Submitted
              </th>
              <th scope="col" className="w-[132px] px-4 py-2.5 md:w-[184px]">
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-blue-100/60 dark:divide-blue-900/40">
            {!settled && rows.length === 0 ? (
              <QueueSkeletonRows />
            ) : (
              rows.map((row) => {
                const chip = rowStatusChip(row, managedIds, viewerEmail);
                const open = openId === row.id;
                return (
                  <tr
                    key={row.id}
                    onClick={() => onOpen(row.id)}
                    aria-current={open ? 'true' : undefined}
                    className={cn(
                      'cursor-pointer transition-colors',
                      open
                        ? 'bg-blue-50/60 shadow-[inset_2px_0_0_var(--color-blue-500)] dark:bg-blue-950/30'
                        : 'hover:bg-blue-50/40 dark:hover:bg-blue-950/20',
                    )}
                  >
                    <td data-label="Employee" className="px-4 py-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            chip.tone === 'action'
                              ? 'bg-blue-500'
                              : chip.tone === 'flight'
                                ? 'bg-amber-400'
                                : 'bg-zinc-300 dark:bg-zinc-600',
                          )}
                        />
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen(row.id);
                            }}
                            className="block w-full truncate rounded text-left text-[13px] font-medium text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 dark:text-zinc-100"
                          >
                            {row.work_email}
                          </button>
                          {/* 640-767px only: the Reason column is dropped there for
                              room, and below 640 the stacked card shows it with its
                              own label, so this line would be a duplicate. */}
                          <div className="hidden truncate text-[11px] text-zinc-500 sm:block md:hidden dark:text-zinc-400">
                            {reasonLabel(row.reason)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td
                      data-label="Work date"
                      className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-zinc-500 dark:text-zinc-400"
                    >
                      {row.adjust_date}
                    </td>
                    <td
                      data-label="Reason"
                          className="hidden truncate px-4 py-3 text-zinc-600 md:table-cell dark:text-zinc-400"
                    >
                      {reasonLabel(row.reason)}
                    </td>
                    <td
                      data-label="Hours"
                      className="px-4 py-3 text-right font-mono text-[12px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
                    >
                      {fmtAdjustmentHours(row.requested_hours)}
                    </td>
                    <td
                      data-label="Submitted"
                          className="hidden whitespace-nowrap px-4 py-3 font-mono text-[11px] text-zinc-500 lg:table-cell dark:text-zinc-400"
                    >
                      {(row.created_at ?? '').slice(0, 10)}
                    </td>
                    <td data-label="Status" className="px-4 py-3">
                      <StatusChip label={chip.label} tone={chip.tone} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function TrailList({ row }: { row: TimeAdjustmentRow }) {
  const trail = decisionTrail(row);
  if (trail.length === 0) return null;
  return (
    <div>
      <FieldLabel className="mb-2">Decision trail</FieldLabel>
      <ol className="space-y-0">
        {trail.map((entry, i) => (
          <li
            key={`${entry.at}-${i}`}
            className="grid grid-cols-[84px_1fr] gap-2.5 border-b border-blue-100/60 py-1.5 last:border-b-0 dark:border-blue-900/40"
          >
            <span className="whitespace-nowrap font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              {entry.at.slice(0, 10)}
            </span>
            <span className="text-[13px] text-zinc-600 dark:text-zinc-300">
              <strong className="font-semibold text-zinc-900 dark:text-zinc-100">
                {entry.who}
              </strong>{' '}
              {entry.what}
              {entry.note && (
                <span className="mt-0.5 block text-[11px] italic text-zinc-500 dark:text-zinc-400">
                  &ldquo;{entry.note}&rdquo;
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function EvidenceBlock({
  row,
  signedUrls,
  onImageClick,
}: {
  row: TimeAdjustmentRow;
  signedUrls: Record<string, string>;
  onImageClick: (urls: string[], idx: number) => void;
}) {
  const [active, setActive] = useState(0);
  const urls = row.image_paths.map((p) => signedUrls[p]).filter(Boolean) as string[];
  // A different request is a different set of images; keep the index in range.
  const idx = Math.min(active, Math.max(urls.length - 1, 0));
  const featured = urls[idx] ?? null;

  return (
    <div>
      <FieldLabel className="mb-2">
        Proof attached
        {urls.length > 0 && (
          <span className="ml-1 font-normal normal-case tracking-normal text-zinc-400">
            ({urls.length})
          </span>
        )}
      </FieldLabel>
      {featured ? (
        <div className="group relative aspect-square w-full overflow-hidden rounded-xl border border-blue-100/80 bg-zinc-100 max-sm:max-w-[320px] dark:border-blue-900/40 dark:bg-zinc-900">
          <button
            type="button"
            onClick={() => onImageClick(urls, idx)}
            className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
            aria-label="View evidence full size"
          >
            <EvidenceImage
              src={featured}
              alt={`Evidence ${idx + 1} of ${urls.length}`}
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
            <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/20" />
          </button>
          <span className="pointer-events-none absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium text-white">
            <Camera aria-hidden className="h-3 w-3" />
            Proof
          </span>
          {urls.length > 1 && (
            <>
              <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white">
                {idx + 1}/{urls.length}
              </span>
              <button
                type="button"
                onClick={() => setActive((i) => (i - 1 + urls.length) % urls.length)}
                aria-label="Previous evidence image"
                className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1 text-white transition-colors hover:bg-black/75"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setActive((i) => (i + 1) % urls.length)}
                aria-label="Next evidence image"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/55 p-1 text-white transition-colors hover:bg-black/75"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 text-zinc-500 max-sm:max-w-[320px] dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-400">
          <ImageOff aria-hidden className="h-6 w-6" />
          <span className="text-[11px] font-medium">
            {row.image_paths.length > 0 ? 'Evidence could not be loaded' : 'No evidence attached'}
          </span>
        </div>
      )}
    </div>
  );
}

function RequestDetail({
  row,
  managedIds,
  viewerEmail,
  signedUrls,
  pool,
  approverDraft,
  onApproverChange,
  note,
  onNoteChange,
  busy,
  error,
  onDecide,
  onRecall,
  onClose,
  onImageClick,
}: {
  row: TimeAdjustmentRow;
  managedIds: ReadonlySet<string>;
  viewerEmail: string;
  signedUrls: Record<string, string>;
  pool: ApproverPool;
  approverDraft: string;
  onApproverChange: (v: string) => void;
  note: string;
  onNoteChange: (v: string) => void;
  busy: 'deciding' | 'recalling' | null;
  error: string | null;
  onDecide: (action: DecideAction) => void;
  onRecall: () => void;
  onClose: () => void;
  onImageClick: (urls: string[], idx: number) => void;
}) {
  const chip = rowStatusChip(row, managedIds, viewerEmail);
  const isManagerTurn = taNeedsMyManagerDecision(row, managedIds);
  const isSecondTurn = taNeedsMySecondDecision(row, viewerEmail);
  const actionable = isManagerTurn || isSecondTurn;
  const canRecall =
    (row.status === 'manager_approved' || row.status === 'awaiting_second_approval') &&
    managedIds.has(row.id);

  const teamLabel = pool.department ? formatDeptLabel(pool.department) : '';
  const approverOptions: SmoothSelectOption[] = [
    { value: '', label: pool.loading ? 'Loading the team…' : 'Select a second approver…' },
    ...pool.list.map((c) => ({ value: c.email, label: c.name ? `${c.name} · ${c.email}` : c.email })),
  ];
  // The server refuses `manager_approve` without an approver, so the button is
  // disabled rather than allowed to produce a 400 the manager has to decode.
  const approveBlocked = isManagerTurn && !approverDraft;
  const window = fmtAdjustmentSegments(row.requested_segments ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start gap-3 border-b border-blue-100/80 bg-blue-50/60 px-5 py-3.5 dark:border-blue-900/40 dark:bg-blue-950/30">
        <div className="min-w-0">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
            Request {requestRef(row.id)}
          </p>
          <DialogTitle className="mt-0.5 truncate text-base font-bold tracking-tight text-zinc-900 dark:text-white">
            {row.work_email}
          </DialogTitle>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close request detail"
          className="ml-auto shrink-0 rounded-lg border border-blue-100 bg-white/80 p-1.5 text-zinc-500 transition-colors hover:bg-white hover:text-zinc-900 dark:border-blue-900/40 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/*
        Two columns so the whole request fits without scrolling: the facts stack on
        the left and the square proof sits beside them. Stacked, the square pushed
        the decision trail and the footer out of a 1000px window. The scroll region
        stays as the safety net a long explanation or a long trail still needs — it
        just does not engage on a normal request.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid gap-x-5 gap-y-4 p-5 sm:grid-cols-[1fr_286px]">
          <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Hours requested</FieldLabel>
          <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
            {fmtAdjustmentHours(row.requested_hours)}
          </div>
        </div>
        <div>
          <FieldLabel>Pay period</FieldLabel>
          <div className="mt-0.5 font-mono text-xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">
            {periodOf(row) || '—'}
          </div>
        </div>
        <div className="col-span-2">
          <FieldLabel>Time window</FieldLabel>
          <div className="mt-0.5 font-mono text-[13px] text-zinc-700 dark:text-zinc-300">
            {window ? (
              <>
                {window}
                <span className="mx-1.5 text-zinc-300 dark:text-zinc-600">·</span>
                {row.adjust_date}
              </>
            ) : (
              // Legacy rows stored a claimed day total instead of ranges.
              <span className="text-zinc-500 dark:text-zinc-400">
                No ranges recorded · {row.adjust_date}
              </span>
            )}
          </div>
        </div>
        <div className="col-span-2">
          <FieldLabel>Reason</FieldLabel>
          <div className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-300">
            {reasonLabel(row.reason)}
          </div>
        </div>
      </div>

      <div className="border-t border-blue-100/60 pt-3 dark:border-blue-900/40">
        <FieldLabel className="mb-2">Employee explanation</FieldLabel>
        {row.explanation?.trim() ? (
          // Ink tinted to the fill's own hue rather than neutral grey: this is the
          // employee's own words and the most-read text in the panel, and grey on a
          // tint reads washed out next to the neutral copy around it.
          <p className="whitespace-pre-wrap rounded-xl bg-blue-50/50 px-3 py-2.5 text-sm text-blue-950 dark:bg-blue-950/20 dark:text-blue-50">
            {row.explanation}
          </p>
        ) : (
          <p className="rounded-xl bg-zinc-50 px-3 py-2.5 text-sm italic text-zinc-500 dark:bg-zinc-900/60 dark:text-zinc-400">
            No explanation was given.
          </p>
        )}
      </div>

      <div className="border-t border-blue-100/60 pt-3 dark:border-blue-900/40">
        <TrailList row={row} />
      </div>
          </div>

          <div className="min-w-0">
            <EvidenceBlock row={row} signedUrls={signedUrls} onImageClick={onImageClick} />
          </div>
        </div>
      </div>

      {/* Pinned: the decision must stay reachable on a short window, which is the
          exact failure the height-cap rule exists to prevent. */}
      <div className="shrink-0 border-t border-blue-100/80 bg-blue-50/40 px-5 py-4 dark:border-blue-900/40 dark:bg-blue-950/20">
      {actionable ? (
        <div className="flex flex-col gap-2.5">
          {isManagerTurn && (
            <div>
              <FieldLabel className="mb-1.5">
                Second approver
                <span className="ml-1 font-normal normal-case tracking-normal text-blue-600 dark:text-blue-400">
                  required
                </span>
              </FieldLabel>
              <SmoothSelect
                value={approverDraft}
                options={approverOptions}
                onChange={onApproverChange}
                aria-label="Choose the second approver"
                triggerClassName="h-9 w-full"
                searchable={pool.list.length > 8}
                searchPlaceholder="Search the team…"
              />
              <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                {pool.loading
                  ? 'Loading this request’s team…'
                  : pool.list.length === 0
                    ? `Nobody else is active on ${teamLabel || 'this team'}, so there is no one to countersign.`
                    : `Anyone active on ${teamLabel || 'the requester’s team'}. They review it in their own portal.`}
              </p>
            </div>
          )}

          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Note to the employee (optional)"
            aria-label="Note to the employee"
            className="min-h-[64px] w-full resize-y rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-100 dark:placeholder:text-zinc-400"
          />

          {/* Inline, above the buttons — the handoff is explicit that a failed
              action must not open a modal. */}
          {error && (
            <p
              role="alert"
              className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300"
            >
              <AlertCircle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2 sm:justify-end">
            <button
              type="button"
              disabled={busy !== null || approveBlocked}
              onClick={() => onDecide(isManagerTurn ? 'manager_approve' : 'second_approve')}
              className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 disabled:cursor-not-allowed disabled:opacity-45 sm:min-w-[11rem] sm:flex-none dark:bg-blue-600 dark:hover:bg-blue-500"
            >
              {busy === 'deciding' ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : (
                <Check aria-hidden className="h-4 w-4" />
              )}
              <span className="truncate">
                Approve {fmtAdjustmentHours(row.requested_hours)}
              </span>
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onDecide(isManagerTurn ? 'manager_deny' : 'second_deny')}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/50 disabled:cursor-not-allowed disabled:opacity-45 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300"
            >
              Decline
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {isManagerTurn
              ? 'Approving sends it to the second approver you picked. Both signatures are needed before Accounting can act.'
              : 'You are the named second approver. Either decline ends the request.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip label={chip.label} tone={chip.tone} />
          {canRecall && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={onRecall}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-45 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200"
            >
              {busy === 'recalling' ? (
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 aria-hidden className="h-3.5 w-3.5" />
              )}
              Retrieve request
            </button>
          )}
          {error && (
            <p
              role="alert"
              className="basis-full rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300"
            >
              {error}
            </p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ── The workspace ─────────────────────────────────────────────────────────────

export default function ManagerTimeAdjustments({
  onCountChange,
}: {
  onCountChange: (n: number) => void;
}) {
  // RAW payload in, render shape derived. `manager-dashboard-cache.md`: a cached
  // value paints, it never decides, and a Set cannot survive the JSON mirror.
  const [payload, setPayload] = useManagerCachedState<TimeAdjustmentQueuePayload>(
    MANAGER_CACHE_KEYS.timeAdjustmentQueue,
    EMPTY_QUEUE_PAYLOAD,
  );
  // NOT cached: signed storage URLs expire, and a cached one paints a broken image
  // where an uncached one paints nothing.
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [settled, setSettled] = useState(false);

  const [filters, setFilters] = useState<TaFilters>(EMPTY_TA_FILTERS);
  /** Whether the landing segment has been chosen for this mount. */
  const bucketPickedRef = useRef(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [poolByRow, setPoolByRow] = useState<Record<string, ApproverPool>>({});
  const [approverDraft, setApproverDraft] = useState<Record<string, string>>({});
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<'deciding' | 'recalling' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ urls: string[]; idx: number } | null>(null);

  const { rows, managedIds, viewerEmail } = useMemo(() => deriveQueue(payload), [payload]);

  // Refed so `load` can be `[]`-stable: an identity that changes per render turns
  // the mount fetch into a fetch-per-render loop (fixed in 62c8312e).
  const countChangeRef = useRef(onCountChange);
  countChangeRef.current = onCountChange;
  const setPayloadRef = useRef(setPayload);
  setPayloadRef.current = setPayload;

  const load = useCallback(() => {
    fetch('/api/manager/time-adjustments', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json: Partial<TimeAdjustmentQueuePayload> & { signedUrls?: Record<string, string> }) => {
        const next: TimeAdjustmentQueuePayload = {
          rows: json.rows ?? [],
          viewerEmail: json.viewerEmail ?? '',
          managedIds: json.managedIds ?? [],
        };
        setPayloadRef.current(next);
        setSignedUrls(json.signedUrls ?? {});
        // The sidebar badge is "things waiting on ME" — both hats.
        const d = deriveQueue(next);
        countChangeRef.current(
          d.rows.filter(
            (r) =>
              taNeedsMyManagerDecision(r, d.managedIds) ||
              taNeedsMySecondDecision(r, d.viewerEmail),
          ).length,
        );
      })
      .catch(() => {
        // A failed read must not leave a stale queue on screen under no warning,
        // and must not invent an empty one either — keep what we have and let the
        // count stand; the poll will correct it.
      })
      .finally(() => setSettled(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useLiveRefresh({
    tables: ['time_adjustment_requests'],
    onRefresh: load,
    channel: 'manager-time-adjustments',
    pollMs: 60_000,
  });

  const counts = useMemo(
    () => countBuckets(rows, managedIds, viewerEmail),
    [rows, managedIds, viewerEmail],
  );
  const kpis = useMemo(
    () => buildQueueKpis(rows, managedIds, viewerEmail),
    [rows, managedIds, viewerEmail],
  );
  const visible = useMemo(
    () => filterRequests(rows, filters, managedIds, viewerEmail),
    [rows, filters, managedIds, viewerEmail],
  );
  const reasonCodes = useMemo(() => reasonOptionsFrom(rows), [rows]);
  const periods = useMemo(() => periodOptionsFrom(rows), [rows]);

  // Land on the first segment with outstanding work, once per mount and only once
  // real data has arrived. This is the discovery path for a countersign duty.
  useEffect(() => {
    if (bucketPickedRef.current || rows.length === 0) return;
    bucketPickedRef.current = true;
    const landing = defaultBucketFor(counts);
    if (landing !== 'all') setFilters((f) => ({ ...f, bucket: landing }));
  }, [rows.length, counts]);

  const openRow = useMemo(
    () => (openId ? rows.find((r) => r.id === openId) ?? null : null),
    [openId, rows],
  );

  // Clear a stale error when the manager moves to another request.
  useEffect(() => {
    setActionError(null);
  }, [openId]);

  // Ids the viewer owes a MANAGER decision on are the only ones that render a
  // picker, so the only ones worth a pool fetch. Sorted for a stable effect key.
  const pickerIdsKey = useMemo(
    () =>
      rows
        .filter((r) => taNeedsMyManagerDecision(r, managedIds))
        .map((r) => r.id)
        .sort()
        .join(','),
    [rows, managedIds],
  );

  useEffect(() => {
    if (!pickerIdsKey) return;
    let cancelled = false;
    const ids = pickerIdsKey.split(',');
    setPoolByRow((prev) => {
      const next = { ...prev };
      for (const id of ids) if (!next[id]) next[id] = EMPTY_POOL;
      return next;
    });
    void Promise.all(
      ids.map(async (id) => {
        try {
          const res = await fetch(
            `/api/manager/approver-candidates?requestId=${encodeURIComponent(id)}`,
            { cache: 'no-store' },
          );
          const json = (await res.json()) as {
            candidates?: ApproverCandidate[];
            department?: string | null;
          };
          return [
            id,
            { list: json.candidates ?? [], department: json.department ?? null, loading: false },
          ] as [string, ApproverPool];
        } catch {
          return [id, { list: [], department: null, loading: false }] as [string, ApproverPool];
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setPoolByRow((prev) => {
        const next = { ...prev };
        for (const [id, pool] of entries) next[id] = pool;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [pickerIdsKey]);

  // Escape closes the lightbox first, then the detail panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (lightbox) {
        setLightbox(null);
        return;
      }
      if (openId) setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox, openId]);

  // Lightbox arrow navigation.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        setLightbox((lb) => lb && { ...lb, idx: (lb.idx + 1) % lb.urls.length });
      }
      if (e.key === 'ArrowLeft') {
        setLightbox((lb) => lb && { ...lb, idx: (lb.idx - 1 + lb.urls.length) % lb.urls.length });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const decide = async (id: string, action: DecideAction) => {
    const secondApprover = action === 'manager_approve' ? approverDraft[id] ?? '' : '';
    if (action === 'manager_approve' && !secondApprover) {
      setActionError('Pick a second approver before approving.');
      return;
    }
    setBusyId(id);
    setBusyKind('deciding');
    setActionError(null);
    try {
      const res = await fetch(`/api/time-adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          decision_note: notesDraft[id]?.trim() || null,
          ...(secondApprover ? { second_approver_email: secondApprover } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'The request could not be updated.');
      // A second approval only reaches Accounting once the manager has signed too.
      const managerAlreadyApproved =
        rows.find((r) => r.id === id)?.manager_decision === 'approved';
      toast.success(
        action === 'manager_approve'
          ? 'Approved, sent to the second approver'
          : action === 'second_approve'
            ? managerAlreadyApproved
              ? 'Approved, forwarded to Accounting'
              : 'Approved, still awaiting the manager'
            : 'Request declined',
      );
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The request could not be updated.');
    } finally {
      setBusyId(null);
      setBusyKind(null);
    }
  };

  const recall = async (id: string) => {
    setBusyId(id);
    setBusyKind('recalling');
    setActionError(null);
    try {
      const res = await fetch(`/api/time-adjustments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recall' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'The request could not be retrieved.');
      toast.success('Retrieved, back in your queue');
      load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'The request could not be retrieved.');
    } finally {
      setBusyId(null);
      setBusyKind(null);
    }
  };

  const oldestOwed = useMemo(() => {
    const owed = rows
      .filter((r) => {
        const b = bucketOfRequest(r, managedIds, viewerEmail);
        return b === 'needs-you' || b === 'countersign';
      })
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
    return owed[0] ?? null;
  }, [rows, managedIds, viewerEmail]);

  const detailProps = openRow
    ? {
        row: openRow,
        managedIds,
        viewerEmail,
        signedUrls,
        pool: poolByRow[openRow.id] ?? EMPTY_POOL,
        approverDraft: approverDraft[openRow.id] ?? openRow.second_approver_email ?? '',
        onApproverChange: (v: string) =>
          setApproverDraft((p) => ({ ...p, [openRow.id]: v })),
        note: notesDraft[openRow.id] ?? '',
        onNoteChange: (v: string) => setNotesDraft((p) => ({ ...p, [openRow.id]: v })),
        busy: busyId === openRow.id ? busyKind : null,
        error: actionError,
        onDecide: (action: DecideAction) => decide(openRow.id, action),
        onRecall: () => recall(openRow.id),
        onClose: () => setOpenId(null),
        onImageClick: (urls: string[], idx: number) => setLightbox({ urls, idx }),
      }
    : null;

  return (
    <>
      {/* Evidence lightbox */}
      <AnimatePresence>
        {lightbox && (
          <motion.div
            key="ta-lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
            onClick={() => setLightbox(null)}
            role="dialog"
            aria-modal="true"
            aria-label="Evidence image"
          >
            <motion.div
              key={lightbox.urls[lightbox.idx]}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="relative max-h-[88vh] max-w-[90vw]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={lightbox.urls[lightbox.idx]}
                alt={`Evidence ${lightbox.idx + 1} of ${lightbox.urls.length}`}
                className="max-h-[88vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
              />
              <button
                type="button"
                onClick={() => setLightbox(null)}
                aria-label="Close image"
                className="absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-white/25 backdrop-blur-md transition-colors hover:bg-white/25"
              >
                <X className="h-4 w-4" />
              </button>
              {lightbox.urls.length > 1 && (
                <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
                  {lightbox.idx + 1} / {lightbox.urls.length}
                </span>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* MESA's page treatment: a soft tinted wash in light, flat #0d1117 in dark. */}
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-gradient-to-br from-white via-blue-50/30 to-sky-50/20 p-4 sm:p-6 dark:bg-none dark:bg-[#0d1117]">
        <div className="w-full space-y-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-100 to-sky-100 text-blue-700 ring-1 ring-blue-100 dark:from-blue-950/60 dark:to-sky-950/40 dark:text-blue-300 dark:ring-blue-900/60">
            <CalendarClock className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-300">
              Manager review
            </p>
            <h2 className="mt-0.5 text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Time adjustment requests
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              Judge each request against its evidence, then approve it to the second
              approver or decline it. Requests can cover any past date.
            </p>
          </div>
          {oldestOwed && (
            <button
              type="button"
              onClick={() => setOpenId(oldestOwed.id)}
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg bg-gradient-to-r from-blue-600 to-sky-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
            >
              Review oldest waiting
            </button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Needs your review"
            value={String(kpis.owedByMe)}
            sub={
              kpis.owedByMe === 0
                ? 'Nothing waiting on you'
                : `${fmtAdjustmentHours(kpis.owedHours)} requested`
            }
            tone="blue"
            settled={settled}
            onClick={
              kpis.owedByMe > 0
                ? () =>
                    setFilters((f) => ({
                      ...f,
                      bucket: counts['needs-you'] > 0 ? 'needs-you' : 'countersign',
                    }))
                : undefined
            }
            ariaLabel={`Show the ${kpis.owedByMe} requests waiting on you`}
          />
          <StatTile
            label="Awaiting second approver"
            value={String(kpis.awaitingSecondApprover)}
            sub="Parked on a countersignature"
            tone="zinc"
            settled={settled}
          />
          <StatTile
            label="Decided last 30 days"
            value={String(kpis.decidedInWindow)}
            sub={kpis.approvalRate == null ? 'None decided yet' : `${kpis.approvalRate}% approved`}
            tone="zinc"
            settled={settled}
          />
          <StatTile
            label="Median time to decide"
            value={kpis.medianDays == null ? '—' : `${Math.round(kpis.medianDays * 10) / 10} d`}
            sub={
              kpis.medianSample === 0
                ? 'No decided requests yet'
                : `Across ${kpis.medianSample} decided`
            }
            tone="zinc"
            settled={settled}
          />
        </div>

        <QueueFilterBar
          filters={filters}
          onChange={setFilters}
          counts={counts}
          reasonCodes={reasonCodes}
          periods={periods}
        />

          <RequestTable
            rows={visible}
            managedIds={managedIds}
            viewerEmail={viewerEmail}
            openId={openId}
            onOpen={setOpenId}
            settled={settled}
            total={rows.length}
            filtered={hasActiveTaFilter(filters)}
            onClearFilters={() => setFilters(EMPTY_TA_FILTERS)}
          />
        </div>
      </div>

      {/*
        The request detail. All four rules from `docs/design/responsive-design.md`
        § "Dialogs and modals" are on the className below, because `DialogContent`
        declares no max-height and is centred with `-translate-y-1/2`: without them
        a tall dialog is clipped at BOTH ends and the decision buttons become
        unreachable. `bg-none` is there to drop the primitive's default
        orange-tinted gradient, which would fight the blue theme.

        The animation is the primitive's own (320ms, cubic-bezier(0.22,1,0.36,1),
        fade + zoom-in-[0.94] + a 6px rise; 180ms on the way out), so this modal
        feels like every other dialog in the app.
      */}
      <Dialog
        open={detailProps !== null}
        onOpenChange={(next) => {
          if (next) return;
          // Escape and outside-press back out ONE layer. With the evidence
          // lightbox open, that layer is the lightbox — closing the whole modal
          // under it would throw away the note and the approver already picked.
          if (lightbox) {
            setLightbox(null);
            return;
          }
          setOpenId(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className={cn(
            'flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[min(880px,calc(100%-1.5rem))] flex-col gap-0 overflow-hidden p-0',
            'sm:max-h-[92dvh] sm:max-w-[min(880px,calc(100%-4rem))]',
            'border-blue-100/80 bg-white bg-none dark:border-blue-900/40 dark:bg-[#0d1117]',
          )}
        >
          {detailProps ? (
            <RequestDetail {...detailProps} />
          ) : (
            // `DialogContent` needs an accessible name even on the closing frame,
            // after the row has already gone.
            <DialogTitle className="sr-only">Request detail</DialogTitle>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
