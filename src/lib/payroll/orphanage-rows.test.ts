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

test('OMS door (default `refuse`): a repeated person is refused — OMS Save keys one result per OMS row', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: 2 },
      { line: 2, payWeek: 'w', email: 'JENL@simple.biz', hours: 3 },
    ],
    ctx(),
  );
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].hours, 2);
  assert.equal(r.ok[0].combinedFrom, undefined);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].reason, /Duplicate/);
});

test('OMS door: a first line that fails to price does not make the second a duplicate (unchanged since 09-16)', () => {
  // 38h worked, no OT rate: 5h crosses 40 and is refused; 1h fits under the cap and prices.
  const c = ctx({
    rowByEmail: new Map([['jenl@simple.biz', row({ email: 'jenl@simple.biz', workedRegularHours: 38, otRate: null })]]),
  });
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: 5 },
      { line: 2, payWeek: 'w', email: 'jenl@simple.biz', hours: 1 },
    ],
    c,
  );
  assert.deepEqual(r.ok.map((o) => [o.line, o.hours]), [[2, 1]]);
  assert.deepEqual(r.errors.map((e) => e.line), [1]);
});

// ── Paste door: `repeats: 'combine'` (Kane 2026-09-29, "if there are two line items just
// add them both and calculate properly"). ──────────────────────────────────────────────

const COMBINE = { repeats: 'combine' } as const;

test('paste: two lines for one person ADD, and price exactly like one line of the total', () => {
  const combined = resolveOrphanageHourRows(
    [
      { line: 3, payWeek: '6/8- 6/14', email: 'eulap@simple.biz', hours: '10' },
      { line: 7, payWeek: '6/8- 6/14', email: 'eulap@simple.biz', hours: '5.5' },
    ],
    ctx(),
    COMBINE,
  );
  const single = resolveOrphanageHourRows([{ line: 3, payWeek: '6/8- 6/14', email: 'eulap@simple.biz', hours: 15.5 }], ctx());
  assert.equal(combined.errors.length, 0);
  assert.equal(combined.ok.length, 1);
  const { combinedFrom, ...rest } = combined.ok[0];
  assert.deepEqual(rest, single.ok[0]);
  assert.deepEqual(combinedFrom, [{ line: 3, hours: 10 }, { line: 7, hours: 5.5 }]);
});

test('paste: "properly" = the 40h cap is consumed ONCE by the total, never once per line', () => {
  // 34.1986h worked ⇒ 5.8014h of regular capacity for the WHOLE 15.5h, not per line.
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'eulap@simple.biz', hours: 10 },
      { line: 2, payWeek: 'w', email: 'eulap@simple.biz', hours: 5.5 },
    ],
    ctx(),
    COMBINE,
  );
  const o = r.ok[0];
  assert.ok(Math.abs(o.regH - 5.8014) < 1e-9);
  assert.ok(Math.abs(o.otH - 9.6986) < 1e-9);
  // Pricing each line separately against the same worked hours would give 11.3014 reg h.
  const perLine = [10, 5.5].map((h) => resolveOrphanageHourRows([{ line: 1, payWeek: 'w', email: 'eulap@simple.biz', hours: h }], ctx()).ok[0]);
  const perLineTotal = perLine.reduce((s, x) => s + x.amount, 0);
  assert.ok(perLineTotal < o.amount); // regular capacity double-counted ⇒ paid at 355 instead of 532.50
});

test('paste: the incident row split across two lines still lands on the sheet figure ₱7,224.25 (HSL sheet-2dp)', () => {
  const c = ctx({
    rowByEmail: new Map([['josephinet@simple.biz', row({ email: 'josephinet@simple.biz', isHslSheetForm: true, otRate: 177.5 })]]),
  });
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'josephinet@simple.biz', hours: '7.25' },
      { line: 2, payWeek: 'w', email: 'josephinet@simple.biz', hours: '8.25' },
    ],
    c,
    COMBINE,
  );
  assert.equal(r.ok[0].hours, 15.5);
  assert.equal(r.ok[0].regH, 5.8);
  assert.equal(r.ok[0].otH, 9.7);
  assert.equal(r.ok[0].otRate, 532.5);
  assert.equal(r.ok[0].amount, 7224.25);
});

test('paste: float noise in the sum never reaches the hours (2.1 + 3.2 = 5.3)', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: '2.1' },
      { line: 2, payWeek: 'w', email: 'jenl@simple.biz', hours: '3.2' },
    ],
    ctx(),
    COMBINE,
  );
  assert.equal(r.ok[0].hours, 5.3);
  assert.equal(r.ok[0].amount, Math.round(5.3 * 355 * 100) / 100);
});

test('paste: two addresses (or casings) of ONE person combine — keyed on the Additions row', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'EulaP@simple.biz', hours: 1 },
      { line: 2, payWeek: 'w', email: 'eula.personal@gmail.com', hours: 2 },
      { line: 3, payWeek: 'w', email: 'jenl@simple.biz', hours: 4 },
    ],
    ctx(),
    COMBINE,
  );
  assert.deepEqual(r.ok.map((o) => [o.emailKey, o.hours]), [['eulap@simple.biz', 3], ['jenl@simple.biz', 4]]);
  assert.equal(r.ok[1].combinedFrom, undefined); // one line ⇒ no combinedFrom
});

test('paste: one bad line HOLDS the person — never a partial amount; other people still lock in', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'jenl@simple.biz', hours: 2 },
      { line: 2, payWeek: 'w', email: 'eulap@simple.biz', hours: 1 },
      { line: 3, payWeek: 'w', email: 'jenl@simple.biz', hours: 'abc' },
    ],
    ctx(),
    COMBINE,
  );
  assert.deepEqual(r.ok.map((o) => o.emailKey), ['eulap@simple.biz']);
  assert.deepEqual(r.errors.map((e) => e.line), [1, 3]);
  assert.match(r.errors[0].reason, /^Held — this person's L3 was skipped/);
  assert.match(r.errors[1].reason, /Invalid hours/);
});

test('paste: a combined person that cannot be priced lists EVERY one of their lines', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: 'w', email: 'norate@simple.biz', hours: 1 },
      { line: 2, payWeek: 'w', email: 'norate@simple.biz', hours: 2 },
    ],
    ctx(),
    COMBINE,
  );
  assert.equal(r.ok.length, 0);
  assert.deepEqual(r.errors.map((e) => e.line), [1, 2]);
  for (const e of r.errors) assert.match(e.reason, /No pay rate on file/);
});

test('paste: an invalid-hours line for nobody in the period reports its hours, not a second error', () => {
  const r = resolveOrphanageHourRows([{ line: 1, payWeek: 'w', email: 'nobody@simple.biz', hours: 'x' }], ctx(), COMBINE);
  assert.deepEqual(r.errors, [{ line: 1, email: 'nobody@simple.biz', reason: 'Invalid hours: "x"' }]);
});

test('paste: distinct pay-week labels on a combined person are kept, never dropped', () => {
  const r = resolveOrphanageHourRows(
    [
      { line: 1, payWeek: '6/8- 6/14', email: 'jenl@simple.biz', hours: 1 },
      { line: 2, payWeek: '6/8- 6/14', email: 'jenl@simple.biz', hours: 1 },
      { line: 3, payWeek: '6/9', email: 'jenl@simple.biz', hours: 1 },
    ],
    ctx(),
    COMBINE,
  );
  assert.equal(r.ok[0].payWeek, '6/8- 6/14, 6/9');
});

test('paste door end to end: tokenizer → combine', () => {
  const t = tokenizeOrphanagePaste('Pay week\tEmail\tHours\nw\tjenl@simple.biz\t2\nw\tjenl@simple.biz\t1.5');
  const r = resolveOrphanageHourRows(t.rows, ctx(), COMBINE);
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].hours, 3.5);
  assert.equal(r.ok[0].amount, 3.5 * 355);
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
