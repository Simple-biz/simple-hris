import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fpuAttendanceVerdict, fpuUnmarkedTotal } from './fpu-attendance';

const marks = (m: Record<number, boolean>) => new Map(Object.entries(m).map(([k, v]) => [Number(k), v]));
const allPresent = (n: number): Map<number, boolean> => new Map(Array.from({ length: n }, (_, i) => [i + 1, true]));

test('attending every session is the only way to be eligible', () => {
  const v = fpuAttendanceVerdict({ sessionCount: 6, marks: allPresent(6) });
  assert.equal(v.outcome, 'eligible');
  assert.equal(v.attended, 6);
  assert.deepEqual(v.absent, []);
  assert.deepEqual(v.unmarked, []);
  assert.equal(v.decidedBy, 'attendance');
  assert.match(v.reason, /all 6 sessions/);
});

// Kane: "if they miss even once they will no longer be eligible for MESA."
test('ONE absence fails the class', () => {
  for (const missed of [1, 3, 6]) {
    const m = allPresent(6);
    m.set(missed, false);
    const v = fpuAttendanceVerdict({ sessionCount: 6, marks: m });
    assert.equal(v.outcome, 'failed', `missing session ${missed}`);
    assert.deepEqual(v.absent, [missed]);
    assert.equal(v.attended, 5);
    assert.match(v.reason, new RegExp(`session ${missed}`));
  }
});

// Kane, Q3: fail closed, and name unmarked separately from absent.
test('an UNMARKED session fails the class and is reported as its own state', () => {
  const v = fpuAttendanceVerdict({ sessionCount: 6, marks: allPresent(5) });
  assert.equal(v.outcome, 'failed');
  assert.deepEqual(v.absent, [], 'an unmarked session is NOT an absence');
  assert.deepEqual(v.unmarked, [6]);
  assert.match(v.reason, /never marked/);
  assert.match(v.reason, /group leader/);
});

test('absent and unmarked are both named when both happened', () => {
  const v = fpuAttendanceVerdict({ sessionCount: 6, marks: marks({ 1: true, 2: false, 3: true }) });
  assert.equal(v.outcome, 'failed');
  assert.deepEqual(v.absent, [2]);
  assert.deepEqual(v.unmarked, [4, 5, 6]);
  assert.equal(v.attended, 2);
  assert.match(v.reason, /Missed session 2/);
  assert.match(v.reason, /never marked/);
});

test('nothing marked at all fails — silence is never a pass', () => {
  const v = fpuAttendanceVerdict({ sessionCount: 6, marks: new Map() });
  assert.equal(v.outcome, 'failed');
  assert.deepEqual(v.unmarked, [1, 2, 3, 4, 5, 6]);
  assert.equal(v.attended, 0);
});

// Kane, Q6: HR can override, and the marks stop deciding once they do.
test('an HR override outranks the marks in both directions', () => {
  const missed = allPresent(6);
  missed.set(2, false);
  const passed = fpuAttendanceVerdict({ sessionCount: 6, marks: missed, override: 'pass' });
  assert.equal(passed.outcome, 'eligible');
  assert.equal(passed.decidedBy, 'override');
  assert.match(passed.reason, /HR passed/);
  // The record is still reported truthfully — the override changes the verdict, not the history.
  assert.deepEqual(passed.absent, [2]);

  const failed = fpuAttendanceVerdict({ sessionCount: 6, marks: allPresent(6), override: 'fail' });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.decidedBy, 'override');
  assert.deepEqual(failed.absent, []);
});

test('a null or absent override leaves the marks deciding', () => {
  assert.equal(fpuAttendanceVerdict({ sessionCount: 2, marks: allPresent(2), override: null }).decidedBy, 'attendance');
  assert.equal(fpuAttendanceVerdict({ sessionCount: 2, marks: allPresent(2) }).decidedBy, 'attendance');
});

test('a class with no sessions fails closed rather than passing everyone', () => {
  const v = fpuAttendanceVerdict({ sessionCount: 0, marks: new Map() });
  assert.equal(v.outcome, 'failed');
  assert.equal(v.decidedBy, 'no_sessions');
  assert.match(v.reason, /no sessions/);
  // ...unless HR has explicitly ruled.
  assert.equal(fpuAttendanceVerdict({ sessionCount: 0, marks: new Map(), override: 'pass' }).outcome, 'eligible');
});

test('marks for sessions outside the class are ignored, not counted', () => {
  // HR shortened the class from 6 weeks to 4 after marks existed.
  const v = fpuAttendanceVerdict({ sessionCount: 4, marks: marks({ 1: true, 2: true, 3: true, 4: true, 5: false, 6: false }) });
  assert.equal(v.outcome, 'eligible');
  assert.equal(v.sessionCount, 4);
  assert.deepEqual(v.absent, []);
});

test('fpuUnmarkedTotal counts what HR still has to chase', () => {
  const a = fpuAttendanceVerdict({ sessionCount: 6, marks: allPresent(6) });
  const b = fpuAttendanceVerdict({ sessionCount: 6, marks: allPresent(4) });
  const c = fpuAttendanceVerdict({ sessionCount: 6, marks: new Map() });
  assert.equal(fpuUnmarkedTotal([a, b, c]), 0 + 2 + 6);
});
