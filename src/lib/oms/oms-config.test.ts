import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { OMS_ENV, isSafeOmsIdentifier, readOmsConfig } from './oms-config';

const base = {
  OMS_SUPABASE_URL: 'https://oms-ref.supabase.co',
  OMS_SUPABASE_KEY: 'eyJ.fake',
};

test('no URL or key ⇒ not configured, naming the VARIABLES and never a value', () => {
  const r = readOmsConfig({});
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, [OMS_ENV.url, OMS_ENV.key]);
    assert.match(r.reason, /OMS_SUPABASE_URL and OMS_SUPABASE_KEY/);
  }
  const half = readOmsConfig({ OMS_SUPABASE_URL: base.OMS_SUPABASE_URL });
  assert.equal(half.ok, false);
  if (!half.ok) assert.deepEqual(half.missing, [OMS_ENV.key]);
});

test('defaults fill every identifier when only URL + key are set', () => {
  const r = readOmsConfig(base);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.table, 'orphanage_hours');
    assert.deepEqual(r.config.cols, {
      weekStart: 'week_start',
      email: 'work_email',
      hours: 'hours',
      status: 'status',
      payWeek: 'pay_week',
      updatedAt: 'updated_at',
    });
    assert.equal(r.config.approvedValue, 'approved');
    assert.equal(r.config.key, 'eyJ.fake');
  }
});

test('a malformed identifier is refused BY NAME — it never reaches a query builder', () => {
  const r = readOmsConfig({ ...base, OMS_HOURS_COL_EMAIL: 'email; drop table x' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, ['OMS_HOURS_COL_EMAIL']);
    assert.equal(r.reason.includes('drop table'), false);
  }
  assert.equal(isSafeOmsIdentifier('week_start'), true);
  assert.equal(isSafeOmsIdentifier('1abc'), false);
  assert.equal(isSafeOmsIdentifier('a.b'), false);
});

test('an optional column set to EMPTY is disabled; unset keeps the default', () => {
  const r = readOmsConfig({ ...base, OMS_HOURS_COL_UPDATED_AT: '', OMS_HOURS_COL_PAY_WEEK: 'week_label' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.cols.updatedAt, null);
    assert.equal(r.config.cols.payWeek, 'week_label');
  }
});

test('a trailing slash on the URL is trimmed and a non-URL is refused', () => {
  const r = readOmsConfig({ ...base, OMS_SUPABASE_URL: 'https://oms-ref.supabase.co/' });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.config.url, 'https://oms-ref.supabase.co');
  const bad = readOmsConfig({ ...base, OMS_SUPABASE_URL: 'not a url' });
  assert.equal(bad.ok, false);
});
