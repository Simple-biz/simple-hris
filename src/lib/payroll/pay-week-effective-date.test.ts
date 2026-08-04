import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  payWeekStartContaining,
  snapEffectiveFromIso,
  snapEffectiveFromToPayWeekStart,
  toLocalIsoDate,
} from './pay-week-effective-date';

const d = (iso: string) => {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(y, m - 1, day);
};

test('sun_sat: a Sunday is already the week start and does not move', () => {
  const r = snapEffectiveFromToPayWeekStart(d('2026-07-26'));
  assert.equal(r.iso, '2026-07-26');
  assert.equal(r.moved, false);
  assert.equal(r.daysMoved, 0);
});

test('sun_sat: erjiee’s case — Monday snaps back one day to the Sunday', () => {
  // The live defect: raise entered eff 2026-07-27 (Mon) stranded Sun 2026-07-26 at the
  // old ₱225 rate while Mon–Sat paid ₱355.
  const r = snapEffectiveFromToPayWeekStart(d('2026-07-27'));
  assert.equal(r.iso, '2026-07-26');
  assert.equal(r.moved, true);
  assert.equal(r.daysMoved, 1);
});

test('sun_sat: mid-week days snap back to the same Sunday', () => {
  // The "HSL Rate Correction (2026-07-22)" campaign landed on a Wednesday and
  // stranded Sun+Mon+Tue.
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-22')).iso, '2026-07-19');
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-22')).daysMoved, 3);
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-21')).iso, '2026-07-19');
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-23')).iso, '2026-07-19');
});

test('sun_sat: Saturday snaps back six days, never forward into the next week', () => {
  const r = snapEffectiveFromToPayWeekStart(d('2026-07-25'));
  assert.equal(r.iso, '2026-07-19');
  assert.equal(r.daysMoved, 6);
  // Must not become 2026-07-26 — snapping forward would strand the whole week instead.
  assert.notEqual(r.iso, '2026-07-26');
});

test('sun_sat: every day of one pay week maps to the identical week start', () => {
  const starts = new Set(
    ['2026-07-19', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25']
      .map((iso) => snapEffectiveFromToPayWeekStart(d(iso)).iso),
  );
  assert.deepEqual([...starts], ['2026-07-19']);
});

test('sun_sat: the next Sunday opens a NEW week and is not pulled backward', () => {
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-26')).iso, '2026-07-26');
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-07-25')).iso, '2026-07-19');
});

test('mon_sun (legacy HSL pre-cutover): Monday is the week start', () => {
  const r = snapEffectiveFromToPayWeekStart(d('2026-05-25'), 'mon_sun');
  assert.equal(r.iso, '2026-05-25');
  assert.equal(r.moved, false);
});

test('mon_sun: Sunday belongs to the week that STARTED the previous Monday', () => {
  // Sun 2026-05-31 closes the Mon 05-25 week under the legacy model.
  const r = snapEffectiveFromToPayWeekStart(d('2026-05-31'), 'mon_sun');
  assert.equal(r.iso, '2026-05-25');
  assert.equal(r.daysMoved, 6);
});

test('mon_sun and sun_sat disagree for the same date, as they must', () => {
  assert.equal(payWeekStartContaining(d('2026-07-27'), 'sun_sat').getDay(), 0);
  assert.equal(payWeekStartContaining(d('2026-07-27'), 'mon_sun').getDay(), 1);
  assert.equal(toLocalIsoDate(payWeekStartContaining(d('2026-07-27'), 'mon_sun')), '2026-07-27');
});

test('snapping is idempotent — re-snapping a snapped date is a no-op', () => {
  const once = snapEffectiveFromToPayWeekStart(d('2026-07-22'));
  const twice = snapEffectiveFromToPayWeekStart(once.snapped);
  assert.equal(twice.iso, once.iso);
  assert.equal(twice.moved, false);
});

test('month and year boundaries are handled by real date arithmetic', () => {
  // Thu 2026-01-01 -> Sun 2025-12-28, crossing both a month and a year.
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-01-01')).iso, '2025-12-28');
  // Tue 2026-03-03 -> Sun 2026-03-01.
  assert.equal(snapEffectiveFromToPayWeekStart(d('2026-03-03')).iso, '2026-03-01');
});

test('toLocalIsoDate never shifts a day via UTC', () => {
  // A local-midnight date in a negative-offset timezone would render as the PREVIOUS
  // day under toISOString(); this must not.
  assert.equal(toLocalIsoDate(d('2026-07-26')), '2026-07-26');
  assert.equal(toLocalIsoDate(d('2026-01-01')), '2026-01-01');
});

test('iso helper snaps strings and reports the movement', () => {
  assert.deepEqual(snapEffectiveFromIso('2026-07-27'), {
    iso: '2026-07-26',
    moved: true,
    daysMoved: 1,
  });
  assert.deepEqual(snapEffectiveFromIso('2026-07-26'), {
    iso: '2026-07-26',
    moved: false,
    daysMoved: 0,
  });
});

test('iso helper tolerates a full timestamp by reading only the date part', () => {
  assert.equal(snapEffectiveFromIso('2026-07-27T13:45:00Z').iso, '2026-07-26');
});

test('iso helper passes malformed input through rather than failing a rate write', () => {
  for (const bad of [null, undefined, '', 'not-a-date', '07/27/2026']) {
    const r = snapEffectiveFromIso(bad as string | null | undefined);
    assert.equal(r.moved, false);
    assert.equal(r.daysMoved, 0);
  }
});

test('the stranded-day shortfall is exactly hours x regular-rate delta', () => {
  // erjiee: Sun 8:06:09 = 29169s = 8.1025h, paid at 225+15, owed at 355+15.
  const hours = 29169 / 3600;
  const paid = hours * (225 + 15);
  const owed = hours * (355 + 15);
  assert.equal(Math.round(paid * 100) / 100, 1944.6);
  assert.equal(Math.round(owed * 100) / 100, 2997.93);
  // The +15 weekend premium cancels, leaving hours x (355 - 225).
  assert.equal(Math.round((owed - paid) * 100) / 100, Math.round(hours * 130 * 100) / 100);
});
