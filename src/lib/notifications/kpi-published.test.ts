import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KPI_PUBLISHED_TYPE,
  kpiPublishedCard,
  kpiPublishedDedupeKey,
  kpiPublishedTargets,
} from './kpi-published';

test('the type string matches the ALTER that allows it', () => {
  // references/sql/alter/2026-09-10_add_kpi_published_notification_type.sql
  assert.equal(KPI_PUBLISHED_TYPE, 'kpi.published');
});

test('the de-dupe key is one string per (dept, week, status), case-folded on the dept', () => {
  assert.equal(kpiPublishedDedupeKey('lead_gen', '2026-09-13', 'ready'), 'lead_gen|2026-09-13|ready');
  assert.equal(kpiPublishedDedupeKey(' Lead_Gen ', '2026-09-13', 'ready'), 'lead_gen|2026-09-13|ready');
  // ready and locked are DIFFERENT events — each notifies once.
  assert.notEqual(
    kpiPublishedDedupeKey('lead_gen', '2026-09-13', 'ready'),
    kpiPublishedDedupeKey('lead_gen', '2026-09-13', 'locked'),
  );
});

test('the card names the department, the week and the action, and carries the dedupe key', () => {
  const c = kpiPublishedCard({ department: 'lead_gen', periodStart: '2026-09-13', periodEnd: '2026-09-19', status: 'locked' });
  assert.match(c.title, /KPI bonuses locked/);
  assert.match(c.title, /2026-09-13 – 2026-09-19/);
  assert.match(c.message, /locked the week's KPI bonuses/);
  assert.match(c.message, /Readiness/);
  assert.equal(c.details.dedupe_key, 'lead_gen|2026-09-13|locked');
  assert.equal(c.details.status, 'locked');
  assert.equal(c.details.ahead_of_hubstaff, false);
  assert.doesNotMatch(c.message, /ahead of the Hubstaff report/);
});

test('scored-ahead weeks say so — Accounting must know the hours are not in yet', () => {
  const c = kpiPublishedCard({ department: 'lead_gen', periodStart: '2026-09-13', status: 'ready', aheadOfHubstaff: true });
  assert.match(c.title, /marked ready/);
  assert.match(c.title, /week of 2026-09-13/, 'no period_end ⇒ "week of" form');
  assert.match(c.message, /ahead of the Hubstaff report/);
  assert.equal(c.details.ahead_of_hubstaff, true);
});

test('targets = recipients minus already-notified, de-duplicated and case-folded', () => {
  const targets = kpiPublishedTargets(
    ['Carla@simple.biz', 'claire@simple.biz', 'carla@simple.biz', '', 'lennyt@simple.biz'],
    ['CLAIRE@simple.biz'],
  );
  assert.deepEqual(targets, ['carla@simple.biz', 'lennyt@simple.biz']);
});

test('nobody to notify ⇒ empty, never a throw', () => {
  assert.deepEqual(kpiPublishedTargets([], []), []);
  assert.deepEqual(kpiPublishedTargets(['a@simple.biz'], ['a@simple.biz']), []);
});
