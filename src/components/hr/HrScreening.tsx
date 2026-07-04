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

const PAGE_SIZE = 25;

const listVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.02, delayChildren: 0.02 } },
};

const rowVariants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const } },
};

type Cache = { rows: ScreeningRow[]; total: number };

function cellValue(row: ScreeningRow, db: string): string {
  const v = row[db];
  return v == null || String(v).trim() === '' ? '—' : String(v);
}

export default function HrScreening() {
  const cached = getHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening);
  const [rows, setRows] = useState<ScreeningRow[]>(() => cached?.rows ?? []);
  const [total, setTotal] = useState<number>(() => cached?.total ?? 0);
  const [loading, setLoading] = useState(() => !hasHrTabCache(HR_TAB_CACHE_KEYS.screening));
  const [fetching, setFetching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(0);
  const reduceMotion = useReducedMotion();

  // Latest-wins: only the most recent request applies its result, so fast paging
  // or typing never lets a slow earlier response clobber a newer one.
  const reqId = useRef(0);
  const firstLoad = useRef(true);

  const fetchPage = useCallback(async (p: number, q: string, mode: 'initial' | 'quiet') => {
    const myId = ++reqId.current;
    if (mode === 'initial') setLoading(true);
    setFetching(true);
    try {
      const res = await fetch(
        `/api/screening?page=${p}&pageSize=${PAGE_SIZE}&q=${encodeURIComponent(q)}`,
        { cache: 'no-store' },
      );
      const json = (await res.json()) as { rows?: ScreeningRow[]; total?: number; error?: string };
      if (json.error) throw new Error(json.error);
      if (myId !== reqId.current) return; // a newer request superseded this one
      const next = json.rows ?? [];
      const tot = json.total ?? 0;
      setRows(next);
      setTotal(tot);
      if (p === 0 && !q) setHrTabCache<Cache>(HR_TAB_CACHE_KEYS.screening, { rows: next, total: tot });
    } catch (e) {
      if (myId === reqId.current && mode === 'initial') {
        toast.error(e instanceof Error ? e.message : 'Failed to load screening');
      }
    } finally {
      if (myId === reqId.current) {
        setFetching(false);
        if (mode === 'initial') setLoading(false);
      }
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

  // Fetch whenever the page or the (debounced) query changes.
  useEffect(() => {
    const cold = firstLoad.current && !hasHrTabCache(HR_TAB_CACHE_KEYS.screening);
    void fetchPage(page, debouncedSearch, cold ? 'initial' : 'quiet');
    firstLoad.current = false;
  }, [page, debouncedSearch, fetchPage]);

  // Keep the current page fresh (a Sync elsewhere, or by another HR user).
  useLiveRefresh({
    tables: ['screening'],
    channel: 'hr-screening',
    onRefresh: () => void fetchPage(page, debouncedSearch, 'quiet'),
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
        activeCount?: number | null;
      };
      if (!res.ok || !json.success) throw new Error(json.error || 'Sync failed');
      const parts: string[] = [];
      if (json.inserted) parts.push(`${json.inserted} new`);
      if (json.updated) parts.push(`${json.updated} changed`);
      if (json.removed) parts.push(`${json.removed} removed`);
      if (typeof json.unchanged === 'number') parts.push(`${json.unchanged} unchanged`);
      toast.success(`Synced from Google Sheet${parts.length ? ` · ${parts.join(' · ')}` : ''}`);
      await fetchPage(0, debouncedSearch, 'quiet');
      setPage(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [fetchPage, debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const listKey = `${safePage}::${debouncedSearch}::${rows.map((r) => r.id).join('|')}`;
  const rangeStart = total === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min((safePage + 1) * PAGE_SIZE, total);

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
                {loading ? 'Loading…' : `${total.toLocaleString()} ${debouncedSearch ? 'match' : 'total'}${total === 1 ? '' : debouncedSearch ? 'es' : ''}`}
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
          ) : total === 0 ? (
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
          {!loading && total > 0 && (
            <div className="flex items-center justify-between border-t border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
              <p className="text-sm text-zinc-600 dark:text-white">
                {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0 || fetching} onClick={() => setPage(0)}>
                  <ChevronLeft className="h-3 w-3" /><ChevronLeft className="-ml-2 h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage === 0 || fetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-3 w-3" />
                </Button>
                <div className="relative min-w-[5rem] overflow-hidden text-center">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={safePage}
                      initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                      transition={{ duration: 0.15, ease: 'easeOut' }}
                      className="block text-sm tabular-nums text-zinc-600 dark:text-white"
                    >
                      {safePage + 1} / {totalPages.toLocaleString()}
                    </motion.span>
                  </AnimatePresence>
                </div>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1 || fetching} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                  <ChevronRight className="h-3 w-3" />
                </Button>
                <Button variant="outline" size="icon" className="h-7 w-7" disabled={safePage >= totalPages - 1 || fetching} onClick={() => setPage(totalPages - 1)}>
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
