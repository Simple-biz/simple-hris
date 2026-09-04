/**
 * buildHrPipeline — the HR hiring funnel, measured per week and per month.
 *
 * The properties pinned here are the ones live data and the governing docs
 * proved you cannot guess:
 *
 *  - The week is HR's `period_start` via `pickChecklistWeek` — the SAME
 *    resolver the Manager and HR surfaces use. Deriving it from the hire's own
 *    dates filed 46% of hires one week early.
 *  - "Listed" ≠ "staged", and every rate is over STAGED.
 *  - A week with nothing staged is UNMEASURABLE, not 0%.
 *  - The headline is promoted / staged (Kane, 2026-09-04).
 *  - Attendance is the STAMP, never `status`.
 *  - Month rates are POOLED, and off-checklist hires never join a month.
 *
 * Run:  npx tsx --test src/lib/admin/hr-pipeline-performance.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHrPipeline,
  formatWeekLabel,
  type HrPipelinePendingRow,
} from '@/lib/admin/hr-pipeline-performance';

/**
 * `??` would swallow an explicit `null` and hand back the default — exactly the
 * value these tests are trying to assert about. Every field is taken by
 * PRESENCE of the key, so `promoted_at: null` means null.
 */
function hire(over: Partial<HrPipelinePendingRow> & { personal_email: string }): HrPipelinePendingRow {
  const pick = <K extends keyof HrPipelinePendingRow>(
    key: K,
    fallback: HrPipelinePendingRow[K],
  ): HrPipelinePendingRow[K] => (key in over ? (over[key] as HrPipelinePendingRow[K]) : fallback);
  return {
    personal_email: over.personal_email,
    created_at: pick('created_at', '2026-08-16T00:00:00.000Z'),
    status: pick('status', 'promoted'),
    onboarding_submission_id: pick('onboarding_submission_id', 'sub-1'),
    orientation_attended_at: pick('orientation_attended_at', '2026-08-17T09:00:00.000Z'),
    no_show_at: pick('no_show_at', null),
    promoted_at: pick('promoted_at', '2026-08-18T00:00:00.000Z'),
  };
}

const WEEK = '2026-08-16';

function weeks(pairs: Array<[string, string[]]>): Map<string, string[]> {
  return new Map(pairs);
}

test('the headline rate is promoted / staged', () => {
  const built = buildHrPipeline({
    pending: [
      hire({ personal_email: 'a@x.com' }),
      hire({ personal_email: 'b@x.com' }),
      hire({ personal_email: 'c@x.com', promoted_at: null, no_show_at: '2026-08-18T00:00:00Z' }),
      hire({ personal_email: 'd@x.com', promoted_at: null, no_show_at: null }),
    ],
    checklistWeeksByEmail: weeks([
      ['a@x.com', [WEEK]], ['b@x.com', [WEEK]], ['c@x.com', [WEEK]], ['d@x.com', [WEEK]],
    ]),
    checklistWeekCounts: new Map([[WEEK, 6]]),
  });
  const w = built.weeks.find((x) => x.weekStart === WEEK);
  assert.ok(w);
  assert.equal(w.staged, 4);
  assert.equal(w.promoted, 2);
  assert.equal(w.rate, 0.5);
  assert.equal(w.noShow, 1);
  assert.equal(w.stillOpen, 1);
});

test('listed is never a denominator — notStaged gets its own count', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 10]]),
  });
  const w = built.weeks.find((x) => x.weekStart === WEEK)!;
  assert.equal(w.listed, 10);
  assert.equal(w.staged, 1);
  assert.equal(w.notStaged, 9);
  // 1 promoted of 1 staged is 100% — NOT 10%.
  assert.equal(w.rate, 1);
});

test('a listed week with nothing staged is unmeasurable, not 0%', () => {
  const built = buildHrPipeline({
    pending: [],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map([['2026-05-03', 52]]),
  });
  const w = built.weeks.find((x) => x.weekStart === '2026-05-03')!;
  assert.equal(w.listed, 52);
  assert.equal(w.staged, 0);
  assert.equal(w.measurable, false);
  assert.equal(w.rate, null);
  assert.equal(built.totals.unmeasurableWeeks, 1);
  assert.equal(built.totals.rate, null);
});

test('an unmeasurable week never enters a month denominator but is still listed', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1], ['2026-08-23', 40]]),
  });
  const aug = built.months.find((m) => m.month === '2026-08')!;
  assert.equal(aug.weeks, 2);
  assert.equal(aug.staged, 1);
  assert.equal(aug.listed, 41);
  assert.equal(aug.rate, 1);
});

test('the week comes from the checklist, never from the hire own dates', () => {
  // created_at sits in the week BEFORE the checklist week — the classic 46%
  // wrong-week case. The checklist wins.
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com', created_at: '2026-08-14T00:00:00.000Z' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1]]),
  });
  assert.equal(built.weeks.find((w) => w.staged > 0)!.weekStart, WEEK);
});

test('a re-listed email resolves to one week, at-or-after and nearest', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com', created_at: '2026-08-16T00:00:00.000Z' })],
    checklistWeeksByEmail: weeks([['a@x.com', ['2026-06-07', '2026-08-16', '2026-09-06']]]),
    checklistWeekCounts: new Map([['2026-06-07', 1], [WEEK, 1], ['2026-09-06', 1]]),
  });
  const staged = built.weeks.filter((w) => w.staged > 0);
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.weekStart, WEEK);
});

test('a staged hire matching no checklist row gets its own bucket, never a real week', () => {
  const built = buildHrPipeline({
    pending: [
      hire({ personal_email: 'known@x.com' }),
      hire({ personal_email: 'ghost@x.com', created_at: '2026-08-16T00:00:00.000Z' }),
    ],
    checklistWeeksByEmail: weeks([['known@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1]]),
  });
  const real = built.weeks.find((w) => w.weekStart === WEEK && w.onChecklist)!;
  assert.equal(real.staged, 1);
  const off = built.weeks.find((w) => !w.onChecklist)!;
  assert.equal(off.staged, 1);
  assert.equal(off.label, "Not on HR's checklist");
  assert.equal(built.totals.offChecklist, 1);
  // counted in the all-time totals, absent from every month
  assert.equal(built.totals.staged, 2);
  assert.equal(built.months.find((m) => m.month === '2026-08')!.staged, 1);
});

test('attendance is the stamp, never the status', () => {
  const built = buildHrPipeline({
    // prod row 717: both stamps, status no_show — it IS an attendance.
    // prod row 1034: no_show_at with status ready and no attended stamp.
    pending: [
      hire({ personal_email: 'a@x.com', status: 'no_show', orientation_attended_at: '2026-08-17T00:00:00Z', no_show_at: '2026-08-17T00:00:00Z', promoted_at: null }),
      hire({ personal_email: 'b@x.com', status: 'ready', orientation_attended_at: null, no_show_at: '2026-08-17T00:00:00Z', promoted_at: null }),
    ],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]], ['b@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 2]]),
  });
  const w = built.weeks.find((x) => x.weekStart === WEEK)!;
  assert.equal(w.attended, 1);
  assert.equal(w.noShow, 2); // neither is promoted, both carry no_show_at
});

test('a promoted hire is never also counted as a no-show', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com', promoted_at: '2026-08-18T00:00:00Z', no_show_at: '2026-08-17T00:00:00Z' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1]]),
  });
  const w = built.weeks.find((x) => x.weekStart === WEEK)!;
  assert.equal(w.promoted, 1);
  assert.equal(w.noShow, 0);
  assert.equal(w.stillOpen, 0);
});

test('submitted counts the onboarding submission link', () => {
  const built = buildHrPipeline({
    pending: [
      hire({ personal_email: 'a@x.com', onboarding_submission_id: 'sub-9' }),
      hire({ personal_email: 'b@x.com', onboarding_submission_id: null }),
    ],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]], ['b@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 2]]),
  });
  assert.equal(built.weeks.find((x) => x.weekStart === WEEK)!.submitted, 1);
});

test('month rate is pooled, not a mean of the weekly rates', () => {
  const built = buildHrPipeline({
    pending: [
      // week A: 1 staged, 1 promoted → 100%
      hire({ personal_email: 'a@x.com' }),
      // week B: 2 staged, 0 promoted → 0%
      hire({ personal_email: 'b@x.com', created_at: '2026-08-23T00:00:00Z', promoted_at: null }),
      hire({ personal_email: 'c@x.com', created_at: '2026-08-23T00:00:00Z', promoted_at: null }),
    ],
    checklistWeeksByEmail: weeks([
      ['a@x.com', [WEEK]], ['b@x.com', ['2026-08-23']], ['c@x.com', ['2026-08-23']],
    ]),
    checklistWeekCounts: new Map([[WEEK, 1], ['2026-08-23', 2]]),
  });
  const aug = built.months.find((m) => m.month === '2026-08')!;
  assert.equal(aug.staged, 3);
  assert.equal(aug.promoted, 1);
  assert.equal(aug.rate, 1 / 3);
  assert.notEqual(aug.rate, 0.5); // the mean of 100% and 0%
  assert.equal(aug.worstWeekRate, 0);
});

test('weeks and months come back newest first', () => {
  const built = buildHrPipeline({
    pending: [],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map([['2026-07-05', 1], ['2026-08-16', 1], ['2026-06-07', 1]]),
  });
  assert.deepEqual(
    built.weeks.map((w) => w.weekStart),
    ['2026-08-16', '2026-07-05', '2026-06-07'],
  );
  assert.deepEqual(built.months.map((m) => m.month), ['2026-08', '2026-07', '2026-06']);
});

test('the off-checklist bucket sorts after every real week', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'ghost@x.com', created_at: '2026-09-06T00:00:00Z' })],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map([['2026-06-07', 1]]),
  });
  assert.equal(built.weeks[0]!.onChecklist, true);
  assert.equal(built.weeks.at(-1)!.onChecklist, false);
});

test('emails are matched case- and whitespace-insensitively', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: '  A@X.com ' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1]]),
  });
  assert.equal(built.weeks.find((w) => w.weekStart === WEEK)!.staged, 1);
});

test('a hire with no email is bucketed off-checklist, never dropped', () => {
  const built = buildHrPipeline({
    pending: [{ personal_email: null, created_at: '2026-08-16T00:00:00Z', status: 'promoted', onboarding_submission_id: null, orientation_attended_at: null, no_show_at: null, promoted_at: null }],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map(),
  });
  assert.equal(built.totals.staged, 1);
  assert.equal(built.totals.offChecklist, 1);
});

test('a negative or nonsense listed count degrades to zero', () => {
  const built = buildHrPipeline({
    pending: [],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map([['2026-08-16', -5], ['2026-08-23', Number.NaN]]),
  });
  assert.equal(built.totals.listed, 0);
});

test('the live shape: 1,479 listed / 1,049 staged / 1,008 promoted holds together', () => {
  // A miniature of production: staged is well below listed, and the rate is
  // over staged — 96%, not the 68% a listed-denominator would print.
  const pending: HrPipelinePendingRow[] = [];
  const byEmail = new Map<string, string[]>();
  for (let i = 0; i < 100; i += 1) {
    const email = `h${i}@x.com`;
    byEmail.set(email, [WEEK]);
    pending.push(hire({ personal_email: email, promoted_at: i < 96 ? '2026-08-18T00:00:00Z' : null, no_show_at: i < 96 ? null : '2026-08-18T00:00:00Z' }));
  }
  const built = buildHrPipeline({
    pending,
    checklistWeeksByEmail: byEmail,
    checklistWeekCounts: new Map([[WEEK, 141]]),
  });
  const w = built.weeks.find((x) => x.weekStart === WEEK)!;
  assert.equal(w.listed, 141);
  assert.equal(w.staged, 100);
  assert.equal(w.notStaged, 41);
  assert.equal(w.promoted, 96);
  assert.equal(w.rate, 0.96);
});

test('staged above listed floors notStaged at zero rather than going negative', () => {
  const built = buildHrPipeline({
    pending: [hire({ personal_email: 'a@x.com' }), hire({ personal_email: 'b@x.com' })],
    checklistWeeksByEmail: weeks([['a@x.com', [WEEK]], ['b@x.com', [WEEK]]]),
    checklistWeekCounts: new Map([[WEEK, 1]]),
  });
  assert.equal(built.weeks.find((w) => w.weekStart === WEEK)!.notStaged, 0);
});

test('formatWeekLabel spans Sunday to Saturday and echoes back junk', () => {
  assert.equal(formatWeekLabel('2026-08-16'), 'Aug 16 – Aug 22, 2026');
  assert.equal(formatWeekLabel('2026-12-27'), 'Dec 27 – Jan 2, 2027');
  assert.equal(formatWeekLabel('undated'), 'undated');
});

test('an empty input is an empty summary, not a zero rate', () => {
  const built = buildHrPipeline({
    pending: [],
    checklistWeeksByEmail: new Map(),
    checklistWeekCounts: new Map(),
  });
  assert.deepEqual(built.weeks, []);
  assert.deepEqual(built.months, []);
  assert.equal(built.totals.rate, null);
  assert.equal(built.totals.firstWeek, null);
});
