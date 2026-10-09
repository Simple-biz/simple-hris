/**
 * Setup → Scheduled Posts: what an Admin may save. Pure, so the route refuses exactly what the editor marks wrong.
 *
 * A save is a whole definition (the editor always sends one), normalised: days in the week's order, month days
 * ascending, frequencies in the board's order, each once; the days a repeat does not use are emptied. A pause on its
 * own is `{ id, paused }`. Governing doc: docs/features/accounting-scoreboard-scheduled-posts.md § Editing.
 */

import { COUNTED_FREQUENCIES, type CountedFrequency } from './tasks';
import { WEEKDAYS, type Weekday } from './sections';
import { POST_REPEATS, type PostRepeat, type PostSchedule } from './chat-schedule';
import { templateProblem } from './chat-template';

export const LABEL_MAX_LENGTH = 60;

/** What an Admin sets. Everything the editor shows, nothing the server stamps. */
export type ScheduleDefinition = Pick<
  PostSchedule,
  'label' | 'repeat' | 'weekdays' | 'monthDays' | 'hour' | 'frequencies' | 'template' | 'paused'
>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Why a definition cannot be saved, or null. The editor shows it; the route refuses with it. */
export function definitionProblem(d: ScheduleDefinition): string | null {
  if (!d.label.trim()) return 'Give the post a name.';
  if (d.label.trim().length > LABEL_MAX_LENGTH) return `Keep the name to ${LABEL_MAX_LENGTH} characters.`;
  if (d.repeat === 'weekdays' && !d.weekdays.length) return 'Pick at least one day of the week.';
  if (d.repeat === 'month_days' && !d.monthDays.length) return 'Pick at least one day of the month.';
  if (!d.frequencies.length) return 'Pick what the post counts.';
  return templateProblem(d.template);
}

/** The definition with its lists in order, each value once, and the unused days emptied. */
export function normalizeDefinition(d: ScheduleDefinition): ScheduleDefinition {
  return {
    label: d.label.trim(),
    repeat: d.repeat,
    weekdays: d.repeat === 'weekdays' ? WEEKDAYS.filter((w) => d.weekdays.includes(w)) : [],
    monthDays: d.repeat === 'month_days' ? [...new Set(d.monthDays)].sort((a, b) => a - b) : [],
    hour: d.hour,
    frequencies: COUNTED_FREQUENCIES.filter((f) => d.frequencies.includes(f)),
    template: d.template,
    paused: d.paused,
  };
}

function parseDefinition(o: Record<string, unknown>): Parsed<ScheduleDefinition> {
  if (typeof o.label !== 'string') return { ok: false, error: 'label must be text' };
  if (!(POST_REPEATS as readonly unknown[]).includes(o.repeat)) return { ok: false, error: `repeat must be one of ${POST_REPEATS.join(', ')}` };
  const weekdays = o.weekdays ?? [];
  if (!Array.isArray(weekdays) || !weekdays.every((w) => (WEEKDAYS as readonly unknown[]).includes(w))) {
    return { ok: false, error: `weekdays must be a list of ${WEEKDAYS.join(', ')}` };
  }
  const monthDays = o.monthDays ?? [];
  if (!Array.isArray(monthDays) || !monthDays.every((n) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 31)) {
    return { ok: false, error: 'monthDays must be a list of days from 1 to 31' };
  }
  if (!Number.isInteger(o.hour) || (o.hour as number) < 0 || (o.hour as number) > 23) {
    return { ok: false, error: 'hour must be a whole hour from 0 to 23 (US Eastern)' };
  }
  if (!Array.isArray(o.frequencies) || !o.frequencies.every((f) => (COUNTED_FREQUENCIES as readonly unknown[]).includes(f))) {
    return { ok: false, error: `frequencies must be a list of ${COUNTED_FREQUENCIES.join(', ')}` };
  }
  if (typeof o.template !== 'string') return { ok: false, error: 'template must be text' };
  if (o.paused !== undefined && typeof o.paused !== 'boolean') return { ok: false, error: 'paused must be true or false' };
  const d = normalizeDefinition({
    label: o.label,
    repeat: o.repeat as PostRepeat,
    weekdays: weekdays as Weekday[],
    monthDays: monthDays as number[],
    hour: o.hour as number,
    frequencies: o.frequencies as CountedFrequency[],
    template: o.template,
    paused: (o.paused as boolean | undefined) ?? false,
  });
  const problem = definitionProblem(d);
  return problem ? { ok: false, error: problem } : { ok: true, value: d };
}

/** POST: a new post. */
export function parseScheduleCreate(body: unknown): Parsed<ScheduleDefinition> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send the post as an object' };
  return parseDefinition(body as Record<string, unknown>);
}

export type SchedulePatch = { id: string; kind: 'pause'; paused: boolean } | { id: string; kind: 'edit'; definition: ScheduleDefinition };

/** PATCH: `{ id, paused }` alone pauses or resumes; anything else is a whole definition. */
export function parseSchedulePatch(body: unknown): Parsed<SchedulePatch> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send the change as an object' };
  const o = body as Record<string, unknown>;
  if (!isUuid(o.id)) return { ok: false, error: 'id must be a scheduled post id' };
  const keys = Object.keys(o).filter((k) => k !== 'id');
  if (keys.length === 1 && keys[0] === 'paused') {
    if (typeof o.paused !== 'boolean') return { ok: false, error: 'paused must be true or false' };
    return { ok: true, value: { id: o.id, kind: 'pause', paused: o.paused } };
  }
  const parsed = parseDefinition(o);
  return parsed.ok ? { ok: true, value: { id: o.id, kind: 'edit', definition: parsed.value } } : parsed;
}

/** The fields that differ, as `{ field: { from, to } }`, for the audit row. Lists compare by value. */
export function definitionChanges(before: ScheduleDefinition, after: ScheduleDefinition): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after) as Array<keyof ScheduleDefinition>) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = { from: before[k], to: after[k] };
  }
  return out;
}
