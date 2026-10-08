import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskCheck,
  parseTaskCreate,
  parseTaskFrequencyChange,
  parseTaskOrder,
  parseTaskPatch,
  parseTaskView,
  TASK_TITLE_MAX,
} from './validate';
import { TASK_ORDER_MAX } from './task-order';

const ID = '7d0f3c1e-2b4a-4c6d-8e9f-0a1b2c3d4e5f';

test('a new task: owner lower-cased, title squeezed, frequency one of the eight', () => {
  const r = parseTaskCreate({ ownerEmail: ' Kristine@Simple.biz ', title: '  Check   the  inbox ', frequency: 'daily' });
  assert.deepEqual(r, { ok: true, value: { ownerEmail: 'kristine@simple.biz', title: 'Check the inbox', frequency: 'daily' } });
  assert.equal(parseTaskCreate({ ownerEmail: 'a@simple.biz', title: 'x', frequency: 'as_needed' }).ok, true);
});

test('a new task: each refusal names what is missing', () => {
  assert.deepEqual(parseTaskCreate({ title: 'x', frequency: 'daily' }), { ok: false, error: 'Pick whose board the task goes on' });
  assert.deepEqual(parseTaskCreate({ ownerEmail: 'a@simple.biz', title: '   ', frequency: 'daily' }), { ok: false, error: 'A task needs a title' });
  assert.deepEqual(parseTaskCreate({ ownerEmail: 'a@simple.biz', title: 'x', frequency: 'hourly' }), { ok: false, error: 'Pick how often the task is done' });
  const long = parseTaskCreate({ ownerEmail: 'a@simple.biz', title: 'x'.repeat(TASK_TITLE_MAX + 1), frequency: 'daily' });
  assert.equal(long.ok, false);
});

test('a patch renames, reorders or archives, and never moves owner or frequency', () => {
  assert.deepEqual(parseTaskPatch({ id: ID, title: 'New name' }), { ok: true, value: { id: ID, title: 'New name' } });
  assert.deepEqual(parseTaskPatch({ id: ID, sortOrder: 3 }), { ok: true, value: { id: ID, sortOrder: 3 } });
  assert.deepEqual(parseTaskPatch({ id: ID, archived: true }), { ok: true, value: { id: ID, archived: true } });
  assert.equal(parseTaskPatch({ id: ID, archived: false }).ok, false);
  assert.equal(parseTaskPatch({ id: ID, frequency: 'weekly' }).ok, false);
  assert.equal(parseTaskPatch({ id: ID, ownerEmail: 'b@simple.biz' }).ok, false);
  assert.equal(parseTaskPatch({ id: ID, sortOrder: 1.5 }).ok, false);
  assert.deepEqual(parseTaskPatch({ id: ID }), { ok: false, error: 'Nothing to change' });
  assert.equal(parseTaskPatch({ id: 'not-a-uuid', title: 'x' }).ok, false);
});

test('a tick names the task and the state; the period is never taken from the body', () => {
  assert.deepEqual(parseTaskCheck({ taskId: ID, done: true, periodKey: '2020-01-01' }), { ok: true, value: { taskId: ID, done: true } });
  assert.equal(parseTaskCheck({ taskId: ID, done: 'yes' }).ok, false);
  assert.equal(parseTaskCheck({ taskId: 'x', done: true }).ok, false);
});

test('the view: me by default, all, or a work email', () => {
  assert.deepEqual(parseTaskView(null), { ok: true, value: { kind: 'me' } });
  assert.deepEqual(parseTaskView('all'), { ok: true, value: { kind: 'all' } });
  assert.deepEqual(parseTaskView('Joana@Simple.biz'), { ok: true, value: { kind: 'person', email: 'joana@simple.biz' } });
  assert.equal(parseTaskView('nobody').ok, false);
});

test('changing how often: a task id and one of the eight; the title may change in the same save', () => {
  assert.deepEqual(parseTaskFrequencyChange({ id: ID, frequency: 'weekly' }), { ok: true, value: { id: ID, frequency: 'weekly' } });
  assert.deepEqual(parseTaskFrequencyChange({ id: ID, frequency: 'as_needed', title: '  Send   the report ' }), {
    ok: true,
    value: { id: ID, frequency: 'as_needed', title: 'Send the report' },
  });
  assert.deepEqual(parseTaskFrequencyChange({ id: ID }), { ok: false, error: 'Pick how often the task is done' });
  assert.deepEqual(parseTaskFrequencyChange({ id: ID, frequency: 'hourly' }), { ok: false, error: 'Pick how often the task is done' });
  assert.deepEqual(parseTaskFrequencyChange({ id: ID, frequency: 'weekly', title: '  ' }), { ok: false, error: 'A task needs a title' });
  assert.equal(parseTaskFrequencyChange({ id: 'not-a-uuid', frequency: 'weekly' }).ok, false);
});

test('changing how often never moves the owner', () => {
  const r = parseTaskFrequencyChange({ id: ID, frequency: 'weekly', ownerEmail: 'b@simple.biz' });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /owner never changes/);
});

test('a new order: task ids, each once, lower-cased, at most the cap', () => {
  const ID2 = '8E1F4D2F-3C5B-4D7E-9FA0-1B2C3D4E5F60';
  assert.deepEqual(parseTaskOrder({ ids: [ID, ID2] }), { ok: true, value: { ids: [ID, ID2.toLowerCase()] } });
  assert.equal(parseTaskOrder({ ids: [] }).ok, false);
  assert.equal(parseTaskOrder({ ids: 'x' }).ok, false);
  assert.equal(parseTaskOrder({ ids: [ID, 'nope'] }).ok, false);
  assert.deepEqual(parseTaskOrder({ ids: [ID, ID.toUpperCase()] }), { ok: false, error: 'A task is listed twice' });
  const many = Array.from({ length: TASK_ORDER_MAX + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(parseTaskOrder({ ids: many }).ok, false);
  assert.equal(parseTaskOrder({ ids: many.slice(0, TASK_ORDER_MAX) }).ok, true);
  // Whose card it is never comes from the body.
  assert.deepEqual(parseTaskOrder({ ids: [ID], ownerEmail: 'b@simple.biz' }), { ok: true, value: { ids: [ID] } });
});
