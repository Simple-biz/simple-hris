/**
 * buildHrOrientationWeekStats — one HR checklist week, measured.
 *
 * The properties pinned here are the ones live data (2026-08-26) proved you
 * cannot guess:
 *
 *  - "Listed" ≠ "staged". 2026-08-23 listed 79, staged 70, attended 66. A listed
 *    hire with no `hr_pending_employees` row can never carry an attended stamp,
 *    so it must NOT enter the rate's denominator.
 *  - The rate is `attendanceRate` (attended / staged) — the same number the
 *    manager tally publishes for the same week.
 *  - A week with checklist rows but nothing staged is UNMEASURABLE, not 0%.
 *    Every week before 2026-06-07 looks like this, as does a freshly-listed
 *    current week.
 *  - Attendance is the STAMP: prod row 717 carries both stamps (attended),
 *    prod row 1034 carries `no_show_at` with `status='ready'` (awaiting).
 *
 * Run:  npx tsx --test src/lib/hr/orientation-week-stats.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrientationWeeks,
  attendanceRate,
  type OrientationHire,
} from '@/lib/manager/orientation-weekly';
import {
  buildHrOrientationWeekStats,
  buildStagedWeekIndex,
  previousMeasuredWeek,
  type HrChecklistListedRow,
} from './orientation-week-stats';

const WEEK = '2026-08-23';
const PREV = '2026-08-16';

let nextId = 1;

function hire(over: Partial<OrientationHire> = {}): OrientationHire {
  const id = nextId++;
  return {
    id,
    name: `Hire ${id}`,
    personal_email: `hire${id}@gmail.com`,
    work_email: null,
    department: 'Lead Gen',
    job_description: null,
    // Sun 2026-08-23 week: HR stages on the Friday before.
    created_at: '2026-08-21T02:00:00.000Z',
    start_date: null,
    status: 'promoted',
    source: 'onboarding_form',
    orientation_attended_at: '2026-08-24T01:00:00.000Z',
    orientation_attended_by: 'manager@simple.biz',
    orientation_note: null,
    no_show_at: null,
    no_show_by: null,
    no_show_note: null,
    ...over,
  };
}

let nextListedId = 1;
function listed(over: Partial<HrChecklistListedRow> = {}): HrChecklistListedRow {
  const id = nextListedId++;
  return {
    id: `ck-${id}`,
    name: `Listed ${id}`,
    personal_email: `listed${id}@gmail.com`,
    department: 'Lead Gen',
    ...over,
  };
}

/** Build the summary the way the route does, then measure one week from it. */
function measure(
  weekStart: string,
  hires: OrientationHire[],
  listedRows: HrChecklistListedRow[],
  extraChecklist: Array<[string, string[]]> = [],
) {
  const weeksByEmail = new Map<string, string[]>(extraChecklist);
  for (const h of hires) {
    const e = (h.personal_email ?? '').trim().toLowerCase();
    if (e && !weeksByEmail.has(e)) weeksByEmail.set(e, [weekStart]);
  }
  for (const r of listedRows) {
    const e = (r.personal_email ?? '').trim().toLowerCase();
    if (e && !weeksByEmail.has(e)) weeksByEmail.set(e, [weekStart]);
  }
  const summary = buildOrientationWeeks({ hires, checklistWeeksByEmail: weeksByEmail });
  const week = summary.weeks.find((w) => w.weekStart === weekStart) ?? null;
  const stats = buildHrOrientationWeekStats({
    weekStart,
    listedRows,
    week,
    stagedWeekByEmail: buildStagedWeekIndex(summary),
  });
  return { summary, week, stats };
}

test('the rate runs over STAGED, never over listed', () => {
  // 4 listed, 3 of them staged, 2 attended → 67%, not 50%.
  const a = hire({ personal_email: 'a@gmail.com' });
  const b = hire({ personal_email: 'b@gmail.com' });
  const c = hire({ personal_email: 'c@gmail.com', orientation_attended_at: null, status: 'ready' });
  const rows = [
    listed({ personal_email: 'a@gmail.com' }),
    listed({ personal_email: 'b@gmail.com' }),
    listed({ personal_email: 'c@gmail.com' }),
    listed({ personal_email: 'never-staged@gmail.com' }),
  ];

  const { stats } = measure(WEEK, [a, b, c], rows);

  assert.equal(stats.listed, 4);
  assert.equal(stats.staged, 3);
  assert.equal(stats.attended, 2);
  assert.equal(stats.rate, 67);
  assert.equal(stats.measurable, true);
});

test('a listed hire with no staged row is reported, not folded into the denominator', () => {
  const staged = hire({ personal_email: 'staged@gmail.com' });
  const rows = [
    listed({ personal_email: 'staged@gmail.com' }),
    listed({ personal_email: 'ghost@gmail.com', name: 'Never Staged' }),
    listed({ personal_email: '   ', name: 'Blank Email' }),
  ];

  const { stats } = measure(WEEK, [staged], rows);

  assert.equal(stats.listed, 3);
  assert.equal(stats.staged, 1);
  assert.equal(stats.notStaged.length, 2);
  assert.deepEqual(
    stats.notStaged.map((r) => r.name).sort(),
    ['Blank Email', 'Never Staged'],
  );
  // The unstaged pair never touches the rate.
  assert.equal(stats.rate, 100);
});

test('a listed hire staged into another week counts as elsewhere, not as missing', () => {
  // Re-list: the email sits on both weeks. HR staged them in the WEEK week, so
  // pickChecklistWeek (nearest, at-or-after) files them there — but PREV listed
  // them too, and PREV must not report them as never staged.
  const h = hire({ personal_email: 'relist@gmail.com', created_at: '2026-08-28T02:00:00.000Z' });
  const weeksByEmail = new Map<string, string[]>([['relist@gmail.com', [PREV, WEEK]]]);
  const summary = buildOrientationWeeks({ hires: [h], checklistWeeksByEmail: weeksByEmail });

  const prevStats = buildHrOrientationWeekStats({
    weekStart: PREV,
    listedRows: [listed({ personal_email: 'relist@gmail.com' })],
    week: summary.weeks.find((w) => w.weekStart === PREV) ?? null,
    stagedWeekByEmail: buildStagedWeekIndex(summary),
  });

  assert.equal(prevStats.listed, 1);
  assert.equal(prevStats.notStaged.length, 0, 'they ARE staged — just filed elsewhere');
  assert.equal(prevStats.listedStagedElsewhere, 1);
  assert.equal(prevStats.listedStagedHere, 0);
  assert.equal(prevStats.measurable, false, 'no staged hire landed in PREV');
});

test('checklist rows with nothing staged are UNMEASURABLE, not 0%', () => {
  // Every week before 2026-06-07 looks like this: hires listed, none staged.
  const rows = [listed(), listed(), listed()];
  const { stats } = measure('2026-05-03', [], rows);

  assert.equal(stats.listed, 3);
  assert.equal(stats.staged, 0);
  assert.equal(stats.measurable, false);
  assert.equal(stats.rate, null, 'a rate here would read as 0% attendance');
  assert.equal(stats.notStaged.length, 3);
});

test('an empty week is unmeasurable rather than an error', () => {
  const { stats } = measure(WEEK, [], []);
  assert.equal(stats.listed, 0);
  assert.equal(stats.staged, 0);
  assert.equal(stats.rate, null);
  assert.equal(stats.measurable, false);
  assert.deepEqual(stats.byDepartment, []);
  assert.deepEqual(stats.hires, []);
});

test('attendance is the stamp: prod rows 717 and 1034', () => {
  // 717: both stamps, status no_show → ATTENDED.
  const both = hire({
    personal_email: 'both@gmail.com',
    status: 'no_show',
    orientation_attended_at: '2026-08-24T01:00:00.000Z',
    no_show_at: '2026-08-25T01:00:00.000Z',
  });
  // 1034: no_show_at with status ready and no attended stamp → AWAITING.
  const reverted = hire({
    personal_email: 'reverted@gmail.com',
    status: 'ready',
    orientation_attended_at: null,
    no_show_at: '2026-08-25T01:00:00.000Z',
  });
  // A real no-show, for contrast.
  const noShow = hire({
    personal_email: 'noshow@gmail.com',
    status: 'no_show',
    orientation_attended_at: null,
    no_show_at: '2026-08-25T01:00:00.000Z',
  });

  const { stats } = measure(WEEK, [both, reverted, noShow], []);

  assert.equal(stats.attended, 1, '717 is an attendance');
  assert.equal(stats.notAttended, 2);
  assert.equal(stats.awaiting, 1, '1034 is awaiting, not a no-show');
  assert.equal(stats.noShow, 1);
  assert.equal(stats.rate, 33);
});

test('the rate is byte-identical to the manager tally for the same week', () => {
  const hires = [
    hire(),
    hire(),
    hire({ orientation_attended_at: null, status: 'no_show', no_show_at: '2026-08-25T01:00:00.000Z' }),
    hire({ orientation_attended_at: null, status: 'ready' }),
  ];
  const { week, stats } = measure(WEEK, hires, [listed(), listed()]);

  assert.ok(week);
  assert.equal(stats.rate, attendanceRate(week));
  assert.equal(stats.staged, week.total);
  assert.equal(stats.attended, week.attended);
  assert.equal(stats.notAttended, week.notAttended);
});

test('unmarked hires are counted against the week, and surfaced as awaiting', () => {
  const hires = [hire(), hire({ orientation_attended_at: null, status: 'ready' })];
  const { stats } = measure(WEEK, hires, []);

  assert.equal(stats.rate, 50, 'an unmarked hire counts AGAINST the week');
  assert.equal(stats.awaiting, 1, 'and is named so the panel can note it');
  assert.equal(stats.noShow, 0);
});

test('the department breakdown covers depts that listed but never staged', () => {
  const hires = [
    hire({ department: 'Lead Gen', personal_email: 'lg1@gmail.com' }),
    hire({
      department: 'Lead Gen',
      personal_email: 'lg2@gmail.com',
      orientation_attended_at: null,
      status: 'no_show',
    }),
    hire({ department: 'HSL', personal_email: 'hsl1@gmail.com' }),
  ];
  const rows = [
    listed({ department: 'Lead Gen', personal_email: 'lg1@gmail.com' }),
    listed({ department: 'Lead Gen', personal_email: 'lg2@gmail.com' }),
    listed({ department: 'HSL', personal_email: 'hsl1@gmail.com' }),
    listed({ department: 'AI/API Team', personal_email: 'ghost@gmail.com' }),
  ];

  const { stats } = measure(WEEK, hires, rows);

  const byDept = new Map(stats.byDepartment.map((d) => [d.department, d]));
  assert.equal(byDept.get('Lead Gen')?.listed, 2);
  assert.equal(byDept.get('Lead Gen')?.staged, 2);
  assert.equal(byDept.get('Lead Gen')?.notAttended, 1);
  assert.equal(byDept.get('HSL')?.staged, 1);
  // Listed but never staged still owes a row, or the intake gap disappears.
  assert.equal(byDept.get('AI/API Team')?.listed, 1);
  assert.equal(byDept.get('AI/API Team')?.staged, 0);
  // Worst week first: Lead Gen leads on notAttended.
  assert.equal(stats.byDepartment[0]?.department, 'Lead Gen');
});

test('hires list did-not-attend first', () => {
  const hires = [
    hire({ name: 'Attended One' }),
    hire({ name: 'Missed One', orientation_attended_at: null, status: 'no_show' }),
    hire({ name: 'Attended Two' }),
  ];
  const { stats } = measure(WEEK, hires, []);
  assert.equal(stats.hires[0]?.name, 'Missed One');
});

test('a raw department label is preserved for the caller to format', () => {
  const h = hire({ department: 'hsl:collections', personal_email: 'x@gmail.com' });
  const { stats } = measure(WEEK, [h], []);
  assert.equal(stats.byDepartment[0]?.department, 'hsl:collections');
});

test('previousMeasuredWeek skips weeks nobody ever marked', () => {
  const hires = [
    hire({ personal_email: 'now@gmail.com', created_at: '2026-08-21T02:00:00.000Z' }),
    hire({ personal_email: 'old@gmail.com', created_at: '2026-08-07T02:00:00.000Z' }),
  ];
  const weeksByEmail = new Map<string, string[]>([
    ['now@gmail.com', [WEEK]],
    ['old@gmail.com', ['2026-08-09']],
    // 2026-08-16 exists on HR's checklist but staged nobody.
    ['listed-only@gmail.com', [PREV]],
  ]);
  const summary = buildOrientationWeeks({ hires, checklistWeeksByEmail: weeksByEmail });

  const prev = previousMeasuredWeek(summary, WEEK);
  assert.equal(prev?.weekStart, '2026-08-09', 'skips the week with no staged hires');
  assert.equal(previousMeasuredWeek(summary, '2026-08-09'), null);
});

test('buildStagedWeekIndex includes off-checklist hires', () => {
  // A hire on no checklist row lands in an off-checklist bucket. If the index
  // missed them, HR would be told a staged person was never staged.
  const off = hire({ personal_email: 'off@gmail.com' });
  const summary = buildOrientationWeeks({
    hires: [off],
    checklistWeeksByEmail: new Map(),
  });
  const index = buildStagedWeekIndex(summary);
  assert.equal(index.has('off@gmail.com'), true);

  const stats = buildHrOrientationWeekStats({
    weekStart: WEEK,
    listedRows: [listed({ personal_email: 'off@gmail.com' })],
    week: null,
    stagedWeekByEmail: index,
  });
  assert.equal(stats.notStaged.length, 0);
  assert.equal(stats.listedStagedElsewhere, 1);
});

test('email matching ignores case and surrounding space', () => {
  const h = hire({ personal_email: 'Mixed.Case@Gmail.com ' });
  const { stats } = measure(WEEK, [h], [listed({ personal_email: '  mixed.case@gmail.com' })]);
  assert.equal(stats.notStaged.length, 0);
  assert.equal(stats.listedStagedHere, 1);
});
