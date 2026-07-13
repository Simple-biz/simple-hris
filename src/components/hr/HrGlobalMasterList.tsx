'use client';

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  Sheet,
  Table2,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { EmployeeRow } from '@/lib/supabase/employees';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import { normEmail } from '@/lib/email/norm-email';
import { cn } from '@/lib/utils';
import { usePresenceDetails, type PresenceDetail } from '@/components/presence/PresenceProvider';
import { dashboardLabelForPathname } from '@/lib/presence/page-label';
import { formatLastSeen, TeamAvatar } from '@/components/team/team-ui';
import DeptFilter from './DeptFilter';

// Cards page in 12s (fills 2- and 3-column grids evenly); the table keeps 10.
const CARD_PAGE_SIZE = 12;
const TABLE_PAGE_SIZE = 10;

const EASE = [0.22, 1, 0.36, 1] as const;

type ViewMode = 'cards' | 'table';

// Sticky per-session view choice — survives HR tab switches (this component
// unmounts) without localStorage, so SSR always renders the 'cards' default
// and there is no hydration mismatch.
let viewMemory: ViewMode = 'cards';

type RosterEntry = { row: EmployeeRow; online: boolean; statusText: string };

const EM = <span className="text-zinc-400 dark:text-zinc-600">—</span>;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function tenure(iso: string | null | undefined): string {
  if (!iso) return '—';
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return '—';
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  if (months < 0) { years -= 1; months += 12; }
  if (years > 0 && months > 0) return `${years}y ${months}m`;
  if (years > 0) return `${years}y`;
  if (months > 0) return `${months}mo`;
  const days = Math.floor((now.getTime() - start.getTime()) / 86400000);
  return days <= 0 ? 'New' : `${days}d`;
}

function rowKey(r: EmployeeRow, i: number): string {
  return r.work_email ?? r.personal_email ?? r.employee_id ?? String(i);
}

/* ── View toggle (sliding gradient indicator, same pattern as the HR pills) ─ */

function ViewToggle({ view, onChange }: { view: ViewMode; onChange: (v: ViewMode) => void }) {
  const reduce = useReducedMotion();
  const options = [
    { value: 'cards' as const, label: 'Cards', Icon: LayoutGrid },
    { value: 'table' as const, label: 'Table', Icon: Table2 },
  ];
  return (
    <div className="inline-flex shrink-0 items-center self-start rounded-lg border border-zinc-200 bg-zinc-50/80 p-0.5 dark:border-zinc-700 dark:bg-zinc-900">
      {options.map(({ value, label, Icon }) => {
        const active = view === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={cn(
              'relative flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
              active
                ? 'text-white'
                : 'text-zinc-600 hover:bg-emerald-50 hover:text-emerald-900 dark:text-zinc-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-100',
            )}
          >
            {active && (
              <motion.span
                layoutId="hr-gml-view-toggle"
                className="absolute inset-0 rounded-md bg-gradient-to-r from-emerald-500 to-teal-700 shadow-sm shadow-emerald-600/25"
                transition={{ duration: reduce ? 0 : 0.28, ease: EASE }}
              />
            )}
            <Icon className="relative z-10 h-3.5 w-3.5" aria-hidden />
            <span className="relative z-10">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Search bar (typing dots while the deferred filter catches up) ────────── */

function RosterSearch({
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
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search name, email, ID…"
        aria-label="Search roster"
        autoComplete="off"
        className="h-9 border-zinc-200 bg-white pl-8 pr-20 text-xs text-zinc-900 focus-visible:ring-emerald-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <AnimatePresence mode="wait" initial={false}>
          {isSearching ? (
            <motion.span
              key="typing"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.15 }}
              className="flex items-center rounded-full bg-emerald-50 px-2 py-0.5 dark:bg-emerald-950/40"
              aria-live="polite"
              aria-label="Searching"
            >
              <TypingDots />
            </motion.span>
          ) : hasQuery ? (
            <motion.span
              key="count"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="font-mono text-[10px] tabular-nums text-zinc-400"
              aria-live="polite"
            >
              {resultCount}
            </motion.span>
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

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-1 w-1 rounded-full bg-emerald-500 dark:bg-emerald-400"
          animate={{ y: [0, -2, 0], opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
        />
      ))}
    </span>
  );
}

/* ── Row / card renderers (memoized — presence ticks only repaint changed rows) ─ */

const RosterCard = memo(function RosterCard({
  row,
  online,
  statusText,
  delay,
}: {
  row: EmployeeRow;
  online: boolean;
  statusText: string;
  delay: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE, delay } }}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      className="group flex flex-col rounded-xl border border-zinc-200/90 bg-white p-3.5 shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-emerald-300/70 hover:shadow-md hover:shadow-emerald-600/5 dark:border-zinc-800 dark:bg-zinc-900/70 dark:hover:border-emerald-800/70"
    >
      <div className="flex items-start gap-3">
        <div className="relative shrink-0">
          <TeamAvatar name={row.name ?? ''} email={row.work_email ?? row.personal_email ?? null} />
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-zinc-900',
              online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
            )}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.name ?? '—'}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
            {row.employee_id ?? '—'}
          </p>
        </div>
        {row.department && (
          <span className="max-w-[45%] shrink-0 truncate rounded-full border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {row.department}
          </span>
        )}
      </div>

      <dl className="mt-3 space-y-1.5 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            Work
          </dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
            {row.work_email ?? EM}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            Personal
          </dt>
          <dd className="min-w-0 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
            {row.personal_email ?? EM}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            Started
          </dt>
          <dd className="min-w-0 truncate text-[11px] tabular-nums text-zinc-700 dark:text-zinc-300">
            {fmtDate(row.start_date)} <span className="text-zinc-400 dark:text-zinc-600">·</span>{' '}
            {tenure(row.start_date)}
          </dd>
        </div>
      </dl>

      <div className="mt-auto pt-3">
        <p
          title={statusText}
          className={cn(
            'truncate border-t border-zinc-100 pt-2.5 text-[11px] dark:border-zinc-800',
            online ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400',
          )}
        >
          {statusText}
        </p>
      </div>
    </motion.li>
  );
});

const RosterRow = memo(function RosterRow({
  row,
  online,
  statusText,
  delay,
}: {
  row: EmployeeRow;
  online: boolean;
  statusText: string;
  delay: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.tr
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: 'easeOut', delay } }}
      className="transition-colors hover:bg-emerald-50/40 dark:hover:bg-zinc-800/30"
    >
      <td data-label="Employee" className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <TeamAvatar size="sm" name={row.name ?? ''} email={row.work_email ?? row.personal_email ?? null} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.name ?? '—'}</p>
            <p className="truncate font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{row.employee_id ?? '—'}</p>
          </div>
        </div>
      </td>
      <td data-label="Dept" className="px-4 py-2.5 text-sm text-zinc-700 dark:text-zinc-300">
        {row.department ?? EM}
      </td>
      <td data-label="Work email" className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
        {row.work_email ?? EM}
      </td>
      <td data-label="Personal email" className="px-4 py-2.5 font-mono text-xs text-zinc-600 dark:text-zinc-300">
        {row.personal_email ?? EM}
      </td>
      <td data-label="Start date" className="px-4 py-2.5 text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
        {fmtDate(row.start_date)}
      </td>
      <td data-label="Tenure" className="px-4 py-2.5 text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
        {tenure(row.start_date)}
      </td>
      <td data-label="Status" className="px-4 py-2.5">
        <span className="inline-flex min-w-0 max-w-[200px] items-center gap-1.5" title={statusText}>
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
            )}
            aria-hidden
          />
          <span
            className={cn(
              'truncate text-xs',
              online ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-zinc-500 dark:text-zinc-400',
            )}
          >
            {statusText}
          </span>
        </span>
      </td>
    </motion.tr>
  );
});

/* ── The keyed pane: remounts (and cascades) on view / page / dept change,
      but NOT on search keystrokes — persisting rows never re-animate, so
      typing feels instant. Rows mounted after the ~600ms entrance window
      (i.e. search results streaming in) fade in with zero stagger delay. ─── */

function RosterPane({ view, entries }: { view: ViewMode; entries: RosterEntry[] }) {
  const reduce = useReducedMotion();
  const mountTs = useRef(Date.now());
  const cascading = Date.now() - mountTs.current < 600;
  const delayFor = (i: number) => (reduce || !cascading ? 0 : Math.min(i * 0.03, 0.24));

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={
        reduce
          ? { opacity: 0, transition: { duration: 0.1 } }
          : { opacity: 0, y: -8, transition: { duration: 0.15, ease: 'easeIn' } }
      }
      transition={{ duration: 0.22, ease: EASE }}
      className={view === 'cards' ? 'bg-zinc-50/60 p-3 dark:bg-zinc-950/40 sm:p-4' : undefined}
    >
      {view === 'cards' ? (
        <ul role="list" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {entries.map((e, i) => (
            <RosterCard
              key={rowKey(e.row, i)}
              row={e.row}
              online={e.online}
              statusText={e.statusText}
              delay={delayFor(i)}
            />
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-zinc-100 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/60">
              <tr>
                {['Employee', 'Dept', 'Work email', 'Personal email', 'Start date', 'Tenure', 'Status'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="whitespace-nowrap px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500 dark:text-zinc-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100/80 dark:divide-zinc-800/60">
              {entries.map((e, i) => (
                <RosterRow
                  key={rowKey(e.row, i)}
                  row={e.row}
                  online={e.online}
                  statusText={e.statusText}
                  delay={delayFor(i)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </motion.div>
  );
}

/* ── Loading / empty / no-match panes ──────────────────────────────────────── */

function FadePane({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: 0.2, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

function RosterSkeleton({ view }: { view: ViewMode }) {
  if (view === 'table') {
    return (
      <div className="divide-y divide-zinc-100/80 dark:divide-zinc-800/60" aria-hidden>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-3 w-40 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="hidden h-3 flex-1 animate-pulse rounded bg-zinc-100 sm:block dark:bg-zinc-800" />
            <div className="hidden h-3 w-24 animate-pulse rounded bg-zinc-100 md:block dark:bg-zinc-800" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="bg-zinc-50/60 p-3 dark:bg-zinc-950/40 sm:p-4" aria-hidden>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rounded-xl border border-zinc-200/80 bg-white p-3.5 dark:border-zinc-800 dark:bg-zinc-900/70">
            <div className="flex items-start gap-3">
              <div className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-zinc-100 dark:bg-zinc-800" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            </div>
            <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <div className="h-2.5 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-2.5 w-5/6 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-2.5 w-1/2 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyRoster() {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white shadow-md">
        <Users className="h-6 w-6" aria-hidden />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">No employees yet</h3>
      <p className="mt-1 max-w-sm text-xs text-zinc-500 dark:text-zinc-400">
        Pull the master list with{' '}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">Sync from Google Sheet</span> above.
      </p>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
      {children}
    </span>
  );
}

function NoMatches({ query, dept, onClear }: { query: string; dept: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-zinc-400 to-zinc-500 text-white shadow-md dark:from-zinc-600 dark:to-zinc-700">
        <SearchX className="h-6 w-6" aria-hidden />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">No matches</h3>
      <p className="mt-1 flex flex-wrap items-center justify-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
        {query ? (
          <>
            Nothing in the roster matches <Chip>{query}</Chip>
            {dept && (
              <>
                in <Chip>{dept}</Chip>
              </>
            )}
          </>
        ) : (
          <>
            No one in <Chip>{dept}</Chip> right now.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={onClear}
        className="mt-3 rounded-full border border-zinc-200 bg-white px-3 py-1 text-[11px] font-medium text-zinc-600 transition-colors hover:border-emerald-300 hover:text-emerald-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-emerald-800 dark:hover:text-emerald-300"
      >
        {query && !dept ? 'Clear search' : 'Clear filters'}
      </button>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export default function HrGlobalMasterList() {
  const [roster, setRoster] = useState<EmployeeRow[]>(
    () => getHrTabCache<EmployeeRow[]>(HR_TAB_CACHE_KEYS.globalMasterList) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList));
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [page, setPage] = useState(0);
  const [view, setView] = useState<ViewMode>(() => viewMemory);
  const reduceMotion = useReducedMotion();

  // The input stays perfectly responsive; the (heavier) filter over ~1000 rows
  // runs against the deferred value so fast typing never blocks a paint.
  const deferredSearch = useDeferredValue(search);
  const isSearching = search.trim() !== deferredSearch.trim();

  // Live presence — who's online and which dashboard/tab they're on. Read-only
  // here (HR sees status; the Ping / force-logout controls are Admin-only).
  const presenceDetails = usePresenceDetails();
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});

  // `/api/employees` returns the full ~1000-row active roster and is expensive
  // (paginated view reads + an employee_ids query + a global_master_list scan +
  // in-JS id generation). The liveness triggers below (30s poll, window focus,
  // visibilitychange, Realtime) can otherwise fire it repeatedly and CONCURRENTLY
  // — and concurrent calls starve each other, so latency balloons and requests
  // pile up faster than they drain (the tab appears to "load forever", worst on
  // Vercel where per-call latency is higher). This in-flight guard coalesces all
  // of those triggers so at most ONE roster fetch is ever outstanding.
  const inFlight = useRef(false);

  const fetchRoster = useCallback(async (mode: 'initial' | 'quiet' = 'quiet') => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (mode === 'initial') setLoading(true);
    try {
      const res = await fetch('/api/employees', { cache: 'no-store' });
      const json = (await res.json()) as { employees?: EmployeeRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      const rows = json.employees ?? [];
      setRoster(rows);
      setHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList, rows);
    } catch (e) {
      if (mode === 'initial') toast.error(e instanceof Error ? e.message : 'Failed to load master list');
    } finally {
      inFlight.current = false;
      if (mode === 'initial') setLoading(false);
    }
  }, []);

  // Cold load only — a warm cache (tab revisit) paints instantly; liveness is
  // maintained by the Realtime + poll below.
  useEffect(() => {
    if (hasHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList)) return;
    void fetchRoster('initial');
  }, [fetchRoster]);

  // Live data: Realtime on global_master_list when it's in the publication,
  // otherwise the 30s poll + tab-focus refresh keep the table fresh — so a Sheet
  // sync or an add made by another HR user shows up without a manual reload.
  useLiveRefresh({
    tables: ['global_master_list'],
    channel: 'hr-global-master-list',
    onRefresh: () => void fetchRoster('quiet'),
  });

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/cron/sync-master-from-sheet', { method: 'POST' });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        updated?: number;
        activeCount?: number | null;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Sync failed');
      const parts: string[] = [];
      if (typeof json.inserted === 'number') parts.push(`${json.inserted} added`);
      if (typeof json.updated === 'number') parts.push(`${json.updated} updated`);
      if (typeof json.activeCount === 'number') parts.push(`${json.activeCount} active`);
      toast.success(`Synced from Google Sheet${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      await fetchRoster('quiet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [fetchRoster]);

  const handleSearchChange = useCallback((v: string) => {
    setSearch(v);
    setPage(0);
  }, []);
  const handleDeptChange = useCallback((v: string) => {
    setDept(v);
    setPage(0);
  }, []);
  const handleViewChange = useCallback((v: ViewMode) => {
    viewMemory = v;
    setView(v);
    setPage(0);
  }, []);
  const handleClearFilters = useCallback(() => {
    setSearch('');
    setDept('');
    setPage(0);
  }, []);

  // Precomputed lowercase haystack per row — a keystroke only does a cheap
  // .includes() sweep instead of rebuilding + lowercasing 5 fields × 1000 rows.
  const indexed = useMemo(
    () =>
      roster.map((r) => ({
        r,
        dept: (r.department ?? '').trim(),
        hay: [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
          .filter(Boolean)
          .join(' ')
          .toLowerCase(),
      })),
    [roster],
  );

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    const out: EmployeeRow[] = [];
    for (const e of indexed) {
      if (dept && e.dept !== dept) continue;
      if (q && !e.hay.includes(q)) continue;
      out.push(e.r);
    }
    return out;
  }, [indexed, deferredSearch, dept]);

  const pageSize = view === 'cards' ? CARD_PAGE_SIZE : TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const detailFor = useCallback(
    (r: EmployeeRow): PresenceDetail | null => {
      const w = normEmail(r.work_email ?? '');
      const p = normEmail(r.personal_email ?? '');
      return (w && presenceDetails.get(w)) || (p && presenceDetails.get(p)) || null;
    },
    [presenceDetails],
  );

  const lastSeenFor = useCallback(
    (r: EmployeeRow): string | null => {
      const w = r.work_email ? normEmail(r.work_email) : null;
      const p = r.personal_email ? normEmail(r.personal_email) : null;
      return (w && lastSeen[w]) || (p && lastSeen[p]) || null;
    },
    [lastSeen],
  );

  // Offline "last seen" only needs to cover the rows currently on screen —
  // fetching it for the whole ~1000-row roster would blow past the endpoint's
  // 500-email cap for no benefit.
  const visibleEmailKey = pageRows
    .map((r) => r.work_email ?? r.personal_email ?? '')
    .join('|');
  useEffect(() => {
    const emails = pageRows
      .flatMap((r) => [r.work_email, r.personal_email])
      .filter((e): e is string => !!e);
    if (emails.length === 0) return;
    let cancelled = false;
    fetch(`/api/presence/last-seen?emails=${encodeURIComponent(emails.join(','))}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((json: { lastSeen?: Record<string, string> }) => {
        if (!cancelled) setLastSeen(json.lastSeen ?? {});
      })
      .catch(() => {
        /* non-fatal — status falls back to "Offline" */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEmailKey]);

  const entries: RosterEntry[] = pageRows.map((row) => {
    const detail = detailFor(row);
    if (detail) {
      return {
        row,
        online: true,
        statusText: dashboardLabelForPathname(detail.path) + (detail.tab ? ` · ${detail.tab}` : ''),
      };
    }
    const seen = lastSeenFor(row);
    return {
      row,
      online: false,
      statusText: seen ? `Last seen ${formatLastSeen(seen) ?? '—'}` : 'Offline',
    };
  });

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-6 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/90">
              <Sheet className="h-3 w-3 shrink-0" />
              HR &middot; Global Master List
            </div>
            <h1 className="mt-1 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              The synced roster, in one place.
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              Mirrors the Google Sheet master list. Pull the latest with{' '}
              <span className="font-semibold">Sync from Google Sheet</span>. New hires are added
              through the New Hire Checklist and onboarding, not here.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="gap-2 bg-white/15 text-white backdrop-blur-sm hover:bg-white/25"
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? 'Syncing…' : 'Sync from Google Sheet'}
            </Button>
          </div>
        </div>
      </header>

      {/* Roster */}
      <Card className="border-zinc-100 shadow-sm dark:border-zinc-800">
        <CardHeader className="border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Active roster</CardTitle>
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                {loading
                  ? 'Loading roster…'
                  : `${filtered.length.toLocaleString()} of ${roster.length.toLocaleString()} shown`}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <DeptFilter rows={roster} getDept={(r) => r.department} value={dept} onChange={handleDeptChange} />
              <RosterSearch
                value={search}
                onChange={handleSearchChange}
                isSearching={isSearching}
                resultCount={filtered.length}
              />
              <ViewToggle view={view} onChange={handleViewChange} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0" aria-busy={loading}>
          <AnimatePresence mode="wait" initial={false}>
            {loading ? (
              <FadePane key={`skeleton:${view}`}>
                <RosterSkeleton view={view} />
              </FadePane>
            ) : roster.length === 0 ? (
              <FadePane key="empty">
                <EmptyRoster />
              </FadePane>
            ) : filtered.length === 0 ? (
              <FadePane key="no-match">
                <NoMatches query={search.trim()} dept={dept} onClear={handleClearFilters} />
              </FadePane>
            ) : (
              <RosterPane key={`${view}:${safePage}:${dept}`} view={view} entries={entries} />
            )}
          </AnimatePresence>

          {!loading && filtered.length > 0 && (
            <div
              data-readonly-allow
              className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800"
            >
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {`${safePage * pageSize + 1}–${Math.min((safePage + 1) * pageSize, filtered.length)}`} of{' '}
                {filtered.length.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100"
                  disabled={safePage === 0}
                  onClick={() => setPage(0)}
                  aria-label="First page"
                >
                  <ChevronLeft className="h-3 w-3" />
                  <ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100"
                  disabled={safePage === 0}
                  onClick={() => setPage(Math.max(0, safePage - 1))}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <div className="relative min-w-[4rem] overflow-hidden text-center">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={safePage}
                      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="block text-sm tabular-nums text-zinc-600 dark:text-zinc-300"
                    >
                      {safePage + 1} / {totalPages}
                    </motion.span>
                  </AnimatePresence>
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100"
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(totalPages - 1)}
                  aria-label="Last page"
                >
                  <ChevronRight className="h-3 w-3" />
                  <ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
