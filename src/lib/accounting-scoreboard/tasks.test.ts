import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPeriodKeys, isTaskDone, progressByOwner, taskPeriodKey, taskProgress, type TaskLike } from './tasks';

test('period keys on Wednesday 2026-10-07 (Eastern)', () => {
  assert.equal(taskPeriodKey('daily', '2026-10-07'), '2026-10-07');
  assert.equal(taskPeriodKey('weekly', '2026-10-07'), '2026-10-04');
  assert.equal(taskPeriodKey('biweekly', '2026-10-07'), '2026-09-27');
  assert.equal(taskPeriodKey('monthly', '2026-10-07'), '2026-10-01');
  assert.equal(taskPeriodKey('bimonthly', '2026-10-07'), '2026-09-01');
  assert.equal(taskPeriodKey('quarterly', '2026-10-07'), '2026-10-01');
  assert.equal(taskPeriodKey('annually', '2026-10-07'), '2026-01-01');
  assert.equal(taskPeriodKey('as_needed', '2026-10-07'), null);
});

test('week edges: Sunday starts a week, Saturday ends it, and the two-week blocks follow', () => {
  assert.equal(taskPeriodKey('weekly', '2026-10-04'), '2026-10-04');
  assert.equal(taskPeriodKey('weekly', '2026-10-10'), '2026-10-04');
  assert.equal(taskPeriodKey('biweekly', '2026-10-10'), '2026-09-27');
  assert.equal(taskPeriodKey('biweekly', '2026-10-11'), '2026-10-11');
  assert.equal(taskPeriodKey('biweekly', '2026-01-04'), '2026-01-04');
  assert.equal(taskPeriodKey('biweekly', '2026-01-17'), '2026-01-04');
  assert.equal(taskPeriodKey('biweekly', '2026-01-18'), '2026-01-18');
});

test('before the anchor the blocks run backwards on the same rhythm', () => {
  assert.equal(taskPeriodKey('biweekly', '2026-01-03'), '2025-12-21');
  assert.equal(taskPeriodKey('biweekly', '2025-12-21'), '2025-12-21');
});

test('month, two-month and quarter edges', () => {
  assert.equal(taskPeriodKey('monthly', '2026-12-31'), '2026-12-01');
  assert.equal(taskPeriodKey('bimonthly', '2026-01-15'), '2026-01-01');
  assert.equal(taskPeriodKey('bimonthly', '2026-02-28'), '2026-01-01');
  assert.equal(taskPeriodKey('bimonthly', '2026-12-01'), '2026-11-01');
  assert.equal(taskPeriodKey('quarterly', '2026-11-30'), '2026-10-01');
  assert.equal(taskPeriodKey('quarterly', '2026-03-31'), '2026-01-01');
});

test('currentPeriodKeys covers every counted frequency and never as-needed', () => {
  const keys = currentPeriodKeys('2026-10-07');
  assert.deepEqual(Object.keys(keys).sort(), ['annually', 'bimonthly', 'biweekly', 'daily', 'monthly', 'quarterly', 'weekly']);
});

const t = (id: string, frequency: TaskLike['frequency'], ownerEmail = 'a@simple.biz', archived = false): TaskLike => ({
  id,
  frequency,
  ownerEmail,
  archived,
});

test('progress: live tasks, this period only, as-needed never counted, empty frequencies left out', () => {
  const tasks = [t('d1', 'daily'), t('d2', 'daily'), t('d3', 'daily', 'a@simple.biz', true), t('w1', 'weekly'), t('n1', 'as_needed')];
  const checks = [
    { taskId: 'd1', periodKey: '2026-10-07' },
    { taskId: 'd2', periodKey: '2026-10-06' }, // yesterday's tick does not count today
    { taskId: 'd3', periodKey: '2026-10-07' }, // an archived task never counts
    { taskId: 'w1', periodKey: '2026-10-04' }, // ticked Monday, still done on Wednesday
  ];
  assert.deepEqual(taskProgress(tasks, checks, '2026-10-07'), [
    { frequency: 'daily', total: 2, done: 1 },
    { frequency: 'weekly', total: 1, done: 1 },
  ]);
});

test('a weekly tick does not carry into next week', () => {
  const tasks = [t('w1', 'weekly')];
  const checks = [{ taskId: 'w1', periodKey: '2026-10-04' }];
  assert.deepEqual(taskProgress(tasks, checks, '2026-10-11'), [{ frequency: 'weekly', total: 1, done: 0 }]);
});

test('isTaskDone follows the current period; as-needed and archived are never done', () => {
  const checks = [{ taskId: 'm1', periodKey: '2026-10-01' }];
  assert.equal(isTaskDone(t('m1', 'monthly'), checks, '2026-10-31'), true);
  assert.equal(isTaskDone(t('m1', 'monthly'), checks, '2026-11-01'), false);
  assert.equal(isTaskDone(t('n1', 'as_needed'), [{ taskId: 'n1', periodKey: '2026-10-07' }], '2026-10-07'), false);
  assert.equal(isTaskDone(t('m1', 'monthly', 'a@simple.biz', true), checks, '2026-10-31'), false);
});

test('the All view: one entry per owner with counted tasks; an owner with only as-needed tasks is left out', () => {
  const tasks = [t('a1', 'daily', 'a@simple.biz'), t('b1', 'daily', 'b@simple.biz'), t('b2', 'weekly', 'b@simple.biz'), t('c1', 'as_needed', 'c@simple.biz')];
  const checks = [{ taskId: 'b1', periodKey: '2026-10-07' }];
  assert.deepEqual(progressByOwner(tasks, checks, '2026-10-07'), [
    { ownerEmail: 'a@simple.biz', progress: [{ frequency: 'daily', total: 1, done: 0 }] },
    {
      ownerEmail: 'b@simple.biz',
      progress: [
        { frequency: 'daily', total: 1, done: 1 },
        { frequency: 'weekly', total: 1, done: 0 },
      ],
    },
  ]);
});
