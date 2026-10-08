/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/load-progress.test.ts
 *
 * The loading modal is accurate only if every line is real work, reported when it happened. These pin:
 * the lines ↔ the reads readBoard really sends (both ways, read from the source), a line done only when
 * its LAST read answered, a failed read never reported as done, the stream assembled fail-closed, and a
 * whole run through the shared step model never moving backwards and only full once painted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { glidePositionAt } from '@/lib/npd/load-progress';
import {
  applyRefresh,
  beginStep,
  completeStep,
  failRefresh,
  finishRefresh,
  refreshLines,
  startRefresh,
  type RefreshProgress,
} from '@/lib/refresh-progress/refresh-progress';
import {
  BOARD_LOAD_LINES,
  BOARD_READS,
  BOARD_STREAM_CUT_SHORT,
  boardLoadPlan,
  createBoardStreamAssembler,
  createLineTracker,
  encodeBoardStreamLine,
  lineOfRead,
  type BoardRead,
  type ServerLine,
} from './load-progress';
import type { BoardPayload } from './types';

const src = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8');
const ALL_READS = Object.values(BOARD_READS).flat() as BoardRead[];

function board(weekStart = '2026-10-04'): BoardPayload {
  return {
    weekStart,
    lastWeekStart: '2026-09-27',
    today: '2026-10-06',
    viewer: { email: 'carla@simple.biz', role: 'admin' },
    settings: [],
    customSections: [],
    rows: [],
    entries: [],
    collections: [],
    problems: [],
    problemTypes: [],
    lastMeetingDate: null,
    history: { allTimeByRow: {}, record: null, liveSince: null },
    members: [],
    bonus: { ok: false, reason: 'test' },
    payrollEvents: [],
    firstClosedPeriodEnd: null,
    generatedAt: '2026-10-06T12:00:00Z',
  };
}

test('every read readBoard reports is on a line, and every line read is reported by readBoard (both ways)', () => {
  const server = src('src/lib/accounting-scoreboard/server.ts');
  const reported = new Set([...server.matchAll(/(?:paged|single)\(\s*'([a-zA-Z]+)'|progress\?\.(?:done|failed\?\.)\('([a-zA-Z]+)'/g)].map((m) => m[1] ?? m[2]));
  assert.deepEqual([...reported].sort(), [...ALL_READS].sort());
  for (const r of ALL_READS) assert.equal(BOARD_READS[lineOfRead(r)].includes(r as never), true, r);
});

test('the route checks membership and the week BEFORE the stream starts, and streams NDJSON uncached', () => {
  const route = src('app/api/accounting-scoreboard/route.ts');
  const stream = route.indexOf('new ReadableStream');
  assert.ok(route.indexOf("resolveAccess()") > 0 && route.indexOf("resolveAccess()") < stream);
  assert.ok(route.indexOf('isWeekStart(week)') < stream);
  assert.match(route, /'Content-Type': 'application\/x-ndjson; charset=utf-8',\n\s+'Cache-Control': 'no-store',/);
});

test('the plan lists the lines in order, with the server lines after the member check', () => {
  const plan = boardLoadPlan('the scoreboard');
  assert.deepEqual(plan.steps.map((s) => s.id), [...BOARD_LOAD_LINES]);
  assert.equal(plan.applyLabel, 'Laying out the board');
  assert.equal(plan.appliedLabel, 'Board ready');
});

test('a line is reported only when its LAST read answered, with what came back; once', () => {
  const seen: [ServerLine, string][] = [];
  const t = createLineTracker((line, detail) => seen.push([line, detail]));
  t.done('collections', 165);
  assert.deepEqual(seen, [], 'the all-time weeks have not answered yet');
  t.done('collectionWeeks', 566);
  assert.deepEqual(seen, [['collections', 'Collected 165 collections this week and last']]);
  t.done('collections', 999);
  assert.equal(seen.length, 1, 'a read reported twice counts once');

  t.done('rows', 102);
  assert.equal(seen.length, 1, 'rows waits for the removed-rows decision');
  t.done('removedRows', 3);
  assert.deepEqual(seen.at(-1), ['rows', 'Found 102 lines on the board (+ 3 removed lines with numbers)']);

  t.done('entries', 866);
  assert.deepEqual(seen.at(-1), ['numbers', 'Collected 866 numbers this week and last']);
  t.done('problems', 0);
  t.done('problemTypes', 3);
  assert.deepEqual(seen.at(-1), ['problems', 'No payroll problems logged this week or last']);
  t.done('payrollEvents', 12);
  t.done('closes', 9);
  assert.deepEqual(seen.at(-1), ['payroll', 'Found 12 Payroll Wizard starts and closes']);
  for (const r of ['settings', 'customSections', 'lastMeeting', 'members'] as const) t.done(r, 1);
  t.done('bonus', 1, 'the bonus formula could not be read');
  assert.deepEqual(seen.at(-1), ['setup', 'Read the goals and sections · the bonus formula could not be read'], 'a tolerated failure is never called read');
});

test('a failed read blocks its line forever and is the line the error names', () => {
  const seen: ServerLine[] = [];
  const t = createLineTracker((line) => seen.push(line));
  t.failed('entries');
  t.done('entries', 10);
  assert.deepEqual(seen, [], 'a failed read is never reported as answered');
  assert.equal(t.failedLine(), 'numbers');
  t.failed('closes');
  assert.equal(t.failedLine(), 'numbers', 'the first failure is the one named');
});

test('the stream assembles a whole board; lines arrive as events', () => {
  const a = createBoardStreamAssembler(null);
  assert.deepEqual(a.push(encodeBoardStreamLine({ type: 'line', line: 'numbers', detail: 'Collected 3 numbers' })), {
    kind: 'line',
    line: 'numbers',
    detail: 'Collected 3 numbers',
  });
  assert.equal(a.push(''), null);
  assert.equal(a.push(encodeBoardStreamLine({ type: 'board', board: board() }))?.kind, 'board');
  const done = a.finish();
  assert.equal(done.ok && done.board.weekStart, '2026-10-04');
});

test('fail-closed: cut short, unreadable, an unknown line, another week, or anything after the board', () => {
  const cut = createBoardStreamAssembler(null);
  cut.push(encodeBoardStreamLine({ type: 'line', line: 'rows', detail: 'x' }));
  assert.deepEqual(cut.finish(), { ok: false, error: BOARD_STREAM_CUT_SHORT, code: 'cut_short', line: null });

  for (const bad of ['{not json', '{"type":"line","line":"access","detail":"x"}', '{"type":"line","line":"rows"}', '{"type":"mystery"}']) {
    const a = createBoardStreamAssembler(null);
    assert.equal(a.push(bad)?.kind, 'failed', bad);
    assert.equal(a.finish().ok, false, bad);
  }

  const wrongWeek = createBoardStreamAssembler('2026-09-27');
  assert.equal(wrongWeek.push(encodeBoardStreamLine({ type: 'board', board: board('2026-10-04') }))?.kind, 'failed');

  const partial = createBoardStreamAssembler(null);
  assert.equal(partial.push(JSON.stringify({ type: 'board', board: { ...board(), rows: undefined } }))?.kind, 'failed', 'a board missing a list');

  const after = createBoardStreamAssembler(null);
  after.push(encodeBoardStreamLine({ type: 'board', board: board() }));
  assert.equal(after.push(encodeBoardStreamLine({ type: 'line', line: 'rows', detail: 'x' }))?.kind, 'failed');
  assert.equal(after.finish().ok, false);
});

test("the server's error line keeps its sentence and names only the failed read's line", () => {
  const a = createBoardStreamAssembler(null);
  const e = a.push(encodeBoardStreamLine({ type: 'error', error: 'Could not read the scoreboard', code: 'db_error', line: 'payroll' }));
  assert.deepEqual(e, { kind: 'failed', error: 'Could not read the scoreboard', code: 'db_error', line: 'payroll' });
  assert.deepEqual(a.finish(), { ok: false, error: 'Could not read the scoreboard', code: 'db_error', line: 'payroll' });
});

test('a whole run never moves backwards, and is full and green only after the board is painted', () => {
  let t = 0;
  let p: RefreshProgress = beginStep(startRefresh(boardLoadPlan('the scoreboard'), t), 'access', t);
  const marks: number[] = [];
  const ceilings: number[] = [];
  const mark = () => {
    t += 500;
    marks.push(glidePositionAt(p.glide, t));
    ceilings.push(p.glide.to);
  };
  mark();
  p = completeStep(p, 'access', null, t);
  for (const l of BOARD_LOAD_LINES.slice(1)) p = beginStep(p, l, t);
  mark();
  for (const l of BOARD_LOAD_LINES.slice(1)) {
    p = completeStep(p, l, `${l} done`, t);
    mark();
  }
  assert.ok(p.glide.to < 1, 'every read answered, but the board is not on screen yet');
  p = applyRefresh(p, t);
  mark();
  assert.ok(p.glide.to < 1, 'laying out the board is not the end');
  assert.equal(refreshLines(p).at(-1)?.text, 'Laying out the board');
  p = finishRefresh(p, t);
  mark();
  assert.equal(p.glide.to, 1);
  assert.equal(refreshLines(p).at(-1)?.text, 'Board ready');
  for (let i = 1; i < marks.length; i++) {
    assert.ok(marks[i] >= marks[i - 1] - 1e-9, `the fill moved backwards at ${i}`);
    assert.ok(ceilings[i] >= ceilings[i - 1] - 1e-9, `the ceiling moved backwards at ${i}`);
  }
});

test('a failure holds the bar and blames only the failed line', () => {
  let p = beginStep(startRefresh(boardLoadPlan('the scoreboard'), 0), 'access', 0);
  p = completeStep(p, 'access', null, 10);
  for (const l of BOARD_LOAD_LINES.slice(1)) p = beginStep(p, l, 10);
  p = completeStep(p, 'numbers', 'Collected 3 numbers', 20);
  const before = glidePositionAt(p.glide, 30);
  p = failRefresh(p, 'Could not read the scoreboard', 30, 'payroll');
  const states = Object.fromEntries(refreshLines(p).map((l) => [l.id, l.state]));
  assert.equal(states.payroll, 'failed');
  assert.equal(states.numbers, 'done');
  assert.equal(states.rows, 'todo', 'a read still in flight beside it did not fail');
  assert.equal(p.glide.to, p.glide.from, 'held where it stopped');
  assert.ok(glidePositionAt(p.glide, 99_999) >= before - 1e-9);
});
