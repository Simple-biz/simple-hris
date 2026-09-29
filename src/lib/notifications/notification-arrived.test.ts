import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KPI_SCORED_NOTIFICATION,
  announceNotificationsArrived,
  detailMatchesTypes,
  subscribeNotificationTypes,
} from './notification-arrived';
import { KPI_SCORED_TYPE } from './kpi-scored';

// The client mirror cannot import the server module, so drift would be silent:
// the chime would announce 'kpi.scored' and no KPI surface would ever hear it.
test('the client mirror equals the server kpi.scored type', () => {
  assert.equal(KPI_SCORED_NOTIFICATION, KPI_SCORED_TYPE);
});

test('matches when any announced type is wanted', () => {
  assert.equal(detailMatchesTypes({ view: 'employee', types: ['payroll.available', 'kpi.scored'] }, ['kpi.scored']), true);
});

test('ignores a batch with none of the wanted types', () => {
  assert.equal(detailMatchesTypes({ view: 'employee', types: ['payroll.available'] }, ['kpi.scored']), false);
});

test('ignores malformed detail rather than throwing', () => {
  for (const bad of [null, undefined, 'kpi.scored', 42, {}, { types: 'kpi.scored' }, { types: [null, 7] }]) {
    assert.equal(detailMatchesTypes(bad, ['kpi.scored']), false);
  }
});

test('subscriber fires on a matching announcement and stops after unsubscribe', () => {
  const target = new EventTarget();
  let calls = 0;
  const off = subscribeNotificationTypes(['kpi.scored'], () => { calls += 1; }, target);

  announceNotificationsArrived({ view: 'employee', types: ['kpi.scored'] }, target);
  announceNotificationsArrived({ view: 'employee', types: ['payroll.available'] }, target);
  assert.equal(calls, 1);

  off();
  announceNotificationsArrived({ view: 'employee', types: ['kpi.scored'] }, target);
  assert.equal(calls, 1);
});
