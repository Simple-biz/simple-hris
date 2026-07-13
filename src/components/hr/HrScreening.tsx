'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
  UserSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useLiveRefresh } from '@/hooks/useLiveRefresh';
import { getHrTabCache, hasHrTabCache, setHrTabCache, HR_TAB_CACHE_KEYS } from '@/lib/hr/tab-cache';
import { SCREENING_COLUMNS, type ScreeningRow } from '@/lib/screening/columns';

const PAGE_SIZE = 100;

const listVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.01, delayChildren: 0.01 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const } },
};

// total = null → still counting in the background.
type Cache = { rows: ScreeningRow[]; total: number | null };

function cellValue(row: ScreeningRow, db: string): string {
  const v = row[db];
  return v == null || String(v).trim() === '' ? '—' : String(v);
}

export default function HrScreening() {
  const cached = getHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening);
  const [rows, setRows] = useState<ScreeningRow[]>(() => cached?.rows ?? []);
  const [total, setTotal] = useState<number | null>(() => cached?.total ?? null);
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.screening));
  const [fetching, setFetching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const reduceMotion = useReducedMotion();

  // Independent latest-wins guards for the two request streams.
  const rowsReq = useRef(0);
  const countReq = useRef(0);
  const firstLoad = useRef(true);

  // Fast path: fetch just the visible rows (indexed LIMIT scan, no count).
  const fetchRows = useCallback(async (p: number, q: string, mode: 'initial' | 'quiet') => {
    const myId = ++rowsReq.current;
    if (mode === 'initial') setLoading(true);
    setFetching(true);
    try {
      const res = await fetch(
        `/api/screening?page=${p}&pageSize=${PAGE_SIZE}&q=${encodeURIComponent(q)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: ScreeningRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      if (myId !== rowsReq.current) return; // superseded
      const next = json.rows ?? [];
      setRows(next);
      if (p === 0 && !q) {
        setHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening, { rows: next, total: null });
      }
    } catch (e) {
      if (myId === rowsReq.current && mode === 'initial') {
        toast.error(e instanceof Error ? e.message : 'Failed to load screening');
      }
    } finally {
      if (myId === rowsReq.current) {
        setFetching(false);
        if (mode === 'initial') setLoading(false);
      }
    }
  }, []);

  // Background: total row count for the current query (fills in pagination).
  const fetchCount = useCallback(async (q: string) => {
    const myId = ++countReq.current;
    try {
      const res = await fetch(`/api/screening?count=1&q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const json = (await res.json()) as { total?: number; error?: string };
      if (json.error) throw new Error(json.error);
      if (myId !== countReq.current) return;
      setTotal(json.total ?? 0);
      if (!q) {
        const c = getHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening);
        if (c) setHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening, { ...c, total: json.total ?? 0 });
      }
    } catch {
      /* count is best-effort; pagination degrades to "next while a full page" */
    }
  }, []);

  // Debounce the search box → resets to page 0 on a new query.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(0);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  // Rows: refetch on page or query change.
  useEffect(() => {
    const cold = firstLoad.current && !hasHrTabCache(HR_TAB_CACHE_KEYS.screening);
    void fetchRows(page, debouncedSearch, cold ? 'initial' : 'quiet');
    firstLoad.current = false;
  }, [page, debouncedSearch, fetchRows]);

  // Count: recompute only when the query changes (not on page turns).
  useEffect(() => {
    setTotal(null);
    void fetchCount(debouncedSearch);
  }, [debouncedSearch, fetchCount]);

  // Keep current page + count fresh after a Sync (or another HR user's).
  useLiveRefresh({
    tables: ['screening'],
    channel: 'hr-screening',
    onRefresh: () => {
      void fetchRows(page, debouncedSearch, 'quiet');
      void fetchCount(debouncedSearch);
    },
  });

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/cron/sync-screening-from-sheet', { method: 'POST' });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        inserted?: number;
        updated?: number;
        removed?: number;
        unchanged?: number;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Sync failed');
      const parts: string[] = [];
      if (json.inserted) parts.push(`${json.inserted} new`);
      if (json.updated) parts.push(`${json.updated} changed`);
      if (json.removed) parts.push(`${json.removed} removed`);
      if (typeof json.unchanged === 'number') parts.push(`${json.unchanged} unchanged`);
      toast.success(`Synced from Google Sheet${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      setPage(0);
      await fetchRows(0, debouncedSearch, 'quiet');
      void fetchCount(debouncedSearch);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [fetchRows, fetchCount, debouncedSearch]);

  const totalPages = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasPrev = page > 0;
  // If the count isn't in yet, allow "next" whenever we got a full page back.
  const hasNext = totalPages != null ? page < totalPages - 1 : rows.length === PAGE_SIZE;
  const listKey = `${page}::${debouncedSearch}::${rows.map((r) => r.id).join('|')}`;
  const rangeStart = rows.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = page * PAGE_SIZE + rows.length;

  const countLabel = loading
    ? 'Loading…'
    : total != null
      ? `${total.toLocaleString()} ${debouncedSearch ? (total === 1 ? 'match' : 'matches') : 'total'}`
      : 'counting…';

  return (
    <div className="flex flex-col gap-6 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-2xl border border-emerald-200/80 bg-gradient-to-br from-emerald-500 via-teal-600 to-zinc-900 px-5 py-6 text-white shadow-lg shadow-emerald-600/20 dark:border-emerald-900/50 dark:from-emerald-600 dark:via-teal-900 dark:to-black sm:px-7">
        <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-emerald-100/90">
              <UserSearch className="h-3 w-3 shrink-0" />
              HR &middot; Screening
            </div>
            <h1 className="mt-1 text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              The candidate screening pipeline, in sync.
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-emerald-100/85">
              Mirrors the “Screenings2.0” Google Sheet — latest scans first. Pull updates with{' '}
              <span className="font-semibold">Sync from Google Sheet</span>; only changed rows are written.
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
              <CardTitle className="text-lg font-semibold text-zinc-900 dark:text-white">Screenings</CardTitle>
              <p className="mt-0.5 flex items-center gap-2 text-sm text-zinc-600 dark:text-white">
                {countLabel}
                {fetching && !loading && <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />}
              </p>
            </div>
            <div className="relative w-full sm:w-96 sm:shrink-0">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email, screener, source…"
                className="h-9 border-zinc-200 pl-8 text-xs text-zinc-900 dark:border-zinc-700 dark:text-white"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-zinc-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-xs text-zinc-400">
              {debouncedSearch
                ? 'No rows match your search.'
                : 'No screenings yet. Click “Sync from Google Sheet” to pull the sheet.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-100 bg-zinc-50/90 text-xs font-semibold text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/90 dark:text-white">
                  <tr>
                    {SCREENING_COLUMNS.map((c) => (
                      <th key={c.db} className="whitespace-nowrap px-3 py-2">
                        {c.label ?? c.db}
                      </th>
                    ))}
                  </tr>
                </thead>
                <motion.tbody
                  key={listKey}
                  className="divide-y divide-zinc-50 dark:divide-zinc-800/60"
                  variants={listVariants}
                  initial={reduceMotion ? false : 'hidden'}
                  animate="show"
                >
                  {rows.map((r) => (
                    <motion.tr
                      key={r.id}
                      variants={rowVariants}
                      className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30"
                    >
                      {SCREENING_COLUMNS.map((c) => (
                        <td
                          key={c.db}
                          data-label={c.label ?? c.db}
                          className="px-3 py-2.5 text-zinc-700 dark:text-white"
                        >
                          {cellValue(r, c.db)}
                        </td>
                      ))}
                    </motion.tr>
                  ))}
                </motion.tbody>
              </table>
            </div>
          )}
          {!loading && rows.length > 0 && (
            <div data-readonly-allow className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
              <p className="text-sm text-zinc-600 dark:text-white">
                {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
                {total != null ? ` of ${total.toLocaleString()}` : ''}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={!hasPrev || fetching} onClick={() => setPage(0)}>
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={!hasPrev || fetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <div className="relative min-w-[5rem] overflow-hidden text-center">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={page}
                      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="block text-sm tabular-nums text-zinc-600 dark:text-white"
                    >
                      {page + 1}{totalPages != null ? ` / ${totalPages.toLocaleString()}` : ''}
                    </motion.span>
                  </AnimatePresence>
                </div>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={!hasNext || fetching} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={totalPages == null || page >= totalPages - 1 || fetching} onClick={() => totalPages != null && setPage(totalPages - 1)}>
                  <ChevronRight className="h-3 w-3" /><ChevronRight className="-ml-2 h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
