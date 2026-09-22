import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aliasAccountConflict,
  closedStintConflict,
  isCalendarDate,
  openAccountConflict,
  resolveEnrollmentDate,
} from './enrollment-date';

// The enrollment effective date is written to two DATE columns and mints the
// account number's YY-MM. Before 2026-09-15 the toggle route accepted whatever
// the caller sent, sliced to ten characters, and let Postgres be the one to
// object. These tests pin the boundary that replaced that.

const TODAY = '2026-09-15';

// ── isCalendarDate ─────────────────────────────────────────────────────────

test('accepts real calendar days, including a leap day', () => {
  for (const d of ['2026-09-15', '2024-02-29', '2026-01-01', '2026-12-31', '1999-06-30']) {
    assert.equal(isCalendarDate(d), true, d);
  }
});

test('refuses days that do not exist', () => {
  for (const d of ['2026-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-09-00', '2026-09-32']) {
    assert.equal(isCalendarDate(d), false, d);
  }
});

test('refuses anything that is not exactly YYYY-MM-DD', () => {
  for (const d of [
    '2026-9-5',
    '26-09-05',
    '2026/09/05',
    '2026-09-05T00:00:00Z',
    '2026-09-05 ',
    ' 2026-09-05',
    '2026-09-05x',
    'hello',
    '',
  ]) {
    assert.equal(isCalendarDate(d), false, JSON.stringify(d));
  }
});

// ── resolveEnrollmentDate ──────────────────────────────────────────────────

test('no date sent means today — the caller decides whose today', () => {
  for (const input of [undefined, null, '', '   ']) {
    const r = resolveEnrollmentDate(input, TODAY);
    assert.deepEqual(r, { ok: true, date: TODAY, defaulted: true });
  }
});

test('an explicit date is kept verbatim after trimming, and is not "defaulted"', () => {
  assert.deepEqual(resolveEnrollmentDate(' 2026-08-03 ', TODAY), { ok: true, date: '2026-08-03', defaulted: false });
  assert.deepEqual(resolveEnrollmentDate('2026-08-03', TODAY), { ok: true, date: '2026-08-03', defaulted: false });
});

test('a non-string is refused, never coerced', () => {
  for (const input of [42, true, {}, [], new Date('2026-09-15')]) {
    const r = resolveEnrollmentDate(input, TODAY);
    assert.equal(r.ok, false, String(input));
  }
});

test('a timestamp is refused — the old slice(0, 10) would have accepted it', () => {
  const r = resolveEnrollmentDate('2026-09-05T10:00:00Z', TODAY);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /YYYY-MM-DD/);
});

test('garbage and impossible dates are refused with the offending value in the message', () => {
  for (const input of ['hello', '2026-02-30', '2026-9-5']) {
    const r = resolveEnrollmentDate(input, TODAY);
    assert.equal(r.ok, false, input);
    assert.match((r as { error: string }).error, new RegExp(input));
  }
});

// ── openAccountConflict ────────────────────────────────────────────────────

const OPEN = { account_number: '26-07-00008', opened_on: '2026-07-10' };

test('no open account — nothing to conflict with', () => {
  assert.equal(openAccountConflict('2026-09-15', true, null), null);
  assert.equal(openAccountConflict('2026-09-15', false, null), null);
});

test('re-enrolling an enrolled member with NO explicit date is idempotent', () => {
  // HR re-approving a duplicate opt-in, or a stale Non Members tab, sends no
  // date and must not be refused — the route keeps opened_on as the since.
  assert.equal(openAccountConflict(TODAY, false, OPEN), null);
});

test('re-enrolling with the date the open account already carries is idempotent', () => {
  assert.equal(openAccountConflict('2026-07-10', true, OPEN), null);
});

test('a DIFFERENT explicit date on an open account is refused, naming the account', () => {
  const msg = openAccountConflict('2026-09-01', true, OPEN);
  assert.ok(msg);
  assert.match(msg, /26-07-00008/);
  assert.match(msg, /2026-07-10/);
  assert.match(msg, /2026-09-01/);
  assert.match(msg, /opt them out first/i);
});

// ── closedStintConflict ────────────────────────────────────────────────────

test('a member with no closed stint may open on any day', () => {
  assert.equal(closedStintConflict('2020-01-01', null), null);
  assert.equal(closedStintConflict('2030-01-01', null), null);
});

test('the day after the previous close is the earliest allowed opening', () => {
  assert.equal(closedStintConflict('2026-08-16', '2026-08-15'), null);
  assert.equal(closedStintConflict('2026-09-15', '2026-08-15'), null);
});

test('opening ON the day the previous stint closed is refused', () => {
  // The backfill invariant puts a deposit dated on closed_on INSIDE the old
  // stint; a new window starting that day would count it again.
  const msg = closedStintConflict('2026-08-15', '2026-08-15');
  assert.ok(msg);
  assert.match(msg, /2026-08-15/);
  assert.match(msg, /counted again/);
});

test('opening BEFORE the previous close is refused', () => {
  const msg = closedStintConflict('2026-06-01', '2026-08-15');
  assert.ok(msg);
  assert.match(msg, /2026-06-01/);
  assert.match(msg, /2026-08-15/);
});

test('the comparison is on the calendar, not on string length or locale', () => {
  // Lexical compare of YYYY-MM-DD is calendar order; a year boundary proves it.
  assert.equal(closedStintConflict('2027-01-01', '2026-12-31'), null);
  assert.ok(closedStintConflict('2026-12-31', '2027-01-01'));
});

// ── aliasAccountConflict ───────────────────────────────────────────────────
//
// A member whose MESA identity drifted holds their account under an EARLIER
// address (`dale@simple.biz` for `dales@simple.biz`). `getOpenMesaAccount`
// keys on the one email it is handed, finds nothing, and the route mints a
// SECOND account dated today — hiding the balance they already hold, because
// every balance is the ledger sliced to `opened_on` (mesa.md:225). These pin
// the refusal that replaced that.

const ALIAS_ACCT = { account_number: '26-06-00027', opened_on: '2026-06-22' };

test('no alias account open — enrollment proceeds', () => {
  assert.equal(aliasAccountConflict('dales@simple.biz', null), null);
});

test('an alias holds an open account — refused, and nothing is written', () => {
  const msg = aliasAccountConflict('dales@simple.biz', {
    email: 'dale@simple.biz',
    account: ALIAS_ACCT,
  });
  assert.ok(msg, 'expected a refusal');
  // The reviewer must be able to act on it without reading the source: whose
  // account, which number, since when, and what to run instead.
  assert.match(msg, /26-06-00027/);
  assert.match(msg, /2026-06-22/);
  assert.match(msg, /dale@simple\.biz/);
  assert.match(msg, /SECOND account/);
  assert.match(msg, /fix-mesa-aliased-membership\.mjs --only dales@simple\.biz --apply/);
  assert.match(msg, /Nothing was changed/);
});
