'use client';

/**
 * Tasks: the per-person task boards (plan Task 7 + 8, Open item 393), behind the header's Scoreboard | Tasks switch.
 * Governing doc: docs/features/accounting-scoreboard-tasks.md.
 *
 * - Everyone opens on their OWN board and ticks their own tasks for the current period (today, this week, ...).
 * - An Admin or an Assistant gets a picker: a person's board, or Everyone (the All view: done of total per person).
 * - An Admin adds, renames and removes tasks, unticks anyone's, and posts the team's progress to Google Chat.
 * - As-needed tasks are listed last, never counted and never ticked.
 * Reads its own route (GET /api/accounting-scoreboard/tasks), never the board payload. Nothing is cached: who may
 * see what is a permission, and the route answers per request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { dayHeader } from '@/lib/accounting-scoreboard/week';
import type { BoardPayload, BoardTask, TaskCheck, TasksPayload } from '@/lib/accounting-scoreboard/types';
import { api, TINY_CAPS } from './shared';

type ViewKey = 'me' | 'all' | string;

const FREQUENCY_OPTIONS = TASK_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }));

const asLike = (t: BoardTask): TaskLike => ({ id: t.id, ownerEmail: t.ownerEmail, frequency: t.frequency, archived: false });

function progressTone(p: FrequencyProgress): string {
  if (p.done === p.total) return 'text-emerald-700 dark:text-emerald-300';
  if (p.done === 0) return 'text-rose-700 dark:text-rose-300';
  return 'text-amber-700 dark:text-amber-300';
}

export function TasksPanel({ viewer }: { viewer: BoardPayload['viewer'] }) {
  const [view, setView] = useState<ViewKey>('me');
  const [data, setData] = useState<TasksPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const load = useCallback(async (next: ViewKey) => {
    const id = ++seq.current;
    setLoading(true);
    const res = await api<TasksPayload>(`/api/accounting-scoreboard/tasks?person=${encodeURIComponent(next)}`);
    if (id !== seq.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setData(res.data);
  }, []);

  useEffect(() => {
    void load(view);
  }, [load, view]);

  const role = data?.viewer.role ?? viewer.role;
  const seesAll = can(role, 'view_all_tasks');
  const manages = can(role, 'manage_tasks');

  const pickerOptions = useMemo(() => {
    const people = data?.people ?? [];
    return [
      { value: 'me', label: 'My tasks' },
      { value: 'all', label: 'Everyone' },
      ...people.filter((p) => p.email !== viewer.email).map((p) => ({ value: p.email, label: p.name })),
    ];
  }, [data?.people, viewer.email]);

  const onTick = async (task: BoardTask, done: boolean) => {
    const res = await api<{ check: TaskCheck | null }>('/api/accounting-scoreboard/tasks/checks', {
      method: 'POST',
      body: JSON.stringify({ taskId: task.id, done }),
    });
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    setData((d) => {
      if (!d) return d;
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
    setData((d) => (d ? { ...d, tasks: [...d.tasks, res.data.task] } : d));
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
    setData((d) => {
      if (!d) return d;
      const tasks = res.data.archived ? d.tasks.filter((t) => t.id !== task.id) : d.tasks.map((t) => (t.id === task.id ? res.data.task : t));
      return { ...d, tasks, checks: res.data.archived ? d.checks.filter((c) => c.taskId !== task.id) : d.checks };
    });
    return true;
  };

  const today = data?.today;
  const todayText = today ? `${dayHeader(today).weekday} ${dayHeader(today).short}` : '';

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {data?.view.kind === 'all' ? 'Everyone' : data?.view.kind === 'person' && !data.view.own ? `${data.view.person.name}'s tasks` : 'My tasks'}
          </h2>
          <p className="text-xs text-zinc-500">
            Ticks count for the current period: today for daily tasks, this week for weekly ones, and so on (US Eastern
            {todayText ? `, today is ${todayText}` : ''}).
          </p>
        </div>
        {seesAll ? (
          <SmoothSelect
            value={view}
            onChange={(v) => setView(v)}
            options={pickerOptions}
            accent="orange"
            align="start"
            portal
            searchable={pickerOptions.length > 8}
            aria-label="Whose tasks"
            triggerClassName="h-9 min-w-44 text-sm"
          />
        ) : null}
        <Button size="icon-sm" variant="outline" aria-label="Refresh tasks" disabled={loading} onClick={() => void load(view)}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
          {error}
          <Button className="ml-3" size="xs" variant="outline" onClick={() => void load(view)}>
            Try again
          </Button>
        </div>
      ) : null}

      {!data ? (
        loading ? (
          <div className="flex items-center gap-2 py-10 text-sm text-zinc-500">
            <Loader2 className="size-4 animate-spin" /> Loading tasks…
          </div>
        ) : null
      ) : data.view.kind === 'all' ? (
        <EveryoneView data={data} manages={manages} onOpen={(email) => setView(email)} />
      ) : (
        <PersonBoard
          data={data}
          canTick={data.view.own}
          canUntickAny={manages}
          manages={manages}
          onTick={onTick}
          onAdd={(title, frequency) => (data.view.kind === 'person' ? onAdd(data.view.person.email, title, frequency) : Promise.resolve(false))}
          onPatch={onPatch}
        />
      )}
    </div>
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
}: {
  data: TasksPayload;
  canTick: boolean;
  canUntickAny: boolean;
  manages: boolean;
  onTick: (task: BoardTask, done: boolean) => Promise<boolean>;
  onAdd: (title: string, frequency: TaskFrequency) => Promise<boolean>;
  onPatch: (task: BoardTask, patch: { title?: string; archived?: true }) => Promise<boolean>;
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
}: {
  task: BoardTask;
  done: boolean;
  canTick: boolean;
  canUntick: boolean;
  manages: boolean;
  onTick: (task: BoardTask, done: boolean) => Promise<boolean>;
  onPatch: (task: BoardTask, patch: { title?: string; archived?: true }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [confirming, setConfirming] = useState(false);
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
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = title.trim() === task.title || (await onPatch(task, { title }));
            setBusy(false);
            if (ok) setEditing(false);
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} className="h-8 flex-1" aria-label="Task title" autoFocus />
          <Button size="xs" type="submit" disabled={busy || !title.trim()}>
            Save
          </Button>
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => {
              setTitle(task.title);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
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
            <Button size="icon-xs" variant="ghost" aria-label={`Rename ${task.title}`} onClick={() => setEditing(true)}>
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
