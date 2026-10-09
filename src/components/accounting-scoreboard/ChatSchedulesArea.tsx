'use client';

/**
 * Setup → Scheduled Posts: the progress messages the scoreboard posts to the accounting team's Google Chat on its own
 * (Kane, 2026-10-09: "where I can see all the scheduled posts and that I can edit that template and add a new one").
 * Each post says when it goes out (US Eastern), what it counts and its words, with a preview on today's counts; an
 * Admin edits, pauses, removes and adds them. Under them, the recent posts and what happened to each.
 *
 * Rules: chat-schedule.ts (when), chat-template.ts (the words), chat-schedule-input.ts (what may be saved) and
 * docs/features/accounting-scoreboard-scheduled-posts.md.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CalendarClock, Loader2, MessageSquareText, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SmoothSelect } from '@/components/ui/smooth-select';
import { Switch } from '@/components/ui/switch';
import {
  POST_REPEATS,
  describeWhen,
  hourLabel,
  nextPostAt,
  type ChatPostRecord,
  type ChatScheduleView,
  type ChatSchedulesPayload,
  type PostRepeat,
} from '@/lib/accounting-scoreboard/chat-schedule';
import {
  LABEL_MAX_LENGTH,
  definitionProblem,
  normalizeDefinition,
  type ScheduleDefinition,
} from '@/lib/accounting-scoreboard/chat-schedule-input';
import {
  DEFAULT_POST_TEMPLATE,
  PROGRESS_TOKEN,
  TEMPLATE_MAX_LENGTH,
  renderPostTemplate,
} from '@/lib/accounting-scoreboard/chat-template';
import {
  clearCachedChatSchedules,
  readCachedChatSchedules,
  writeCachedChatSchedules,
  type CachedChatSchedules,
} from '@/lib/accounting-scoreboard/chat-schedules-cache';
import { COUNTED_FREQUENCIES, FREQUENCY_LABEL, type FrequencyProgress } from '@/lib/accounting-scoreboard/tasks';
import { WEEKDAYS, type Weekday } from '@/lib/accounting-scoreboard/sections';
import type { BoardRole } from '@/lib/accounting-scoreboard/roles';
import { api, EASE_SETTLE, LoadingLines, SlidingPill, TINY_CAPS } from './shared';

/** What GET /chat-schedules really reads, side by side: shown in turn while nothing is painted yet. */
const LOADING_LINES = ['Fetching the scheduled posts', 'Reading the recent posts', "Counting the team's tasks"] as const;
const URL = '/api/accounting-scoreboard/chat-schedules';

const REPEAT_LABEL: Record<PostRepeat, string> = {
  every_day: 'Every day',
  weekdays: 'Days of the week',
  month_days: 'Days of the month',
};
const DAY_SHORT: Record<Weekday, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${hourLabel(h)} ET` }));
/** Shown when today's counts could not be read: plausible numbers, labelled as samples. */
const SAMPLE: FrequencyProgress[] = COUNTED_FREQUENCIES.map((frequency, i) => ({ frequency, total: [170, 80, 12, 40, 6, 9, 4][i], done: [98, 13, 5, 5, 2, 3, 1][i] }));

const NEW_POST: ScheduleDefinition = {
  label: '',
  repeat: 'weekdays',
  weekdays: ['fri'],
  monthDays: [],
  hour: 9,
  frequencies: ['weekly'],
  template: DEFAULT_POST_TEMPLATE,
  paused: false,
};

const SLOT_DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** "Fri, Oct 9 · 9:00 AM ET": a slot's Eastern date and hour, as the card and the Chat card say it. */
function slotWhen(date: string, hour: number): string {
  return `${SLOT_DAY.format(new Date(`${date}T12:00:00Z`))} · ${hourLabel(hour)} ET`;
}

const definitionOf = (s: ChatScheduleView): ScheduleDefinition => ({
  label: s.label,
  repeat: s.repeat,
  weekdays: s.weekdays,
  monthDays: s.monthDays,
  hour: s.hour,
  frequencies: s.frequencies,
  template: s.template,
  paused: s.paused,
});

const countsWords = (d: Pick<ScheduleDefinition, 'frequencies'>) =>
  d.frequencies.map((f) => FREQUENCY_LABEL[f].toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' and $1');

/**
 * `role` is the role the server page resolved on THIS load (the cache paints only for a role that may see Setup now).
 * `canEdit` is edit_setup: an Assistant sees every post, its words and the recent posts, and changes nothing.
 */
export function ChatSchedulesArea({ role, canEdit }: { role: BoardRole; canEdit: boolean }) {
  const reduce = useReducedMotion() ?? false;
  const [payload, setPayload] = useState<CachedChatSchedules | null>(() => readCachedChatSchedules(role) ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The post being edited, or 'new'. One editor at a time. */
  const [editing, setEditing] = useState<string | null>(null);
  const painted = useRef(payload);
  painted.current = payload;

  async function load() {
    const res = await api<ChatSchedulesPayload>(URL);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        clearCachedChatSchedules();
        setPayload(null);
        setLoadError(res.error);
        return;
      }
      if (painted.current) toast.error(`Couldn't refresh the scheduled posts: ${res.error}`);
      else setLoadError(res.error);
      return;
    }
    setLoadError(null);
    setPayload(res.data);
    writeCachedChatSchedules(res.data);
  }
  useEffect(() => {
    void load();
  }, []);

  const live = useMemo(() => (payload?.schedules ?? []).filter((s) => !s.archived), [payload]);

  if (loadError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
        <span>Couldn&rsquo;t load the scheduled posts: {loadError}</span>
        <Button size="xs" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!payload) return <LoadingLines label="Loading the scheduled posts" lines={LOADING_LINES} />;

  const progress = payload.progress;
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-xs leading-relaxed text-zinc-500">
          The progress messages the scoreboard posts to the accounting team&rsquo;s Google Chat on its own, each with the
          bars card under it. Times are US Eastern. Posts due at the same hour go out together as one message.
        </p>
        {canEdit && editing !== 'new' ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus /> New scheduled post
          </Button>
        ) : null}
      </div>

      {payload.progressError ? (
        <p role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          Couldn&rsquo;t read today&rsquo;s counts ({payload.progressError}), so the previews use sample numbers.
        </p>
      ) : null}

      <AnimatePresence initial={false}>
        {editing === 'new' ? (
          <motion.div
            key="new"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: reduce ? 0 : 0.28, ease: EASE_SETTLE }}
            className="overflow-y-clip"
          >
            <PostEditor
              title="New scheduled post"
              initial={NEW_POST}
              progress={progress}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void load();
              }}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <ul className="space-y-3">
        <AnimatePresence initial={false}>
          {live.map((s) => (
            <motion.li
              key={s.id}
              layout={reduce ? false : 'position'}
              initial={{ opacity: 0, y: reduce ? 0 : -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: reduce ? 0 : -14, transition: { duration: 0.14 } }}
              transition={{ duration: reduce ? 0 : 0.22, ease: EASE_SETTLE }}
            >
              {editing === s.id ? (
                <PostEditor
                  title={`Edit ${s.label}`}
                  id={s.id}
                  initial={definitionOf(s)}
                  progress={progress}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    void load();
                  }}
                />
              ) : (
                <PostCard
                  post={s}
                  posts={payload.posts}
                  progress={progress}
                  canEdit={canEdit}
                  onEdit={() => setEditing(s.id)}
                  onChanged={() => void load()}
                />
              )}
            </motion.li>
          ))}
        </AnimatePresence>
        {!live.length ? (
          <li className="rounded-xl border border-dashed border-zinc-300 px-3 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
            No scheduled posts. Nothing posts to the Chat on its own until one is added.
          </li>
        ) : null}
      </ul>

      <RecentPosts posts={payload.posts} schedules={payload.schedules} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The message as it would post now: the words with today's counts (or samples), and why it would be skipped. */
function Preview({ definition, progress }: { definition: Pick<ScheduleDefinition, 'template' | 'frequencies'>; progress: FrequencyProgress[] | null }) {
  const counts = (progress ?? SAMPLE).filter((p) => definition.frequencies.includes(p.frequency));
  if (!counts.length) {
    return (
      <p className="text-xs text-zinc-500">
        No {countsWords(definition) || 'counted'} tasks on the board right now, so this post would be skipped (nothing is sent).
      </p>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words rounded-lg bg-zinc-100 px-3 py-2 text-[13px] leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
      {renderPostTemplate(definition.template, counts).trim() || '(empty)'}
    </p>
  );
}

function PostCard({
  post,
  posts,
  progress,
  canEdit,
  onEdit,
  onChanged,
}: {
  post: ChatScheduleView;
  posts: ChatPostRecord[];
  progress: FrequencyProgress[] | null;
  canEdit: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const next = useMemo(() => nextPostAt(post, new Date()), [post]);
  const last = posts.find((p) => p.scheduleIds?.includes(post.id));

  async function setPaused(paused: boolean) {
    setBusy(true);
    const res = await api(URL, { method: 'PATCH', body: JSON.stringify({ id: post.id, paused }) });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(paused ? `${post.label} is paused. It won't post until it is turned back on.` : `${post.label} is back on.`);
    onChanged();
  }

  async function remove() {
    setBusy(true);
    const res = await api(`${URL}?id=${encodeURIComponent(post.id)}`, { method: 'DELETE' });
    setBusy(false);
    setConfirming(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${post.label} removed. It won't post again.`);
    onChanged();
  }

  return (
    <div className={cn('rounded-xl border bg-white p-3 dark:bg-zinc-950', post.paused ? 'border-dashed border-zinc-300 dark:border-zinc-700' : 'border-zinc-200 dark:border-zinc-800')}>
      <div className="flex items-center gap-3">
        <MessageSquareText className="size-4 shrink-0 text-orange-700 dark:text-orange-400" aria-hidden />
        <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{post.label}</h3>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canEdit ? (
            <>
              <Switch checked={!post.paused} disabled={busy} onCheckedChange={(on: boolean) => void setPaused(!on)} aria-label={`${post.label} on or paused`} />
              <Button size="icon-xs" variant="ghost" aria-label={`Edit ${post.label}`} onClick={onEdit} disabled={busy}>
                <Pencil />
              </Button>
              {confirming ? (
                <span className="flex items-center gap-1">
                  <Button size="xs" variant="destructive" onClick={() => void remove()} disabled={busy}>
                    Remove
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button size="icon-xs" variant="ghost" aria-label={`Remove ${post.label}`} onClick={() => setConfirming(true)} disabled={busy}>
                  <X />
                </Button>
              )}
            </>
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-7 text-xs text-zinc-500">
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{describeWhen(post)}</span>
        <span>Counts {countsWords(post)} tasks</span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3.5" aria-hidden />
          {post.paused ? 'Paused' : next ? `Next ${slotWhen(next.date, next.hour)}` : 'No date ahead'}
        </span>
        {last ? (
          <span>
            Last {slotWhen(last.date, last.hour)}, {STATUS_WORD[last.status]}
          </span>
        ) : null}
      </div>
      <div className="mt-2 pl-7">
        <Preview definition={post} progress={progress} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-lg border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/60',
        on
          ? 'border-orange-700 bg-orange-700 text-white'
          : 'border-zinc-200 bg-white text-zinc-700 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-orange-950/30 dark:hover:text-orange-200',
      )}
    >
      {children}
    </button>
  );
}

const toggle = <T,>(list: readonly T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className={cn(TINY_CAPS, 'text-zinc-500')}>{label}</div>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function PostEditor({
  title,
  id,
  initial,
  progress,
  onCancel,
  onSaved,
}: {
  title: string;
  id?: string;
  initial: ScheduleDefinition;
  progress: FrequencyProgress[] | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ScheduleDefinition>(initial);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const set = (patch: Partial<ScheduleDefinition>) => setDraft((d) => ({ ...d, ...patch }));
  const normalized = normalizeDefinition(draft);
  const problem = definitionProblem(normalized);
  const retimed =
    !!id &&
    (normalized.hour !== initial.hour ||
      normalized.repeat !== initial.repeat ||
      normalized.weekdays.join() !== initial.weekdays.join() ||
      normalized.monthDays.join() !== initial.monthDays.join());

  function insertToken() {
    const el = textRef.current;
    const at = el ? el.selectionStart : draft.template.length;
    const end = el ? el.selectionEnd : at;
    const template = `${draft.template.slice(0, at)}${PROGRESS_TOKEN}${draft.template.slice(end)}`;
    set({ template });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + PROGRESS_TOKEN.length, at + PROGRESS_TOKEN.length);
    });
  }

  async function save() {
    if (problem) return;
    setSaving(true);
    const res = id
      ? await api(URL, { method: 'PATCH', body: JSON.stringify({ id, ...normalized }) })
      : await api(URL, { method: 'POST', body: JSON.stringify(normalized) });
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(id ? `${normalized.label} saved.` : `${normalized.label} added. ${describeWhen(normalized)}.`);
    onSaved();
  }

  return (
    <form
      className="space-y-4 rounded-xl border border-orange-200 bg-white p-4 shadow-sm dark:border-orange-900/60 dark:bg-zinc-950"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>

      <Field label="Name">
        <Input value={draft.label} maxLength={LABEL_MAX_LENGTH} onChange={(e) => set({ label: e.target.value })} placeholder="e.g. Friday reminder" aria-label="Name" className="max-w-sm" />
      </Field>

      <Field label="When" hint={draft.repeat === 'month_days' ? "A day the month doesn't have (the 30th in February) posts on the month's last day." : undefined}>
        <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-xl border border-zinc-200 bg-white/70 p-1 dark:border-zinc-800 dark:bg-zinc-900/60">
          {POST_REPEATS.map((r) => (
            <SlidingPill key={r} layoutId={`acct-sb-post-repeat-${id ?? 'new'}`} active={draft.repeat === r} onClick={() => set({ repeat: r })}>
              {REPEAT_LABEL[r]}
            </SlidingPill>
          ))}
        </div>
        {draft.repeat === 'weekdays' ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((d) => (
              <Chip key={d} on={draft.weekdays.includes(d)} onClick={() => set({ weekdays: toggle(draft.weekdays, d) })}>
                {DAY_SHORT[d]}
              </Chip>
            ))}
          </div>
        ) : null}
        {draft.repeat === 'month_days' ? (
          <div className="grid max-w-sm grid-cols-7 gap-1.5" role="group" aria-label="Days of the month">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <Chip key={n} on={draft.monthDays.includes(n)} onClick={() => set({ monthDays: toggle(draft.monthDays, n) })} label={`Day ${n}`}>
                {n}
              </Chip>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <span className="text-xs text-zinc-600 dark:text-zinc-400">at</span>
          <SmoothSelect
            value={String(draft.hour)}
            onChange={(v) => set({ hour: Number(v) })}
            options={HOUR_OPTIONS}
            accent="orange"
            align="start"
            portal
            aria-label="Time (US Eastern)"
            triggerClassName="w-36"
          />
        </div>
      </Field>

      <Field label="Counts" hint="As-needed tasks are never counted.">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="What the post counts">
          {COUNTED_FREQUENCIES.map((f) => (
            <Chip key={f} on={draft.frequencies.includes(f)} onClick={() => set({ frequencies: toggle(draft.frequencies, f) })}>
              {FREQUENCY_LABEL[f]}
            </Chip>
          ))}
        </div>
      </Field>

      <Field
        label="Message"
        hint={
          <>
            <code className="rounded bg-zinc-100 px-1 font-mono text-[11px] dark:bg-zinc-800">{PROGRESS_TOKEN}</code> becomes the counts, e.g. &ldquo;49 of 97
            weekly tasks&rdquo;. It is the only placeholder. The bars card goes under the message either way.
          </>
        }
      >
        <textarea
          ref={textRef}
          value={draft.template}
          onChange={(e) => set({ template: e.target.value })}
          rows={3}
          maxLength={TEMPLATE_MAX_LENGTH}
          aria-label="Message"
          className="w-full min-w-0 resize-y rounded-lg border border-zinc-300 bg-transparent px-2.5 py-2 text-sm text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:border-input dark:bg-input/30 dark:text-zinc-100"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="xs" variant="outline" onClick={insertToken}>
            <Plus /> Insert {PROGRESS_TOKEN}
          </Button>
          <span className="font-mono text-[11px] tabular-nums text-zinc-500">
            {draft.template.length.toLocaleString('en-US')} / {TEMPLATE_MAX_LENGTH.toLocaleString('en-US')}
          </span>
        </div>
      </Field>

      <Field label={progress ? "Preview, with today's counts" : 'Preview, with sample counts'}>
        <Preview definition={normalized} progress={progress} />
      </Field>

      {retimed ? (
        <p role="note" className="text-xs text-zinc-600 dark:text-zinc-400">
          The new time counts from the next hour. If this post already went out today, it won&rsquo;t go out again today.
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-xs font-medium text-rose-700 dark:text-rose-400">
          {problem}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={saving || !!problem} className="bg-orange-700 text-white hover:bg-orange-800">
          {saving ? <Loader2 className="animate-spin" /> : null} {id ? 'Save' : 'Add post'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

const STATUS_WORD: Record<ChatPostRecord['status'], string> = {
  posted: 'posted',
  skipped: 'skipped (no tasks)',
  refused: 'refused by Google',
  unreachable: "couldn't reach Google",
  timed_out: 'may or may not have posted',
  failed: 'failed',
  sending: 'may or may not have posted',
};

const STATUS_TONE: Record<ChatPostRecord['status'], string> = {
  posted: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  skipped: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  refused: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  unreachable: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  failed: 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300',
  timed_out: 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
  sending: 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
};

function RecentPosts({ posts, schedules }: { posts: ChatPostRecord[]; schedules: ChatScheduleView[] }) {
  const nameOf = useMemo(() => new Map(schedules.map((s) => [s.id, s.label])), [schedules]);
  return (
    <section className="space-y-2 pt-2">
      <h3 className={cn(TINY_CAPS, 'text-zinc-500')}>Recent posts</h3>
      {posts.length ? (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white dark:divide-zinc-900 dark:border-zinc-800 dark:bg-zinc-950">
          {posts.map((p) => {
            // Rows from before Setup → Scheduled Posts carry no posts: name them by what they counted.
            const names = p.scheduleIds
              ? p.scheduleIds.map((id) => nameOf.get(id) ?? 'A removed post').join(' + ')
              : p.frequencies.map((f) => FREQUENCY_LABEL[f]).join(' + ');
            return (
              <li key={p.id} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-medium tabular-nums text-zinc-800 dark:text-zinc-200">{slotWhen(p.date, p.hour)}</span>
                  <span className="text-zinc-600 dark:text-zinc-400">{names}</span>
                  <span className={cn('ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium', STATUS_TONE[p.status])}>{STATUS_WORD[p.status]}</span>
                </div>
                {p.message ? <p className="line-clamp-2 whitespace-pre-wrap text-xs text-zinc-500">{p.message}</p> : null}
                {p.detail ? <p className="text-[11px] text-zinc-500">{p.detail}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-zinc-300 px-3 py-4 text-center text-xs text-zinc-500 dark:border-zinc-700">
          Nothing has posted on a schedule yet.
        </p>
      )}
    </section>
  );
}
