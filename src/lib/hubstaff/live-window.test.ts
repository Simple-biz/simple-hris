/**
 * Tripwires for the employee live-overlay window.
 *
 * The failure classes this pins, in the order they would actually bite:
 *   1. the window reaching FURTHER BACK than the fixed 13 days it replaces
 *      (a "narrowing" that silently costs MORE requests)
 *   2. the window starting LATER than the current week's Sunday
 *      (today or the week in progress going dark behind a stale batch)
 *   3. a HOLE in the upload history being skipped instead of covered
 *   4. an unparseable / suffixed batch filename silently narrowing coverage
 *   5. a local-vs-UTC day shift in the filename → ISO conversion
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LOOKBACK_DAYS,
  coveredDatesFromSourceFiles,
  dayNumToIso,
  isoToDayNum,
  resolveLiveOverlayWindow,
} from './live-window';

const file = (start: string, end: string, suffix = '.csv') =>
  `simple-biz_daily_report_${start}_to_${end}${suffix}`;

test('production case 2026-09-12 — one week uncovered collapses 15 days to 8', () => {
  // The batch prod is actually carrying, browser duplicate suffix and all.
  const covered = coveredDatesFromSourceFiles([file('2026-08-30', '2026-09-05', ' 4.csv')]);
  const w = resolveLiveOverlayWindow({ todayIso: '2026-09-12', coveredDates: covered });
  assert.equal(w.rangeStart, '2026-09-06');
  assert.equal(w.rangeStop, '2026-09-13');
  assert.equal(w.days, 8);
  assert.equal(w.reason, 'batch-coverage');
  // The whole point: strictly fewer days than the fixed window it replaces.
  assert.ok(w.days < MAX_LOOKBACK_DAYS + 2);
});

test('no coverage at all degrades to EXACTLY the old fixed window, never wider', () => {
  const w = resolveLiveOverlayWindow({ todayIso: '2026-09-12', coveredDates: new Set() });
  assert.equal(w.rangeStart, '2026-08-30'); // today - 13
  assert.equal(w.rangeStop, '2026-09-13');
  assert.equal(w.days, 15);
  assert.equal(w.reason, 'max-lookback');
});

test('CLASS 1 — never reaches further back than MAX_LOOKBACK_DAYS, for any coverage', () => {
  const today = isoToDayNum('2026-09-12')!;
  const floor = today - MAX_LOOKBACK_DAYS;
  for (const covered of [
    new Set<string>(),
    coveredDatesFromSourceFiles([file('2020-01-05', '2020-01-11')]), // ancient, irrelevant
    coveredDatesFromSourceFiles([file('2026-06-01', '2026-06-07')]), // months stale
  ]) {
    const w = resolveLiveOverlayWindow({ todayIso: '2026-09-12', coveredDates: covered });
    assert.ok(
      isoToDayNum(w.rangeStart)! >= floor,
      `${w.rangeStart} reached past the ${MAX_LOOKBACK_DAYS}-day floor`,
    );
  }
});

test('CLASS 2 — the current week is always live, even if a batch claims to cover today', () => {
  // A batch covering the week IN PROGRESS is a snapshot of a moving target.
  const covered = coveredDatesFromSourceFiles([file('2026-09-06', '2026-09-12')]);
  const w = resolveLiveOverlayWindow({ todayIso: '2026-09-10', coveredDates: covered });
  assert.equal(w.rangeStart, '2026-09-06', 'the week Sunday must win over batch coverage');
  assert.equal(w.reason, 'current-week');
  assert.equal(w.rangeStop, '2026-09-11');
});

test('CLASS 2 — a Sunday still gets a window (start never runs past today)', () => {
  const covered = coveredDatesFromSourceFiles([file('2026-08-30', '2026-09-05')]);
  const w = resolveLiveOverlayWindow({ todayIso: '2026-09-06', coveredDates: covered });
  assert.equal(w.rangeStart, '2026-09-06');
  assert.equal(w.rangeStop, '2026-09-07');
  assert.equal(w.days, 2);
});

test('CLASS 3 — a HOLE in the upload history is walked through, not skipped', () => {
  // 08-23→08-29 uploaded, 08-30→09-05 MISSED, 09-06→09-12 uploaded.
  // Taking "the newest batch end + 1" would start at 09-13 and lose the hole entirely.
  const covered = coveredDatesFromSourceFiles([
    file('2026-08-23', '2026-08-29'),
    file('2026-09-06', '2026-09-12'),
  ]);
  const w = resolveLiveOverlayWindow({ todayIso: '2026-09-12', coveredDates: covered });
  assert.equal(w.rangeStart, '2026-09-06', 'current-week guard still applies');
  // And with the hole adjacent to today rather than a covered week:
  const w2 = resolveLiveOverlayWindow({ todayIso: '2026-09-05', coveredDates: covered });
  assert.equal(w2.rangeStart, '2026-08-30', 'the missed week must be inside the window');
  assert.equal(w2.rangeStop, '2026-09-06');
});

test('CLASS 4 — suffixed, 8-day and unparseable filenames', () => {
  // Browser duplicate-download suffixes, both shapes seen in prod.
  assert.ok(coveredDatesFromSourceFiles([file('2026-08-30', '2026-09-05', ' 4.csv')]).has('2026-09-01'));
  assert.ok(coveredDatesFromSourceFiles([file('2026-08-30', '2026-09-05', ' (1).csv')]).has('2026-09-01'));
  // 8-day Sun→Sun exports exist in prod; the span is read literally, never assumed to be 7.
  const eight = coveredDatesFromSourceFiles([file('2026-08-30', '2026-09-06')]);
  assert.equal(eight.size, 8);
  assert.ok(eight.has('2026-09-06'));
  // An undatable name contributes NOTHING — it must not be guessed into coverage,
  // because a wrong "covered" claim is what would blank a real day.
  assert.equal(coveredDatesFromSourceFiles(['backfill.csv', null, undefined, '']).size, 0);
  // ...and that degrades to the old window rather than a narrow one.
  const w = resolveLiveOverlayWindow({
    todayIso: '2026-09-12',
    coveredDates: coveredDatesFromSourceFiles(['backfill.csv']),
  });
  assert.equal(w.days, 15);
});

test('CLASS 5 — day arithmetic is UTC-anchored and survives a DST boundary', () => {
  // US DST ends 2026-11-01. A local-midnight Date round-tripped through toISOString()
  // shifts the day west of UTC; these helpers must not.
  for (const iso of ['2026-11-01', '2026-11-02', '2026-03-08', '2026-01-01', '2026-12-31']) {
    assert.equal(dayNumToIso(isoToDayNum(iso)!), iso);
  }
  const covered = coveredDatesFromSourceFiles([file('2026-11-01', '2026-11-07')]);
  assert.ok(covered.has('2026-11-01'), 'DST-end Sunday lost from coverage');
  assert.ok(covered.has('2026-11-07'));
  assert.equal(covered.size, 7);
  assert.equal(isoToDayNum('not-a-date'), null);
});

test('the stop is always tomorrow — the org-timezone absorber is untouched', () => {
  for (const todayIso of ['2026-09-12', '2026-01-31', '2026-02-28', '2026-12-31']) {
    const w = resolveLiveOverlayWindow({ todayIso, coveredDates: new Set() });
    assert.equal(w.rangeStop, dayNumToIso(isoToDayNum(todayIso)! + 1));
  }
});
