'use client';

/**
 * The History tab (Kane, 2026-10-09: "This tab shows all the weeks and each KPI Card's performance like a histogram …
 * add like 3 KPI Cards that would highlight important stuffs. And like notes on the right side … like greatest week").
 * Governing doc: docs/features/accounting-scoreboard-history.md.
 *
 * Every number is the Overview's own for that week (history.ts). This panel only chooses which weeks to show and what
 * to point out. It reads one quarter at a time, newest first (GET /history), because one read of every week measured
 * 13.8–71 s. It paints the browser cache first and then reads every window again. A window that fails is retried once,
 * then named with a Try again: its weeks stay empty slots, never 0.
 *
 * Motion: a bar grows from its baseline once when it first appears (a CSS animation, staggered left to right), and a
 * changed value eases to its new height. The selected week is one band that glides across every chart. Under reduced
 * motion everything is simply there.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  ArrowUpRight,
  CalendarCheck,
  CalendarClock,
  ChartColumn,
  Loader2,
  RefreshCw,
  Star,
  Table2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  HISTORY_WINDOW_WEEKS,
  historyHighlights,
  historyNotes,
  historyWindows,
  rangeStart,
  weeksBetween,
  type HistoryNote,
  type HistoryPayload,
  type HistoryRange,
  type HistoryWeek,
  type HistoryWindow,
} from '@/lib/accounting-scoreboard/history';
import type { BoardSection } from '@/lib/accounting-scoreboard/sections';
import { goalText } from '@/lib/accounting-scoreboard/scoring';
import { LIGHT_LABEL, type Light } from '@/lib/accounting-scoreboard/stoplight';
import { TEAM_BANDS } from '@/lib/accounting-scoreboard/team-score';
import { readCachedHistory, writeCachedHistory } from '@/lib/accounting-scoreboard/tab-cache';
import { addDays, weekLabel, weekStartOf } from '@/lib/accounting-scoreboard/week';
import {
  api,
  cardTitle,
  EASE_SETTLE,
  EASE_TAB,
  headlineFormat,
  headlineUnit,
  LIGHT_STYLE,
  LoadingLines,
  ScrollEdgeFade,
  sectionIcon,
  SlidingPill,
  TINY_CAPS,
  useScrollEdges,
} from './shared';

const RANGES: { id: HistoryRange; label: string }[] = [
  { id: '12', label: '12 weeks' },
  { id: '26', label: '26 weeks' },
  { id: '52', label: '1 year' },
  { id: 'all', label: 'All' },
];

/** The stop light's own lamps (StopLight), as bar fills. A status colour, so a word always travels with it. */
const BAR_TONE: Record<Light, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-400',
  red: 'bg-rose-500',
  none: 'bg-zinc-300 dark:bg-zinc-600',
};

/** What the history read is really doing, cycled under the spinner while nothing is painted yet. */
const HISTORY_LOADING_LINES = [
  "Reading this quarter's numbers",
  'Adding up every card, week by week',
  'Judging each week against its goal',
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The Monday of a Sunday-keyed week: the board's weeks are Mon–Fri. */
const monday = (weekStart: string) => addDays(weekStart, 1);
const monthOf = (weekStart: string) => Number(monday(weekStart).slice(5, 7)) - 1;
const monthYear = (weekStart: string) => `${MONTHS[monthOf(weekStart)]} ${monday(weekStart).slice(0, 4)}`;
const shortDay = (weekStart: string) => `${MONTHS[monthOf(weekStart)]} ${Number(monday(weekStart).slice(8, 10))}`;

const fmt1 = (n: number | null) => (n === null || !Number.isFinite(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 }));
const signed1 = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt1(Math.abs(n))}`;

type LoadState =
  | { phase: 'loading'; loaded: number; total: number | null }
  | { phase: 'done'; loaded: number; total: number }
  | { phase: 'failed'; loaded: number; total: number | null; window: HistoryWindow; message: string };

interface HistoryData {
  firstWeek: string | null;
  sectionIds: string[];
  weeks: Record<string, HistoryWeek>;
}

/** A card's word for one week: its light, or why it has none. Colour is never the only signal. */
function cellWord(s: BoardSection, value: number | null, light: Light): string {
  if (light !== 'none') return LIGHT_LABEL[light];
  if (value === null) return s.kind === 'payroll_cycle' ? 'Not judged' : 'Nothing typed';
  return s.goal ? 'No call yet' : 'Not scored';
}

/** A clean top for a value axis: a score is 0–10, a percentage 0–100, anything else rounds up past its biggest week. */
function scaleMax(s: BoardSection, values: readonly number[]): number {
  if (s.kind === 'payroll_cycle' || s.kind === 'amount_count') return 100;
  if (s.score || s.goal?.measure === 'score') return 10;
  if (s.goal?.measure === 'ratio' || s.goal?.unit === '%') return 100;
  const top = Math.max(0, ...values, s.goal?.value ?? 0) * 1.08;
  if (top <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(top));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * pow >= top) ?? 10) * pow;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function HistoryPanel({
  sections,
  today,
  onOpenWeek,
}: {
  /** Every section on the board (boardSections), to name and format each card. */
  sections: readonly BoardSection[];
  /** US Eastern, from the board. */
  today: string;
  /** Open a week on the Overview. */
  onOpenWeek: (weekStart: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const thisWeek = weekStartOf(today);
  // Painted from the browser cache before anything is fetched (the panel mounts only once the board is on screen).
  const [data, setData] = useState<HistoryData | null>(() => {
    const cached = readCachedHistory();
    return cached ? { firstWeek: cached.firstWeek, sectionIds: cached.sectionIds, weeks: Object.fromEntries(cached.weeks.map((w) => [w.weekStart, w])) } : null;
  });
  const [load, setLoad] = useState<LoadState>({ phase: 'loading', loaded: 0, total: null });
  const [range, setRange] = useState<HistoryRange>('all');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const fetched = useRef(false);

  // Only what a read answered is written back, never the cached seed itself.
  useEffect(() => {
    if (!fetched.current || !data) return;
    writeCachedHistory({
      thisWeek,
      firstWeek: data.firstWeek,
      sectionIds: data.sectionIds,
      weeks: Object.values(data.weeks).sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    });
  }, [data, thisWeek]);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const merge = (p: HistoryPayload) => {
      fetched.current = true;
      setData((prev) => ({
        firstWeek: p.firstWeek,
        sectionIds: p.sectionIds,
        weeks: { ...(prev?.weeks ?? {}), ...Object.fromEntries(p.weeks.map((w) => [w.weekStart, w])) },
      }));
    };
    // One window, retried once when the failure could pass (a network blip, a 5xx). A refusal is final.
    const readWindow = async (w: HistoryWindow) => {
      let res = await api<HistoryPayload>(`/api/accounting-scoreboard/history?from=${w.from}&to=${w.to}`, { signal: ctrl.signal });
      if (!res.ok && alive && (res.status === 0 || res.status >= 500)) {
        await sleep(1200);
        if (!alive) return null;
        res = await api<HistoryPayload>(`/api/accounting-scoreboard/history?from=${w.from}&to=${w.to}`, { signal: ctrl.signal });
      }
      return alive ? res : null;
    };
    void (async () => {
      setLoad({ phase: 'loading', loaded: 0, total: null });
      const first: HistoryWindow = { from: addDays(thisWeek, -7 * (HISTORY_WINDOW_WEEKS - 1)), to: thisWeek };
      const head = await readWindow(first);
      if (!head) return;
      if (!head.ok) {
        setLoad({ phase: 'failed', loaded: 0, total: null, window: first, message: head.error });
        return;
      }
      merge(head.data);
      // The newest window is read; the rest go back a quarter at a time to the first week with a number.
      const older = historyWindows(thisWeek, head.data.firstWeek).slice(1);
      const total = older.length + 1;
      setLoad(older.length ? { phase: 'loading', loaded: 1, total } : { phase: 'done', loaded: 1, total });
      for (let i = 0; i < older.length; i++) {
        const res = await readWindow(older[i]);
        if (!res) return;
        if (!res.ok) {
          setLoad({ phase: 'failed', loaded: i + 1, total, window: older[i], message: res.error });
          return;
        }
        merge(res.data);
        setLoad(i === older.length - 1 ? { phase: 'done', loaded: total, total } : { phase: 'loading', loaded: i + 2, total });
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [thisWeek, attempt]);

  const cards = useMemo(
    () => (data?.sectionIds ?? []).map((id) => sections.find((s) => s.id === id)).filter((s): s is BoardSection => !!s),
    [data?.sectionIds, sections],
  );
  const domain = useMemo(() => weeksBetween(rangeStart(range, thisWeek, data?.firstWeek ?? null), thisWeek), [range, thisWeek, data?.firstWeek]);
  const shown = useMemo(() => domain.map((w) => data?.weeks[w]).filter((w): w is HistoryWeek => !!w), [domain, data?.weeks]);
  const highlights = useMemo(() => historyHighlights(shown, cards.map((c) => c.id)), [shown, cards]);
  const notes = useMemo(() => historyNotes(shown, cards.find((c) => c.key === 'collections')?.id ?? null), [shown, cards]);
  const lastFull = [...shown].reverse().find((w) => !w.partial)?.weekStart ?? thisWeek;
  const selected = pinned && domain.includes(pinned) ? pinned : lastFull;
  const active = hover ?? selected;
  const allLoaded = domain.every((w) => data?.weeks[w]);

  const scrollToCard = useCallback(
    (id: string) => {
      document.getElementById(`acct-sb-history-${id}`)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    },
    [reduce],
  );

  if (!data) {
    return load.phase === 'failed' ? (
      <FailedBox load={load} onRetry={() => setAttempt((n) => n + 1)} />
    ) : (
      <LoadingLines label="Loading the history" lines={HISTORY_LOADING_LINES} className="min-h-[40vh]" />
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">History</h2>
        <p className="mt-0.5 max-w-3xl text-xs text-zinc-500 dark:text-zinc-400">
          Every week the board holds, each judged the way its Overview was: this week on pace, a past week on its full goal,
          against today&rsquo;s goals.
        </p>
      </div>

      {/* One row of filters above everything they scope. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="Weeks shown" className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-950">
          {RANGES.map((r) => (
            <SlidingPill key={r.id} layoutId="acct-sb-history-range" active={range === r.id} onClick={() => setRange(r.id)}>
              {r.label}
            </SlidingPill>
          ))}
        </div>
        <div role="group" aria-label="Chart or table" className="flex rounded-lg border border-zinc-200 bg-white p-0.5 dark:border-zinc-800 dark:bg-zinc-950">
          <SlidingPill layoutId="acct-sb-history-view" active={view === 'chart'} onClick={() => setView('chart')}>
            <ChartColumn className="size-3.5" aria-hidden /> Chart
          </SlidingPill>
          <SlidingPill layoutId="acct-sb-history-view" active={view === 'table'} onClick={() => setView('table')}>
            <Table2 className="size-3.5" aria-hidden /> Table
          </SlidingPill>
        </div>
        <LoadStatus load={load} domain={domain} allLoaded={allLoaded} reduce={reduce} />
      </div>

      {load.phase === 'failed' ? <FailedBox load={load} onRetry={() => setAttempt((n) => n + 1)} inline /> : null}

      <HighlightCards highlights={highlights} cards={cards} shownWeeks={shown.filter((w) => !w.partial).length} reduce={reduce} onCard={scrollToCard} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0 space-y-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: reduce ? 0 : 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              transition={{ duration: reduce ? 0 : 0.22, ease: EASE_TAB }}
              className="space-y-4"
            >
              {view === 'chart' ? (
                <>
                  <TeamChart
                    key={`team:${range}`}
                    domain={domain}
                    weeks={data.weeks}
                    thisWeek={thisWeek}
                    active={active}
                    selected={selected}
                    onHover={setHover}
                    onPick={setPinned}
                    onOpenWeek={onOpenWeek}
                    reduce={reduce}
                  />
                  <div className="grid gap-4 xl:grid-cols-2">
                    {cards.map((s) => (
                      <CardChart
                        key={`${s.id}:${range}`}
                        section={s}
                        domain={domain}
                        weeks={data.weeks}
                        active={active}
                        onHover={setHover}
                        onPick={setPinned}
                        reduce={reduce}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <HistoryTable domain={domain} weeks={data.weeks} cards={cards} selected={selected} onPick={setPinned} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <NotesRail
          notes={notes}
          cards={cards}
          selected={selected}
          partial={load.phase !== 'done' || !allLoaded}
          shownWeeks={shown.length}
          reduce={reduce}
          onPick={(w) => {
            setPinned(w);
            setHover(null);
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading, failure
// ---------------------------------------------------------------------------

function LoadStatus({ load, domain, allLoaded, reduce }: { load: LoadState; domain: string[]; allLoaded: boolean; reduce: boolean }) {
  const text =
    load.phase === 'loading'
      ? load.total
        ? `Loading older weeks · ${load.loaded} of ${load.total} quarters`
        : 'Reading the newest weeks'
      : load.phase === 'failed'
        ? null
        : `${domain.length} week${domain.length === 1 ? '' : 's'} · since ${shortDay(domain[0])}, ${monday(domain[0]).slice(0, 4)}`;
  return (
    <span role="status" className="ml-auto inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <AnimatePresence initial={false} mode="popLayout">
        {load.phase === 'loading' ? (
          <motion.span key="spin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduce ? 0 : 0.15 }}>
            <Loader2 className="size-3.5 animate-spin text-orange-600" aria-hidden />
          </motion.span>
        ) : null}
      </AnimatePresence>
      {text}
      {load.phase === 'done' && !allLoaded ? ' · some weeks still empty' : null}
    </span>
  );
}

function FailedBox({ load, onRetry, inline = false }: { load: LoadState; onRetry: () => void; inline?: boolean }) {
  if (load.phase !== 'failed') return null;
  const span = load.window.from === load.window.to ? weekLabel(load.window.from) : `${shortDay(load.window.from)} – ${shortDay(load.window.to)}, ${monday(load.window.to).slice(0, 4)}`;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
        !inline && 'mx-auto mt-12 max-w-lg',
      )}
    >
      <TriangleAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        Couldn&rsquo;t load the weeks of {span} ({load.message}).{' '}
        {inline ? 'Those weeks and older stay empty, never 0.' : null}
      </span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw /> Try again
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three highlight cards
// ---------------------------------------------------------------------------

function HighlightCards({
  highlights,
  cards,
  shownWeeks,
  reduce,
  onCard,
}: {
  highlights: ReturnType<typeof historyHighlights>;
  cards: readonly BoardSection[];
  shownWeeks: number;
  reduce: boolean;
  onCard: (id: string) => void;
}) {
  const { team, steadiest, attention } = highlights;
  const titleOf = (id: string) => {
    const s = cards.find((c) => c.id === id);
    return s ? cardTitle(s) : id;
  };
  const rise = (i: number) => ({
    initial: { opacity: 0, y: reduce ? 0 : 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: reduce ? 0 : 0.32, delay: reduce ? 0 : i * 0.05, ease: EASE_SETTLE },
  });
  const up = team.delta !== null && team.delta > 0;
  const down = team.delta !== null && team.delta < 0;

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <motion.section {...rise(0)} aria-label="Team Score, last full week" className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Team Score</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{team.week ? `Week of ${shortDay(team.week)}, the last full week` : 'No full week scored yet'}</p>
          </div>
          {team.light !== 'none' ? (
            <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold', LIGHT_STYLE[team.light].chip)}>
              <span className={cn('size-1.5 rounded-full', LIGHT_STYLE[team.light].dot)} aria-hidden />
              {LIGHT_LABEL[team.light]}
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className={cn('text-4xl font-semibold leading-none tracking-tight', team.score === null ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-900 dark:text-zinc-50')}>
            {fmt1(team.score)}
          </span>
          <span className="text-sm text-zinc-500 dark:text-zinc-400">/ 100</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {team.delta !== null && team.previousWeek ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 font-semibold',
                up ? 'text-emerald-700 dark:text-emerald-300' : down ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-600 dark:text-zinc-300',
              )}
            >
              {up ? <TrendingUp className="size-3.5" aria-hidden /> : down ? <TrendingDown className="size-3.5" aria-hidden /> : null}
              {team.delta === 0 ? 'Level' : signed1(team.delta)} vs {shortDay(team.previousWeek)}
            </span>
          ) : null}
          <span className="text-zinc-500 dark:text-zinc-400">
            Average <span className="font-semibold text-zinc-700 dark:text-zinc-200">{fmt1(team.average)}</span> over {team.scoredWeeks} week
            {team.scoredWeeks === 1 ? '' : 's'}
          </span>
        </div>
      </motion.section>

      <motion.button
        {...rise(1)}
        type="button"
        disabled={!steadiest}
        onClick={() => steadiest && onCard(steadiest.sectionId)}
        className="group rounded-xl border border-zinc-200 bg-white p-4 text-left transition-colors hover:border-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 disabled:cursor-default disabled:hover:border-zinc-200 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-emerald-800"
      >
        <div className="flex items-center gap-2">
          <CalendarCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Most often on track</h3>
        </div>
        {steadiest ? (
          <>
            <p className="mt-3 truncate text-lg font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{titleOf(steadiest.sectionId)}</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              On track <span className="font-semibold">{steadiest.green}</span> of {steadiest.judged} judged week{steadiest.judged === 1 ? '' : 's'}
            </p>
            <Meter share={steadiest.green / Math.max(1, steadiest.judged)} tone="green" reduce={reduce} />
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No card was on track in these weeks.</p>
        )}
      </motion.button>

      <motion.button
        {...rise(2)}
        type="button"
        disabled={!attention}
        onClick={() => attention && onCard(attention.sectionId)}
        className="group rounded-xl border border-zinc-200 bg-white p-4 text-left transition-colors hover:border-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 disabled:cursor-default disabled:hover:border-zinc-200 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-rose-800"
      >
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-4 text-rose-600 dark:text-rose-400" aria-hidden />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Needs attention</h3>
        </div>
        {attention ? (
          <>
            <p className="mt-3 truncate text-lg font-semibold leading-tight text-zinc-900 dark:text-zinc-50">{titleOf(attention.sectionId)}</p>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">
              {attention.reason === 'running' ? (
                <>
                  Behind <span className="font-semibold">{attention.behindRun}</span> judged weeks running
                </>
              ) : (
                <>
                  Behind <span className="font-semibold">{attention.red}</span> of {attention.judged} judged week{attention.judged === 1 ? '' : 's'}
                </>
              )}
            </p>
            <Meter share={(attention.reason === 'running' ? attention.behindRun : attention.red) / Math.max(1, attention.judged)} tone="red" reduce={reduce} />
          </>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            {shownWeeks ? 'Nothing was behind in these weeks.' : 'No full week to judge yet.'}
          </p>
        )}
      </motion.button>
    </div>
  );
}

/** A share of judged weeks: the fill carries the state, the track is a lighter step of the same hue. */
function Meter({ share, tone, reduce }: { share: number; tone: 'green' | 'red'; reduce: boolean }) {
  return (
    <span aria-hidden className={cn('mt-3 block h-1.5 overflow-hidden rounded-full', tone === 'green' ? 'bg-emerald-100 dark:bg-emerald-950/60' : 'bg-rose-100 dark:bg-rose-950/60')}>
      <motion.span
        className={cn('block h-full origin-left rounded-full', tone === 'green' ? 'bg-emerald-500' : 'bg-rose-500')}
        initial={{ scaleX: reduce ? Math.min(1, share) : 0 }}
        animate={{ scaleX: Math.min(1, share) }}
        transition={{ duration: reduce ? 0 : 0.7, delay: reduce ? 0 : 0.15, ease: EASE_SETTLE }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Charts: one bar per week. The bars grow once from the baseline; the band shows the week being read.
// ---------------------------------------------------------------------------

interface Bar {
  week: string;
  loaded: boolean;
  value: number | null;
  light: Light;
  partial: boolean;
}

const GROW_CSS = `
@keyframes acctSbBarGrow { from { clip-path: inset(100% 0 0 0 round 3px 3px 0 0); } }
.acct-sb-bar { animation: acctSbBarGrow 720ms cubic-bezier(0.16, 1, 0.3, 1) backwards; transition: clip-path 520ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms; }
@media (prefers-reduced-motion: reduce) { .acct-sb-bar { animation: none; transition: none; } }
`;

/** The bars only: memoized, so moving the pointer re-renders the band and the readouts, never a thousand bars. */
const BarsLayer = memo(function BarsLayer({ bars, max, reduce }: { bars: readonly Bar[]; max: number; reduce: boolean }) {
  const n = bars.length;
  return (
    <div className="absolute inset-0 flex">
      {bars.map((b, i) => {
        const share = b.value === null ? 0 : Math.min(1, Math.max(0, b.value / max));
        return (
          <div key={b.week} className={cn('relative h-full flex-1', n > 60 ? 'px-[0.5px]' : 'px-px')}>
            {!b.loaded ? (
              // Not read yet: a quiet slot, never a zero.
              <div className="absolute inset-x-[1px] bottom-0 h-full rounded-[2px] bg-zinc-100 dark:bg-zinc-900" />
            ) : b.value === null ? null : (
              <div
                className={cn(
                  'acct-sb-bar absolute inset-x-[1px] bottom-0 mx-auto h-full max-w-6',
                  BAR_TONE[b.light],
                  b.partial && 'opacity-55',
                )}
                style={{
                  // A real 0 keeps a 2px stub, so it never reads as "nothing typed" (no bar at all).
                  clipPath: `inset(calc(${(1 - share) * 100}% - ${share === 0 ? 2 : 0}px) 0 0 0 round 3px 3px 0 0)`,
                  animationDelay: reduce ? undefined : `${Math.min(i * (420 / Math.max(n, 1)), 420)}ms`,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

function Band({ index, count, reduce }: { index: number; count: number; reduce: boolean }) {
  if (index < 0) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 rounded-[3px] bg-zinc-900/[0.07] dark:bg-white/[0.08]"
      style={{
        width: `${100 / count}%`,
        transform: `translateX(${index * 100}%)`,
        transition: reduce ? 'none' : 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    />
  );
}

/** The hit layer: a column per week, the whole height, so a reader aims at a week and never at a thin bar. */
function HitLayer({ domain, onHover, onPick }: { domain: string[]; onHover: (w: string | null) => void; onPick: (w: string) => void }) {
  return (
    <div className="absolute inset-0 flex" onPointerLeave={() => onHover(null)}>
      {domain.map((w) => (
        <div key={w} className="h-full flex-1 cursor-pointer" onPointerEnter={() => onHover(w)} onClick={() => onPick(w)} />
      ))}
    </div>
  );
}

/** Hairline reference lines at the given values, each labelled in the plot's right gutter (never dashed, never over a bar). */
function RefLines({ lines, max }: { lines: { value: number; label: string; strong?: boolean }[]; max: number }) {
  return (
    <>
      {lines.map((l) => (
        <div
          key={l.label}
          aria-hidden
          className={cn('pointer-events-none absolute inset-x-0 border-t', l.strong ? 'border-zinc-400/80 dark:border-zinc-500/80' : 'border-zinc-200/90 dark:border-zinc-800')}
          style={{ bottom: `${Math.min(100, (l.value / max) * 100)}%` }}
        >
          <span className={cn('absolute left-full top-0 ml-2 -translate-y-1/2 whitespace-nowrap text-[10px] leading-none', l.strong ? 'font-medium text-zinc-600 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-400')}>
            {l.label}
          </span>
        </div>
      ))}
    </>
  );
}

/** Month labels under a chart, spaced so they never collide: every month, or every 2nd, 3rd… */
function MonthAxis({ domain }: { domain: string[] }) {
  const starts = domain.map((w, i) => ({ w, i })).filter(({ w, i }) => i === 0 || monthOf(w) !== monthOf(domain[i - 1]));
  const step = Math.max(1, Math.ceil(starts.length / 9));
  const shown = starts.filter((_, k) => k % step === 0);
  return (
    <div aria-hidden className="relative mr-16 mt-1.5 h-4 text-[10px] text-zinc-500 dark:text-zinc-400">
      {shown.map(({ w, i }, k) => (
        <span
          key={w}
          className="absolute top-0 whitespace-nowrap"
          style={{ left: `${(i / domain.length) * 100}%`, transform: k === 0 ? undefined : 'translateX(-2px)' }}
        >
          {monthOf(w) === 0 || k === 0 ? monthYear(w) : MONTHS[monthOf(w)]}
        </span>
      ))}
    </div>
  );
}

function TeamChart({
  domain,
  weeks,
  thisWeek,
  active,
  selected,
  onHover,
  onPick,
  onOpenWeek,
  reduce,
}: {
  domain: string[];
  weeks: Record<string, HistoryWeek>;
  thisWeek: string;
  active: string;
  selected: string;
  onHover: (w: string | null) => void;
  onPick: (w: string) => void;
  onOpenWeek: (w: string) => void;
  reduce: boolean;
}) {
  const bars = useMemo<Bar[]>(
    () =>
      domain.map((w) => {
        const wk = weeks[w];
        return { week: w, loaded: !!wk, value: wk?.team.score ?? null, light: wk?.team.light ?? 'none', partial: wk?.partial ?? false };
      }),
    [domain, weeks],
  );
  const at = weeks[active];
  const idx = domain.indexOf(active);
  const scored = bars.filter((b) => b.value !== null && !b.partial).length;

  // Arrow keys move the selected week (one tab stop for the whole chart); Enter opens it on the Overview.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = domain.indexOf(selected);
    const go = (j: number) => {
      e.preventDefault();
      onPick(domain[Math.max(0, Math.min(domain.length - 1, j))]);
    };
    if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(domain.length - 1);
    else if (e.key === 'PageUp') go(i - 4);
    else if (e.key === 'PageDown') go(i + 4);
    else if (e.key === 'Enter') {
      e.preventDefault();
      onOpenWeek(selected);
    }
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Team Score by week</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {scored} scored week{scored === 1 ? '' : 's'}. A week counts only the tabs that had numbers that week.
          </p>
        </div>
        {/* The readout: the week the pointer is on, or the one picked. Every chart below reads the same week. */}
        <div aria-live="polite" className="flex items-center gap-3 text-right">
          <div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              {weekLabel(active)}
              {active === thisWeek ? ' · so far' : ''}
            </div>
            <div className="text-sm text-zinc-700 dark:text-zinc-200">
              <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{fmt1(at?.team.score ?? null)}</span>{' '}
              {at ? (at.team.light === 'none' ? (at.team.score === null ? 'No scored tabs' : '') : LIGHT_LABEL[at.team.light]) : 'Loading…'}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => onOpenWeek(active)} title="Open this week on the Overview">
            Open week <ArrowUpRight />
          </Button>
        </div>
      </div>
      <style>{GROW_CSS}</style>
      <div
        tabIndex={0}
        role="group"
        aria-label={`Team Score by week, ${domain.length} weeks. Left and right arrows pick a week; Enter opens it on the Overview. Picked: ${weekLabel(selected)}, ${fmt1(weeks[selected]?.team.score ?? null)}.`}
        onKeyDown={onKey}
        className="relative mr-16 mt-5 h-40 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60 focus-visible:ring-offset-4 dark:focus-visible:ring-offset-zinc-950"
      >
        <RefLines
          max={100}
          lines={[
            { value: 0, label: '0' },
            { value: TEAM_BANDS.amber, label: `${TEAM_BANDS.amber} close` },
            { value: TEAM_BANDS.green, label: `${TEAM_BANDS.green} on track`, strong: true },
          ]}
        />
        <Band index={idx} count={domain.length} reduce={reduce} />
        <BarsLayer bars={bars} max={100} reduce={reduce} />
        <HitLayer domain={domain} onHover={onHover} onPick={onPick} />
      </div>
      <MonthAxis domain={domain} />
      <LightKey />
    </section>
  );
}

function LightKey() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
      {(['green', 'amber', 'red'] as const).map((l) => (
        <span key={l} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn('h-2.5 w-1.5 rounded-t-[2px]', BAR_TONE[l])} />
          {LIGHT_LABEL[l]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-1.5 rounded-t-[2px] bg-zinc-300 dark:bg-zinc-600" />
        No goal or no call
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-1.5 rounded-t-[2px] bg-emerald-500 opacity-55" />
        This week, so far
      </span>
      <span>No bar: nothing typed that week</span>
    </div>
  );
}

function CardChart({
  section,
  domain,
  weeks,
  active,
  onHover,
  onPick,
  reduce,
}: {
  section: BoardSection;
  domain: string[];
  weeks: Record<string, HistoryWeek>;
  active: string;
  onHover: (w: string | null) => void;
  onPick: (w: string) => void;
  reduce: boolean;
}) {
  const Icon: LucideIcon = sectionIcon(section);
  const fmt = headlineFormat(section);
  const bars = useMemo<Bar[]>(
    () =>
      domain.map((w) => {
        const wk = weeks[w];
        const cell = wk?.cells[section.id];
        return { week: w, loaded: !!wk, value: cell?.value ?? null, light: cell?.light ?? 'none', partial: wk?.partial ?? false };
      }),
    [domain, weeks, section.id],
  );
  const max = useMemo(() => scaleMax(section, bars.flatMap((b) => (b.value === null ? [] : [b.value]))), [section, bars]);
  const tally = useMemo(() => {
    const t = { green: 0, amber: 0, red: 0, typed: 0 };
    for (const b of bars) {
      if (b.partial || !b.loaded) continue;
      if (b.value !== null) t.typed++;
      if (b.light !== 'none') t[b.light]++;
    }
    return t;
  }, [bars]);
  const cell = weeks[active]?.cells[section.id];
  const loaded = !!weeks[active];
  const value = cell?.value ?? null;
  const light = cell?.light ?? 'none';
  const below = section.goal?.direction === 'below';
  const goalShown = !!section.goal && section.goal.value > 0 && section.goal.value <= max;

  return (
    <section id={`acct-sb-history-${section.id}`} className="scroll-mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Icon className={cn('mt-0.5 size-4 shrink-0', LIGHT_STYLE[light].icon)} aria-hidden />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{cardTitle(section)}</h3>
            <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {section.goal ? `Goal ${goalText(section.goal)}` : 'No goal set'}
              {below ? ' · lower is better' : ''}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">
            <span className={cn('text-base font-semibold', value === null ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-900 dark:text-zinc-50')}>
              {loaded ? fmt(value) : '…'}
            </span>{' '}
            <span className="text-xs">{headlineUnit(section)}</span>
          </div>
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {shortDay(active)} · {loaded ? cellWord(section, value, light) : 'loading'}
          </div>
        </div>
      </div>
      <div
        role="img"
        aria-label={`${cardTitle(section)} by week: ${tally.typed} weeks with numbers; on track ${tally.green}, close ${tally.amber}, behind ${tally.red}. The table view lists every week.`}
        className="relative mr-14 mt-4 h-24"
      >
        <RefLines
          max={max}
          lines={[
            { value: 0, label: '0' },
            ...(goalShown ? [{ value: section.goal!.value, label: `goal ${fmt(section.goal!.value)}`, strong: true }] : []),
            // The top label steps aside when the goal line sits close under it, so two labels never stack.
            ...(goalShown && (max - section.goal!.value) / max < 0.18 ? [] : [{ value: max, label: fmt(max) }]),
          ]}
        />
        <Band index={domain.indexOf(active)} count={domain.length} reduce={reduce} />
        <BarsLayer bars={bars} max={max} reduce={reduce} />
        <HitLayer domain={domain} onHover={onHover} onPick={onPick} />
      </div>
      <div className="mr-14 mt-1.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
        <span>{monthYear(domain[0])}</span>
        <span className="truncate">
          {tally.green} on track · {tally.amber} close · {tally.red} behind
        </span>
        <span>{monthYear(domain[domain.length - 1])}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The table view: every value without hovering.
// ---------------------------------------------------------------------------

function HistoryTable({
  domain,
  weeks,
  cards,
  selected,
  onPick,
}: {
  domain: string[];
  weeks: Record<string, HistoryWeek>;
  cards: readonly BoardSection[];
  selected: string;
  onPick: (w: string) => void;
}) {
  const [ref, edges] = useScrollEdges<HTMLDivElement>();
  const rows = [...domain].reverse();
  const Dot = ({ light }: { light: Light }) => <span aria-hidden className={cn('inline-block size-1.5 shrink-0 rounded-full', LIGHT_STYLE[light].dot)} />;
  return (
    <div className="relative rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div ref={ref} className="max-h-[70vh] overflow-auto rounded-xl">
        <table className="table-keep w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className={cn(TINY_CAPS, 'sticky left-0 top-0 z-20 whitespace-nowrap bg-white px-3 py-2.5 text-left text-zinc-500 shadow-[inset_0_-1px_0_rgb(228_228_231)] dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-[inset_0_-1px_0_rgb(39_39_42)]')}>Week</th>
              <th className={cn(TINY_CAPS, 'sticky top-0 z-10 whitespace-nowrap bg-white px-3 py-2.5 text-right text-zinc-500 shadow-[inset_0_-1px_0_rgb(228_228_231)] dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-[inset_0_-1px_0_rgb(39_39_42)]')}>Team Score</th>
              {cards.map((s) => (
                <th key={s.id} className={cn(TINY_CAPS, 'sticky top-0 z-10 whitespace-nowrap bg-white px-3 py-2.5 text-right text-zinc-500 shadow-[inset_0_-1px_0_rgb(228_228_231)] dark:bg-zinc-950 dark:text-zinc-400 dark:shadow-[inset_0_-1px_0_rgb(39_39_42)]')}>
                  {cardTitle(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => {
              const wk = weeks[w];
              const picked = w === selected;
              return (
                <tr key={w} onClick={() => onPick(w)} className={cn('cursor-pointer', picked ? 'bg-orange-50/70 dark:bg-orange-950/20' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900/60')}>
                  <td className={cn('sticky left-0 z-10 whitespace-nowrap px-3 py-2 shadow-[inset_0_-1px_0_rgb(244_244_245)] dark:shadow-[inset_0_-1px_0_rgb(24_24_27)]', picked ? 'bg-orange-50 font-medium text-orange-950 dark:bg-[#1c1410] dark:text-orange-100' : 'bg-white text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300')}>
                    {weekLabel(w)}
                    {wk?.partial ? <span className={cn(TINY_CAPS, 'ml-1.5 text-[9px] text-orange-700 dark:text-orange-400')}>so far</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-zinc-900 shadow-[inset_0_-1px_0_rgb(244_244_245)] dark:text-zinc-100 dark:shadow-[inset_0_-1px_0_rgb(24_24_27)]">
                    {wk ? (
                      <span className="inline-flex items-center justify-end gap-1.5" title={wk.team.light === 'none' ? undefined : LIGHT_LABEL[wk.team.light]}>
                        {wk.team.light !== 'none' ? <Dot light={wk.team.light} /> : null}
                        {fmt1(wk.team.score)}
                      </span>
                    ) : (
                      <span className="text-zinc-400">…</span>
                    )}
                  </td>
                  {cards.map((s) => {
                    const c = wk?.cells[s.id];
                    return (
                      <td key={s.id} className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums text-zinc-800 shadow-[inset_0_-1px_0_rgb(244_244_245)] dark:text-zinc-200 dark:shadow-[inset_0_-1px_0_rgb(24_24_27)]">
                        {!wk ? (
                          <span className="text-zinc-400">…</span>
                        ) : (
                          <span className="inline-flex items-center justify-end gap-1.5" title={c ? cellWord(s, c.value, c.light) : undefined}>
                            {c && c.light !== 'none' ? <Dot light={c.light} /> : null}
                            <span className={c?.value === null || !c ? 'text-zinc-400 dark:text-zinc-500' : undefined}>{headlineFormat(s)(c?.value ?? null)}</span>
                            {c && c.light !== 'none' ? <span className="sr-only">{LIGHT_LABEL[c.light]}</span> : null}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ScrollEdgeFade side="left" shown={edges.left} className="from-white dark:from-zinc-950" />
      <ScrollEdgeFade side="right" shown={edges.right} className="from-white dark:from-zinc-950" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The notes rail: computed from the weeks shown, never typed.
// ---------------------------------------------------------------------------

const NOTE_ICON: Record<HistoryNote['kind'], LucideIcon> = {
  best_week: Star,
  toughest_week: TrendingDown,
  best_run: CalendarCheck,
  biggest_jump: TrendingUp,
  record: Star,
  this_week: CalendarClock,
};

function NotesRail({
  notes,
  cards,
  selected,
  partial,
  shownWeeks,
  reduce,
  onPick,
}: {
  notes: HistoryNote[];
  cards: readonly BoardSection[];
  selected: string;
  partial: boolean;
  shownWeeks: number;
  reduce: boolean;
  onPick: (w: string) => void;
}) {
  const describe = (n: HistoryNote): { title: string; value: string; detail: string } => {
    switch (n.kind) {
      case 'best_week':
        return { title: 'Greatest week', value: `${fmt1(n.score)} Team Score`, detail: weekLabel(n.week) };
      case 'toughest_week':
        return { title: 'Toughest week', value: `${fmt1(n.score)} Team Score`, detail: weekLabel(n.week) };
      case 'best_run':
        return { title: 'Longest on-track run', value: `${n.weeks} weeks in a row`, detail: `${shortDay(n.from)} – ${shortDay(n.week)}, ${monday(n.week).slice(0, 4)}` };
      case 'biggest_jump':
        return { title: 'Biggest jump', value: `${signed1(n.delta)} in one week`, detail: `${weekLabel(n.week)}, from ${shortDay(n.from)}` };
      case 'record': {
        const s = cards.find((c) => c.id === n.sectionId);
        return { title: s ? `Record ${s.tab.toLowerCase()} week` : 'Record week', value: `${s ? headlineFormat(s)(n.value) : n.value} ${s ? headlineUnit(s) : ''}`.trim(), detail: weekLabel(n.week) };
      }
      case 'this_week':
        return {
          title: 'This week so far',
          value: n.score === null ? 'Nothing scored yet' : `${fmt1(n.score)}${n.light === 'none' ? '' : ` · ${LIGHT_LABEL[n.light]}`}`,
          detail: 'Judged on pace until Friday',
        };
    }
  };

  return (
    <aside aria-label="Notes" className="lg:sticky lg:top-0 lg:self-start">
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Notes</h3>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          From the {shownWeeks} week{shownWeeks === 1 ? '' : 's'} shown{partial ? ', so far' : ''}. Pick one to see that week in every chart.
        </p>
        {notes.length ? (
          <ul className="mt-3 space-y-1">
            {notes.map((n, i) => {
              const d = describe(n);
              const Icon = NOTE_ICON[n.kind];
              const picked = n.week === selected;
              return (
                <motion.li
                  key={`${n.kind}:${n.week}`}
                  initial={{ opacity: 0, x: reduce ? 0 : 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: reduce ? 0 : 0.28, delay: reduce ? 0 : 0.1 + i * 0.04, ease: EASE_SETTLE }}
                >
                  <button
                    type="button"
                    onClick={() => onPick(n.week)}
                    aria-pressed={picked}
                    className={cn(
                      'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60',
                      picked ? 'bg-orange-50 dark:bg-orange-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                    )}
                  >
                    <Icon
                      aria-hidden
                      className={cn(
                        'mt-0.5 size-4 shrink-0',
                        n.kind === 'toughest_week' ? 'text-rose-600 dark:text-rose-400' : n.kind === 'this_week' ? 'text-zinc-500 dark:text-zinc-400' : 'text-orange-600 dark:text-orange-400',
                      )}
                    />
                    <span className="min-w-0">
                      <span className={cn('block text-xs font-semibold', picked ? 'text-orange-950 dark:text-orange-100' : 'text-zinc-900 dark:text-zinc-100')}>{d.title}</span>
                      <span className={cn('block text-sm', picked ? 'text-orange-950 dark:text-orange-100' : 'text-zinc-800 dark:text-zinc-200')}>{d.value}</span>
                      <span className={cn('block text-[11px]', picked ? 'text-orange-900/80 dark:text-orange-200/80' : 'text-zinc-500 dark:text-zinc-400')}>{d.detail}</span>
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Nothing to point out yet.</p>
        )}
      </div>
    </aside>
  );
}
