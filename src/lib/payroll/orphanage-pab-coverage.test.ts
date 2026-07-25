import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAB_FULL_DAY_SECONDS,
  buildOrphanageHoursIndex,
  orphanageHoursForDate,
  orphanageCoversDay,
  orphanageHoursByCoveredDate,
  buildOrphanageCoverageMap,
} from './orphanage-pab-coverage';

// Mon Jul 13 – Sun Jul 19; coverage window opens Mon Jul 6 (week before).
const WEEK = 'hubstaff_2026-07-13_to_2026-07-19.csv';
const NEXT_WEEK = 'hubstaff_2026-07-20_to_2026-07-26.csv';

// ── orphanageCoversDay (the core predicate) ─────────────────────────────────
test('orphanageCoversDay: worked + orphanage reaching 7h passes', () => {
  // worked 2h + 5h orphanage = 7h
  assert.equal(orphanageCoversDay(2 * 3600, 5), true);
  // worked 0h + 7h orphanage = 7h (exactly the threshold)
  assert.equal(orphanageCoversDay(0, 7), true);
  // worked 2h + 3h orphanage = 5h — short of 7h
  assert.equal(orphanageCoversDay(2 * 3600, 3), false);
  // no orphanage hours never covers, even at 6.99h worked
  assert.equal(orphanageCoversDay(PAB_FULL_DAY_SECONDS - 1, 0), false);
});

// ── window semantics: file week + the week BEFORE it ────────────────────────
test('orphanageHoursForDate: covers the file week AND the week before (hours land one payroll run after the visit)', () => {
  const idx = buildOrphanageHoursIndex([
    { sourceFile: WEEK, email: 'Jane@Simple.biz', hours: 5 },
    { sourceFile: NEXT_WEEK, email: 'jane@simple.biz', hours: 2 },
  ]);
  // inside the file week itself
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-07-15'), 5);
  // the week BEFORE the file week — the Karl pattern (visit Fri Jul 10, hours in the Jul 13–19 run)
  assert.equal(orphanageHoursForDate(idx, 'JANE@simple.biz', '2026-07-10'), 5);
  // window start boundary (file start − 7d = Mon Jul 6)
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-07-06'), 5);
  // one day before the window → nothing
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-07-05'), 0);
  // overlapping windows (consecutive weeks): per-day MAX, not a sum
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-07-16'), 5); // in WEEK + NEXT_WEEK's window
  // only the later week's window → its own hours
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-07-22'), 2);
  // past everything
  assert.equal(orphanageHoursForDate(idx, 'jane@simple.biz', '2026-08-01'), 0);
  // unknown person
  assert.equal(orphanageHoursForDate(idx, 'nobody@simple.biz', '2026-07-15'), 0);
});

test('buildOrphanageHoursIndex: skips zero/negative hours and unparseable weeks', () => {
  const idx = buildOrphanageHoursIndex([
    { sourceFile: WEEK, email: 'a@x.com', hours: 0 },
    { sourceFile: WEEK, email: 'b@x.com', hours: -3 },
    { sourceFile: 'no-date-range.csv', email: 'c@x.com', hours: 5 },
    { sourceFile: null, email: 'd@x.com', hours: 5 },
    { sourceFile: WEEK, email: '', hours: 5 },
  ]);
  assert.equal(idx.size, 0);
});

// ── auto enumeration: weekdays of the window only ────────────────────────────
test('orphanageHoursByCoveredDate: enumerates WEEKDAYS of window (file week + prior week)', () => {
  const idx = buildOrphanageHoursIndex([{ sourceFile: WEEK, email: 'jane@simple.biz', hours: 5 }]);
  const m = orphanageHoursByCoveredDate(idx, 'jane@simple.biz');
  // Window Jul 6 (Mon) → Jul 19 (Sun): weekdays = Jul 6–10 and Jul 13–17 → 10 dates
  assert.equal(m.size, 10);
  assert.equal(m.get('2026-07-06'), 5); // prior-week Monday
  assert.equal(m.get('2026-07-10'), 5); // prior-week Friday (the Karl day)
  assert.equal(m.get('2026-07-17'), 5); // file-week Friday
  assert.equal(m.has('2026-07-11'), false); // Saturday — never covered
  assert.equal(m.has('2026-07-12'), false); // Sunday — never covered
  assert.equal(m.has('2026-07-05'), false); // before the window
  assert.equal(m.has('2026-07-20'), false); // after the window
});

test('buildOrphanageCoverageMap: fleet map keyed by email, windows enumerated', () => {
  const map = buildOrphanageCoverageMap([
    { sourceFile: WEEK, email: 'Jane@Simple.biz', hours: 12 },
    { sourceFile: WEEK, email: 'zero@simple.biz', hours: 0 }, // dropped
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get('jane@simple.biz')?.get('2026-07-10'), 12);
});
