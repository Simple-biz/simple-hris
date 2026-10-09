import 'server-only';

/**
 * The team's progress message, posted on the schedules in Setup → Scheduled Posts (accounting_scoreboard_chat_schedules,
 * chat-schedule.ts) instead of only by an Admin's click. Called by GET /api/cron/accounting-scoreboard-chat, which
 * Vercel cron calls once at every UTC hour (vercel.json). The order and its rules are in scheduled-chat-core.ts; this
 * file wires the database, Google Chat and the audit log.
 *
 * The counts come from readTasks' Everyone view, the same read the Admin's Post to Chat uses, and the post goes through
 * the same sender (chat-webhook.ts), so the two can never count or send differently. The webhook URL carries a key: it
 * is read here and in postTaskProgress only, and it never appears in a response, an error, the posts table or the
 * audit row.
 *
 * Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md § How a post goes out.
 */

import { createSupabaseServiceRoleClient } from '@/lib/supabase/server';
import { insertAuditLog } from '@/lib/supabase/audit-log';
import { readTasks, type Result, type Viewer } from './server';
import { dueChatSlots, easternClock, slotLabel, withoutPostedToday } from './chat-schedule';
import { buildProgressPost } from './chat-summary';
import { sendChatPost } from './chat-webhook';
import { postSlot, type SlotDeps, type SlotResult } from './scheduled-chat-core';
import { readLiveSchedules, readPostsOn } from './chat-schedules-server';

const POSTS = 'accounting_scoreboard_chat_posts';
const CHAT_WEBHOOK_ENV = 'ACCOUNTING_SCOREBOARD_CHAT_WEBHOOK_URL';
const ACTOR = { user_name: 'Scoreboard Chat Schedule', user_role: 'System' } as const;

/**
 * Who the schedule reads as: an Assistant, the least role that may read Everyone's tasks (`view_all_tasks`). It only
 * reads; it is never a session and never written as anyone's *_by.
 */
const SCHEDULE_VIEWER: Viewer = { email: 'scoreboard-chat-schedule', aliases: [], roles: [], role: 'assistant' };

export interface ScheduledRun {
  /** The Eastern time this call ran, e.g. "2026-10-08 15:00 ET". */
  ranAt: string;
  due: string[];
  results: SlotResult[];
}

function isMissingTable(message: string | undefined): boolean {
  return !!message && /does not exist|schema cache|PGRST205|42P01|42703/i.test(message);
}

function client() {
  const sb = createSupabaseServiceRoleClient();
  if (!sb) throw new Error('Supabase service role is not configured');
  return sb;
}

function deps(url: string, schedule: string | null): SlotDeps {
  return {
    async claim(slot) {
      const { data, error } = await client()
        .from(POSTS)
        .insert({
          slot_date: slot.date,
          slot_hour: slot.hour,
          frequencies: slot.frequencies,
          schedule_ids: slot.schedules.map((s) => s.id),
          schedule: schedule?.slice(0, 100) ?? null,
        })
        .select('id')
        .single();
      if (error?.code === '23505') return { kind: 'taken' };
      if (error) {
        return isMissingTable(error.message)
          ? { kind: 'error', status: 503, code: 'not_set_up', message: `${POSTS} is not set up for scheduled posts yet: run scripts/apply-accounting-scoreboard-chat-schedules-migration.mts --apply. Nothing was posted.` }
          : { kind: 'error', status: 500, code: 'db_error', message: `Could not claim ${slotLabel(slot)}: ${error.message}. Nothing was posted.` };
      }
      return { kind: 'claimed', id: (data as { id: string }).id };
    },
    async readProgress() {
      const team = await readTasks(SCHEDULE_VIEWER, { kind: 'all' });
      return team.ok ? { ok: true, progress: team.value.teamProgress ?? [] } : { ok: false, message: team.message };
    },
    send: ({ message, progress }) => sendChatPost(url, buildProgressPost(progress, new Date(), message)),
    async finish(id, status, fields) {
      const { data, error } = await client()
        .from(POSTS)
        .update({
          status,
          finished_at: new Date().toISOString(),
          message: fields.message ?? null,
          progress: fields.progress ?? null,
          detail: fields.detail?.slice(0, 300) ?? null,
        })
        .eq('id', id)
        .eq('status', 'sending')
        .select('id');
      if (error || !(data ?? []).length) {
        console.error(`[accounting-scoreboard-chat] could not stamp ${id} as ${status}:`, error?.message ?? 'no row updated');
        return false;
      }
      return true;
    },
    async audit(id, { message, progress, slot, card, posts }) {
      await insertAuditLog({
        ...ACTOR,
        action: 'accounting_scoreboard.tasks_progress_posted',
        resource: POSTS,
        resource_id: id,
        details: { message, progress, trigger: 'schedule', slot, card, posts },
      });
    },
  };
}

/** Post every slot due at `now`. `schedule` is the cron expression that fired (Vercel's x-vercel-cron-schedule). */
export async function runScheduledChatPosts(now: Date, schedule: string | null): Promise<Result<ScheduledRun>> {
  const clock = easternClock(now);
  const ranAt = `${clock.date} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')} ET`;

  const live = await readLiveSchedules();
  if (!live.ok) return live;
  const dueBefore = dueChatSlots(now, live.value);
  if (!dueBefore.length) return { ok: true, value: { ranAt, due: [], results: [] } };
  // At most once per post per Eastern day: drop a post that already went out today at another hour (it was retimed).
  const today = await readPostsOn(clock.date);
  if (!today.ok) return today;
  const due = withoutPostedToday(dueBefore, today.value);
  if (!due.length) return { ok: true, value: { ranAt, due: [], results: [] } };

  const url = process.env[CHAT_WEBHOOK_ENV]?.trim();
  if (!url) {
    return {
      ok: false,
      status: 503,
      code: 'chat_not_configured',
      message: `Google Chat isn't connected: ${CHAT_WEBHOOK_ENV} is not set on the server. Nothing was claimed or posted.`,
    };
  }

  const wired = deps(url, schedule);
  const results: SlotResult[] = [];
  for (const slot of due) {
    const r = await postSlot(slot, wired);
    if (!r.ok) return r;
    results.push(r.value);
  }
  return { ok: true, value: { ranAt, due: due.map(slotLabel), results } };
}
