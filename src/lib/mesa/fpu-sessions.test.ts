import { test } from 'node:test';
import assert from 'node:assert/strict';

import { elapsedFpuSessions, fpuSessionCount, fpuSessions, isMarkableSession } from './fpu-sessions';

// The live class: Thu 2026-10-01 through Thu 2026-11-05 = six Thursdays.
const LIVE = { class_starts_on: '2026-10-01', class_ends_on: '2026-11-05' };

test('the live class is six weekly sessions on its start weekday', () => {
  const r = fpuSessions(LIVE);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.sessions.length, 6);
    assert.deepEqual(r.sessions.map((s) => s.date), [
      '2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05',
    ]);
    assert.deepEqual(r.sessions.map((s) => s.no), [1, 2, 3, 4, 5, 6]);
  }
});

test('the end date is inclusive', () => {
  assert.equal(fpuSessionCount({ class_starts_on: '2026-10-01', class_ends_on: '2026-10-01' }), 1);
  assert.equal(fpuSessionCount({ class_starts_on: '2026-10-01', class_ends_on: '2026-10-07' }), 1);
  assert.equal(fpuSessionCount({ class_starts_on: '2026-10-01', class_ends_on: '2026-10-08' }), 2);
});

test('a partial trailing week is not a session — nobody meets in it', () => {
  // Start Thu Oct 1, end Sun Nov 8: the sixth Thursday is Nov 5, and Nov 6-8 is not a seventh.
  assert.equal(fpuSessionCount({ class_starts_on: '2026-10-01', class_ends_on: '2026-11-08' }), 6);
});

// Kane, Q7: no end date means the class cannot be grouped or attended yet.
test('no end date is a refusal with a sentence, never a guessed count', () => {
  for (const end of [null, undefined, '', '   ']) {
    const r = fpuSessions({ class_starts_on: '2026-10-01', class_ends_on: end });
    assert.equal(r.ok, false, String(end));
    if (!r.ok) {
      assert.equal(r.reason, 'no_end_date');
      assert.match(r.detail, /end date/i);
    }
  }
  assert.equal(fpuSessionCount({ class_starts_on: '2026-10-01', class_ends_on: null }), 0);
  assert.deepEqual(elapsedFpuSessions({ class_starts_on: '2026-10-01', class_ends_on: null }, '2026-12-01'), []);
});

test('an end before the start, or a missing start, is refused', () => {
  const back = fpuSessions({ class_starts_on: '2026-10-01', class_ends_on: '2026-09-01' });
  assert.equal(back.ok, false);
  if (!back.ok) assert.equal(back.reason, 'bad_dates');
  const none = fpuSessions({ class_starts_on: '', class_ends_on: '2026-11-05' });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reason, 'bad_dates');
});

test('a span of years is refused rather than enumerated', () => {
  const r = fpuSessions({ class_starts_on: '2026-01-01', class_ends_on: '2029-01-01' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'too_many');
});

test('only sessions that have happened are markable', () => {
  assert.equal(elapsedFpuSessions(LIVE, '2026-09-30').length, 0);
  assert.equal(elapsedFpuSessions(LIVE, '2026-10-01').length, 1);
  assert.equal(elapsedFpuSessions(LIVE, '2026-10-14').length, 2);
  assert.equal(elapsedFpuSessions(LIVE, '2026-11-05').length, 6);
  assert.equal(elapsedFpuSessions(LIVE, '2027-01-01').length, 6);

  assert.equal(isMarkableSession(LIVE, 1, '2026-10-01'), true);
  assert.equal(isMarkableSession(LIVE, 2, '2026-10-01'), false, 'a future session is not markable');
  assert.equal(isMarkableSession(LIVE, 7, '2027-01-01'), false, 'a session that does not exist is not markable');
  assert.equal(isMarkableSession(LIVE, 0, '2027-01-01'), false);
});

test('dates never shift a day — they are compared as strings, not Dates', () => {
  // A class starting on a month boundary must not roll backwards.
  const r = fpuSessions({ class_starts_on: '2026-12-31', class_ends_on: '2027-01-21' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.sessions.map((s) => s.date), ['2026-12-31', '2027-01-07', '2027-01-14', '2027-01-21']);
});
