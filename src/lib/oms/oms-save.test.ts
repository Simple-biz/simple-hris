import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { buildOmsSavePayload, validateOmsSavePayload } from './oms-save';

const pull = {
  rows: [
    { line: 1, payWeek: '9/13- 9/19', email: 'eulap@simple.biz', hours: '15.50' },
    { line: 2, payWeek: '9/13- 9/19', email: 'nobody@simple.biz', hours: 3 },
    { line: 3, payWeek: '', email: 'bad@simple.biz', hours: 'abc' },
  ],
  approvedCount: 3,
  latestUpdatedAt: '2026-09-16T10:00:00Z',
  truncated: false,
};
const resolved = {
  ok: [
    { line: 1, payWeek: '9/13- 9/19', emailKey: 'eulap@simple.biz', matchedEmail: 'eulap@simple.biz', name: 'Eula P', hours: 15.5, rate: 355, otRate: 532.5, regH: 5.8014, otH: 9.6986, amount: 7224 },
  ],
  errors: [
    { line: 2, email: 'nobody@simple.biz', reason: 'No employee in this pay period matches that work email' },
    { line: 3, email: 'bad@simple.biz', reason: 'Invalid hours: "abc"' },
  ],
};

test('one save row per OMS row: matched rows carry the resolution, unmatched carry the reason', () => {
  const p = buildOmsSavePayload({ weekStart: '2026-09-13', sourceFile: 'f.csv', mode: 'test', pull, resolved });
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows[0], {
    omsEmail: 'eulap@simple.biz', omsPayWeek: '9/13- 9/19', omsHoursRaw: '15.50', omsHours: 15.5,
    matched: true, employeeEmail: 'eulap@simple.biz', employeeName: 'Eula P',
    regHours: 5.8014, otHours: 9.6986, regularRatePhp: 355, otRatePhp: 532.5, amountPhp: 7224, skipReason: null,
  });
  assert.equal(p.rows[1].matched, false);
  assert.equal(p.rows[1].skipReason, 'No employee in this pay period matches that work email');
  assert.equal(p.rows[1].amountPhp, null);
  assert.equal(p.rows[1].omsHours, 3);
  // unparsable hours keep the raw text and a null number — nothing invented
  assert.equal(p.rows[2].omsHoursRaw, 'abc');
  assert.equal(p.rows[2].omsHours, null);
  assert.equal(p.rows[2].omsPayWeek, null);
  assert.equal(p.mode, 'test');
  assert.equal(p.approved_count, 3);
});

test('the payload the builder makes is the payload the route accepts', () => {
  const p = buildOmsSavePayload({ weekStart: '2026-09-13', sourceFile: null, mode: 'live', pull, resolved });
  const v = validateOmsSavePayload(JSON.parse(JSON.stringify(p)));
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.payload.rows.length, 3);
    assert.equal(v.payload.source_file, null);
    assert.equal(v.payload.mode, 'live');
  }
});

test('the route refuses a body that would violate the table shape', () => {
  const bad = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    validateOmsSavePayload({ week_start: '2026-09-13', mode: 'test', rows, ...extra });
  assert.equal(validateOmsSavePayload(null).ok, false);
  assert.equal(bad([]).ok, false);
  assert.equal(bad([{ omsEmail: 'a@x', matched: true, amountPhp: 1 }]).ok, false, 'matched without key');
  assert.equal(bad([{ omsEmail: 'a@x', matched: true, employeeEmail: 'a@x', amountPhp: 1, skipReason: 'x' }]).ok, false, 'matched with reason');
  assert.equal(bad([{ omsEmail: 'a@x', matched: false }]).ok, false, 'unmatched without reason');
  assert.equal(bad([{ omsEmail: 'a@x', matched: false, skipReason: 'r', amountPhp: 5 }]).ok, false, 'unmatched with amount');
  assert.equal(bad([{ omsEmail: 'a@x', matched: false, skipReason: 'r' }], { mode: 'preview' }).ok, false, 'bad mode');
  assert.equal(bad([{ omsEmail: 'a@x', matched: false, skipReason: 'r' }], { week_start: '13-19' }).ok, false, 'bad week');
  assert.equal(bad([{ omsEmail: 'a@x', matched: false, skipReason: 'r' }]).ok, true);
});
