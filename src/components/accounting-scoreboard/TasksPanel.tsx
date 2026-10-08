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
import type { BoardPayload, BoardTask, TaskCheck, TasksPayload } from '@/lib/accounting-scoreboard/types';
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

  // Paint the view from the cache before the browser paints. It never decides: the fetch below runs anyway, and its
  // answer replaces it. `viewer` is deliberately not a dependency (the board's rule): a role change arrives with the
  // page, and the role passed here is the one the page resolved, never a cached one.
  useIsoLayoutEffect(() => {
    const cached = readCachedTasks(view, todayEastern(), viewer.role);
    if (!cached) return;
    setData((prev) => (prev?.view === view ? prev : { view, payload: { ...cached, viewer } }));
  }, [view]);

  const load = useCallback(async (next: TasksView, click: boolean) => {
    const id = ++seq.current;
    if (click) setRefreshing(true);
    const res = await api<TasksPayload>(`/api/accounting-scoreboard/tasks?person=${encodeURIComponent(next)}`);
    if (id !== seq.current) return;
    setRefreshing(false);
    if (!res.ok) {
      // A refusal is the server deciding this viewer may not see the view: it leaves the screen and never paints from
      // the cache again. Any other failure keeps the last good view on screen and says so; it never blanks it.
      if (res.status === 401 || res.status === 403) {
        clearCachedTasks(next);
        setData((d) => (d?.view === next ? null : d));
      }
      setError({ view: next, message: res.error });
      return;
    }
    liveView.current = next;
    setError(null);
    setData({ view: next, payload: res.data });
  }, []);

  useEffect(() => {
    void load(view, false);
  }, [load, view]);

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
    </div>
  );
}

/* ── Skeletons: shaped like what arrives, on the same cards (ui-standards § 12.3), for the first paint only ── */

const BAR = 'skeleton-shimmer rounded';
const TITLE_WIDTHS = ['w-2/3', 'w-1/2', 'w-3/4', 'w-5/12', 'w-7/12', 'w-1/3'];
const NAME_WIDTHS = ['w-28', 'w-36', 'w-24', 'w-32', 'w-20', 'w-28'];

function TasksLoading({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading tasks…</span>
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
