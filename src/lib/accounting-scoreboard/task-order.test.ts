import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTaskOrder, planTaskOrder, type OrderableTask } from './task-order';

const t = (id: string, sortOrder: number, over: Partial<OrderableTask> = {}): OrderableTask => ({
  id,
  ownerEmail: 'aliviah@simple.biz',
  frequency: 'weekly',
  sortOrder,
  createdAt: '2026-10-08T00:00:00Z',
  archived: false,
  ...over,
});

const CARD = [t('a', 0), t('b', 1), t('c', 2)];

test('a new order writes 0, 1, 2… and only the rows that move', () => {
  const plan = planTaskOrder(['c', 'a', 'b'], CARD, CARD);
  assert.deepEqual(plan, {
    ok: true,
    ownerEmail: 'aliviah@simple.biz',
    frequency: 'weekly',
    updates: [
      { id: 'c', sortOrder: 0 },
      { id: 'a', sortOrder: 1 },
      { id: 'b', sortOrder: 2 },
    ],
  });
  // Moving the last two only rewrites them.
  const swap = planTaskOrder(['a', 'c', 'b'], CARD, CARD);
  assert.ok(swap.ok);
  assert.deepEqual(swap.updates, [
    { id: 'c', sortOrder: 1 },
    { id: 'b', sortOrder: 2 },
  ]);
  // The same order writes nothing.
  const same = planTaskOrder(['a', 'b', 'c'], CARD, CARD);
  assert.ok(same.ok && same.updates.length === 0);
});

test('imported tasks that share a number are renumbered in the order asked', () => {
  const tied = [t('a', 0), t('b', 0), t('c', 0)];
  const plan = planTaskOrder(['b', 'a', 'c'], tied, tied);
  assert.ok(plan.ok);
  assert.deepEqual(plan.updates, [
    { id: 'a', sortOrder: 1 },
    { id: 'c', sortOrder: 2 },
  ]);
});

test('a list that misses a live task (added since the page loaded) is stale, never applied in part', () => {
  const grown = [...CARD, t('d', 3)];
  const plan = planTaskOrder(['c', 'a', 'b'], CARD, grown);
  assert.deepEqual(plan, { ok: false, status: 409, code: 'stale', message: 'This list changed since it was loaded. Refresh and try again.' });
});

test('a task archived since the page loaded makes the list stale', () => {
  const named = [t('a', 0), t('b', 1, { archived: true }), t('c', 2)];
  const plan = planTaskOrder(['a', 'b', 'c'], named, [t('a', 0), t('c', 2)]);
  assert.equal(plan.ok, false);
  assert.equal(!plan.ok && plan.code, 'stale');
});

test('an id that names no task is a 404', () => {
  const plan = planTaskOrder(['a', 'zzz', 'b', 'c'], CARD, CARD);
  assert.equal(!plan.ok && plan.status, 404);
});

test("a task never moves to another card or another person's board", () => {
  const otherCard = [t('a', 0), t('x', 0, { frequency: 'daily' })];
  const mixedFreq = planTaskOrder(['a', 'x'], otherCard, otherCard);
  assert.equal(!mixedFreq.ok && mixedFreq.code, 'mixed_frequencies');
  const otherOwner = [t('a', 0), t('y', 1, { ownerEmail: 'carla@simple.biz' })];
  const mixedOwner = planTaskOrder(['a', 'y'], otherOwner, otherOwner);
  assert.equal(!mixedOwner.ok && mixedOwner.code, 'mixed_owners');
});

test("the card read is narrowed to the first task's owner and frequency", () => {
  // Someone else's tasks or another card in the read never count towards completeness.
  const card = [...CARD, t('d', 0, { frequency: 'daily' }), t('e', 0, { ownerEmail: 'carla@simple.biz' })];
  const plan = planTaskOrder(['b', 'c', 'a'], CARD, card);
  assert.ok(plan.ok);
});

test('the board order: sort_order, then oldest, then id', () => {
  const rows = [
    t('b', 1),
    t('c', 0, { createdAt: '2026-10-09T00:00:00Z' }),
    t('a', 0, { createdAt: '2026-10-09T00:00:00Z' }),
    t('d', 0, { createdAt: '2026-10-01T00:00:00Z' }),
  ];
  assert.deepEqual(rows.sort(compareTaskOrder).map((r) => r.id), ['d', 'a', 'c', 'b']);
});
