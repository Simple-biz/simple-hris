import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { OMS_ENV, OMS_RETURN_TABLE_ENV, isSafeOmsIdentifier, readOmsConfig, readOmsReturnConfig } from './oms-config';

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

test('Send to OMS: no table name ⇒ NOT set up, naming the variable — a write never goes to a guessed table', () => {
  const r = readOmsReturnConfig(base);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, [OMS_RETURN_TABLE_ENV]);
    assert.match(r.reason, /OMS_RETURN_TABLE/);
  }
  const blank = readOmsReturnConfig({ ...base, OMS_RETURN_TABLE: '   ' });
  assert.equal(blank.ok, false);
});

test('Send to OMS: the read side must be configured first; the key is never echoed', () => {
  const r = readOmsReturnConfig({ OMS_RETURN_TABLE: 'hris_orphanage_returns' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.missing, [OMS_ENV.url, OMS_ENV.key]);
});

test('Send to OMS: a malformed table name is refused by name; the hours table is refused outright', () => {
  const bad = readOmsReturnConfig({ ...base, OMS_RETURN_TABLE: 'x; drop table y' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason.includes('drop table'), false);
  const hours = readOmsReturnConfig({ ...base, OMS_RETURN_TABLE: 'orphanage_hours' });
  assert.equal(hours.ok, false);
  if (!hours.ok) assert.match(hours.reason, /never writes that table/);
  const custom = readOmsReturnConfig({ ...base, OMS_HOURS_TABLE: 'weekly_hours', OMS_RETURN_TABLE: 'weekly_hours' });
  assert.equal(custom.ok, false);
});

test('Send to OMS: set ⇒ the shared URL + key and the named table', () => {
  const r = readOmsReturnConfig({ ...base, OMS_RETURN_TABLE: 'hris_orphanage_returns' });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.config, { url: 'https://oms-ref.supabase.co', key: 'eyJ.fake', table: 'hris_orphanage_returns' });
});
