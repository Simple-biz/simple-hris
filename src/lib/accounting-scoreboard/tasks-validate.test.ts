import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskCheck, parseTaskCreate, parseTaskPatch, parseTaskView, TASK_TITLE_MAX } from './validate';

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
