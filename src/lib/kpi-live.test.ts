import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KPI_LIVE_TOPIC,
  bonusWriteAnnounces,
  parseKpiLivePayload,
} from './kpi-live';
import { PAB_PERIOD_LIVE_TOPIC } from './pab-period-live';
import { FPU_LIVE_TOPIC } from './mesa/fpu-live';
import { GIFT_LIVE_TOPIC } from './gift-tracker/gift-live';
import { CHAT_LIVE_TOPIC } from './support/chat-live';

// realtime-js keeps ONE channel per topic per client: sharing a topic with
// another feature lets either side's teardown kill the other's channel.
test('the KPI topic is its own', () => {
  const others = [
    PAB_PERIOD_LIVE_TOPIC,
    FPU_LIVE_TOPIC,
    GIFT_LIVE_TOPIC,
    CHAT_LIVE_TOPIC,
    'employee-support-tickets-sync',
    'payment-dispatch-sync',
    'payment-dispatch-paid',
    'payroll-start-processing',
    'payroll-wizard-follow',
    'payroll-wizard-pab-decisions',
  ];
  assert.ok(!others.includes(KPI_LIVE_TOPIC), `${KPI_LIVE_TOPIC} collides with another feature's topic`);
});

test('a status write parses with its status', () => {
  assert.deepEqual(
    parseKpiLivePayload({ kind: 'status', department: 'hsl:intake', periodStart: '2026-09-20', status: 'locked', ts: 5 }),
    { kind: 'status', department: 'hsl:intake', periodStart: '2026-09-20', status: 'locked', ts: 5 },
  );
});

test('an unknown status is kept as null, not dropped', () => {
  const p = parseKpiLivePayload({ kind: 'bonus', department: 'pm_team', periodStart: '2026-09-20', status: 'weird', ts: 1 });
  assert.equal(p?.status, null);
  assert.equal(p?.department, 'pm_team');
});

test('malformed payloads parse to null — still a re-read signal, never a throw', () => {
  for (const bad of [null, undefined, 'x', 3, {}, { kind: 'status' }, { kind: 'nope', department: 'a', periodStart: 'b' }, { kind: 'bonus', department: 1, periodStart: 'b' }]) {
    assert.equal(parseKpiLivePayload(bad), null);
  }
});

test('only a published week announces a bonus write', () => {
  assert.equal(bonusWriteAnnounces('ready'), true);
  assert.equal(bonusWriteAnnounces('locked'), true);
  assert.equal(bonusWriteAnnounces('draft'), false);
  assert.equal(bonusWriteAnnounces(null), false);
  assert.equal(bonusWriteAnnounces(undefined), false);
});
