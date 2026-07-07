'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  Sheet,
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
import { formatLastSeen } from '@/components/team/team-ui';
import DeptFilter from './DeptFilter';

const PAGE_SIZE = 10;

const listVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.035, delayChildren: 0.02 },
  },
};

const rowVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] as const } },
};

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

export default function HrGlobalMasterList() {
  const [roster, setRoster] = useState<EmployeeRow[]>(
    () => getHrTabCache<EmployeeRow[]>(HR_TAB_CACHE_KEYS.globalMasterList) ?? [],
  );
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.globalMasterList));
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [page, setPage] = useState(0);
  const reduceMotion = useReducedMotion();

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

  const filtered = useMemo(() => {
    setPage(0);
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (dept && (r.department ?? '').trim() !== dept) return false;
      if (!q) return true;
      return [r.name, r.work_email, r.personal_email, r.department, r.employee_id]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q));
    });
  }, [roster, search, dept]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Re-key the tbody on the visible row set so the staggered fade-in replays
  // whenever the search filters the results or the page changes.
  const listKey = `${safePage}::${pageRows
    .map((r) => r.work_email ?? r.personal_email ?? r.employee_id ?? '')
    .join('|')}`;

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

      {/* Table */}
      <Card className="border-zinc-100 shadow-sm dark:border-zinc-800">
        <CardHeader className="border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Active roster</CardTitle>
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-white">
                {loading ? 'Loading…' : `${filtered.length} of ${roster.length} shown`}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <DeptFilter rows={roster} getDept={(r) => r.department} value={dept} onChange={setDept} />
              <div className="relative w-full sm:w-96 sm:shrink-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, ID…"
                  className="h-9 border-zinc-200 pl-8 text-xs text-zinc-900 dark:border-zinc-700 dark:text-white"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-xs text-zinc-400">
              {roster.length === 0
                ? 'No active employees. Click “Sync from Google Sheet” to pull the master list.'
                : 'No rows match your search.'}
            </p>
          ) : (
            <>
              <table className="w-full text-left text-base">
                <thead className="border-b border-zinc-100 bg-zinc-50/90 text-sm font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-white">
                  <tr>
                    <th className="px-4 py-2">Employee ID</th>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Dept</th>
                    <th className="px-4 py-2">Work email</th>
                    <th className="px-4 py-2">Personal email</th>
                    <th className="px-4 py-2">Start date</th>
                    <th className="px-4 py-2">Tenure</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <motion.tbody
                  key={listKey}
                  className="divide-y divide-zinc-50 dark:divide-zinc-800/60"
                  variants={listVariants}
                  initial={reduceMotion ? false : 'hidden'}
                  animate="show"
                >
                  {pageRows.map((r, i) => {
                    const detail = detailFor(r);
                    const online = !!detail;
                    const statusText = online
                      ? dashboardLabelForPathname(detail!.path) + (detail!.tab ? ` · ${detail!.tab}` : '')
                      : lastSeenFor(r)
                        ? `Last seen ${formatLastSeen(lastSeenFor(r)) ?? '—'}`
                        : 'Offline';
                    return (
                    <motion.tr
                      key={`${r.work_email ?? r.personal_email ?? r.employee_id ?? i}`}
                      variants={rowVariants}
                      className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30"
                    >
                      <td data-label="Employee ID" className="px-4 py-2.5 font-mono text-sm text-zinc-700 dark:text-white">{r.employee_id ?? '—'}</td>
                      <td data-label="Name" className="px-4 py-2.5 text-base font-medium text-zinc-900 dark:text-white">{r.name ?? '—'}</td>
                      <td data-label="Dept" className="px-4 py-2.5 text-base text-zinc-700 dark:text-white">{r.department ?? '—'}</td>
                      <td data-label="Work email" className="px-4 py-2.5 font-mono text-sm text-zinc-700 dark:text-white">{r.work_email ?? '—'}</td>
                      <td data-label="Personal email" className="px-4 py-2.5 font-mono text-sm text-zinc-700 dark:text-white">{r.personal_email ?? '—'}</td>
                      <td data-label="Start date" className="px-4 py-2.5 text-base text-zinc-700 dark:text-white">{fmtDate(r.start_date)}</td>
                      <td data-label="Tenure" className="px-4 py-2.5 text-base tabular-nums text-zinc-700 dark:text-white">{tenure(r.start_date)}</td>
                      <td data-label="Status" className="px-4 py-2.5">
                        <span className="inline-flex min-w-0 items-center gap-1.5" title={statusText}>
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600',
                            )}
                            aria-hidden
                          />
                          <span
                            className={cn(
                              'truncate text-sm',
                              online
                                ? 'font-medium text-emerald-700 dark:text-emerald-400'
                                : 'text-zinc-500 dark:text-zinc-400',
                            )}
                          >
                            {statusText}
                          </span>
                        </span>
                      </td>
                    </motion.tr>
                    );
                  })}
                </motion.tbody>
              </table>
              <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                <p className="text-sm text-zinc-600 dark:text-white">
                  {filtered.length === 0
                    ? '0'
                    : `${safePage * PAGE_SIZE + 1}–${Math.min((safePage + 1) * PAGE_SIZE, filtered.length)}`}{' '}
                  of {filtered.length}
                </p>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon" className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100" disabled={safePage === 0} onClick={() => setPage(0)}>
                    <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
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
                        className="block text-sm text-zinc-600 dark:text-white"
                      >
                        {safePage + 1} / {totalPages}
                      </motion.span>
                    </AnimatePresence>
                  </div>
                  <Button variant="outline" size="icon" className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100" disabled={safePage >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-7 w-7 transition-transform duration-150 hover:scale-110 active:scale-90 disabled:hover:scale-100" disabled={safePage >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>
                    <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
