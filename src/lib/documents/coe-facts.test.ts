/**
 * The pure rules behind the two 2026-09-10 additions to the Certificate of
 * Engagement: the self-declared role clause and the "bonuses earned over the
 * last pay cycles" line. Both are OPTIONAL facts — the resolver omits them
 * rather than printing a blank — so the tests pin exactly when each is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COE_RECENT_BONUS_CYCLES,
  COE_RECENT_BONUS_LOOKBACK_DAYS,
  coeRoleTitle,
  recentBonusWindowStart,
  summarizeRecentBonuses,
  type CoeStatementLike,
} from './coe-facts';

const TODAY = '2026-09-10'; // a Thursday; the live week is Sep 6 – Sep 12

/** One statement week, Sunday-anchored, with the three bonus lines. */
function week(
  weekStart: string,
  weekEnd: string,
  bonuses: Partial<Pick<CoeStatementLike, 'attendanceBonus' | 'techBonus' | 'performanceBonus'>> = {},
): CoeStatementLike {
  return {
    weekStart,
    weekEnd,
    attendanceBonus: bonuses.attendanceBonus ?? 0,
    techBonus: bonuses.techBonus ?? 0,
    performanceBonus: bonuses.performanceBonus ?? 0,
  };
}

// Newest-first, exactly as listEmployeePayStubs returns them. The Sep 6–12 week
// is the live one — it has a statement (the wizard snapshot) but is not complete.
const STATEMENTS: CoeStatementLike[] = [
  week('2026-09-06', '2026-09-12', { attendanceBonus: 5000, techBonus: 1850, performanceBonus: 999 }),
  week('2026-08-30', '2026-09-05', { performanceBonus: 1000 }),
  week('2026-08-23', '2026-08-29', { attendanceBonus: 5000, techBonus: 1850 }),
  week('2026-08-16', '2026-08-22'),
  week('2026-08-09', '2026-08-15', { attendanceBonus: 5000 }),
  week('2026-08-02', '2026-08-08', { attendanceBonus: 5000, techBonus: 1850, performanceBonus: 7000 }),
];

test('sums Attendance + Technology + Performance over the 4 most recent COMPLETED weeks', () => {
  const r = summarizeRecentBonuses(STATEMENTS, TODAY);
  assert.ok(r);
  assert.equal(r.cycles, 4);
  // Aug 9–15, Aug 16–22, Aug 23–29, Aug 30–Sep 5. NOT the live Sep 6–12 week
  // (its 5000/1850/999 would otherwise be counted) and NOT Aug 2–8 (fifth).
  assert.equal(r.attendancePhp, 10000);
  assert.equal(r.technologyPhp, 1850);
  assert.equal(r.performancePhp, 1000);
  assert.equal(r.totalPhp, 12850);
  assert.equal(r.total, '₱12,850');
  assert.equal(r.windowStart, '2026-08-09');
  assert.equal(r.windowEnd, '2026-09-05');
  assert.equal(r.windowLabel, 'Aug 9 – Sep 5, 2026');
  assert.equal(r.breakdown, 'Attendance ₱10,000 · Technology ₱1,850 · Performance ₱1,000');
});

test('the in-progress week is excluded until it has ENDED — its last day still counts as in progress', () => {
  // On the Saturday the week ends, the week is not yet complete (hours are
  // still being logged), so weekEnd === today is excluded; the day after, it counts.
  const onSaturday = summarizeRecentBonuses(STATEMENTS, '2026-09-12');
  assert.ok(onSaturday);
  assert.equal(onSaturday.windowEnd, '2026-09-05');
  const onSunday = summarizeRecentBonuses(STATEMENTS, '2026-09-13');
  assert.ok(onSunday);
  assert.equal(onSunday.windowEnd, '2026-09-12');
  assert.equal(onSunday.windowStart, '2026-08-16');
  assert.equal(onSunday.performancePhp, 1999);
});

test('fewer than four completed weeks: the real count is reported, never padded', () => {
  const r = summarizeRecentBonuses(STATEMENTS.slice(0, 3), TODAY);
  assert.ok(r);
  assert.equal(r.cycles, 2);
  assert.equal(r.windowLabel, 'Aug 23 – Sep 5, 2026');
  assert.equal(r.totalPhp, 7850);
});

test('no completed week at all ⇒ null, so the certificate OMITS the line', () => {
  assert.equal(summarizeRecentBonuses([], TODAY), null);
  // Only the live week exists (a hire in their first week).
  assert.equal(summarizeRecentBonuses(STATEMENTS.slice(0, 1), TODAY), null);
  // Statements with no dated week cannot be shown to be complete.
  assert.equal(
    summarizeRecentBonuses([{ ...week('2026-08-30', '2026-09-05'), weekEnd: null }], TODAY),
    null,
  );
});

test('four completed weeks with no bonus money is a real ₱0, with no breakdown', () => {
  const r = summarizeRecentBonuses(
    [
      week('2026-08-30', '2026-09-05'),
      week('2026-08-23', '2026-08-29'),
      week('2026-08-16', '2026-08-22'),
      week('2026-08-09', '2026-08-15'),
    ],
    TODAY,
  );
  assert.ok(r);
  assert.equal(r.cycles, 4);
  assert.equal(r.totalPhp, 0);
  assert.equal(r.total, '₱0');
  assert.equal(r.breakdown, null);
});

test('input order does not matter — the newest completed weeks win regardless', () => {
  const shuffled = [...STATEMENTS].reverse();
  const a = summarizeRecentBonuses(STATEMENTS, TODAY);
  const b = summarizeRecentBonuses(shuffled, TODAY);
  assert.deepEqual(a, b);
});

test('cents survive the sum and the total is rounded to 2dp, not floated', () => {
  const r = summarizeRecentBonuses(
    [
      week('2026-08-30', '2026-09-05', { performanceBonus: 0.1 }),
      week('2026-08-23', '2026-08-29', { performanceBonus: 0.2 }),
    ],
    TODAY,
  );
  assert.ok(r);
  assert.equal(r.performancePhp, 0.3);
  assert.equal(r.total, '₱0.30');
});

test('the cycle count is the pinned constant', () => {
  assert.equal(COE_RECENT_BONUS_CYCLES, 4);
  const r = summarizeRecentBonuses(STATEMENTS, TODAY, 2);
  assert.ok(r);
  assert.equal(r.cycles, 2);
});

test('the lookback is 12 weeks, clamped to the engagement start so pre-join weeks are never candidates', () => {
  assert.equal(COE_RECENT_BONUS_LOOKBACK_DAYS, 84);
  // 84 days before Sep 10 is Jun 18; a 2024 start does not move it.
  assert.equal(recentBonusWindowStart(TODAY, '2024-03-04'), '2026-06-18');
  // A July hire: the window starts on their start date instead — the weeks
  // before it would each have cost a whole-company engine run to say "not here".
  assert.equal(recentBonusWindowStart(TODAY, '2026-07-13'), '2026-07-13');
  // A timestamp start date is read as a calendar day; date-only never goes
  // through UTC midnight.
  assert.equal(recentBonusWindowStart(TODAY, '2026-07-13T00:00:00.000Z').slice(0, 7), '2026-07');
  // Unparseable ⇒ the plain cutoff (the resolver has already refused a BLANK
  // start date, so this is a malformed-but-present value).
  assert.equal(recentBonusWindowStart(TODAY, 'someday'), '2026-06-18');
  // A start date in the future (data error) still just clamps — the read then
  // finds nothing and the line is omitted, which is the truthful outcome.
  assert.equal(recentBonusWindowStart(TODAY, '2026-12-01'), '2026-12-01');
});

test('the role is trimmed and whitespace-collapsed; blank is null (clause omitted)', () => {
  assert.equal(coeRoleTitle('  Senior   Sales  Associate '), 'Senior Sales Associate');
  assert.equal(coeRoleTitle('Team Lead'), 'Team Lead');
  assert.equal(coeRoleTitle(''), null);
  assert.equal(coeRoleTitle('   '), null);
  assert.equal(coeRoleTitle(null), null);
  assert.equal(coeRoleTitle(undefined), null);
});
