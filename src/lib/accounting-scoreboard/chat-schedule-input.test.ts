import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { definitionChanges, parseScheduleCreate, parseSchedulePatch, type ScheduleDefinition } from './chat-schedule-input';
import { DEFAULT_POST_TEMPLATE } from './chat-template';

const ID = '7f0c2a52-1b7e-4d3e-9b51-0d1f2a3b4c5d';
const WEEKLY: ScheduleDefinition = {
  label: 'Weekly',
  repeat: 'weekdays',
  weekdays: ['wed', 'fri'],
  monthDays: [],
  hour: 9,
  frequencies: ['weekly'],
  template: DEFAULT_POST_TEMPLATE,
  paused: false,
};

const refused = (body: unknown) => {
  const r = parseScheduleCreate(body);
  assert.equal(r.ok, false, JSON.stringify(body));
  return r.ok ? '' : r.error;
};

test('a new post is normalised: days in the week order, month days ascending, counts in the board order, each once', () => {
  const r = parseScheduleCreate({
    label: '  Friday nudge ',
    repeat: 'weekdays',
    weekdays: ['fri', 'mon', 'fri'],
    monthDays: [5],
    hour: 16,
    frequencies: ['monthly', 'daily', 'daily'],
    template: '{progress}',
  });
  assert.deepEqual(r, {
    ok: true,
    value: { label: 'Friday nudge', repeat: 'weekdays', weekdays: ['mon', 'fri'], monthDays: [], hour: 16, frequencies: ['daily', 'monthly'], template: '{progress}', paused: false },
  });
  const m = parseScheduleCreate({ ...WEEKLY, repeat: 'month_days', monthDays: [30, 1, 30], weekdays: ['wed'] });
  assert.ok(m.ok && m.value.monthDays.join() === '1,30' && m.value.weekdays.length === 0);
  const e = parseScheduleCreate({ ...WEEKLY, repeat: 'every_day' });
  assert.ok(e.ok && e.value.weekdays.length === 0 && e.value.monthDays.length === 0);
});

test('what a post cannot be', () => {
  assert.equal(refused({ ...WEEKLY, label: '   ' }), 'Give the post a name.');
  assert.equal(refused({ ...WEEKLY, label: 'x'.repeat(61) }), 'Keep the name to 60 characters.');
  assert.equal(refused({ ...WEEKLY, weekdays: [] }), 'Pick at least one day of the week.');
  assert.equal(refused({ ...WEEKLY, repeat: 'month_days', monthDays: [] }), 'Pick at least one day of the month.');
  assert.equal(refused({ ...WEEKLY, frequencies: [] }), 'Pick what the post counts.');
  assert.match(refused({ ...WEEKLY, frequencies: ['as_needed'] }), /frequencies must be/); // never counted
  assert.match(refused({ ...WEEKLY, hour: 24 }), /hour must be/);
  assert.match(refused({ ...WEEKLY, hour: 9.5 }), /hour must be/);
  assert.match(refused({ ...WEEKLY, repeat: 'monthly' }), /repeat must be/);
  assert.match(refused({ ...WEEKLY, weekdays: ['wednesday'] }), /weekdays must be/);
  assert.match(refused({ ...WEEKLY, repeat: 'month_days', monthDays: [0] }), /monthDays must be/);
  assert.match(refused({ ...WEEKLY, repeat: 'month_days', monthDays: [32] }), /monthDays must be/);
  assert.equal(refused({ ...WEEKLY, template: 'Hi {name}' }), "{name} isn't a placeholder. The only one is {progress}.");
  assert.match(refused({ ...WEEKLY, paused: 'no' }), /paused must be/);
  assert.match(refused(null), /object/);
  assert.match(refused([WEEKLY]), /object/);
});

test('a PATCH is a pause on its own, or a whole definition', () => {
  assert.deepEqual(parseSchedulePatch({ id: ID, paused: true }), { ok: true, value: { id: ID, kind: 'pause', paused: true } });
  const edit = parseSchedulePatch({ id: ID, ...WEEKLY, hour: 10 });
  assert.ok(edit.ok && edit.value.kind === 'edit' && edit.value.definition.hour === 10);
  assert.equal(parseSchedulePatch({ id: 'nope', paused: true }).ok, false);
  assert.equal(parseSchedulePatch({ id: ID, paused: 'yes' }).ok, false);
  // Half a definition is refused, never merged into the saved one.
  assert.equal(parseSchedulePatch({ id: ID, template: 'x' }).ok, false);
});

test('the audit row names exactly what changed', () => {
  assert.deepEqual(definitionChanges(WEEKLY, { ...WEEKLY }), {});
  assert.deepEqual(definitionChanges(WEEKLY, { ...WEEKLY, hour: 10, weekdays: ['wed'] }), {
    weekdays: { from: ['wed', 'fri'], to: ['wed'] },
    hour: { from: 9, to: 10 },
  });
});

// Source pins: the area's server and route.
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('the route reads like the rest of Setup (view_setup) and writes like it (edit_setup)', () => {
  const src = read('app', 'api', 'accounting-scoreboard', 'chat-schedules', 'route.ts');
  const handlers = src.split(/(?=export async function )/).filter((c) => c.startsWith('export async function'));
  assert.equal(handlers.length, 4);
  for (const h of handlers) {
    const write = /^export async function (POST|PATCH|DELETE)\b/.test(h);
    assert.match(h, write ? /resolveAccess\('edit_setup'\)/ : /resolveAccess\('view_setup'\)/, h.slice(0, 30));
  }
});

test('nothing is deleted, and the webhook is never touched from Setup', () => {
  const src = read('src', 'lib', 'accounting-scoreboard', 'chat-schedules-server.ts');
  assert.ok(!/\.delete\(/.test(src), 'a post is archived, never deleted');
  assert.ok(!src.includes('CHAT_WEBHOOK'), 'the webhook URL is read only by the senders');
  assert.ok(!/\bfetch\(/.test(src), 'nothing here posts to Chat');
  assert.match(src, /archived_by: viewer\.email/);
  assert.match(src, /updated_by: viewer\.email/);
});

test('the cron no longer holds a time of its own: every post comes from the table', () => {
  const src = read('src', 'lib', 'accounting-scoreboard', 'chat-schedule.ts');
  assert.ok(!/MORNING_HOUR|AFTERNOON_HOUR|WEEKLY_POST_DAYS/.test(src));
  assert.match(read('src', 'lib', 'accounting-scoreboard', 'scheduled-chat.ts'), /readLiveSchedules\(\)/);
});
