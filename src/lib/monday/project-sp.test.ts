import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectSp, type RollupEpic, type RollupTask } from './project-sp';

const epics: RollupEpic[] = [
  { code: 'A', sp: 10, status: 'Shipped' }, //     history under forecast, new work on top
  { code: 'B', sp: 20, status: 'In Progress' }, // history blew past the forecast
  { code: 'C', sp: 10, status: 'In Progress' }, // mostly undecomposed, one open row
  { code: 'D', sp: 12, status: 'Shipped' }, //     no rows at all
];
const tasks: RollupTask[] = [
  { epic: 'A', sp: 4, done: true, sprint: 'S24' },
  { epic: 'A', sp: 6, done: true, sprint: 'S27' },
  { epic: 'B', sp: 25, done: true, sprint: 'S25' },
  { epic: 'B', sp: 5, done: true, sprint: 'S30' },
  { epic: 'C', sp: 3, done: false, sprint: 'S30' },
  { epic: 'C', sp: 2, done: true, sprint: 'BL' },
];

test('total: the forecast covers history, rows from Sprint 26 on are added on top', () => {
  const r = projectSp(epics, tasks);
  // A: max(10, 4) + 6 · B: max(20, 25) + 5 · C: max(10, 0) + 5 · D: 12
  assert.equal(r.total, 16 + 30 + 15 + 12);
  assert.equal(r.forecast, 52);
  assert.equal(r.childPre, 29);
  assert.equal(r.childPost, 16);
});

test('uncovered: forecast minus ALL child SP, on epics that are not Shipped only', () => {
  const r = projectSp(epics, tasks);
  // B is over-covered (30 > 20) → 0. C: 10 − 5 = 5. A and D are Shipped → never uncovered.
  assert.deepEqual(r.uncoveredByEpic, { C: 5 });
  assert.equal(r.uncovered, 5);
});

test('completed = total − open task SP − uncovered forecast', () => {
  const r = projectSp(epics, tasks);
  assert.equal(r.openSp, 3);
  assert.equal(r.openRows, 1);
  assert.equal(r.completed, 73 - 3 - 5);
  assert.equal(r.taskSp, r.doneSp + r.openSp);
});

test('a Backlog row counts as post-Aug-4 work, never as history', () => {
  const r = projectSp([{ code: 'X', sp: 5, status: 'Shipped' }], [{ epic: 'X', sp: 3, done: true, sprint: 'BL' }]);
  assert.equal(r.total, 5 + 3);
});

test('asShipped answers "what if these epics were Shipped" without touching the total', () => {
  const recorded = projectSp(epics, tasks);
  const shipped = projectSp(epics, tasks, ['C']);
  assert.equal(shipped.total, recorded.total);
  assert.equal(shipped.uncovered, 0);
  assert.equal(shipped.completed, recorded.completed + 5);
  // an open row is still open: shipping the epic does not close its tasks
  assert.equal(shipped.openSp, 3);
});
