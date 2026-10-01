import { test } from 'node:test';
import assert from 'node:assert/strict';

import { __HIRE_CACHE_KEY_LISTS, toCachedHireRow, toCachedHireRows } from './hire-row-cache';

/**
 * `/api/manager/pending-hires` and `/api/manager/orientation-history` pass the
 * staged hire's pay rates through to a rate-visible viewer, and every row carries
 * phone + location. The Manager tab cache mirrors to `sessionStorage`, so what
 * it stores is this projection, never the row. These tests pin that from the
 * outside; the compiler pins that every column is classified.
 */

/** A row as the JSON actually arrives for an admin who manages a department. */
const RATE_VISIBLE_ROW = {
  id: 7,
  created_at: '2026-09-27T10:00:00Z',
  created_by: 'hr@simple.biz',
  updated_at: '2026-09-28T10:00:00Z',
  name: 'Dela Cruz, Juan',
  first_name: 'Juan',
  middle_name: 'Santos',
  last_name: 'Dela Cruz',
  name_extension: null,
  display_name: 'Dela Cruz, Juan',
  personal_email: 'juan@example.com',
  work_email: 'juand@simple.biz',
  department: 'Lead Gen',
  job_description: 'Appointment setter',
  start_date: '2026-10-05',
  source: 'facebook',
  phone: '+63 917 000 0000',
  location: '12 Rizal St, Quezon City',
  regular_rate: '95.00',
  ot_rate: '118.75',
  status: 'ready',
  notes: 'HR note',
  promoted_at: null,
  promoted_to_master_id: null,
  orientation_attended_at: null,
  orientation_attended_by: null,
  orientation_note: null,
  no_show_at: null,
  no_show_by: null,
  no_show_note: null,
  scheduled_deletion_at: null,
  deletion_processed_at: null,
  onboarding_submission_id: 'sub-1',
  project_names: ['Lead Gen'],
  country: 'Philippines',
  calltools_username: 'juand',
};

test('pay rates never survive the projection, even when the route sent them', () => {
  const cached = toCachedHireRow(RATE_VISIBLE_ROW) as Record<string, unknown>;
  assert.equal('regular_rate' in cached, false);
  assert.equal('ot_rate' in cached, false);
});

test('phone, location and the HR-record-only middle name never survive either', () => {
  const cached = toCachedHireRow(RATE_VISIBLE_ROW) as Record<string, unknown>;
  for (const k of ['phone', 'location', 'middle_name', 'notes']) {
    assert.equal(k in cached, false, `${k} reached the cached copy`);
  }
});

test('everything the two panels render survives, including the CallTools username', () => {
  const cached = toCachedHireRow(RATE_VISIBLE_ROW);
  assert.equal(cached.id, 7);
  assert.equal(cached.name, 'Dela Cruz, Juan');
  assert.equal(cached.personal_email, 'juan@example.com');
  assert.equal(cached.department, 'Lead Gen');
  assert.equal(cached.status, 'ready');
  assert.equal(cached.calltools_username, 'juand');
});

test('an unknown column is dropped, not copied — the failure direction is "missing"', () => {
  const cached = toCachedHireRow({ ...RATE_VISIBLE_ROW, bank_account_number: '0123' }) as Record<string, unknown>;
  assert.equal('bank_account_number' in cached, false);
});

test('a list is projected row by row', () => {
  const rows = toCachedHireRows([RATE_VISIBLE_ROW, { ...RATE_VISIBLE_ROW, id: 8 }]) as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal('regular_rate' in r, false);
});

test('the cacheable and uncacheable lists never overlap', () => {
  const uncacheable = new Set<string>(__HIRE_CACHE_KEY_LISTS.uncacheable);
  for (const k of [...__HIRE_CACHE_KEY_LISTS.cacheable, ...__HIRE_CACHE_KEY_LISTS.attached]) {
    assert.equal(uncacheable.has(k), false, `${k} is classified both ways`);
  }
});

test('no cacheable key is spelled after pay, contact or address', () => {
  for (const k of [...__HIRE_CACHE_KEY_LISTS.cacheable, ...__HIRE_CACHE_KEY_LISTS.attached]) {
    assert.doesNotMatch(k, /rate|phone|location|address|bank|account|salary/i, k);
  }
});
