'use client';

/**
 * The Accounting Scoreboard page: header with the week, one tab per section that is switched on,
 * the overview, and Setup for managers. It replaces Carla's "Accounting Scoreboard" sheet.
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * Data flow: GET /api/accounting-scoreboard for the week, recomputed in the browser with the pure
 * modules after every edit. A background refresh runs every 45 s while the tab is visible and
 * on focus, but NEVER while a cell is being edited (the editing counter), so someone else's save
 * cannot overwrite what you are typing. A failed refresh keeps the last good board on screen and
 * says so. It never blanks to zeros.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, RefreshCw, Settings2, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { resolveSections, type ResolvedSection, type SectionKey, type Slot } from '@/lib/accounting-scoreboard/sections';
import { addDays, weekLabel, weekStartOf } from '@/lib/accounting-scoreboard/week';
import { buildLookup, entryKey, type StoredEntry } from '@/lib/accounting-scoreboard/scoring';
import { summarizeSection } from '@/lib/accounting-scoreboard/board';
import type { BoardPayload } from '@/lib/accounting-scoreboard/types';
import { api, fmtNum, fmtScore, GoalChip, TINY_CAPS } from './shared';
import { SectionGrid } from './SectionGrid';
import { CollectionsPanel, type NewCollection } from './CollectionsPanel';
import { SetupPanel } from './SetupPanel';

type Tab = 'overview' | SectionKey | 'setup';

const REFRESH_MS = 45_000;

export default function ScoreboardApp() {
  const [week, setWeek] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [fatal, setFatal] = useState<{ message: string; code: string } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const editing = useRef(0);
  const seq = useRef(0);
  const hasBoard = useRef(false);

  const load = useCallback(async (w: string | null, quiet: boolean) => {
    const id = ++seq.current;
    if (quiet) setRefreshing(true);
    else setLoading(true);
    const res = await api<BoardPayload>(`/api/accounting-scoreboard${w ? `?week=${w}` : ''}`);
    if (id !== seq.current) return;
    if (res.ok) {
      setBoard(res.data);
      hasBoard.current = true;
      setFatal(null);
      setStale(null);
    } else if (hasBoard.current && quiet) {
      setStale(res.error);
    } else {
      setFatal({ message: res.error, code: res.code });
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load(week, false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && editing.current === 0) void load(week, true);
    }, REFRESH_MS);
    const onFocus = () => {
      if (editing.current === 0) void load(week, true);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [week, load]);

  const onEditing = useCallback((delta: 1 | -1) => {
    editing.current = Math.max(0, editing.current + delta);
  }, []);

  const sections = useMemo(() => resolveSections(board?.settings ?? []), [board?.settings]);
  const enabled = useMemo(() => sections.filter((s) => s.enabled), [sections]);
  const lookup = useMemo(() => buildLookup(board?.entries ?? []), [board?.entries]);

  // A tab whose section was just switched off falls back to the overview.
  const activeTab: Tab =
    tab === 'overview' || tab === 'setup' || enabled.some((s) => s.key === tab) ? tab : 'overview';

  const saveEntry = useCallback(
    async (rowId: string, date: string, slot: Slot, value: number | null): Promise<boolean> => {
      const res = await api<{ entry: StoredEntry | null }>('/api/accounting-scoreboard/entries', {
        method: 'PUT',
        body: JSON.stringify({ rowId, date, slot, value }),
      });
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      setBoard((prev) => {
        if (!prev) return prev;
        const key = entryKey(rowId, date, slot);
        const rest = prev.entries.filter((e) => entryKey(e.rowId, e.date, e.slot) !== key);
        return { ...prev, entries: res.data.entry ? [...rest, res.data.entry] : rest };
      });
      return true;
    },
    [],
  );

  const logCollection = useCallback(
    async (c: NewCollection): Promise<boolean> => {
      const res = await api<{ collection: BoardPayload['collections'][number] }>('/api/accounting-scoreboard/collections', {
        method: 'POST',
        body: JSON.stringify(c),
      });
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      setBoard((prev) => (prev ? { ...prev, collections: [...prev.collections, res.data.collection] } : prev));
      toast.success(`Logged ${c.businessName}`);
      void load(week, true);
      return true;
    },
    [load, week],
  );

  const deleteCollection = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await api(`/api/accounting-scoreboard/collections?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      setBoard((prev) => (prev ? { ...prev, collections: prev.collections.filter((c) => c.id !== id) } : prev));
      void load(week, true);
      return true;
    },
    [load, week],
  );

  if (loading && !board) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center gap-2 text-zinc-400">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[10px] uppercase tracking-[0.22em]">Loading the scoreboard</span>
        </div>
      </Shell>
    );
  }

  if (fatal && !board) {
    return (
      <Shell>
        <div className="mx-auto mt-16 max-w-md rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="size-4" />
            {fatal.code === 'not_set_up' ? 'Not set up yet' : 'The scoreboard could not load'}
          </div>
          <p className="mt-2 leading-relaxed">{fatal.message}</p>
          <Button className="mt-3" variant="outline" onClick={() => void load(week, false)}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </Shell>
    );
  }

  if (!board) return null;
  const rowsFor = (key: SectionKey) => board.rows.filter((r) => r.sectionKey === key);
  const isThisWeek = week === null;

  return (
    <Shell>
      <header className="flex flex-wrap items-center gap-3 border-b border-orange-100/80 bg-white/90 px-4 py-3 backdrop-blur-md sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-sm">
            <Trophy className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold leading-tight text-zinc-900 sm:text-lg dark:text-zinc-100">
              Accounting Scoreboard
            </h1>
            <p className="font-mono text-[11px] text-zinc-500">{board.viewer.email}</p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous week"
            onClick={() => setWeek(addDays(board.weekStart, -7))}
          >
            <ChevronLeft />
          </Button>
          <div className="min-w-[10.5rem] text-center">
            <div className="text-sm font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{weekLabel(board.weekStart)}</div>
            <div className={cn(TINY_CAPS, 'text-[9px]', isThisWeek ? 'text-orange-600' : 'text-zinc-400')}>
              {isThisWeek ? 'This week' : 'Past week'}
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next week"
            disabled={isThisWeek}
            onClick={() => {
              const next = addDays(board.weekStart, 7);
              setWeek(next >= weekStartOf(board.today) ? null : next);
            }}
          >
            <ChevronRight />
          </Button>
          {!isThisWeek ? (
            <Button size="sm" variant="ghost" onClick={() => setWeek(null)}>
              This week
            </Button>
          ) : null}
          <span className="ml-1 w-4">{refreshing || loading ? <Loader2 className="size-3.5 animate-spin text-zinc-400" /> : null}</span>
        </div>
      </header>

      {stale ? (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 sm:px-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="size-3.5" />
          Couldn&rsquo;t refresh ({stale}). You&rsquo;re seeing the board as of the last good load.
        </div>
      ) : null}

      <nav className="flex gap-1 overflow-x-auto border-b border-zinc-100 bg-white px-3 py-2 sm:px-5 dark:border-zinc-900 dark:bg-zinc-950" aria-label="Sections">
        <TabButton active={activeTab === 'overview'} onClick={() => setTab('overview')}>
          Overview
        </TabButton>
        {enabled.map((s) => (
          <TabButton key={s.key} active={activeTab === s.key} onClick={() => setTab(s.key)}>
            {s.tab}
          </TabButton>
        ))}
        {board.viewer.isManager ? (
          <TabButton active={activeTab === 'setup'} onClick={() => setTab('setup')}>
            <Settings2 className="size-3.5" /> Setup
          </TabButton>
        ) : null}
      </nav>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {activeTab === 'overview' ? (
          <Overview board={board} sections={enabled} lookup={lookup} onOpen={setTab} />
        ) : activeTab === 'setup' ? (
          <SetupPanel board={board} sections={sections} onChanged={() => void load(week, true)} />
        ) : activeTab === 'collections' ? (
          <CollectionsPanel
            section={enabled.find((s) => s.key === 'collections')!}
            board={board}
            rows={rowsFor('collections')}
            onLog={logCollection}
            onDelete={deleteCollection}
          />
        ) : (
          <SectionGrid
            section={enabled.find((s) => s.key === activeTab)!}
            rows={rowsFor(activeTab)}
            weekStart={board.weekStart}
            lastWeekStart={board.lastWeekStart}
            today={board.today}
            lookup={lookup}
            isManager={board.viewer.isManager}
            onSave={saveEntry}
            onEditing={onEditing}
          />
        )}
      </main>
    </Shell>
  );
}

/** The root layout already mounts the app-wide Toaster; this shell must not add a second one. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh max-h-dvh w-full flex-col overflow-hidden bg-gradient-to-br from-white via-orange-50/30 to-blue-50/20 dark:bg-none dark:bg-[#0d1117]">
      {children}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-gradient-to-r from-orange-100 to-orange-50 text-orange-900 dark:from-orange-950/70 dark:to-orange-950/30 dark:text-orange-200'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900',
      )}
    >
      {children}
    </button>
  );
}

function Overview({
  board,
  sections,
  lookup,
  onOpen,
}: {
  board: BoardPayload;
  sections: ResolvedSection[];
  lookup: ReturnType<typeof buildLookup>;
  onOpen: (tab: Tab) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">This week at a glance</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Every number is added up from what the team typed. Nothing here is copied by hand, and last week is kept
          automatically.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {sections.map((s) => {
          const ids = board.rows.filter((r) => r.sectionKey === s.key).map((r) => r.id);
          const sum = summarizeSection(s, ids, lookup, board.collections, board.weekStart, board.lastWeekStart, board.today);
          const fmt = s.goal?.measure === 'avg_score' ? fmtScore : fmtNum;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => onOpen(s.key)}
              className="group rounded-xl border border-zinc-200 bg-white/80 p-4 text-left transition-colors hover:border-orange-200 hover:bg-orange-50/40 dark:border-zinc-800 dark:bg-zinc-950/70 dark:hover:border-orange-900 dark:hover:bg-zinc-900/60"
            >
              <div className={cn(TINY_CAPS, 'text-zinc-500 group-hover:text-orange-700 dark:group-hover:text-orange-300')}>{s.title}</div>
              <div className="mt-1.5 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{fmt(sum.headline)}</span>
                <span className="text-xs text-zinc-500">{headlineUnit(s)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <GoalChip goal={s.goal} met={sum.met} value={sum.headline} unitFormat={fmt} />
                <span className="text-[11px] text-zinc-500">
                  Last week <span className="font-mono tabular-nums">{fmt(sum.lastHeadline)}</span>
                </span>
                <span className="text-[11px] text-zinc-400">· {ids.length} {s.rowNoun}{ids.length === 1 ? '' : 's'}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function headlineUnit(s: ResolvedSection): string {
  switch (s.key) {
    case 'buckets':
    case 'inbox':
      return 'avg score';
    case 'chargebacks':
      return 'net cleared';
    case 'collections':
      return 'points';
    case 'pm_buckets':
      return 'avg in buckets';
    case 'payroll_timing':
      return 'hours';
    default:
      return 'this week';
  }
}
