import test from 'node:test';
import assert from 'node:assert/strict';

import { nextPayWeek, upcomingWeekFor, weekEndFromStart } from './use-pay-weeks';

test('nextPayWeek is the live batch Sunday + 7, with the matching Saturday end', () => {
  // 2026-08-30 is a Sunday — the anchor every uploaded file starts on.
  assert.deepEqual(nextPayWeek('2026-08-30'), { start: '2026-09-06', end: '2026-09-12' });
  assert.deepEqual(nextPayWeek('2026-09-06'), { start: '2026-09-13', end: '2026-09-19' });
});

test('it rolls over month and year boundaries by calendar arithmetic, not string math', () => {
  assert.deepEqual(nextPayWeek('2026-09-27'), { start: '2026-10-04', end: '2026-10-10' });
  assert.deepEqual(nextPayWeek('2026-12-27'), { start: '2027-01-03', end: '2027-01-09' });
});

test('the anchor is preserved — a Sunday in yields a Sunday out', () => {
  // Every stored KPI row is keyed on the upload's SUNDAY; a Monday-anchored key
  // is invisible to every reader (audit-kpi-key-drift.mts). This helper must
  // never be the thing that introduces one.
  const dow = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y!, m! - 1, d!).getDay();
  };
  for (const sunday of ['2026-08-30', '2026-09-06', '2026-12-27']) {
    assert.equal(dow(sunday), 0, 'fixture must be a Sunday');
    assert.equal(dow(nextPayWeek(sunday).start), 0, 'output must be a Sunday');
  }
});

test('the end is exactly what weekEndFromStart says for that start', () => {
  const w = nextPayWeek('2026-09-06');
  assert.equal(w.end, weekEndFromStart(w.start));
});

test('upcomingWeekFor is null until the live week is known', () => {
  assert.equal(upcomingWeekFor(null, []), null);
});

test('upcomingWeekFor is the next week while no file exists for it — and vanishes when one does', () => {
  const live = '2026-09-06';
  const uploaded = [
    { start: '2026-09-06', end: '2026-09-12' },
    { start: '2026-08-30', end: '2026-09-05' },
  ];
  assert.deepEqual(upcomingWeekFor(live, uploaded), { start: '2026-09-13', end: '2026-09-19' });
  // The moment the real 2026-09-13 file uploads, it is a normal week, not "upcoming".
  const withNext = [{ start: '2026-09-13', end: '2026-09-19' }, ...uploaded];
  assert.equal(upcomingWeekFor(live, withNext), null);
});

test('exactly ONE week ahead — never two (Kane, Q3)', () => {
  const w = upcomingWeekFor('2026-09-06', []);
  assert.equal(w?.start, '2026-09-13');
  // There is no API for "the week after that", by design.
});
