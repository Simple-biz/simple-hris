'use client';

/**
 * The Accounting Scoreboard page: header with the week, one tab per section that is switched on,
 * the overview, and Setup for managers. It replaces Carla's "Accounting Scoreboard" sheet.
 * Governing doc: docs/features/accounting-scoreboard.md.
 *
 * Data flow: GET /api/accounting-scoreboard for the week, recomputed in the browser with the pure
 * modules after every edit. A teammate's write reaches an open board live: the route announces it on
 * Supabase Realtime Broadcast and the onSnapshot listener re-reads (`live-client.ts`). A background refresh
 * also runs every 45 s while the tab is visible and on focus. Neither runs while a cell is being edited (the
 * editing counter), so someone else's save
 * cannot overwrite what you are typing. A failed refresh keeps the last good board on screen and
 * says so. It never blanks to zeros.
 *
 * Browser cache (Kane, 2026-10-06: "i dont wanna see loading every switch of tab"): the board for a
 * week PAINTS from sessionStorage before the first paint of the page or of a week change
 * (`tab-cache.ts`), and is then fetched anyway, silently. Only a week with nothing of it on screen
 * shows a spinner. The cache is bound to the viewer the server page resolved, and the viewer (a
 * permission) is never read from it. The seed runs in a layout effect, never in the first render: the
 * page is server-rendered, and the first client render must match it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import { AlertTriangle, Archive, ChevronLeft, ChevronRight, LayoutGrid, ListChecks, Loader2, Menu, RefreshCw, Settings2, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  boardSections,
  hiddenFromOverview,
  hostedSections,
  overviewSections,
  resolveSections,
  rowSectionId,
  tabIdFor,
  tabSections,
  type BoardSection,
  type Slot,
} from '@/lib/accounting-scoreboard/sections';
import { can } from '@/lib/accounting-scoreboard/roles';
import { addDays, datesFor, formatEasternDateTime, todayEastern, weekLabel, weekStartOf } from '@/lib/accounting-scoreboard/week';
import { bindScoreboardCache, readCachedBoard, writeCachedBoard } from '@/lib/accounting-scoreboard/tab-cache';
import { onScoreboardSnapshot } from '@/lib/accounting-scoreboard/live-client';
import {
  BOARD_LOAD_LINES,
  boardLoadPlan,
  createBoardStreamAssembler,
  type BoardStreamEvent,
  type ServerLine,
} from '@/lib/accounting-scoreboard/load-progress';
import {
  applyRefresh,
  beginStep,
  completeStep,
  failRefresh,
  finishRefresh,
  startRefresh,
  type RefreshProgress,
} from '@/lib/refresh-progress/refresh-progress';
import { ScoreboardLoadDialog, type LoadTitles } from './ScoreboardLoadDialog';
import {
  amPmSectionStats,
  buildLookup,
  entryKey,
  winRatio,
  type ProblemEntry,
  type StoredEntry,
  type WinRatio,
} from '@/lib/accounting-scoreboard/scoring';
import { summarizeSection, type BoardContext, type SectionSummary } from '@/lib/accounting-scoreboard/board';
import { cycleWeek } from '@/lib/accounting-scoreboard/payroll-cycle';
import { LIGHT_LABEL, weekPace, type Light } from '@/lib/accounting-scoreboard/stoplight';
import {
  cardScore,
  cycleCardScore,
  teamLight,
  teamScore,
  type CardScore,
  type TeamScore,
} from '@/lib/accounting-scoreboard/team-score';
import { goalText } from '@/lib/accounting-scoreboard/scoring';
import type { BoardPayload, BoardRow } from '@/lib/accounting-scoreboard/types';
import {
  api,
  EASE_TAB,
  Flash,
  fmtNum,
  fmtPct,
  fmtScore,
  goalFormat,
  LIGHT_STYLE,
  sectionIcon,
  SlidingPill,
  StopLight,
  TINY_CAPS,
} from './shared';
import { PayrollCyclePanel } from './PayrollCyclePanel';
import { SectionGrid } from './SectionGrid';
import { CollectionsPanel, type NewCollection } from './CollectionsPanel';
import { ProblemsPanel, type NewProblem } from './ProblemsPanel';
import { SetupPanel } from './SetupPanel';
import { TasksPanel, type TasksView } from './TasksPanel';
import { SECTIONS_NAV_ID, SectionsDrawer, type DrawerItem } from './SectionsDrawer';

/** 'overview', 'setup', or a section's board id (a built-in key, or `custom:<uuid>`). */
type Tab = string;

const REFRESH_MS = 45_000;

/** The panel slides toward where you moved: a later tab or week from the right, an earlier one from the left. */
const PANEL_VARIANTS = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -28 : 28, transition: { duration: 0.14, ease: EASE_TAB } }),
};

/** How long "Scoreboard ready" stays before the loading modal closes itself (the refresh modal's hold). */
const LOAD_DONE_HOLD_MS = 650;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const SERVER_LINES = BOARD_LOAD_LINES.filter((l): l is ServerLine => l !== 'access');

/**
 * Read the board as a stream (GET ?stream=1, load-progress.ts), reporting `opened` when the route
 * answered and each `line` as it arrives. Fail-closed: anything short of a whole, valid board is a
 * failure with the reason (and, when the server said, whose read failed).
 */
async function streamBoard(
  week: string | null,
  signal: AbortSignal,
  on: (event: { kind: 'opened' } | BoardStreamEvent) => void,
): Promise<{ ok: true; board: BoardPayload } | { ok: false; error: string; code: string; line: ServerLine | null }> {
  try {
    const res = await fetch(`/api/accounting-scoreboard?stream=1${week ? `&week=${week}` : ''}`, { cache: 'no-store', signal });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      return { ok: false, error: body?.error ?? `The server answered ${res.status}.`, code: body?.code ?? 'http_error', line: null };
    }
    on({ kind: 'opened' });
    const assembler = createBoardStreamAssembler(week);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const event = assembler.push(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (event) on(event);
        nl = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const last = assembler.push(buffer);
    if (last) on(last);
    return assembler.finish();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error', code: 'network', line: null };
  }
}

/** Runs before paint in the browser; a plain effect on the server, where there is nothing to seed. */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The Sunday key of the week a request without `?week=` gets (US Eastern), for the cache key. */
const thisWeekStart = () => weekStartOf(todayEastern());

export default function ScoreboardApp({ viewer }: { viewer: BoardPayload['viewer'] }) {
  const reduce = useReducedMotion() ?? false;
  const [dir, setDir] = useState(1);
  const [week, setWeek] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [fatal, setFatal] = useState<{ message: string; code: string } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  // A fetch for a week with NOTHING of it on screen. Only this shows a spinner: revalidating a board
  // that is already painted (from the cache, the 45 s timer or a focus) is silent.
  const [fetching, setFetching] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  // Scoreboard | Tasks (plan Task 7): the task boards have their own periods, so Tasks hides the week arrows and the
  // section row. The board keeps loading underneath, so switching back is instant.
  const [mode, setMode] = useState<'scoreboard' | 'tasks'>('scoreboard');
  // Whose tasks are picked. Kept here, not in the panel, so Scoreboard and back lands on the same board (painted from
  // the browser cache, then fetched again: TasksPanel).
  const [tasksView, setTasksView] = useState<TasksView>('me');
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);
  const editing = useRef(0);
  const seq = useRef(0);
  const hasBoard = useRef(false);
  /** The week whose board is on screen (cached or fetched). */
  const shownWeek = useRef<string | null>(null);
  /** The week the server last answered for. Only a board of THAT week is written back to the cache. */
  const liveWeek = useRef<string | null>(null);

  // Bind the cache to the viewer the server page resolved, then paint the week from it, both before
  // the browser paints. Every week change seeds again, so stepping back to a week shows it at once.
  useIsoLayoutEffect(() => {
    bindScoreboardCache(viewer.email);
  }, [viewer.email]);
  useIsoLayoutEffect(() => {
    const key = week ?? thisWeekStart();
    const cached = readCachedBoard(key);
    if (!cached) return;
    setBoard({ ...cached, viewer });
    hasBoard.current = true;
    shownWeek.current = key;
    setFatal(null);
    // The week is on screen, so its fetch is a silent revalidation: no loader, no spinner. (`fetching`
    // starts true for the cold load, which would otherwise spin over a painted board.)
    setFetching(false);
    // `viewer` is deliberately not a dependency: a role change arrives with the page, and re-seeding on
    // it would repaint the cached week over a fresher one.
  }, [week]);

  // Write back only what the server answered for this week (and edits made on top of it), never the
  // cached seed itself: re-writing a seed would restamp stale data as fresh.
  useEffect(() => {
    if (board && board.weekStart === liveWeek.current) writeCachedBoard(board);
  }, [board]);

  // Below md the tabs live in the burger menu. Escape closes it, and so does growing past md: the menu
  // is md:hidden, and one left open while hidden would leave the page behind it inert.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const wide = window.matchMedia('(min-width: 768px)');
    const onWide = () => {
      if (wide.matches) setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    wide.addEventListener('change', onWide);
    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [menuOpen]);

  // Closing hands focus back to the burger, which was inert while the menu was open.
  useEffect(() => {
    if (menuWasOpen.current && !menuOpen) burgerRef.current?.focus();
    menuWasOpen.current = menuOpen;
  }, [menuOpen]);

  // The loading modal (§ Loading the board): one run per foreground load. A foreground load is one for a
  // week with nothing of it on screen; it streams, and the modal reports each part as the server sends it.
  const [loadRun, setLoadRun] = useState<{ id: number; progress: RefreshProgress; titles: LoadTitles } | null>(null);
  const [loadOpen, setLoadOpen] = useState(false);
  const loadOpenRef = useRef(false);
  loadOpenRef.current = loadOpen;
  /** The foreground stream in flight, so a newer load can cancel it. */
  const foreground = useRef<AbortController | null>(null);

  /**
   * `silent`: the week is already on screen (painted from the cache, or the 45 s tick, or a focus), so
   * plain JSON and no modal. Otherwise the board streams and the modal shows what really arrived. The
   * fetch itself always runs either way.
   */
  const load = useCallback(async (w: string | null, silent: boolean) => {
    const id = ++seq.current;
    // A newer load supersedes a foreground stream: cancel it, and its modal goes with it. (Only a
    // superseded run's modal closes: a finished or failed one stays until it closes itself or is closed.)
    const superseded = foreground.current;
    superseded?.abort();
    foreground.current = null;
    let result: { ok: true; board: BoardPayload } | { ok: false; error: string; code: string };

    if (silent) {
      if (superseded) {
        setLoadOpen(false);
        setLoadRun(null);
      }
      const res = await api<BoardPayload>(`/api/accounting-scoreboard${w ? `?week=${w}` : ''}`);
      if (id !== seq.current) return;
      result = res.ok ? { ok: true, board: res.data } : { ok: false, error: res.error, code: res.code };
    } else {
      setFetching(true);
      const ctrl = new AbortController();
      foreground.current = ctrl;
      const subject = w ? weekLabel(w) : 'the scoreboard';
      const titles: LoadTitles = {
        running: `Loading ${subject}`,
        done: w ? `${subject} is ready` : 'Scoreboard ready',
        failed: `Couldn't load ${subject}`,
      };
      setLoadRun({ id, progress: beginStep(startRefresh(boardLoadPlan(subject), clock()), 'access', clock()), titles });
      setLoadOpen(true);
      const update = (fn: (p: RefreshProgress) => RefreshProgress) => {
        if (id !== seq.current) return;
        setLoadRun((prev) => (prev && prev.id === id ? { ...prev, progress: fn(prev.progress) } : prev));
      };
      const streamed = await streamBoard(w, ctrl.signal, (event) => {
        // The route answered: the member check passed and every read has been sent.
        if (event.kind === 'opened') {
          update((p) => SERVER_LINES.reduce((q, line) => beginStep(q, line, clock()), completeStep(p, 'access', null, clock())));
        } else if (event.kind === 'line') {
          update((p) => completeStep(p, event.line, event.detail, clock()));
        }
      });
      if (id !== seq.current) return;
      foreground.current = null;
      if (streamed.ok) {
        result = { ok: true, board: streamed.board };
        // Every part answered and the board goes on screen in this same render; the effect below
        // fills the bar only once it has been painted.
        update((p) => applyRefresh(p, clock()));
      } else {
        result = { ok: false, error: streamed.error, code: streamed.code };
        update((p) => failRefresh(p, streamed.error, clock(), streamed.line ?? undefined));
        // Hidden by the viewer: nothing on screen would say it failed except the bar below the header.
        if (!loadOpenRef.current) toast.error(`${titles.failed}: ${streamed.error}`);
      }
    }

    if (result.ok) {
      liveWeek.current = result.board.weekStart;
      shownWeek.current = result.board.weekStart;
      setBoard(result.board);
      hasBoard.current = true;
      setFatal(null);
      setStale(null);
    } else if (hasBoard.current) {
      // A failed refresh OR a failed week change keeps the last good board and says so.
      setStale(result.error);
    } else {
      setFatal({ message: result.error, code: result.code });
    }
    setFetching(false);
  }, []);

  // The board from a foreground load has been committed: one painted frame later it is on screen, and
  // only then is the bar full and green. "Ready" holds long enough to read, then the modal closes.
  const applyingId = loadRun?.progress.phase === 'applying' ? loadRun.id : null;
  useEffect(() => {
    if (applyingId === null) return;
    let raf = 0;
    let timer = 0;
    const finish = () => setLoadRun((prev) => (prev && prev.id === applyingId ? { ...prev, progress: finishRefresh(prev.progress, clock()) } : prev));
    // A hidden browser tab paints no frames, so it gets a timer instead.
    if (document.hidden) timer = window.setTimeout(finish, 0);
    else raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(finish);
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [applyingId]);
  const doneId = loadRun?.progress.phase === 'done' ? loadRun.id : null;
  useEffect(() => {
    if (doneId === null) return;
    const t = window.setTimeout(() => setLoadOpen(false), LOAD_DONE_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [doneId]);

  useEffect(() => {
    // Silent when the week was just painted from the cache (the seed above ran first).
    void load(week, shownWeek.current === (week ?? thisWeekStart()));
    // The tick and a focus never interrupt a foreground load: they wait for the next turn.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && editing.current === 0 && !foreground.current) void load(week, true);
    }, REFRESH_MS);
    const onFocus = () => {
      if (editing.current === 0 && !foreground.current) void load(week, true);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [week, load]);

  // The onSnapshot listener (Kane, 2026-10-08: "Should use realtime feature of supabase", "onsnapshot listener"):
  // every board write route announces on Supabase Realtime Broadcast, so a teammate's save reaches this board in
  // a couple of seconds instead of on the next 45 s tick. It is the tick's silent re-read under the tick's rules:
  // never while a cell is being edited or a foreground load runs, and not in a hidden tab. A change that arrives
  // meanwhile waits, and is read as soon as they clear.
  useEffect(
    () =>
      onScoreboardSnapshot(() => void load(week, true), {
        blocked: () => editing.current > 0 || foreground.current !== null || document.visibilityState !== 'visible',
      }),
    [week, load],
  );

  const onEditing = useCallback((delta: 1 | -1) => {
    editing.current = Math.max(0, editing.current + delta);
  }, []);

  const resolved = useMemo(() => resolveSections(board?.settings ?? []), [board?.settings]);
  const sections = useMemo(
    () => boardSections(board?.settings ?? [], board?.customSections ?? []),
    [board?.settings, board?.customSections],
  );
  // Every section that is on gets a tab, except one shown inside its host's tab (Outcomes inside
  // Chargebacks, a custom section a manager put inside a built-in tab).
  const tabs = useMemo(() => tabSections(sections), [sections]);
  // A custom section shown inside another tab keeps its Overview card, right after its host's. A section
  // hidden from the Overview in Setup has none, and so is out of the Team Score (built from these cards).
  const cardSections = useMemo(() => overviewSections(sections), [sections]);
  const lookup = useMemo(() => buildLookup(board?.entries ?? []), [board?.entries]);

  // A tab whose section was just switched off falls back to the overview.
  // Setup is a tab only for a role that sees it: a Team member whose remembered tab is 'setup' lands on the Overview.
  const activeTab: Tab =
    tab === 'overview' || (tab === 'setup' && can(viewer.role, 'view_setup')) || tabs.some((s) => s.id === tab) ? tab : 'overview';

  // The mobile menu: the same tabs as the tab row, each section with its stop light for the week on
  // screen, from the summaries the Overview cards use.
  const menuItems = useMemo<DrawerItem<Tab>[]>(() => {
    if (!board) return [];
    const items: DrawerItem<Tab>[] = [{ key: 'overview', label: 'Overview', icon: LayoutGrid, light: null }];
    summarizeAll(board, tabs, lookup, new Date().toISOString(), sections).forEach(({ section, summary }, i) => {
      items.push({ key: section.id, label: section.tab, icon: sectionIcon(section), light: summary.light, divided: i === 0 });
    });
    if (can(board.viewer.role, 'view_setup')) items.push({ key: 'setup', label: 'Setup', icon: Settings2, light: null, divided: true });
    return items;
  }, [board, tabs, lookup]);

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
      // A meeting tick moves the all-time No Meeting Streak, which is read from every week, not just
      // the two loaded: re-read it now instead of waiting for the next refresh.
      if (slot === 'mtg') void load(week, true);
      return true;
    },
    [load, week],
  );

  const verifyCollection = useCallback(async (id: string, verified: boolean): Promise<boolean> => {
    const res = await api<{ verified: BoardPayload['collections'][number]['verified'] }>(
      '/api/accounting-scoreboard/collections/verify',
      { method: 'POST', body: JSON.stringify({ collectionId: id, verified }) },
    );
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    setBoard((prev) =>
      prev ? { ...prev, collections: prev.collections.map((c) => (c.id === id ? { ...c, verified: res.data.verified } : c)) } : prev,
    );
    return true;
  }, []);

  const logProblem = useCallback(
    async (p: NewProblem): Promise<boolean> => {
      const res = await api<{ problem: ProblemEntry }>('/api/accounting-scoreboard/problems', {
        method: 'POST',
        body: JSON.stringify(p),
      });
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      setBoard((prev) => (prev ? { ...prev, problems: [...prev.problems, res.data.problem] } : prev));
      toast.success(p.count === 1 ? 'Problem logged' : `${p.count} problems logged`);
      void load(week, true);
      return true;
    },
    [load, week],
  );

  const deleteProblem = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await api(`/api/accounting-scoreboard/problems?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(res.error);
        return false;
      }
      setBoard((prev) => (prev ? { ...prev, problems: prev.problems.filter((p) => p.id !== id) } : prev));
      void load(week, true);
      return true;
    },
    [load, week],
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

  // Rendered in every state below: the first load has nothing else on screen, and a failure keeps it open.
  const loadDialog = (
    <ScoreboardLoadDialog
      progress={loadRun?.progress ?? null}
      titles={loadRun?.titles ?? { running: 'Loading the scoreboard', done: 'Scoreboard ready', failed: "Couldn't load the scoreboard" }}
      open={loadOpen && loadRun !== null}
      onOpenChange={setLoadOpen}
      onRetry={() => void load(week, false)}
    />
  );

  if (fetching && !board) {
    return (
      <Shell>
        {/* Under the loading modal; it is what stays if the modal is closed while the board loads. */}
        <div className="flex flex-1 items-center justify-center gap-2 text-zinc-400">
          <Loader2 className="size-4 animate-spin" />
          <span className="text-[10px] uppercase tracking-[0.22em]">Loading the scoreboard</span>
        </div>
        {loadDialog}
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
        {loadDialog}
      </Shell>
    );
  }

  if (!board) return null;
  const rowsFor = (sectionId: string): BoardRow[] => board.rows.filter((r) => rowSectionId(r) === sectionId);
  const isThisWeek = week === null;
  const activeSection = tabs.find((s) => s.id === activeTab) ?? null;

  // Tab order for the slide direction: Overview, the sections that are on, Setup.
  const order: Tab[] = ['overview', ...tabs.map((s) => s.id), 'setup'];
  const selectTab = (next: Tab) => {
    if (next === activeTab) return;
    setDir(order.indexOf(next) >= order.indexOf(activeTab) ? 1 : -1);
    setTab(next);
  };
  const goWeek = (next: string | null, direction: 1 | -1) => {
    setDir(direction);
    setWeek(next);
  };
  const activeLabel =
    mode === 'tasks' ? 'Tasks' : activeTab === 'overview' ? 'Overview' : activeTab === 'setup' ? 'Setup' : (activeSection?.tab ?? 'Overview');

  const sectionGrid = (s: BoardSection) => (
    <SectionGrid
      key={s.id}
      section={s}
      rows={rowsFor(s.id)}
      weekStart={board.weekStart}
      lastWeekStart={board.lastWeekStart}
      today={board.today}
      lookup={lookup}
      canEditSetup={can(board.viewer.role, 'edit_setup')}
      onSave={saveEntry}
      onEditing={onEditing}
      lastMeetingDate={board.lastMeetingDate}
    />
  );
  /**
   * A tab's panel, then every section shown inside it (Outcomes under Open Disputes; a custom section
   * under any built-in section a manager put it in, whatever that section's own panel is).
   */
  const withHosted = (section: BoardSection, panel: ReactNode) => (
    <div className="space-y-8">
      {panel}
      {hostedSections(sections, section).map(sectionGrid)}
    </div>
  );
  const openCard = (id: string) => {
    const s = sections.find((x) => x.id === id);
    selectTab(s ? tabIdFor(sections, s) : id);
  };

  return (
    <Shell>
      {/* While the menu is open the page behind it is inert: no focus, no clicks, nothing read out. */}
      <div className="flex min-h-0 flex-1 flex-col" inert={menuOpen}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-orange-100/80 bg-white/90 px-4 py-3 backdrop-blur-md supports-[padding:max(0px)]:pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/90">
          <Button
            ref={burgerRef}
            type="button"
            variant="outline"
            size="icon"
            className={cn('md:hidden', mode === 'tasks' && 'hidden')}
            onClick={() => setMenuOpen(true)}
            aria-label="Open sections menu"
            aria-expanded={menuOpen}
            aria-controls={SECTIONS_NAV_ID}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 text-white shadow-sm">
              <Trophy className="size-4" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight text-zinc-900 sm:text-lg dark:text-zinc-100">
                Accounting Scoreboard
              </h1>
              <p className="hidden font-mono text-[11px] text-zinc-500 md:block">{board.viewer.email}</p>
              {/* Below md the tab row is in the menu, so the header says where you are. */}
              <p className="truncate text-xs font-medium text-orange-700 md:hidden dark:text-orange-300">{activeLabel}</p>
            </div>
          </div>
          <div role="group" aria-label="Scoreboard or tasks" className="flex rounded-lg border border-zinc-200 bg-white/70 p-0.5 dark:border-zinc-800 dark:bg-zinc-950/60">
            <SlidingPill layoutId="acct-sb-mode" active={mode === 'scoreboard'} onClick={() => setMode('scoreboard')}>
              <Trophy className="size-3.5" /> Scoreboard
            </SlidingPill>
            <SlidingPill layoutId="acct-sb-mode" active={mode === 'tasks'} onClick={() => setMode('tasks')}>
              <ListChecks className="size-3.5" /> Tasks
            </SlidingPill>
          </div>
          <div className={cn('ml-auto flex items-center gap-1.5 max-sm:w-full', mode === 'tasks' && 'hidden')}>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous week"
              onClick={() => goWeek(addDays(board.weekStart, -7), -1)}
            >
              <ChevronLeft />
            </Button>
            <div className="min-w-[10.5rem] overflow-hidden text-center max-sm:flex-1">
              <AnimatePresence mode="popLayout" initial={false} custom={dir}>
                <motion.div
                  key={board.weekStart}
                  custom={dir}
                  initial={{ opacity: 0, y: reduce ? 0 : dir >= 0 ? 6 : -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: reduce ? 0 : dir >= 0 ? -6 : 6, transition: { duration: 0.12 } }}
                  transition={{ duration: reduce ? 0 : 0.22, ease: EASE_TAB }}
                >
                  <div className="text-sm font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{weekLabel(board.weekStart)}</div>
                  <div className={cn(TINY_CAPS, 'text-[9px]', isThisWeek ? 'text-orange-600' : 'text-zinc-400')}>
                    {isThisWeek ? 'This week' : 'Past week'}
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Next week"
              disabled={isThisWeek}
              onClick={() => {
                const next = addDays(board.weekStart, 7);
                goWeek(next >= weekStartOf(board.today) ? null : next, 1);
              }}
            >
              <ChevronRight />
            </Button>
            {!isThisWeek ? (
              <Button size="sm" variant="ghost" onClick={() => goWeek(null, 1)}>
                This week
              </Button>
            ) : null}
            <span className="ml-1 flex w-4 justify-center" aria-live="polite">
              <AnimatePresence>
                {fetching ? (
                  <motion.span
                    key="spin"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    aria-label="Loading this week"
                  >
                    <Loader2 className="size-3.5 animate-spin text-zinc-400" />
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </span>
            {/* The sheet's "Totals - History", kept as typed (accounting-scoreboard-backfill.md; Open item 319). */}
            <a
              href="/accounting-scoreboard/archive"
              aria-label="Archive: the sheet's Totals - History"
              title="Archive: the sheet's Totals - History, kept as typed"
              className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-500 transition-colors hover:bg-orange-50 hover:text-orange-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 dark:border-zinc-800 dark:hover:bg-orange-950/30 dark:hover:text-orange-200"
            >
              <Archive className="size-4" />
            </a>
          </div>
        </header>

        <AnimatePresence initial={false}>
          {stale ? (
            <motion.div
              key="stale"
              initial={{ opacity: 0, y: reduce ? 0 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: 0.2, ease: EASE_TAB }}
              className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 sm:px-6 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              role="status"
            >
              <AlertTriangle className="size-3.5 shrink-0" />
              Couldn&rsquo;t refresh ({stale}). You&rsquo;re seeing the board as of the last good load.
            </motion.div>
          ) : null}
        </AnimatePresence>

        <nav
          className={cn(
            'hidden gap-1 overflow-x-auto border-b border-zinc-100 bg-white/90 px-3 py-2 sm:px-5 dark:border-zinc-900 dark:bg-zinc-950/90',
            mode === 'scoreboard' && 'md:flex',
          )}
          aria-label="Sections"
        >
          <SlidingPill layoutId="acct-sb-section-tab" active={activeTab === 'overview'} onClick={() => selectTab('overview')}>
            Overview
          </SlidingPill>
          {tabs.map((s) => (
            <SlidingPill key={s.id} layoutId="acct-sb-section-tab" active={activeTab === s.id} onClick={() => selectTab(s.id)}>
              {s.tab}
            </SlidingPill>
          ))}
          {can(board.viewer.role, 'view_setup') ? (
            <SlidingPill layoutId="acct-sb-section-tab" active={activeTab === 'setup'} onClick={() => selectTab('setup')}>
              <Settings2 className="size-3.5" /> Setup
            </SlidingPill>
          ) : null}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {/* overflow-x-clip, not hidden: the slide never spawns a scrollbar, and sticky headers keep working (§ 11.1). */}
          {mode === 'tasks' ? (
            <TasksPanel viewer={board.viewer} view={tasksView} onViewChange={setTasksView} />
          ) : (
            <div className="overflow-x-clip">
              <AnimatePresence mode="wait" initial={false} custom={dir}>
                <motion.div
                  key={`${activeTab}:${board.weekStart}`}
                  custom={dir}
                  variants={PANEL_VARIANTS}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: reduce ? 0 : 0.22, ease: EASE_TAB }}
                >
                  {activeTab === 'setup' ? (
                    <SetupPanel board={board} sections={sections} role={board.viewer.role} onChanged={() => void load(week, true)} />
                  ) : !activeSection ? (
                    <Overview board={board} sections={cardSections} all={sections} lookup={lookup} onOpen={openCard} />
                  ) : activeSection.kind === 'payroll_cycle' ? (
                    withHosted(
                      activeSection,
                      <PayrollCyclePanel
                        section={resolved.find((s) => s.key === 'payroll_timing')!}
                        weekStart={board.weekStart}
                        today={board.today}
                        events={board.payrollEvents}
                        firstClosedPeriodEnd={board.firstClosedPeriodEnd}
                      />,
                    )
                  ) : activeSection.kind === 'collections' ? (
                    withHosted(
                      activeSection,
                      <CollectionsPanel
                        section={resolved.find((s) => s.key === 'collections')!}
                        board={board}
                        rows={rowsFor('collections')}
                        onLog={logCollection}
                        onDelete={deleteCollection}
                        onVerify={verifyCollection}
                      />,
                    )
                  ) : activeSection.kind === 'problem_log' ? (
                    withHosted(
                      activeSection,
                      <ProblemsPanel
                        section={activeSection}
                        board={board}
                        rows={rowsFor(activeSection.id)}
                        lookup={lookup}
                        onLog={logProblem}
                        onDelete={deleteProblem}
                      />,
                    )
                  ) : (
                    withHosted(activeSection, sectionGrid(activeSection))
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </main>
      </div>

      <SectionsDrawer
        open={menuOpen}
        items={menuItems}
        active={activeTab}
        email={board.viewer.email}
        onSelect={(next) => {
          selectTab(next);
          setMenuOpen(false);
        }}
        onClose={() => setMenuOpen(false)}
      />
      {loadDialog}
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

/**
 * Every section's headline, stop light and Team Score card score for the week on screen. The Overview
 * cards, the Team Score and the mobile menu all read it, so none of them can disagree. `all` is every
 * section on the board: a card's group is the tab its grid sits on (tabIdFor).
 */
function summarizeAll(
  board: BoardPayload,
  sections: BoardSection[],
  lookup: ReturnType<typeof buildLookup>,
  nowIso: string,
  all: readonly BoardSection[],
) {
  const ctx: BoardContext = {
    lookup,
    collections: board.collections,
    problems: board.problems,
    payrollEvents: board.payrollEvents,
    firstClosedPeriodEnd: board.firstClosedPeriodEnd,
    today: board.today,
    nowIso,
  };
  return sections.map((s) => {
    const rows = board.rows.filter((r) => rowSectionId(r) === s.id);
    const rowCount = s.kind === 'payroll_cycle' ? null : rows.filter((r) => !r.archived).length;
    const dates = datesFor(board.weekStart, s.days);
    // Open Disputes' card is its score (Carla, 2026-10-07), and still says how many are open now and how
    // many are due in the next 7 days (her 2026-10-02 call-out). Outcomes' card is the win ratio.
    const disputes = s.key === 'chargebacks' ? amPmSectionStats(rows, dates, lookup, s.score, board.today) : null;
    const wins = s.kind === 'amount_count' ? winRatio(rows, dates, lookup) : null;
    const summary = summarizeSection(s, rows, ctx, board.weekStart, board.lastWeekStart);
    // Carla's Team Score (2026-10-07): the card's % of goal, on the same pace as its light. A past week is
    // judged on its full goal (pace 1), as its light is.
    const isCycle = s.kind === 'payroll_cycle';
    const cycleOf = (weekStart: string) => cycleWeek(board.payrollEvents, weekStart, nowIso, board.firstClosedPeriodEnd);
    const card: CardScore = isCycle ? cycleCardScore(cycleOf(board.weekStart)) : cardScore(s.goal, summary.headline, weekPace(dates, board.today));
    const lastCard: CardScore = isCycle ? cycleCardScore(cycleOf(board.lastWeekStart)) : cardScore(s.goal, summary.lastHeadline, 1);
    const groupId = tabIdFor(all, s);
    const groupLabel = all.find((x) => x.id === groupId)?.tab ?? s.tab;
    return {
      section: s,
      rowCount,
      disputes: disputes ? { openNow: disputes.openNow, dueSoon: disputes.dueSoonNow } : null,
      wins,
      summary,
      card,
      lastCard,
      groupId,
      groupLabel,
    };
  });
}

/** A 0–100 Team Score or group score: one decimal at most ("88.5", "100", "15.6"). */
function fmtTeam(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** The hero tile's own tint (not a button, so no hover). */
const TEAM_TILE: Record<Light, string> = {
  green: 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900/70 dark:bg-emerald-950/25',
  amber: 'border-amber-200 bg-amber-50/70 dark:border-amber-900/70 dark:bg-amber-950/25',
  red: 'border-rose-200 bg-rose-50/80 dark:border-rose-900/70 dark:bg-rose-950/30',
  none: 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950',
};

/**
 * Carla's Team Score (spec of 2026-10-07): one 0–100 number for every tab with a goal, beside the on
 * track / close / behind count, with last week's and the score of each tab that counts. The math is
 * team-score.ts; its bands are its own (90+ On track, 75–89.9 Close, below 75 Behind).
 */
function TeamScoreTile({
  team,
  last,
  tally,
  scope,
}: {
  team: TeamScore;
  last: TeamScore;
  tally: Record<'green' | 'amber' | 'red', number>;
  scope: string;
}) {
  return (
    <section aria-label="Team Score" className={cn('rounded-2xl border p-5 shadow-sm', TEAM_TILE[team.light])}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <StopLight light={team.light} className="mt-1" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Team Score</h3>
            <div className="mt-2 flex items-baseline gap-2">
              <span
                className={cn(
                  'font-mono text-6xl font-semibold leading-none tracking-tight tabular-nums',
                  team.score === null ? 'text-zinc-300 dark:text-zinc-700' : LIGHT_STYLE[team.light].number,
                )}
              >
                <Flash value={team.score} scope={scope}>
                  {fmtTeam(team.score)}
                </Flash>
              </span>
              <span className="text-sm text-zinc-500 dark:text-zinc-400">/ 100</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className={cn('font-semibold', team.score === null ? 'text-zinc-500 dark:text-zinc-400' : LIGHT_STYLE[team.light].text)}>
                {team.score === null ? 'Waiting on data' : LIGHT_LABEL[team.light]}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                Last week{' '}
                <span className={cn('font-mono font-semibold tabular-nums', LIGHT_STYLE[last.light].text)}>{fmtTeam(last.score)}</span>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="How the sections are doing">
          {(['green', 'amber', 'red'] as const).map((l) => (
            <span key={l} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold', LIGHT_STYLE[l].chip)}>
              <span className={cn('size-2 rounded-full', LIGHT_STYLE[l].dot)} />
              {tally[l]} {LIGHT_LABEL[l].toLowerCase()}
            </span>
          ))}
        </div>
      </div>
      {team.groups.length ? (
        <ul className="mt-4 flex flex-wrap gap-1.5 border-t border-black/5 pt-3 dark:border-white/10" aria-label="Score by tab">
          {team.groups.map((g) => (
            <li
              key={g.groupId}
              className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium', LIGHT_STYLE[teamLight(g.score)].chip)}
            >
              {g.label}
              <span className="font-mono font-semibold tabular-nums">{fmtTeam(g.score)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        Each goal&rsquo;s % of target, capped at 100 and judged on the same pace as its card, averaged by tab, then across the{' '}
        {team.groups.length} tab{team.groups.length === 1 ? '' : 's'} with a goal. A card with no numbers or no goal is left out, never
        counted as 0. 90+ is on track, 75–89.9 close.
      </p>
    </section>
  );
}

/**
 * Overview: one card per section, coloured like a stop light (Kane, 2026-10-01: red when we are
 * failing, amber in the middle, green when good), with big numbers and an icon that matches the KPI.
 * The light comes from stoplight.ts / payroll-cycle.ts through summarizeSection, the same call the
 * section headers make, so a card and its tab can never disagree.
 */
export function Overview({
  board,
  sections,
  all,
  lookup,
  onOpen,
}: {
  board: BoardPayload;
  /** The cards, in order (overviewSections). */
  sections: BoardSection[];
  /** Every section on the board, to find the tab (the Team Score group) each card sits on. */
  all: readonly BoardSection[];
  lookup: ReturnType<typeof buildLookup>;
  onOpen: (tab: Tab) => void;
}) {
  const nowIso = new Date().toISOString();
  // The cards, the tally and the Team Score are all this ONE list, so a section hidden from the Overview
  // (Setup → Sections) is left out of all three, and none of them can disagree with the cards on screen.
  const cards = summarizeAll(board, sections, lookup, nowIso, all);
  const tally = { green: 0, amber: 0, red: 0 };
  for (const c of cards) if (c.summary.light !== 'none') tally[c.summary.light]++;
  const cycle = cycleWeek(board.payrollEvents, board.weekStart, nowIso, board.firstClosedPeriodEnd);
  const team = teamScore(cards.map((c) => ({ groupId: c.groupId, groupLabel: c.groupLabel, card: c.card })));
  const lastTeam = teamScore(cards.map((c) => ({ groupId: c.groupId, groupLabel: c.groupLabel, card: c.lastCard })));
  // Never hidden silently: the Overview says which sections a manager took off it.
  const hidden = hiddenFromOverview(all);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">This week at a glance</h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          Every number adds itself up from what the team typed. This week&rsquo;s totals are judged on pace.
        </p>
      </div>
      <TeamScoreTile team={team} last={lastTeam} tally={tally} scope={board.weekStart} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ section, rowCount, disputes, wins, summary }) => (
          <OverviewCard
            key={section.id}
            section={section}
            summary={summary}
            rowCount={rowCount}
            disputes={disputes}
            wins={wins}
            scope={board.weekStart}
            cycleStartedAt={section.kind === 'payroll_cycle' ? cycle.startedAt : null}
            onOpen={() => onOpen(section.id)}
          />
        ))}
      </div>
      {hidden.length ? (
        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-600 dark:text-zinc-300">Not on the Overview:</span>{' '}
          {hidden.map((s) => s.title).join(', ')}. {hidden.length === 1 ? 'It keeps its tab and is' : 'They keep their tabs and are'} left
          out of the Team Score. A manager can show {hidden.length === 1 ? 'it' : 'them'} again in Setup → Sections.
        </p>
      ) : null}
    </div>
  );
}

function OverviewCard({
  section,
  summary,
  rowCount,
  disputes,
  wins,
  scope,
  cycleStartedAt,
  onOpen,
}: {
  section: BoardSection;
  summary: SectionSummary;
  rowCount: number | null;
  /** Open Disputes only: open now, and the latest "due in 7 days" reading. */
  disputes: { openNow: number | null; dueSoon: number | null } | null;
  /** Outcomes only: the week's wins and losses behind the ratio. */
  wins: WinRatio | null;
  scope: string;
  cycleStartedAt: string | null;
  onOpen: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const Icon = sectionIcon(section);
  const tone = LIGHT_STYLE[summary.light];
  const isCycle = section.kind === 'payroll_cycle';
  const fmt = headlineFormat(section);

  // Payroll Timing is only scored once Friday's close is decided; until then the card shows when this
  // week's cycle started, so it is never a blank "—" while processing is under way.
  const showStart = isCycle && summary.headline === null && cycleStartedAt !== null;
  const big = showStart ? formatEasternDateTime(cycleStartedAt!).split(' ').slice(1).join(' ') : fmt(summary.headline);
  const unit = showStart ? 'started' : headlineUnit(section);
  // Carla's spec: a card with nothing typed says so ("Waiting on data"), and one with no goal is "Not scored".
  const statusWord =
    summary.light !== 'none'
      ? LIGHT_LABEL[summary.light]
      : summary.headline === null && !showStart
        ? 'Waiting on data'
        : !section.goal
          ? 'Not scored'
          : LIGHT_LABEL.none;

  return (
    <motion.button
      type="button"
      onClick={onOpen}
      whileHover={reduce ? undefined : { y: -2 }}
      transition={{ type: 'spring', stiffness: 320, damping: 24 }}
      className={cn(
        'group flex flex-col rounded-2xl border p-5 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60',
        tone.tile,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md', tone.icon)}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{cardTitle(section)}</div>
            <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {/* Every section can take a goal in Setup since 2026-10-07. */}
              {section.goal ? `Goal ${goalText(section.goal)}` : 'No goal set'}
              {rowCount !== null ? ` · ${rowCount} ${section.rowNoun}${rowCount === 1 ? '' : 's'}` : ' · from HRIS'}
            </div>
          </div>
        </div>
        <StopLight light={summary.light} />
      </div>

      <div className="mt-5 flex items-baseline gap-2">
        {/* Absence is quiet, never a bright bar (ui-standards § 12.5). */}
        <span
          className={cn(
            'font-mono text-5xl font-semibold leading-none tracking-tight tabular-nums',
            big === '—' ? 'text-zinc-300 dark:text-zinc-700' : tone.number,
          )}
        >
          <Flash value={summary.headline} scope={scope}>
            {big}
          </Flash>
        </span>
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{unit}</span>
      </div>
      {disputes ? (
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-mono font-semibold tabular-nums">{fmtNum(disputes.openNow)}</span> open now
          {disputes.dueSoon !== null ? (
            <span className="font-semibold text-amber-700 dark:text-amber-300">
              {' · '}
              <span className="font-mono tabular-nums">{fmtNum(disputes.dueSoon)}</span> due in the next 7 days
            </span>
          ) : null}
        </div>
      ) : null}
      {wins ? (
        // Carla's spec: the sample size shows, so one decided chargeback reads as the small sample it is.
        <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400" title="Wins ÷ (wins + losses + Pre-arb), by the number of chargebacks. Pre-arb counts as a loss (Kane, 2026-10-07).">
          <span className="font-mono font-semibold tabular-nums">{fmtNum(wins.won)}</span> won ·{' '}
          <span className="font-mono font-semibold tabular-nums">{fmtNum(wins.lost)}</span> lost{' '}
          {wins.preArb ? <span>(incl. {fmtNum(wins.preArb)} Pre-arb){' '}</span> : null}
          <span className="font-mono tabular-nums">(n = {(wins.won ?? 0) + (wins.lost ?? 0)})</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/5 pt-3 text-xs dark:border-white/10">
        <span className={cn('font-semibold', summary.light === 'none' ? 'text-zinc-500 dark:text-zinc-400' : tone.text)}>{statusWord}</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          Last week{' '}
          <span className={cn('font-mono font-semibold tabular-nums', LIGHT_STYLE[summary.lastLight].text)}>{fmt(summary.lastHeadline)}</span>
        </span>
      </div>
    </motion.button>
  );
}

/** How a card's number prints: a cycle score or a win ratio as %, a 0–10 score with one decimal, else by its goal. */
function headlineFormat(s: BoardSection): (n: number | null) => string {
  if (s.kind === 'payroll_cycle' || s.kind === 'amount_count') return fmtPct;
  if (s.score) return fmtScore;
  return goalFormat(s.goal);
}

/** A card names its tab where the section's own title would not say it (Chargebacks holds two). */
function cardTitle(s: BoardSection): string {
  if (s.key === 'chargebacks') return 'Chargebacks — Open Disputes';
  if (s.key === 'chargeback_outcomes') return 'Chargebacks — Outcomes';
  return s.title;
}

function headlineUnit(s: BoardSection): string {
  if (s.key === 'custom') return s.kind === 'am_pm' ? 'score' : 'this week';
  switch (s.key) {
    case 'buckets':
      return 'overall score';
    case 'inbox':
      return 'avg score';
    case 'chargebacks':
      return 'score';
    case 'chargeback_outcomes':
      return 'won';
    case 'collections':
      return 'points';
    case 'pm_buckets':
      return 'avg in buckets';
    case 'payroll_timing':
      return 'cycle score';
    case 'onboarding':
      return 'payments';
    case 'compliance':
      return 'done';
    case 'cancellations':
      return 'reviewed';
    case 'payroll_problems':
      return 'problems';
    default:
      return 'this week';
  }
}
