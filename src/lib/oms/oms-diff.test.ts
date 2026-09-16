import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { diffOmsPulls, omsChangedSincePull } from './oms-diff';

const row = (email: string, hours: number | string, line = 1) => ({ line, payWeek: 'w', email, hours });

test('two pulls that agree person-for-person diff to nothing — string and numeric hours are the same value', () => {
  const d = diffOmsPulls([row('a@x.biz', '12.50'), row('b@x.biz', 3)], [row('A@x.biz', 12.5), row('b@x.biz', '3')]);
  assert.equal(d.total, 0);
});

test('added, removed and changed rows are each reported once, with before/after hours', () => {
  const d = diffOmsPulls(
    [row('keep@x.biz', 5), row('gone@x.biz', 2), row('edit@x.biz', 4)],
    [row('keep@x.biz', 5), row('new@x.biz', 7), row('edit@x.biz', 6.25)],
  );
  assert.deepEqual(d.added, [{ email: 'new@x.biz', kind: 'added', before: null, after: 7 }]);
  assert.deepEqual(d.removed, [{ email: 'gone@x.biz', kind: 'removed', before: 2, after: null }]);
  assert.deepEqual(d.changed, [{ email: 'edit@x.biz', kind: 'changed', before: 4, after: 6.25 }]);
  assert.equal(d.total, 3);
});

test('a count change OR a newer stamp says "load again"; the same count and stamp says nothing', () => {
  const pull = { approvedCount: 10, latestUpdatedAt: '2026-09-16T10:00:00Z' };
  assert.equal(omsChangedSincePull(pull, { approvedCount: 10, latestUpdatedAt: '2026-09-16T10:00:00Z' }), null);
  assert.deepEqual(omsChangedSincePull(pull, { approvedCount: 12, latestUpdatedAt: '2026-09-16T10:00:00Z' }), { countDelta: 2, stampMoved: false });
  assert.deepEqual(omsChangedSincePull(pull, { approvedCount: 10, latestUpdatedAt: '2026-09-16T11:00:00Z' }), { countDelta: 0, stampMoved: true });
  // An edit that keeps the count but moves the stamp is still a change.
  assert.deepEqual(omsChangedSincePull(pull, { approvedCount: 9, latestUpdatedAt: '2026-09-16T11:00:00Z' }), { countDelta: -1, stampMoved: true });
});

test('without a stamp column only the count can speak', () => {
  const pull = { approvedCount: 10, latestUpdatedAt: null };
  assert.equal(omsChangedSincePull(pull, { approvedCount: 10, latestUpdatedAt: null }), null);
  assert.deepEqual(omsChangedSincePull(pull, { approvedCount: 11, latestUpdatedAt: null }), { countDelta: 1, stampMoved: false });
});
