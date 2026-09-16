import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  mergeOrphanageErrors,
  resolveOrphanageHourRows,
  tokenizeOrphanagePaste,
  type OrphanageResolveContext,
  type OrphanageRowTarget,
} from './orphanage-rows';

/**
 * The rule these tests pin (2026-09-16): the paste tool and the OMS pull are ONE
 * resolver. A pasted line and an OMS row for the same person must come out as the
 * same money, or the "Orphanage Management System" tab is a second pricing path —
 * exactly the shape that half-paid orphanage OT for a week in 2026-08.
 */

const row = (over: Partial<OrphanageRowTarget> & Pick<OrphanageRowTarget, 'email'>): OrphanageRowTarget => ({
  name: over.email,
  regularRate: 355,
  otRate: 532.5,
  isHslSheetForm: false,
  workedRegularHours: 34.1986,
  deptKey: 'npd',
  ...over,
});

function ctx(over: Partial<OrphanageResolveContext> = {}): OrphanageResolveContext {
  const rowByEmail = new Map<string, OrphanageRowTarget>([
    ['eulap@simple.biz', row({ email: 'eulap@simple.biz', name: 'Eula P' })],
    ['jenl@simple.biz', row({ email: 'jenl@simple.biz', name: 'Jen L', workedRegularHours: 10 })],
    ['norate@simple.biz', row({ email: 'norate@simple.biz', regularRate: null })],
  ]);
  return {
    rowByEmail,
    masterAliasesFor: (k) => (k === 'eula.personal@gmail.com' ? ['eulap@simple.biz', 'eula.personal@gmail.com'] : null),
    regularRateFallback: () => null,
    overtimeEnabledFor: () => true,
    ...over,
  };
}

test('a pasted line and an OMS row for the same person price identically', () => {
  const pasted = tokenizeOrphanagePaste('6/8- 6/14\teulap@simple.biz\t15.50');
  const fromPaste = resolveOrphanageHourRows(pasted.rows, ctx());
  const fromOms = resolveOrphanageHourRows(
    [{ line: 1, payWeek: '6/8- 6/14', email: 'EulaP@simple.biz', hours: 15.5 }],
    ctx(),
  );
  assert.equal(fromPaste.ok.length, 1);
  assert.deepEqual(
    { ...fromPaste.ok[0], line: 0 },
    { ...fromOms.ok[0], line: 0 },
  );
  // The incident row: 5.80 reg + 9.70 OT at the FULL OT rate = ₱7,224.25 (exact basis here,
  // so the legs are unrounded: 5.8014 × 355 + 9.6986 × 532.5).
  assert.ok(fromOms.ok[0].otH > 9.69 && fromOms.ok[0].otH < 9.7);
  assert.ok(fromOms.ok[0].amount >= 7224 && fromOms.ok[0].amount < 7225);
});

test('the tokenizer drops a header line and reports short lines as errors', () => {
  const t = tokenizeOrphanagePaste('Pay week\tEmail\tHours\n6/8- 6/14\tjenl@simple.biz\t3\nonly-two\tcells');
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].email, 'jenl@simple.biz');
  assert.deepEqual(t.errors, [{ line: 3, email: 'cells', reason: 'Expected 3 columns: Pay week, Work email, Hours' }]);
});

test('a repeated person is refused — the Orphanage column holds ONE value per person', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: 2 },
      { line: 2, payWeek: 'w', email: 'JENL@simple.biz', hours: 3 },
    ],
    ctx(),
  );
  assert.equal(r.ok.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /Duplicate/);
});

test('an address the period does not know is bridged through the master list', () => {
  const r = resolveOrphanageHourRows([{ line: 1, payWeek: 'w', email: 'eula.personal@gmail.com', hours: 1 }], ctx());
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].emailKey, 'eulap@simple.biz');
  assert.equal(r.ok[0].matchedEmail, 'eula.personal@gmail.com');
});

test('an unknown address is reported, never guessed', () => {
  const r = resolveOrphanageHourRows([{ line: 4, payWeek: 'w', email: 'nobody@simple.biz', hours: 1 }], ctx());
  assert.equal(r.ok.length, 0);
  assert.deepEqual(r.errors, [{ line: 4, email: 'nobody@simple.biz', reason: 'No employee in this pay period matches that work email' }]);
});

test('OT off for the department keeps every hour regular — the HRIS decides overtime, not the source', () => {
  const on = resolveOrphanageHourRows([{ line: 1, payWeek: 'w', email: 'eulap@simple.biz', hours: 15.5 }], ctx());
  const off = resolveOrphanageHourRows(
    [{ line: 1, payWeek: 'w', email: 'eulap@simple.biz', hours: 15.5 }],
    ctx({ overtimeEnabledFor: () => false }),
  );
  assert.ok(on.ok[0].otH > 0);
  assert.equal(off.ok[0].otH, 0);
  assert.equal(off.ok[0].regH, 15.5);
  assert.equal(off.ok[0].amount, 15.5 * 355);
});

test('a rateless row is refused unless the rates index can supply one', () => {
  const refused = resolveOrphanageHourRows([{ line: 1, payWeek: 'w', email: 'norate@simple.biz', hours: 1 }], ctx());
  assert.equal(refused.ok.length, 0);
  assert.equal(refused.errors.length, 1);
  const supplied = resolveOrphanageHourRows(
    [{ line: 1, payWeek: 'w', email: 'norate@simple.biz', hours: 1 }],
    ctx({ regularRateFallback: () => 300 }),
  );
  assert.equal(supplied.ok.length, 1);
  assert.equal(supplied.ok[0].rate, 300);
});

test('invalid hours are refused, including a blank cell and a negative', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: '' },
      { line: 2, payWeek: 'w', email: 'jenl@simple.biz', hours: -1 },
      { line: 3, payWeek: 'w', email: 'jenl@simple.biz', hours: 'abc' },
    ],
    ctx(),
  );
  assert.equal(r.ok.length, 0);
  assert.equal(r.errors.length, 3);
  for (const e of r.errors) assert.match(e.reason, /Invalid hours/);
});

test('errors from the tokenizer and the resolver merge into one list in line order', () => {
  const merged = mergeOrphanageErrors(
    [{ line: 5, email: '', reason: 'a' }],
    [{ line: 2, email: '', reason: 'b' }, { line: 9, email: '', reason: 'c' }],
  );
  assert.deepEqual(merged.map((e) => e.line), [2, 5, 9]);
});
