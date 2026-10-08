'use client';

/**
 * Tasks: the per-person task boards (plan Task 7 + 8, Open item 393), behind the header's Scoreboard | Tasks switch.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md.
 *
 * - Everyone opens on their OWN board and ticks their own tasks for the current period (today, this week, ...).
 * - An Admin or an Assistant gets a picker: a person's board, or Everyone (the All view: done of total per person).
 * - An Admin adds, renames and removes tasks, changes how often one is done (a new task: the old one is archived with
 *   its ticks), unticks anyone's, and posts the team's progress to Google Chat.
 * - As-needed tasks are listed last, never counted and never ticked.
 * Reads its own route (GET /api/accounting-scoreboard/tasks), never the board payload.
 *
 * Loading (Kane, 2026-10-08: "enhance skeleton loading on the table and store cache data"): a view PAINTS from the
 * browser cache before the first paint (`tab-cache.ts`, its own `tasks:<view>` keys) and is then fetched anyway,
 * silently. A view with nothing of it on screen shows a skeleton shaped like what arrives, never a spinner, and a
 * refetch never re-skeletons. The viewer's role is a permission: it comes from the page on every load and is never
 * cached, and someone else's board or Everyone paints from the cache only for a role that may see it now.
 *
 * Over the skeleton, the loading card (Kane, 2026-10-08: "on top of the skeleton lets add the modal loading similar to
 * HRIS - NPD"; `TasksLoadCard`): that read streams (`?stream=1`, task-load-progress.ts) and each line ticks as its read
 * answers. Only a read with a skeleton under it has a card; a silent revalidation and a Refresh click have none.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Check, ClipboardCopy, Loader2, MessageSquareShare, Pencil, Plus, RefreshCw, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { can } from '@/lib/accounting-scoreboard/roles';
import {
  COUNTED_FREQUENCIES,
  FREQUENCY_LABEL,
  PERIOD_WORDS,
  TASK_FREQUENCIES,
  progressByOwner,
  taskProgress,
  type FrequencyProgress,
  type TaskFrequency,
  type TaskLike,
} from '@/lib/accounting-scoreboard/tasks';
import { buildProgressMessage } from '@/lib/accounting-scoreboard/chat-summary';
import { dayHeader, todayEastern } from '@/lib/accounting-scoreboard/week';
import { clearCachedTasks, readCachedTasks, writeCachedTasks } from '@/lib/accounting-scoreboard/tab-cache';
import {
  TASK_LOAD_LINES,
  createTasksStreamAssembler,
  tasksLoadPlan,
  type TaskServerLine,
  type TasksStreamEvent,
} from '@/lib/accounting-scoreboard/task-load-progress';
import type { BoardPayload, BoardTask, TaskCheck, TasksPayload } from '@/lib/accounting-scoreboard/types';
import {
  applyRefresh,
  beginStep,
  completeStep,
  failRefresh,
  finishRefresh,
  startRefresh,
  type RefreshProgress,
} from '@/lib/refresh-progress/refresh-progress';
import type { LoadTitles } from './ScoreboardLoadDialog';
import { TASKS_CARD_FADE_MS, TASKS_CARD_HOLD_MS, TasksLoadCard } from './TasksLoadCard';
import { api, TINY_CAPS } from './shared';

/** 'me' (your own board), 'all' (Everyone), or a board person's work email. */
export type TasksView = 'me' | 'all' | string;

/** The payload on screen and the view it answers. It is shown only while that view is the one picked. */
type Shown = { view: TasksView; payload: TasksPayload };

type ChangeFrequency = (task: BoardTask, frequency: TaskFrequency, title: string | undefined) => Promise<boolean>;

const FREQUENCY_OPTIONS = TASK_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }));

const asLike = (t: BoardTask): TaskLike => ({ id: t.id, ownerEmail: t.ownerEmail, frequency: t.frequency, archived: false });

/** Runs before paint in the browser; a plain effect on the server, where there is nothing to seed. */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const SERVER_LINES = TASK_LOAD_LINES.filter((l): l is TaskServerLine => l !== 'access');
const reducedMotion = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type LoadResult = { ok: true; data: TasksPayload } | { ok: false; status: number; error: string; code: string };

/**
 * Read one board as a stream (GET ?stream=1, task-load-progress.ts), reporting `opened` when the route answered and
 * each `line` as it arrives. Fail-closed: anything short of a whole, valid view of `view` is a failure with the reason
 * (and, when the server said, whose read failed).
 */
async function streamTasks(
  view: TasksView,
  signal: AbortSignal,
  on: (event: { kind: 'opened' } | TasksStreamEvent) => void,
): Promise<{ ok: true; tasks: TasksPayload } | { ok: false; status: number; error: string; code: string; line: TaskServerLine | null }> {
  try {
    const res = await fetch(`/api/accounting-scoreboard/tasks?person=${encodeURIComponent(view)}&stream=1`, { cache: 'no-store', signal });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      return { ok: false, status: res.status, error: body?.error ?? `The server answered ${res.status}.`, code: body?.code ?? 'http_error', line: null };
    }
    on({ kind: 'opened' });
    const assembler = createTasksStreamAssembler(view);
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
    const result = assembler.finish();
    return result.ok ? result : { ...result, status: 500 };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Network error', code: 'network', line: null };
  }
}

/** The card's words for one board: whose tasks, as its title and lines say them. */
function cardWords(view: TasksView, nameOf: (email: string) => string): { titles: LoadTitles; whose: string; subject: string } {
  const whose = view === 'me' ? 'your' : view === 'all' ? "everyone's" : `${nameOf(view)}'s`;
  const Whose = whose.charAt(0).toUpperCase() + whose.slice(1);
  return {
    whose,
    subject: `${whose} tasks`,
    titles: { running: `Loading ${whose} tasks`, done: `${Whose} tasks are ready`, failed: `Couldn't load ${whose} tasks` },
  };
}

/** The loading card of one streamed read. Only the card of the board picked is shown. */
type Card = { id: number; view: TasksView; progress: RefreshProgress; titles: LoadTitles; leaving: boolean };

function progressTone(p: FrequencyProgress): string {
  if (p.done === p.total) return 'text-emerald-700 dark:text-emerald-300';
  if (p.done === 0) return 'text-rose-700 dark:text-rose-300';
  return 'text-amber-700 dark:text-amber-300';
}

/**
 * `view` lives in ScoreboardApp, so switching to the Scoreboard and back lands on the same board. The cache is bound
 * to the viewer there, before this panel can mount.
 */
export function TasksPanel({
  viewer,
  view,
  onViewChange,
}: {
  viewer: BoardPayload['viewer'];
  view: TasksView;
  onViewChange: (view: TasksView) => void;
}) {
  const [data, setData] = useState<Shown | null>(null);
  const [error, setError] = useState<{ view: TasksView; message: string } | null>(null);
  // Only a Refresh click spins: revalidating a view already on screen is silent, like the board's.
  const [refreshing, setRefreshing] = useState(false);
  const seq = useRef(0);
  /** The view the server last answered for. Only THAT view is written back to the cache, never a cached seed. */
  const liveView = useRef<TasksView | null>(null);
  /** The view whose tasks are on screen (painted from the cache or fetched). Its read is silent: no card. */
  const shownView = useRef<TasksView | null>(null);
  /** The streamed read in flight, so a newer read (another board picked) cancels it, and its card goes with it. */
  const foreground = useRef<AbortController | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  /** For the card's words: the last people list the server sent (the picker's). */
  const peopleRef = useRef<TasksPayload['people']>(null);
  peopleRef.current = data?.payload.people ?? peopleRef.current;

  // Paint the view from the cache before the browser paints. It never decides: the fetch below runs anyway, and its
  // answer replaces it. `viewer` is deliberately not a dependency (the board's rule): a role change arrives with the
  // page, and the role passed here is the one the page resolved, never a cached one.
  useIsoLayoutEffect(() => {
    const cached = readCachedTasks(view, todayEastern(), viewer.role);
    if (!cached) return;
    shownView.current = view;
    setData((prev) => (prev?.view === view ? prev : { view, payload: { ...cached, viewer } }));
  }, [view]);

  /**
   * A view already on screen is re-read silently (plain JSON; a Refresh click spins its button). A view with nothing
   * on screen streams, and its card over the skeleton reports each read as it really answers.
   */
  const load = useCallback(async (next: TasksView, click: boolean) => {
    const id = ++seq.current;
    foreground.current?.abort();
    foreground.current = null;
    let res: LoadResult;
    if (shownView.current === next) {
      setCard(null); // a superseded read's card goes with it
      if (click) setRefreshing(true);
      res = await api<TasksPayload>(`/api/accounting-scoreboard/tasks?person=${encodeURIComponent(next)}`);
      if (id !== seq.current) return;
      setRefreshing(false);
    } else {
      const ctrl = new AbortController();
      foreground.current = ctrl;
      // A new attempt (Try again, or this board picked again): the old failure goes, the skeleton and a new card say
      // what this read is doing, and a new failure brings the box back.
      setError((e) => (e?.view === next ? null : e));
      const words = cardWords(next, (email) => peopleRef.current?.find((p) => p.email === email)?.name ?? email.split('@')[0]);
      setCard({
        id,
        view: next,
        titles: words.titles,
        progress: beginStep(startRefresh(tasksLoadPlan(words.subject, words.whose), clock()), 'access', clock()),
        leaving: false,
      });
      const update = (fn: (p: RefreshProgress) => RefreshProgress) => {
        if (id !== seq.current) return;
        setCard((c) => (c && c.id === id ? { ...c, progress: fn(c.progress) } : c));
      };
      const streamed = await streamTasks(next, ctrl.signal, (event) => {
        // The route answered: the member check passed, who may see this board is settled, and every read was sent.
        if (event.kind === 'opened') {
          update((p) => SERVER_LINES.reduce((q, line) => beginStep(q, line, clock()), completeStep(p, 'access', null, clock())));
        } else if (event.kind === 'line') {
          update((p) => completeStep(p, event.line, event.detail, clock()));
        }
      });
      if (id !== seq.current) return;
      foreground.current = null;
      setRefreshing(false);
      if (streamed.ok) {
        // Every read answered and the tasks go on screen in this same render; the effect below fills the bar only
        // once they have been painted.
        update((p) => applyRefresh(p, clock()));
        res = { ok: true, data: streamed.tasks };
      } else {
        update((p) => failRefresh(p, streamed.error, clock(), streamed.line ?? undefined));
        res = { ok: false, status: streamed.status, error: streamed.error, code: streamed.code };
      }
    }
    if (!res.ok) {
      // A refusal is the server deciding this viewer may not see the view: it leaves the screen and never paints from
      // the cache again. Any other failure keeps the last good view on screen and says so; it never blanks it.
      if (res.status === 401 || res.status === 403) {
        clearCachedTasks(next);
        if (shownView.current === next) shownView.current = null;
        setData((d) => (d?.view === next ? null : d));
      }
      setError({ view: next, message: res.error });
      return;
    }
    liveView.current = next;
    shownView.current = next;
    setError(null);
    setData({ view: next, payload: res.data });
  }, []);

  useEffect(() => {
    void load(view, false);
  }, [load, view]);

  // Leaving the Tasks view cancels a streamed read; nothing it would have painted is on screen any more.
  useEffect(() => () => foreground.current?.abort(), []);

  // The tasks of a streamed read have been committed: one painted frame later they are on screen, and only then is
  // the bar full and green. "Tasks ready" holds long enough to read, then the card fades and goes.
  const applyingId = card?.progress.phase === 'applying' ? card.id : null;
  useEffect(() => {
    if (applyingId === null) return;
    let raf = 0;
    let timer = 0;
    const finish = () => setCard((c) => (c && c.id === applyingId ? { ...c, progress: finishRefresh(c.progress, clock()) } : c));
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
  const doneId = card?.progress.phase === 'done' ? card.id : null;
  useEffect(() => {
    if (doneId === null) return;
    const fade = reducedMotion() ? 0 : TASKS_CARD_FADE_MS;
    const t1 = window.setTimeout(() => setCard((c) => (c && c.id === doneId ? { ...c, leaving: true } : c)), TASKS_CARD_HOLD_MS);
    const t2 = window.setTimeout(() => setCard((c) => (c && c.id === doneId ? null : c)), TASKS_CARD_HOLD_MS + fade);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [doneId]);

  // Write back what the server answered (and edits made on top of it), never the seed: re-writing a seed would
  // restamp stale data as fresh.
  useEffect(() => {
    if (data && data.view === liveView.current) writeCachedTasks(data.view, data.payload);
  }, [data]);

  const shown = data && data.view === view ? data.payload : null;
  const viewError = error && error.view === view ? error.message : null;
  const role = shown?.viewer.role ?? viewer.role;
  const seesAll = can(role, 'view_all_tasks');
  const manages = can(role, 'manage_tasks');

  // The picker keeps the last list it had while another view loads, so it never collapses under the skeleton.
  const people = data?.payload.people ?? null;
  const pickerOptions = useMemo(
    () => [
      { value: 'me', label: 'My tasks' },
      { value: 'all', label: 'Everyone' },
      ...(people ?? []).filter((p) => p.email !== viewer.email).map((p) => ({ value: p.email, label: p.name })),
    ],
    [people, viewer.email],
  );

  /** Edits land on the view on screen (only a shown view has controls). */
  const edit = (fn: (p: TasksPayload) => TasksPayload) => setData((d) => (d ? { ...d, payload: fn(d.payload) } : d));

  const onTick = async (task: BoardTask, done: boolean) => {
    const res = await api<{ check: TaskCheck | null }>('/api/accounting-scoreboard/tasks/checks', {
      method: 'POST',
      body: JSON.stringify({ taskId: task.id, done }),
    });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    edit((d) => {
      const others = d.checks.filter((c) => c.taskId !== task.id);
      return { ...d, checks: res.data.check ? [...others, res.data.check] : others };
    });
    return true;
  };

  const onAdd = async (ownerEmail: string, title: string, frequency: TaskFrequency) => {
    const res = await api<{ task: BoardTask }>('/api/accounting-scoreboard/tasks', {
      method: 'POST',
      body: JSON.stringify({ ownerEmail, title, frequency }),
    });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    edit((d) => ({ ...d, tasks: [...d.tasks, res.data.task] }));
    return true;
  };

  const onPatch = async (task: BoardTask, patch: { title?: string; archived?: true }) => {
    const res = await api<{ task: BoardTask; archived: boolean }>('/api/accounting-scoreboard/tasks', {
      method: 'PATCH',
      body: JSON.stringify({ id: task.id, ...patch }),
    });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    edit((d) => {
      const tasks = res.data.archived ? d.tasks.filter((t) => t.id !== task.id) : d.tasks.map((t) => (t.id === task.id ? res.data.task : t));
      return { ...d, tasks, checks: res.data.archived ? d.checks.filter((c) => c.taskId !== task.id) : d.checks };
    });
    return true;
  };

  // A new frequency is a new task (the doc's rule): the server adds it and archives this one, which keeps its ticks.
  const onChangeFrequency: ChangeFrequency = async (task, frequency, title) => {
    const res = await api<{ task: BoardTask; replacedId: string }>('/api/accounting-scoreboard/tasks/frequency', {
      method: 'POST',
      body: JSON.stringify({ id: task.id, frequency, ...(title !== undefined ? { title } : {}) }),
    });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    const { task: added, replacedId } = res.data;
    edit((d) => ({
      ...d,
      tasks: [...d.tasks.filter((t) => t.id !== replacedId), added],
      checks: d.checks.filter((c) => c.taskId !== replacedId),
    }));
    toast.success(`Now ${FREQUENCY_LABEL[frequency].toLowerCase()}: "${added.title}"`);
    return true;
  };

  const today = shown?.today;
  const todayText = today ? `${dayHeader(today).weekday} ${dayHeader(today).short}` : '';
  const eastern = dayHeader(todayEastern());
  const cardSubtitle = `Today is ${eastern.weekday} ${eastern.short}, US Eastern`;
  const nameOf = (email: string) => people?.find((p) => p.email === email)?.name ?? email.split('@')[0];
  const heading = shown
    ? shown.view.kind === 'all'
      ? 'Everyone'
      : shown.view.own
        ? 'My tasks'
        : `${shown.view.person.name}'s tasks`
    : view === 'all'
      ? 'Everyone'
      : view === 'me'
        ? 'My tasks'
        : `${nameOf(view)}'s tasks`;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{heading}</h2>
          <p className="text-xs text-zinc-500">
            Ticks count for the current period: today for daily tasks, this week for weekly ones, and so on (US Eastern
            {todayText ? `, today is ${todayText}` : ''}).
          </p>
        </div>
        {seesAll ? (
          <SmoothSelect
            value={view}
            onChange={(v) => onViewChange(v)}
            options={pickerOptions}
            accent="orange"
            align="start"
            portal
            searchable={pickerOptions.length > 8}
            aria-label="Whose tasks"
            triggerClassName="h-9 min-w-44 text-sm"
          />
        ) : null}
        <Button size="icon-sm" variant="outline" aria-label="Refresh tasks" disabled={refreshing} onClick={() => void load(view, true)}>
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {viewError ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          {shown ? `Couldn't refresh (${viewError}). You're seeing these tasks as of the last good load.` : viewError}
          <Button className="ml-3" size="xs" variant="outline" onClick={() => void load(view, true)}>
            Try again
          </Button>
        </div>
      ) : null}

      {/* The frame the loading card floats in: over the skeleton, then over the tasks while "ready" holds. */}
      <div className={cn('relative', !shown && viewError && card?.view === view && 'min-h-72')}>
        {shown ? (
          shown.view.kind === 'all' ? (
            <EveryoneView data={shown} manages={manages} onOpen={(email) => onViewChange(email)} />
          ) : (
            <PersonBoard
              data={shown}
              canTick={shown.view.own}
              canUntickAny={manages}
              manages={manages}
              onTick={onTick}
              onAdd={(title, frequency) => (shown.view.kind === 'person' ? onAdd(shown.view.person.email, title, frequency) : Promise.resolve(false))}
              onPatch={onPatch}
              onChangeFrequency={onChangeFrequency}
            />
          )
        ) : viewError ? null : view === 'all' ? (
          <EveryoneSkeleton manages={manages} />
        ) : (
          <PersonBoardSkeleton manages={manages} />
        )}
        {card && card.view === view ? (
          <TasksLoadCard progress={card.progress} titles={card.titles} subtitle={cardSubtitle} leaving={card.leaving} />
        ) : null}
      </div>
    </div>
  );
}

/* ── Skeletons: shaped like what arrives, on the same cards (ui-standards § 12.3), for the first paint only ── */

const BAR = 'skeleton-shimmer rounded';
const TITLE_WIDTHS = ['w-2/3', 'w-1/2', 'w-3/4', 'w-5/12', 'w-7/12', 'w-1/3'];
const NAME_WIDTHS = ['w-28', 'w-36', 'w-24', 'w-32', 'w-20', 'w-28'];

/** The card over it announces each read (aria-live), so the skeleton itself only says it is busy. */
function TasksLoading({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4" aria-busy="true">
      {children}
    </div>
  );
}

/** One person's board: the Add form (Admins), then frequency cards of task rows, a checkbox and a title each. */
function PersonBoardSkeleton({ manages }: { manages: boolean }) {
  return (
    <TasksLoading>
      {manages ? (
        <div aria-hidden className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-200/70 bg-orange-50/50 p-3 dark:border-orange-900/50 dark:bg-orange-950/20">
          <div className="skeleton-shimmer h-9 min-w-48 flex-1 rounded-md" />
          <div className="skeleton-shimmer h-9 w-32 rounded-md" />
          <div className="skeleton-shimmer h-8 w-24 rounded-md" />
        </div>
      ) : null}
      {[5, 3].map((rows, s) => (
        <section key={s} aria-hidden className="rounded-xl border border-zinc-200 bg-white/80 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
          <div className="flex h-[37px] items-center justify-between gap-3 border-b border-zinc-100 px-4 dark:border-zinc-900">
            <div className={cn(BAR, 'h-2.5 w-16')} />
            <div className={cn(BAR, 'h-3 w-28')} />
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {Array.from({ length: rows }, (_, i) => (
              // An Admin's rows carry the pencil and Remove, which make them 45px: the skeleton holds that height.
              <li key={i} className={cn('flex items-center gap-3 px-4 py-2.5', manages && 'min-h-[45px]')}>
                <div className="skeleton-shimmer size-4 shrink-0 rounded" />
                <div className="flex h-5 min-w-0 flex-1 items-center">
                  <div className={cn(BAR, 'h-3.5', TITLE_WIDTHS[(i + s * 2) % TITLE_WIDTHS.length])} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </TasksLoading>
  );
}

/** Everyone: the progress message card, then the done-of-total table (Person + a column per frequency). */
function EveryoneSkeleton({ manages }: { manages: boolean }) {
  const cols = [0, 1, 2];
  return (
    <TasksLoading>
      <section aria-hidden className="rounded-xl border border-zinc-200 bg-white/80 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <div className={cn(BAR, 'mb-3 h-2.5 w-36')} />
        <div className="space-y-2">
          <div className={cn(BAR, 'h-3.5 w-full')} />
          <div className={cn(BAR, 'h-3.5 w-3/5')} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="skeleton-shimmer h-8 w-32 rounded-md" />
          {manages ? <div className="skeleton-shimmer h-8 w-28 rounded-md" /> : null}
        </div>
      </section>
      <div aria-hidden className="overflow-x-auto rounded-xl border border-zinc-200 bg-white/80 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <table className="table-keep w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 dark:border-zinc-900">
              <th className="px-4 py-2.5">
                <div className={cn(BAR, 'h-2.5 w-14')} />
              </th>
              {cols.map((c) => (
                <th key={c} className="px-3 py-2.5">
                  <div className={cn(BAR, 'ml-auto h-2.5 w-12')} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {NAME_WIDTHS.map((w, r) => (
              <tr key={r}>
                <td className="px-4 py-2">
                  <div className="flex h-5 items-center">
                    <div className={cn(BAR, 'h-3.5', w)} />
                  </div>
                </td>
                {cols.map((c) => (
                  <td key={c} className="px-3 py-2">
                    <div className="flex h-5 items-center justify-end">
                      <div className={cn(BAR, 'h-3.5 w-10')} />
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TasksLoading>
  );
}

function PersonBoard({
  data,
  canTick,
  canUntickAny,
  manages,
  onTick,
  onAdd,
  onPatch,
  onChangeFrequency,
}: {
  data: TasksPayload;
  canTick: boolean;
  canUntickAny: boolean;
  manages: boolean;
  onTick: (task: BoardTask, done: boolean) => Promise<boolean>;
  onAdd: (title: string, frequency: TaskFrequency) => Promise<boolean>;
  onPatch: (task: BoardTask, patch: { title?: string; archived?: true }) => Promise<boolean>;
  onChangeFrequency: ChangeFrequency;
}) {
  const done = new Set(data.checks.map((c) => c.taskId));
  const progress = taskProgress(data.tasks.map(asLike), data.checks, data.today);
  const groups = TASK_FREQUENCIES.map((f) => ({ frequency: f, tasks: data.tasks.filter((t) => t.frequency === f) })).filter(
    (g) => g.tasks.length > 0,
  );

  return (
    <div className="space-y-4">
      {manages ? <AddTask onAdd={onAdd} /> : null}
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No tasks on this board yet.{manages ? ' Add the first one above.' : ' An Admin adds them.'}
        </p>
      ) : null}
      {groups.map(({ frequency, tasks }) => {
        const p = frequency === 'as_needed' ? null : progress.find((x) => x.frequency === frequency) ?? null;
        return (
          <section
            key={frequency}
            className={cn(
              'rounded-xl border bg-white/80 shadow-sm dark:bg-zinc-950/60',
              frequency === 'as_needed' ? 'border-dashed border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800',
            )}
          >
            <header className="flex items-baseline justify-between gap-3 border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-900">
              <h3 className={cn(TINY_CAPS, 'text-zinc-600 dark:text-zinc-400')}>{FREQUENCY_LABEL[frequency]}</h3>
              {p ? (
                <span className={cn('text-xs font-medium tabular-nums', progressTone(p))}>
                  {p.done} of {p.total} done {PERIOD_WORDS[p.frequency]}
                </span>
              ) : (
                <span className="text-xs text-zinc-500">Look at these before the end of the day. Not counted.</span>
              )}
            </header>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  done={done.has(task.id)}
                  canTick={canTick}
                  canUntick={canTick || canUntickAny}
                  manages={manages}
                  onTick={onTick}
                  onPatch={onPatch}
                  onChangeFrequency={onChangeFrequency}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  done,
  canTick,
  canUntick,
  manages,
  onTick,
  onPatch,
  onChangeFrequency,
}: {
  task: BoardTask;
  done: boolean;
  canTick: boolean;
  canUntick: boolean;
  manages: boolean;
  onTick: (task: BoardTask, done: boolean) => Promise<boolean>;
  onPatch: (task: BoardTask, patch: { title?: string; archived?: true }) => Promise<boolean>;
  onChangeFrequency: ChangeFrequency;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [frequency, setFrequency] = useState<TaskFrequency>(task.frequency);
  const [confirming, setConfirming] = useState(false);
  const moving = frequency !== task.frequency;
  const counted = task.frequency !== 'as_needed';
  const enabled = counted && !busy && (done ? canUntick : canTick);

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      {counted ? (
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-emerald-600 disabled:cursor-not-allowed"
          checked={done}
          disabled={!enabled}
          aria-label={`${done ? 'Done' : 'Not done'}: ${task.title}`}
          title={!enabled && !busy ? (done ? 'Only the owner or an Admin can untick this' : 'Only the owner ticks their own task') : undefined}
          onChange={async (e) => {
            setBusy(true);
            await onTick(task, e.target.checked);
            setBusy(false);
          }}
        />
      ) : (
        <span aria-hidden className="size-4 shrink-0 rounded-full border border-dashed border-zinc-300 dark:border-zinc-700" />
      )}
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const renamed = title.trim() !== task.title;
            setBusy(true);
            // A new frequency is a new task (the old one is archived with its ticks); the title rides along. A title
            // alone is renamed in place.
            const ok = moving
              ? await onChangeFrequency(task, frequency, renamed ? title : undefined)
              : !renamed || (await onPatch(task, { title }));
            setBusy(false);
            if (ok) setEditing(false);
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className="h-8 min-w-40 flex-1" aria-label="Task title" autoFocus />
          <SmoothSelect
            value={frequency}
            onChange={(v) => setFrequency(v)}
            options={FREQUENCY_OPTIONS}
            accent="orange"
            align="start"
            portal
            aria-label="How often"
            triggerClassName="h-8 min-w-32 text-sm"
          />
          <Button size="xs" type="submit" disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null} Save
          </Button>
          <Button
            size="xs"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setTitle(task.title);
              setFrequency(task.frequency);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          {moving ? (
            <p className="basis-full text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
              Saving makes this a new {FREQUENCY_LABEL[frequency].toLowerCase()} task and archives this one. Ticks stay with
              the old task, so the new one starts unticked.
              {frequency === 'as_needed' ? ' As-needed tasks are never ticked or counted.' : ''}
            </p>
          ) : null}
        </form>
      ) : (
        <span
          className={cn(
            'min-w-0 flex-1 break-words text-sm',
            done ? 'text-zinc-400 line-through decoration-zinc-300 dark:text-zinc-500' : 'text-zinc-800 dark:text-zinc-200',
          )}
        >
          {task.title}
        </span>
      )}
      {busy && !editing ? <Loader2 className="size-3.5 animate-spin text-zinc-400" /> : null}
      {manages && !editing ? (
        confirming ? (
          <span className="flex items-center gap-1">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await onPatch(task, { archived: true });
                setBusy(false);
                if (!ok) setConfirming(false);
              }}
            >
              Remove
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
              Keep
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Button size="icon-xs" variant="ghost" aria-label={`Edit ${task.title}`} title="Rename or change how often" onClick={() => setEditing(true)}>
              <Pencil />
            </Button>
            <Button size="xs" variant="ghost" className="text-zinc-500" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          </span>
        )
      ) : null}
    </li>
  );
}

function AddTask({ onAdd }: { onAdd: (title: string, frequency: TaskFrequency) => Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [frequency, setFrequency] = useState<TaskFrequency>('daily');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-200/70 bg-orange-50/50 p-3 dark:border-orange-900/50 dark:bg-orange-950/20"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        const ok = await onAdd(title, frequency);
        setBusy(false);
        if (ok) setTitle('');
      }}
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={300}
        placeholder="New task"
        aria-label="New task title"
        className="h-9 min-w-48 flex-1 bg-white focus-visible:ring-orange-400/60 dark:bg-zinc-950"
      />
      <SmoothSelect
        value={frequency}
        onChange={(v) => setFrequency(v)}
        options={FREQUENCY_OPTIONS}
        accent="orange"
        align="start"
        portal
        aria-label="How often"
        triggerClassName="h-9 min-w-32 text-sm"
      />
      <Button type="submit" size="sm" disabled={busy || !title.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add task
      </Button>
    </form>
  );
}

function EveryoneView({ data, manages, onOpen }: { data: TasksPayload; manages: boolean; onOpen: (email: string) => void }) {
  const [posting, setPosting] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const owners = progressByOwner(data.tasks.map(asLike), data.checks, data.today);
  const nameOf = (email: string) => data.people?.find((p) => p.email === email)?.name ?? email.split('@')[0];
  const freqs = COUNTED_FREQUENCIES.filter((f) => owners.some((o) => o.progress.some((p) => p.frequency === f)));
  const message = buildProgressMessage(data.teamProgress ?? []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success('Copied. Paste it into the team chat.');
    } catch {
      toast.error('Could not copy. Select the message and copy it by hand.');
    }
  };

  const post = async () => {
    setPosting('busy');
    const res = await api<{ message: string; postedAt: string }>('/api/accounting-scoreboard/tasks/post-progress', { method: 'POST' });
    setPosting('idle');
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success('Posted to the accounting team chat.');
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 bg-white/80 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
        <h3 className={cn(TINY_CAPS, 'mb-2 flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400')}>
          <Users className="size-3.5" /> The team&rsquo;s progress
        </h3>
        <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{message}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void copy()}>
            <ClipboardCopy /> Copy message
          </Button>
          {manages ? (
            posting === 'confirm' ? (
              <span className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                Post this to the accounting team&rsquo;s Google Chat?
                <Button size="xs" onClick={() => void post()}>
                  <Check /> Post
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setPosting('idle')}>
                  Cancel
                </Button>
              </span>
            ) : (
              <span title={data.chatConfigured ? undefined : "Google Chat isn't connected: the webhook is not set on the server."}>
                <Button size="sm" disabled={!data.chatConfigured || posting === 'busy'} onClick={() => setPosting('confirm')}>
                  {posting === 'busy' ? <Loader2 className="animate-spin" /> : <MessageSquareShare />} Post to Chat
                </Button>
              </span>
            )
          ) : null}
        </div>
      </section>

      {owners.length === 0 ? (
        <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Nobody has tasks yet. Pick a person above to add theirs.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white/80 shadow-sm dark:border-zinc-800 dark:bg-zinc-950/60">
          <table className="table-keep w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 text-left dark:border-zinc-900">
                <th className={cn(TINY_CAPS, 'sticky left-0 bg-white px-4 py-2.5 text-zinc-500 dark:bg-zinc-950')}>Person</th>
                {freqs.map((f) => (
                  <th key={f} className={cn(TINY_CAPS, 'px-3 py-2.5 text-right text-zinc-500')}>
                    {FREQUENCY_LABEL[f]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {owners
                .map((o) => ({ ...o, name: nameOf(o.ownerEmail) }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((o) => (
                  <tr key={o.ownerEmail} className="hover:bg-orange-50/50 dark:hover:bg-orange-950/20">
                    <td className="sticky left-0 bg-white px-4 py-2 dark:bg-zinc-950">
                      <button
                        type="button"
                        className="text-left font-medium text-zinc-800 underline-offset-4 hover:text-orange-800 hover:underline dark:text-zinc-200 dark:hover:text-orange-200"
                        onClick={() => onOpen(o.ownerEmail)}
                      >
                        {o.name}
                      </button>
                    </td>
                    {freqs.map((f) => {
                      const p = o.progress.find((x) => x.frequency === f);
                      return (
                        <td key={f} className="px-3 py-2 text-right tabular-nums">
                          {p ? <span className={progressTone(p)}>{p.done} / {p.total}</span> : <span className="text-zinc-400">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
