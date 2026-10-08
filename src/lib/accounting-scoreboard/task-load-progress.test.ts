/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/task-load-progress.test.ts
 *
 * The Tasks view's loading card (task-load-progress.ts): its lines are real reads, reported once, a failure blames
 * only its own read, and the stream is assembled fail-closed. Source pins tie the lines to what readTasks and the
 * route really do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TASKS_STREAM_CUT_SHORT,
  TASK_LOAD_LINES,
  createTaskLineReporter,
  createTasksStreamAssembler,
  describeTaskLine,
  encodeTasksStreamLine,
  isTasksPayload,
  payloadShowsView,
  tasksLoadPlan,
} from './task-load-progress';
import type { TasksPayload } from './types';

const payload = (view: TasksPayload['view']): TasksPayload => ({
  today: '2026-10-08',
  viewer: { email: 'avery@example.test', role: 'admin' },
  view,
  people: [],
  tasks: [],
  checks: [],
  teamProgress: null,
  chatConfigured: true,
});
const MINE: TasksPayload['view'] = { kind: 'person', person: { email: 'avery@example.test', name: 'Avery' }, own: true };
const BLAKE: TasksPayload['view'] = { kind: 'person', person: { email: 'blake@example.test', name: 'Blake' }, own: false };

test('the plan lists the member check, then the three reads, then laying out', () => {
  const plan = tasksLoadPlan('My tasks', 'your');
  assert.deepEqual(plan.steps.map((s) => s.id), [...TASK_LOAD_LINES]);
  assert.equal(plan.steps[2].label, 'Reading your tasks');
  assert.equal(plan.applyLabel, 'Laying out the tasks');
  assert.equal(plan.appliedLabel, 'Tasks ready');
});

test('a done line says what came back; nothing is never printed as a count of 0', () => {
  assert.equal(describeTaskLine('people', 14), 'Found 14 people on the board');
  assert.equal(describeTaskLine('people', 1), 'Found 1 person on the board');
  assert.equal(describeTaskLine('tasks', 23), 'Read 23 tasks');
  assert.equal(describeTaskLine('tasks', 0), 'No tasks on this board yet');
  assert.equal(describeTaskLine('ticks', 4), '4 tasks ticked this period');
  assert.equal(describeTaskLine('ticks', 0), 'Nothing ticked yet this period');
});

test('the reporter reports each line once, the moment its read answers', () => {
  const heard: string[] = [];
  const r = createTaskLineReporter((line, detail) => heard.push(`${line}: ${detail}`));
  r.done('tasks', 3);
  r.done('tasks', 3);
  r.done('people', 2);
  r.done('ticks', 1);
  assert.deepEqual(heard, ['tasks: Read 3 tasks', 'people: Found 2 people on the board', 'ticks: 1 task ticked this period']);
  assert.equal(r.failedLine(), null);
});

test('a failed read is never reported done and is the one blamed; a read beside it that answered still ticks', () => {
  const heard: string[] = [];
  const r = createTaskLineReporter((line) => heard.push(line));
  r.failed('people');
  r.done('people', 5);
  r.done('tasks', 2);
  r.failed('ticks');
  assert.deepEqual(heard, ['tasks']);
  assert.equal(r.failedLine(), 'people', 'the FIRST read that failed is blamed, never a later one');
  r.failed('tasks');
  assert.equal(r.failedLine(), 'people', 'a line already reported done is never blamed afterwards');
});

test('a view answers only the board asked for', () => {
  assert.equal(payloadShowsView('me', MINE), true);
  assert.equal(payloadShowsView('me', BLAKE), false);
  assert.equal(payloadShowsView('all', { kind: 'all' }), true);
  assert.equal(payloadShowsView('blake@example.test', BLAKE), true);
  assert.equal(payloadShowsView('casey@example.test', BLAKE), false);
  assert.equal(payloadShowsView('me', undefined), false);
});

test('the payload check refuses a partial view', () => {
  assert.equal(isTasksPayload(payload(MINE)), true);
  const { tasks: _t, ...noTasks } = payload(MINE);
  void _t;
  assert.equal(isTasksPayload(noTasks), false);
  assert.equal(isTasksPayload({ ...payload(MINE), viewer: { email: 'a@b.c', role: 'manager' } }), false);
  assert.equal(isTasksPayload({ ...payload(MINE), chatConfigured: 'yes' }), false);
});

const stream = (view: string, lines: string[]) => {
  const a = createTasksStreamAssembler(view);
  const events = lines.map((l) => a.push(l));
  return { events, result: a.finish() };
};

test('a whole stream assembles: the lines, then the view', () => {
  const { events, result } = stream('me', [
    encodeTasksStreamLine({ type: 'line', line: 'tasks', detail: 'Read 3 tasks' }),
    '',
    encodeTasksStreamLine({ type: 'line', line: 'people', detail: 'Found 2 people on the board' }),
    encodeTasksStreamLine({ type: 'line', line: 'ticks', detail: 'Nothing ticked yet this period' }),
    encodeTasksStreamLine({ type: 'tasks', tasks: payload(MINE) }),
  ]);
  assert.deepEqual(events.map((e) => e?.kind ?? null), ['line', null, 'line', 'line', 'tasks']);
  assert.equal(result.ok, true);
});

test('fail-closed: cut short, unreadable, an unknown line, another view, or anything after the view', () => {
  assert.deepEqual(stream('me', [encodeTasksStreamLine({ type: 'line', line: 'tasks', detail: 'x' })]).result, {
    ok: false,
    error: TASKS_STREAM_CUT_SHORT,
    code: 'cut_short',
    line: null,
  });
  assert.equal(stream('me', ['{not json']).result.ok, false);
  assert.equal(stream('me', ['{"type":"line","line":"access","detail":"x"}']).result.ok, false, 'access is never a server line');
  assert.equal(stream('me', ['{"type":"line","line":"board","detail":"x"}']).result.ok, false);
  assert.equal(stream('me', [encodeTasksStreamLine({ type: 'tasks', tasks: payload(BLAKE) })]).result.ok, false, "Blake's board is never painted as mine");
  assert.equal(
    stream('me', [encodeTasksStreamLine({ type: 'tasks', tasks: payload(MINE) }), encodeTasksStreamLine({ type: 'line', line: 'ticks', detail: 'x' })]).result.ok,
    false,
  );
});

test('an error line fails the load with the server sentence and blames only its read', () => {
  const { result } = stream('all', [
    encodeTasksStreamLine({ type: 'line', line: 'people', detail: 'Found 2 people on the board' }),
    encodeTasksStreamLine({ type: 'error', error: 'Could not read the ticks', code: 'db_error', line: 'ticks' }),
    encodeTasksStreamLine({ type: 'tasks', tasks: payload({ kind: 'all' }) }),
  ]);
  assert.deepEqual(result, { ok: false, error: 'Could not read the ticks', code: 'db_error', line: 'ticks' });
});

// ── Source pins: the lines are what readTasks and the route really do ───────

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('readTasks reports every server line, done and failed, and nothing else (as `lines`, never `progress`: the board pin owns that name)', () => {
  // load-progress.test.ts reads every `progress?.done(` in server.ts as a BOARD read, so the Tasks reporter has its own name.
  const server = read('src', 'lib', 'accounting-scoreboard', 'server.ts');
  const body = server.slice(server.indexOf('export async function readTasks('), server.indexOf('export async function createTask('));
  for (const line of TASK_LOAD_LINES.filter((l) => l !== 'access')) {
    assert.match(body, new RegExp(`lines\\?\\.done\\('${line}'`), `${line} is reported when its read answers`);
    assert.match(body, new RegExp(`lines\\?\\.failed\\('${line}'\\)`), `${line} is blamed when its read fails`);
  }
  assert.doesNotMatch(body, /progress\?\./, "readTasks never reports as `progress`: the board's own pin would read it as a board read");
  const reported = [...body.matchAll(/lines\?\.(?:done|failed)\('([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(reported)].sort(), ['people', 'ticks', 'tasks'].sort(), 'no line is reported that the card does not list');
});

test('the route refuses BEFORE it streams, so a refusal stays a plain 401 / 403 / 400', () => {
  const route = read('app', 'api', 'accounting-scoreboard', 'tasks', 'route.ts');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  const at = (needle: string) => {
    const i = get.indexOf(needle);
    assert.ok(i >= 0, `${needle} is in GET`);
    return i;
  };
  assert.ok(at('resolveAccess(') < at("searchParams.get('stream')"));
  assert.ok(at('parseTaskView(') < at("searchParams.get('stream')"));
  assert.ok(at('refuseTaskView(') < at("searchParams.get('stream')"));
});
