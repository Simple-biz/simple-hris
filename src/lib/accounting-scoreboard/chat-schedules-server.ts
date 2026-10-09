import 'server-only';

/**
 * Setup → Scheduled Posts: the reads and writes behind the area, and the schedule's own reads (scheduled-chat.ts).
 * Its own file, like archive-server.ts: server.ts is the board's.
 *
 * - A post is edited in place and every change is audited with what it was and what it became; removing one is an
 *   archive stamp, never a delete, and a removed post is final (the table's trigger refuses the rest).
 * - Who: view_setup reads (an Assistant sees the area read-only, like the rest of Setup), edit_setup writes (Admins).
 * - Not the board: readBoard never reads these tables, and no write here announces on the live channel.
 *
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { selectAllPaged } from '@/lib/supabase/select-all-paged';
import { readTasks, type Failure, type Result, type Viewer } from './server';
import { ROLE_LABEL } from './roles';
import {
  RECENT_POSTS_SHOWN,
  type ChatPostRecord,
  type ChatScheduleView,
  type ChatSchedulesPayload,
  type PostRepeat,
  type PostSchedule,
} from './chat-schedule';
import { definitionChanges, type ScheduleDefinition, type SchedulePatch } from './chat-schedule-input';
import type { Weekday } from './sections';
import type { CountedFrequency } from './tasks';

const SCHEDULES = 'accounting_scoreboard_chat_schedules';
const POSTS = 'accounting_scoreboard_chat_posts';
const SCHEDULE_COLS =
  'id, label, repeat, weekdays, month_days, post_hour, frequencies, template, paused, timing_changed_at, created_by, created_at, updated_by, updated_at, archived_by, archived_at';
const POST_COLS = 'id, slot_date, slot_hour, frequencies, schedule_ids, status, message, detail, claimed_at, finished_at';

type ScheduleRecord = {
  id: string;
  label: string;
  repeat: PostRepeat;
  weekdays: Weekday[] | null;
  month_days: number[] | null;
  post_hour: number;
  frequencies: CountedFrequency[];
  template: string;
  paused: boolean;
  timing_changed_at: string;
  created_by: string;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
  archived_by: string | null;
  archived_at: string | null;
};

type PostRecord = {
  id: string;
  slot_date: string;
  slot_hour: number;
  frequencies: CountedFrequency[];
  schedule_ids: string[] | null;
  status: ChatPostRecord['status'];
  message: string | null;
  detail: string | null;
  claimed_at: string;
  finished_at: string | null;
};

const fail = (status: number, code: string, message: string): Failure => ({ ok: false, status, code, message });

const NOT_SET_UP = fail(
  503,
  'not_set_up',
  'Scheduled Posts is not set up yet: run scripts/apply-accounting-scoreboard-chat-schedules-migration.mts --apply. Until then nothing is posted on a schedule.',
);

function dbFailure(error: { message?: string; code?: string } | null | undefined, fallback: string): Failure {
  const message = error?.message;
  if (message && /does not exist|schema cache|PGRST205|42P01|42703/i.test(message)) return NOT_SET_UP;
  if (error?.code === '23514' || error?.code === '22P02') return fail(422, 'refused', message ?? fallback);
  return fail(500, 'db_error', message ?? fallback);
}

function client() {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error('Supabase service role is not configured');
  return sb;
}

function toSchedule(r: ScheduleRecord): PostSchedule {
  return {
    id: r.id,
    label: r.label,
    repeat: r.repeat,
    weekdays: r.weekdays ?? [],
    monthDays: (r.month_days ?? []).map(Number),
    hour: Number(r.post_hour),
    frequencies: r.frequencies,
    template: r.template,
    paused: r.paused,
    timingChangedAt: r.timing_changed_at,
  };
}

function toView(r: ScheduleRecord): ChatScheduleView {
  return {
    ...toSchedule(r),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    archived: r.archived_at !== null,
    archivedBy: r.archived_by,
    archivedAt: r.archived_at,
  };
}

function toPost(r: PostRecord): ChatPostRecord {
  return {
    id: r.id,
    date: r.slot_date,
    hour: Number(r.slot_hour),
    frequencies: r.frequencies,
    scheduleIds: r.schedule_ids,
    status: r.status,
    message: r.message,
    detail: r.detail,
    claimedAt: r.claimed_at,
    finishedAt: r.finished_at,
  };
}

const definitionOf = (s: PostSchedule): ScheduleDefinition => ({
  label: s.label,
  repeat: s.repeat,
  weekdays: s.weekdays,
  monthDays: s.monthDays,
  hour: s.hour,
  frequencies: s.frequencies,
  template: s.template,
  paused: s.paused,
});

const columnsOf = (d: ScheduleDefinition) => ({
  label: d.label,
  repeat: d.repeat,
  weekdays: d.weekdays,
  month_days: d.monthDays,
  post_hour: d.hour,
  frequencies: d.frequencies,
  template: d.template,
  paused: d.paused,
});

async function audit(viewer: Viewer, action: string, id: string, details: Record<string, unknown>): Promise<void> {
  await insertAuditLog({
    user_name: viewer.email,
    user_role: ROLE_LABEL[viewer.role],
    action: `accounting_scoreboard.${action}`,
    resource: SCHEDULES,
    resource_id: id,
    details,
  });
}

// ---------------------------------------------------------------------------
// The schedule's reads (scheduled-chat.ts)
// ---------------------------------------------------------------------------

/** The live posts (paused ones too: chat-schedule.ts skips them), oldest first, so a slot's message has a stable order. */
export async function readLiveSchedules(): Promise<Result<PostSchedule[]>> {
  const { rows, error } = await selectAllPaged<ScheduleRecord>((from, to) =>
    client().from(SCHEDULES).select(SCHEDULE_COLS).is('archived_at', null).order('created_at').order('id').range(from, to),
  );
  if (error) return dbFailure({ message: error }, 'Could not read the scheduled posts');
  return { ok: true, value: rows.map(toSchedule) };
}

/** Each slot claimed on an Eastern date: its hour and the posts it carried. */
export async function readPostsOn(date: string): Promise<Result<Array<{ hour: number; scheduleIds: string[] | null }>>> {
  const { rows, error } = await selectAllPaged<Pick<PostRecord, 'id' | 'slot_hour' | 'schedule_ids'>>((from, to) =>
    client().from(POSTS).select('id, slot_hour, schedule_ids').eq('slot_date', date).order('id').range(from, to),
  );
  if (error) return dbFailure({ message: error }, "Could not read today's posts");
  return { ok: true, value: rows.map((r) => ({ hour: Number(r.slot_hour), scheduleIds: r.schedule_ids })) };
}

// ---------------------------------------------------------------------------
// Setup → Scheduled Posts
// ---------------------------------------------------------------------------

export async function readChatSchedules(viewer: Viewer): Promise<Result<ChatSchedulesPayload>> {
  const [schedules, posts, team] = await Promise.all([
    selectAllPaged<ScheduleRecord>((from, to) =>
      client().from(SCHEDULES).select(SCHEDULE_COLS).order('created_at').order('id').range(from, to),
    ),
    // The newest few, by design: the area shows recent posts, not the whole history.
    client().from(POSTS).select(POST_COLS).order('claimed_at', { ascending: false }).limit(RECENT_POSTS_SHOWN),
    readTasks(viewer, { kind: 'all' }),
  ]);
  if (schedules.error) return dbFailure({ message: schedules.error }, 'Could not read the scheduled posts');
  if (posts.error) return dbFailure(posts.error, 'Could not read the recent posts');
  return {
    ok: true,
    value: {
      viewer: { email: viewer.email, role: viewer.role },
      schedules: schedules.rows.map(toView),
      posts: ((posts.data ?? []) as PostRecord[]).map(toPost),
      progress: team.ok ? (team.value.teamProgress ?? []) : null,
      progressError: team.ok ? null : team.message,
    },
  };
}

async function readLive(id: string): Promise<Result<ScheduleRecord>> {
  const { data, error } = await client().from(SCHEDULES).select(SCHEDULE_COLS).eq('id', id).maybeSingle();
  if (error) return dbFailure(error, 'Could not read the scheduled post');
  const rec = data as ScheduleRecord | null;
  if (!rec) return fail(404, 'not_found', 'That scheduled post does not exist.');
  if (rec.archived_at) return fail(409, 'post_removed', `${rec.label} was removed. Refresh to see the live posts.`);
  return { ok: true, value: rec };
}

const nameTaken = (label: string) => fail(409, 'post_exists', `There is already a scheduled post named ${label}.`);

export async function createChatSchedule(viewer: Viewer, d: ScheduleDefinition): Promise<Result<ChatScheduleView>> {
  const { data, error } = await client()
    .from(SCHEDULES)
    .insert({ ...columnsOf(d), created_by: viewer.email })
    .select(SCHEDULE_COLS)
    .single();
  if (error?.code === '23505') return nameTaken(d.label);
  if (error) return dbFailure(error, 'Could not add the scheduled post');
  const view = toView(data as ScheduleRecord);
  await audit(viewer, 'chat_schedule_created', view.id, { ...definitionOf(view) });
  return { ok: true, value: view };
}

export async function updateChatSchedule(viewer: Viewer, patch: SchedulePatch): Promise<Result<ChatScheduleView>> {
  const current = await readLive(patch.id);
  if (!current.ok) return current;
  const before = definitionOf(toSchedule(current.value));
  const after = patch.kind === 'pause' ? { ...before, paused: patch.paused } : patch.definition;
  const changes = definitionChanges(before, after);
  if (!Object.keys(changes).length) return { ok: true, value: toView(current.value) };

  const { data, error } = await client()
    .from(SCHEDULES)
    .update({ ...columnsOf(after), updated_by: viewer.email, updated_at: new Date().toISOString() })
    .eq('id', patch.id)
    .is('archived_at', null)
    .select(SCHEDULE_COLS);
  if (error?.code === '23505') return nameTaken(after.label);
  if (error) return dbFailure(error, 'Could not save the scheduled post');
  const rec = ((data ?? []) as ScheduleRecord[])[0];
  if (!rec) return fail(409, 'post_removed', `${current.value.label} was removed meanwhile. Refresh to see the live posts.`);
  const view = toView(rec);
  const action = patch.kind === 'pause' ? (patch.paused ? 'chat_schedule_paused' : 'chat_schedule_resumed') : 'chat_schedule_updated';
  await audit(viewer, action, view.id, { label: view.label, changes });
  return { ok: true, value: view };
}

export async function archiveChatSchedule(viewer: Viewer, id: string): Promise<Result<{ id: string }>> {
  const current = await readLive(id);
  if (!current.ok) return current;
  const { data, error } = await client()
    .from(SCHEDULES)
    .update({ archived_at: new Date().toISOString(), archived_by: viewer.email })
    .eq('id', id)
    .is('archived_at', null)
    .select('id');
  if (error) return dbFailure(error, 'Could not remove the scheduled post');
  if (!(data ?? []).length) return fail(409, 'post_removed', `${current.value.label} was already removed.`);
  await audit(viewer, 'chat_schedule_removed', id, { ...definitionOf(toSchedule(current.value)) });
  return { ok: true, value: { id } };
}
