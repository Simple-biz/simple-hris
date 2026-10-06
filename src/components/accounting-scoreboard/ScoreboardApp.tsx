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
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import { AlertTriangle, Archive, ChevronLeft, ChevronRight, LayoutGrid, Loader2, Menu, RefreshCw, Settings2, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  boardSections,
  hostedSections,
  resolveSections,
  rowSectionId,
  tabSections,
  type BoardSection,
  type Slot,
} from '@/lib/accounting-scoreboard/sections';
import { addDays, datesFor, formatEasternDateTime, weekLabel, weekStartOf } from '@/lib/accounting-scoreboard/week';
import { amPmSectionStats, buildLookup, entryKey, type ProblemEntry, type StoredEntry } from '@/lib/accounting-scoreboard/scoring';
import { summarizeSection, type BoardContext, type SectionSummary } from '@/lib/accounting-scoreboard/board';
import { cycleWeek } from '@/lib/accounting-scoreboard/payroll-cycle';
import { LIGHT_LABEL } from '@/lib/accounting-scoreboard/stoplight';
import { goalText } from '@/lib/accounting-scoreboard/scoring';
import type { BoardPayload, BoardRow } from '@/lib/accounting-scoreboard/types';
import { api, EASE_TAB, Flash, fmtNum, fmtScore, LIGHT_STYLE, sectionIcon, SlidingPill, StopLight, TINY_CAPS } from './shared';
import { PayrollCyclePanel } from './PayrollCyclePanel';
import { SectionGrid } from './SectionGrid';
import { CollectionsPanel, type NewCollection } from './CollectionsPanel';
import { ProblemsPanel, type NewProblem } from './ProblemsPanel';
import { SetupPanel } from './SetupPanel';
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

export default function ScoreboardApp() {
  const reduce = useReducedMotion() ?? false;
  const [dir, setDir] = useState(1);
  const [week, setWeek] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [fatal, setFatal] = useState<{ message: string; code: string } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const menuWasOpen = useRef(false);
  const editing = useRef(0);
  const seq = useRef(0);
  const hasBoard = useRef(false);

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
    } else if (hasBoard.current) {
      // A failed refresh OR a failed week change keeps the last good board and says so.
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

  const resolved = useMemo(() => resolveSections(board?.settings ?? []), [board?.settings]);
  const sections = useMemo(
    () => boardSections(board?.settings ?? [], board?.customSections ?? []),
    [board?.settings, board?.customSections],
  );
  // Every section that is on gets a tab, except one shown inside its host's tab (Outcomes inside Chargebacks).
  const tabs = useMemo(() => tabSections(sections), [sections]);
  const lookup = useMemo(() => buildLookup(board?.entries ?? []), [board?.entries]);

  // A tab whose section was just switched off falls back to the overview.
  const activeTab: Tab = tab === 'overview' || tab === 'setup' || tabs.some((s) => s.id === tab) ? tab : 'overview';

  // The mobile menu: the same tabs as the tab row, each section with its stop light for the week on
  // screen, from the summaries the Overview cards use.
  const menuItems = useMemo<DrawerItem<Tab>[]>(() => {
    if (!board) return [];
    const items: DrawerItem<Tab>[] = [{ key: 'overview', label: 'Overview', icon: LayoutGrid, light: null }];
    summarizeAll(board, tabs, lookup, new Date().toISOString()).forEach(({ section, summary }, i) => {
      items.push({ key: section.id, label: section.tab, icon: sectionIcon(section), light: summary.light, divided: i === 0 });
    });
    if (board.viewer.isManager) items.push({ key: 'setup', label: 'Setup', icon: Settings2, light: null, divided: true });
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
  const activeLabel = activeTab === 'overview' ? 'Overview' : activeTab === 'setup' ? 'Setup' : (activeSection?.tab ?? 'Overview');

  /** A grid section's panel, plus any section shown inside its tab (Outcomes under Open Disputes). */
  const gridPanel = (section: BoardSection) => (
    <div className="space-y-8">
      {[section, ...hostedSections(sections, section)].map((s) => (
        <SectionGrid
          key={s.id}
          section={s}
          rows={rowsFor(s.id)}
          weekStart={board.weekStart}
          lastWeekStart={board.lastWeekStart}
          today={board.today}
          lookup={lookup}
          isManager={board.viewer.isManager}
          onSave={saveEntry}
          onEditing={onEditing}
          lastMeetingDate={board.lastMeetingDate}
        />
      ))}
    </div>
  );

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
            className="md:hidden"
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
          <div className="ml-auto flex items-center gap-1.5 max-sm:w-full">
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
                {refreshing || loading ? (
                  <motion.span
                    key="spin"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    aria-label="Refreshing"
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
          className="hidden gap-1 overflow-x-auto border-b border-zinc-100 bg-white/90 px-3 py-2 sm:px-5 md:flex dark:border-zinc-900 dark:bg-zinc-950/90"
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
          {board.viewer.isManager ? (
            <SlidingPill layoutId="acct-sb-section-tab" active={activeTab === 'setup'} onClick={() => selectTab('setup')}>
              <Settings2 className="size-3.5" /> Setup
            </SlidingPill>
          ) : null}
        </nav>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          {/* overflow-x-clip, not hidden: the slide never spawns a scrollbar, and sticky headers keep working (§ 11.1). */}
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
                  <SetupPanel board={board} sections={sections} onChanged={() => void load(week, true)} />
                ) : !activeSection ? (
                  <Overview board={board} sections={tabs} lookup={lookup} onOpen={selectTab} />
                ) : activeSection.kind === 'payroll_cycle' ? (
                  <PayrollCyclePanel
                    section={resolved.find((s) => s.key === 'payroll_timing')!}
                    weekStart={board.weekStart}
                    today={board.today}
                    events={board.payrollEvents}
                    firstClosedPeriodEnd={board.firstClosedPeriodEnd}
                  />
                ) : activeSection.kind === 'collections' ? (
                  <CollectionsPanel
                    section={resolved.find((s) => s.key === 'collections')!}
                    board={board}
                    rows={rowsFor('collections')}
                    onLog={logCollection}
                    onDelete={deleteCollection}
                    onVerify={verifyCollection}
                  />
                ) : activeSection.kind === 'problem_log' ? (
                  <ProblemsPanel
                    section={activeSection}
                    board={board}
                    rows={rowsFor(activeSection.id)}
                    lookup={lookup}
                    onLog={logProblem}
                    onDelete={deleteProblem}
                  />
                ) : (
                  gridPanel(activeSection)
                )}
              </motion.div>
            </AnimatePresence>
          </div>
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
 * Every section's headline and stop light for the week on screen. The Overview cards and the mobile
 * menu both read it, so the two can never disagree.
 */
function summarizeAll(board: BoardPayload, sections: BoardSection[], lookup: ReturnType<typeof buildLookup>, nowIso: string) {
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
    // Open Disputes' card also says how many are due in the next 7 days (Carla's call-out).
    const dueSoon =
      s.kind === 'am_pm' && !s.score
        ? amPmSectionStats(rows, datesFor(board.weekStart, s.days), lookup, undefined, board.today).dueSoonNow
        : null;
    return { section: s, rowCount, dueSoon, summary: summarizeSection(s, rows, ctx, board.weekStart, board.lastWeekStart) };
  });
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
  lookup,
  onOpen,
}: {
  board: BoardPayload;
  sections: BoardSection[];
  lookup: ReturnType<typeof buildLookup>;
  onOpen: (tab: Tab) => void;
}) {
  const nowIso = new Date().toISOString();
  const cards = summarizeAll(board, sections, lookup, nowIso);
  const tally = { green: 0, amber: 0, red: 0 };
  for (const c of cards) if (c.summary.light !== 'none') tally[c.summary.light]++;
  const cycle = cycleWeek(board.payrollEvents, board.weekStart, nowIso, board.firstClosedPeriodEnd);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">This week at a glance</h2>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            Every number adds itself up from what the team typed. This week&rsquo;s totals are judged on pace.
          </p>
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
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ section, rowCount, dueSoon, summary }) => (
          <OverviewCard
            key={section.id}
            section={section}
            summary={summary}
            rowCount={rowCount}
            dueSoon={dueSoon}
            scope={board.weekStart}
            cycleStartedAt={section.kind === 'payroll_cycle' ? cycle.startedAt : null}
            onOpen={() => onOpen(section.id)}
          />
        ))}
      </div>
    </div>
  );
}

function OverviewCard({
  section,
  summary,
  rowCount,
  dueSoon,
  scope,
  cycleStartedAt,
  onOpen,
}: {
  section: BoardSection;
  summary: SectionSummary;
  rowCount: number | null;
  /** Open Disputes only: the latest "due in 7 days" reading. */
  dueSoon: number | null;
  scope: string;
  cycleStartedAt: string | null;
  onOpen: () => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const Icon = sectionIcon(section);
  const tone = LIGHT_STYLE[summary.light];
  const isCycle = section.kind === 'payroll_cycle';
  const fmt = isCycle ? (n: number | null) => (n === null ? '—' : `${n}%`) : section.goal?.measure === 'score' ? fmtScore : fmtNum;

  // Payroll Timing is only scored once Friday's close is decided; until then the card shows when this
  // week's cycle started, so it is never a blank "—" while processing is under way.
  const showStart = isCycle && summary.headline === null && cycleStartedAt !== null;
  const big = showStart ? formatEasternDateTime(cycleStartedAt!).split(' ').slice(1).join(' ') : fmt(summary.headline);
  const unit = showStart ? 'started' : headlineUnit(section);

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
            <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {section.key === 'chargebacks' ? 'Chargebacks' : section.title}
            </div>
            <div className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {section.goal ? `Goal ${goalText(section.goal)}` : section.key === 'custom' ? 'No goal set' : 'No goal on the sheet'}
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
      {dueSoon !== null ? (
        <div className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
          <span className="font-mono tabular-nums">{fmtNum(dueSoon)}</span> due in the next 7 days
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-black/5 pt-3 text-xs dark:border-white/10">
        <span className={cn('font-semibold', tone.text)}>{LIGHT_LABEL[summary.light]}</span>
        <span className="text-zinc-500 dark:text-zinc-400">
          Last week{' '}
          <span className={cn('font-mono font-semibold tabular-nums', LIGHT_STYLE[summary.lastLight].text)}>{fmt(summary.lastHeadline)}</span>
        </span>
      </div>
    </motion.button>
  );
}

function headlineUnit(s: BoardSection): string {
  if (s.key === 'custom') return s.kind === 'am_pm' ? 'score' : 'this week';
  switch (s.key) {
    case 'buckets':
      return 'overall score';
    case 'inbox':
      return 'avg score';
    case 'chargebacks':
      return 'open disputes';
    case 'chargeback_outcomes':
      return 'chargebacks';
    case 'collections':
      return 'points';
    case 'pm_buckets':
      return 'avg in buckets';
    case 'payroll_timing':
      return 'cycle score';
    case 'onboarding':
      return 'onboarded';
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
