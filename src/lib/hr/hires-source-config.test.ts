import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { HIRES_SOURCE_ENV, isSafeHiresIdentifier, readHiresSourceConfig } from './hires-source-config';

const base = {
  HRIS_HIRES_SUPABASE_URL: 'https://hires-ref.supabase.co/',
  HRIS_HIRES_SUPABASE_KEY: 'eyJ.fake',
  HRIS_HIRES_TABLE: 'hires',
};

test('no URL, key or table ⇒ not set up, naming the VARIABLES and never a value', () => {
  const r = readHiresSourceConfig({});
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, [HIRES_SOURCE_ENV.url, HIRES_SOURCE_ENV.key, HIRES_SOURCE_ENV.table]);
    assert.match(r.reason, /not set up/);
  }
});

test('the TABLE has no default: URL + key alone are still "not set up"', () => {
  const r = readHiresSourceConfig({
    HRIS_HIRES_SUPABASE_URL: base.HRIS_HIRES_SUPABASE_URL,
    HRIS_HIRES_SUPABASE_KEY: base.HRIS_HIRES_SUPABASE_KEY,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, [HIRES_SOURCE_ENV.table]);
    assert.match(r.reason, /HRIS_HIRES_TABLE/);
    assert.doesNotMatch(r.reason, /eyJ/);
  }
});

test("defaults are the column names Kane gave on 2026-10-08, and the id defaults to `id`", () => {
  const r = readHiresSourceConfig(base);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.url, 'https://hires-ref.supabase.co');
    assert.equal(r.config.table, 'hires');
    assert.equal(r.config.idColumn, 'id');
    assert.deepEqual(r.config.cols, {
      name: 'name',
      personal_email: 'personalEmail',
      location: 'location',
      phone_number: 'phoneNumber',
      date_of_interview: 'dateOfInterview',
      source: 'hiringSource',
      referred_by: 'referredBy',
      hired_by: 'hiredBy',
      department: 'department',
      country: 'country',
    });
    assert.equal(r.config.createdAtColumn, null);
    assert.equal(r.config.updatedAtColumn, null);
  }
});

test('env overrides each column, and the optional stamps are read when set', () => {
  const r = readHiresSourceConfig({
    ...base,
    HRIS_HIRES_COL_PERSONAL_EMAIL: 'personal_email',
    HRIS_HIRES_COL_ID: 'hire_id',
    HRIS_HIRES_COL_CREATED_AT: 'created_at',
    HRIS_HIRES_COL_UPDATED_AT: 'updated_at',
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.config.cols.personal_email, 'personal_email');
    assert.equal(r.config.idColumn, 'hire_id');
    assert.equal(r.config.createdAtColumn, 'created_at');
    assert.equal(r.config.updatedAtColumn, 'updated_at');
  }
});

test('a malformed identifier is refused BY VARIABLE NAME, value never echoed', () => {
  const bad = 'name; drop table x';
  const r = readHiresSourceConfig({ ...base, HRIS_HIRES_COL_NAME: bad });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.missing, ['HRIS_HIRES_COL_NAME']);
    assert.ok(!r.reason.includes(bad));
  }
  const t = readHiresSourceConfig({ ...base, HRIS_HIRES_TABLE: 'hires,secrets' });
  assert.equal(t.ok, false);
  if (!t.ok) assert.deepEqual(t.missing, [HIRES_SOURCE_ENV.table]);
  const s = readHiresSourceConfig({ ...base, HRIS_HIRES_COL_CREATED_AT: 'created at' });
  assert.equal(s.ok, false);
  if (!s.ok) assert.deepEqual(s.missing, [HIRES_SOURCE_ENV.colCreatedAt]);
});

test('identifier rule: letters, digits, underscore; camelCase allowed (PostgREST is case-sensitive)', () => {
  assert.ok(isSafeHiresIdentifier('personalEmail'));
  assert.ok(isSafeHiresIdentifier('_x1'));
  assert.ok(!isSafeHiresIdentifier('1x'));
  assert.ok(!isSafeHiresIdentifier('a.b'));
  assert.ok(!isSafeHiresIdentifier(''));
});
