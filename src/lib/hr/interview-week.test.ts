/**
 * Run: node --import tsx --test src/lib/hr/interview-week.test.ts
 *
 * The New Hire modal's interview week and the sync's placement read ONE rule: a hire belongs on the checklist week
 * after their interview week. Pinned here against the sync's own `targetWeekFor`, day by day, so the two cannot drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interviewFitsWeek, interviewWeekFor } from './interview-week';
import { targetWeekFor } from './hires-source-map';

test('the interview week of Oct 11–17 is Oct 4–10 (the week before, Sunday to Saturday)', () => {
  assert.deepEqual(interviewWeekFor('2026-10-11'), { start: '2026-10-04', end: '2026-10-10' });
  assert.deepEqual(interviewWeekFor('2026-01-04'), { start: '2025-12-28', end: '2026-01-03' }, 'across a year');
  assert.deepEqual(interviewWeekFor('2026-03-08'), { start: '2026-03-01', end: '2026-03-07' }, 'across DST');
  assert.equal(interviewWeekFor('Oct 11'), null);
  assert.equal(interviewWeekFor(''), null);
});

test('ONE rule: every day of the interview week places on the checklist week the modal was opened on (sync agrees)', () => {
  for (let i = 0; i < 400; i += 1) {
    const sunday = new Date(Date.UTC(2025, 11, 28 + 7 * i)).toISOString().slice(0, 10);
    const week = interviewWeekFor(sunday)!;
    for (let d = 0; d < 7; d += 1) {
      const day = new Date(Date.UTC(+week.start.slice(0, 4), +week.start.slice(5, 7) - 1, +week.start.slice(8, 10) + d)).toISOString().slice(0, 10);
      assert.equal(targetWeekFor(day), sunday, `${day} → ${sunday}`);
      assert.equal(interviewFitsWeek(day, sunday), true);
    }
    assert.equal(interviewFitsWeek(sunday, sunday), false, 'the checklist week itself is not its interview week');
  }
});

test('a date outside the interview week is false; nothing to judge is null, never "outside"', () => {
  assert.equal(interviewFitsWeek('2026-10-03', '2026-10-11'), false, 'two weeks before');
  assert.equal(interviewFitsWeek('2026-10-11', '2026-10-11'), false, 'the same week');
  assert.equal(interviewFitsWeek('2026-10-04', '2026-10-11'), true);
  assert.equal(interviewFitsWeek(' 2026-10-10 ', '2026-10-11'), true);
  assert.equal(interviewFitsWeek('', '2026-10-11'), null);
  assert.equal(interviewFitsWeek('10/5/2026', '2026-10-11'), null);
  assert.equal(interviewFitsWeek('2026-10-05', 'bad'), null);
});
