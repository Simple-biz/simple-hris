/**
 * buildOrientationWeeks — the weekly attendance model behind Manager → My Team →
 * New Hire Check List.
 *
 * The two properties pinned here are the ones live data proved you cannot guess:
 *
 *  - Attendance is decided by the `orientation_attended_at` STAMP. Prod row 717
 *    carries both that stamp and `no_show_at`; prod row 1034 carries `no_show_at`
 *    with `status='ready'`. Any status- or no_show_at-based rule mis-files both.
 *  - The week is HR's `hr_new_hire_checklist.period_start`, joined on
 *    personal_email — NOT the hire's own dates. `start_date` is null on 973 of
 *    974 prod rows, so a date-derived key degrades to `created_at` (when HR
 *    staged them, usually the Fri/Sat BEFORE their week) and mis-files 46% of
 *    hires by exactly one week.
 *
 * Run:  npx tsx --test src/lib/manager/orientation-weekly.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrientationWeeks,
  pickChecklistWeek,
  attendanceRate,
  UNDATED_WEEK,
  type OrientationHire,
} from './orientation-weekly';

let nextId = 1;

function hire(over: Partial<OrientationHire> = {}): OrientationHire {
  return {
    id: nextId++,
    name: 'Test Hire',
    personal_email: `hire${nextId}@gmail.com`,
    work_email: null,
    department: 'Lead Gen',
    job_description: null,
    created_at: '2026-08-21T02:00:00.000Z',
    start_date: null,
    status: 'promoted',
    source: 'onboarding_form',
    orientation_attended_at: '2026-08-24T00:00:00.000Z',
    orientation_attended_by: 'manager@simple.biz',
    orientation_note: null,
    no_show_at: null,
    no_show_by: null,
    no_show_note: null,
    ...over,
  };
}

function weeks(pairs: Array<[string, string[]]>): Map<string, string[]> {
  return new Map(pairs);
}

// ── Rule 1: the attended stamp decides ──────────────────────────────────────

test('a row carrying BOTH stamps counts as attended (prod id 717)', () => {
  const h = hire({
    personal_email: 'both@gmail.com',
    status: 'no_show',
    orientation_attended_at: '2026-08-24T00:00:00.000Z',
    no_show_at: '2026-08-23T00:00:00.000Z',
  });
  const out = buildOrientationWeeks({
    hires: [h],
    checklistWeeksByEmail: weeks([['both@gmail.com', ['2026-08-23']]]),
  });
  assert.equal(out.weeks[0]!.attended, 1);
  assert.equal(out.weeks[0]!.notAttended, 0);
  assert.equal(out.weeks[0]!.noShow, 0, 'status=no_show must not override the attended stamp');
});

test('no_show_at with status=ready and no attended stamp is NOT attended (prod id 1034)', () => {
  const h = hire({
    personal_email: 'reverted@gmail.com',
    status: 'ready',
    orientation_attended_at: null,
    no_show_at: '2026-08-22T00:00:00.000Z',
  });
  const out = buildOrientationWeeks({
    hires: [h],
    checklistWeeksByEmail: weeks([['reverted@gmail.com', ['2026-08-23']]]),
  });
  const w = out.weeks[0]!;
  assert.equal(w.notAttended, 1);
  assert.equal(w.stillOpen, 1, 'a reverted no-show is still open, not a no-show');
  assert.equal(w.noShow, 0);
});

test('an offboarded no-show is counted as notAttended AND noShow', () => {
  const out = buildOrientationWeeks({
    hires: [hire({ personal_email: 'ns@gmail.com', status: 'no_show', orientation_attended_at: null, no_show_at: '2026-08-22T00:00:00.000Z' })],
    checklistWeeksByEmail: weeks([['ns@gmail.com', ['2026-08-23']]]),
  });
  const w = out.weeks[0]!;
  assert.equal(w.notAttended, 1);
  assert.equal(w.noShow, 1);
  assert.equal(w.stillOpen, 0);
});

// ── Rule 2: the week is HR's, not the hire's dates ──────────────────────────

test("HR's checklist week wins over the week derived from created_at", () => {
  // Staged Sat 2026-07-25 -> derived week 2026-07-19. HR listed them for 07-26.
  const h = hire({ personal_email: 'candy@gmail.com', created_at: '2026-07-25T09:00:00.000Z' });
  const out = buildOrientationWeeks({
    hires: [h],
    checklistWeeksByEmail: weeks([['candy@gmail.com', ['2026-07-26']]]),
  });
  assert.equal(out.weeks.length, 1);
  assert.equal(out.weeks[0]!.weekStart, '2026-07-26');
  assert.equal(out.weeks[0]!.onChecklist, true);
});

test('email match is case- and whitespace-insensitive', () => {
  const h = hire({ personal_email: '  Candy@Gmail.COM ' });
  const out = buildOrientationWeeks({
    hires: [h],
    checklistWeeksByEmail: weeks([['candy@gmail.com', ['2026-07-26']]]),
  });
  assert.equal(out.weeks[0]!.weekStart, '2026-07-26');
  assert.equal(out.totals.unmatched, 0);
});

// ── The multi-week tie-break ────────────────────────────────────────────────

test('a re-listed hire lands on the upcoming week, not their first listing', () => {
  // Anchor week for created_at 2026-08-21 is 2026-08-16.
  const picked = pickChecklistWeek(
    'rehire@gmail.com',
    '2026-08-21T00:00:00.000Z',
    weeks([['rehire@gmail.com', ['2026-06-21', '2026-08-23']]]),
  );
  assert.equal(picked, '2026-08-23');
});

test('when every listing predates the anchor, the nearest one behind wins', () => {
  const picked = pickChecklistWeek(
    'old@gmail.com',
    '2026-08-21T00:00:00.000Z',
    weeks([['old@gmail.com', ['2026-06-21', '2026-08-02']]]),
  );
  assert.equal(picked, '2026-08-02');
});

test('at equal distance the week at-or-after the anchor wins', () => {
  // Anchor 2026-08-16; candidates are exactly 7 days either side.
  const picked = pickChecklistWeek(
    'tie@gmail.com',
    '2026-08-21T00:00:00.000Z',
    weeks([['tie@gmail.com', ['2026-08-09', '2026-08-23']]]),
  );
  assert.equal(picked, '2026-08-23');
});

test('an unparsable created_at falls back to the latest listing rather than throwing', () => {
  const picked = pickChecklistWeek(
    'bad@gmail.com',
    'not-a-date',
    weeks([['bad@gmail.com', ['2026-06-21', '2026-08-23']]]),
  );
  assert.equal(picked, '2026-08-23');
});

// ── The labelled fallback: nobody is dropped, nobody is folded in ───────────

test('a hire on no checklist row is bucketed OFF-checklist, never into a real week', () => {
  const matched = hire({ personal_email: 'on@gmail.com', created_at: '2026-08-21T00:00:00.000Z' });
  const orphan = hire({ personal_email: 'off@gmail.com', created_at: '2026-08-21T00:00:00.000Z' });
  const out = buildOrientationWeeks({
    hires: [matched, orphan],
    checklistWeeksByEmail: weeks([['on@gmail.com', ['2026-08-16']]]),
  });

  assert.equal(out.weeks.length, 1);
  assert.equal(out.weeks[0]!.total, 1, 'the orphan must not inflate the real HR week');
  assert.equal(out.offChecklist.length, 1);
  assert.equal(out.offChecklist[0]!.onChecklist, false);
  assert.equal(out.offChecklist[0]!.weekStart, '2026-08-16', 'falls back to its own derived week');
  assert.equal(out.totals.unmatched, 1);
  assert.equal(out.totals.total, 2, 'both are still COUNTED');
});

test('an unmatched hire with an unparsable created_at is still counted, in UNDATED', () => {
  const out = buildOrientationWeeks({
    hires: [hire({ personal_email: 'x@gmail.com', created_at: '' })],
    checklistWeeksByEmail: new Map(),
  });
  assert.equal(out.offChecklist[0]!.weekStart, UNDATED_WEEK);
  assert.equal(out.totals.total, 1, 'a row that cannot be placed must still be counted');
});

test('negative control: an empty checklist map drops nobody', () => {
  const hires = [hire(), hire(), hire()];
  const out = buildOrientationWeeks({ hires, checklistWeeksByEmail: new Map() });
  assert.equal(out.weeks.length, 0);
  assert.equal(out.totals.total, 3);
  assert.equal(out.totals.unmatched, 3);
});

test('a hire with a blank personal_email is unmatched, not crashed on', () => {
  const out = buildOrientationWeeks({
    hires: [hire({ personal_email: null })],
    checklistWeeksByEmail: weeks([['', ['2026-08-16']]]),
  });
  assert.equal(out.totals.unmatched, 1);
  assert.equal(out.totals.total, 1);
});

// ── Totals + the denominator ───────────────────────────────────────────────

test('totals reconcile and off-checklist people are included in them', () => {
  const out = buildOrientationWeeks({
    hires: [
      hire({ personal_email: 'a@gmail.com' }),
      hire({ personal_email: 'b@gmail.com', orientation_attended_at: null, status: 'no_show', no_show_at: '2026-08-22T00:00:00.000Z' }),
      hire({ personal_email: 'c@gmail.com', orientation_attended_at: null, status: 'ready' }),
      hire({ personal_email: 'orphan@gmail.com', orientation_attended_at: null, status: 'ready' }),
    ],
    checklistWeeksByEmail: weeks([
      ['a@gmail.com', ['2026-08-16']],
      ['b@gmail.com', ['2026-08-16']],
      ['c@gmail.com', ['2026-08-16']],
    ]),
  });
  const t = out.totals;
  assert.equal(t.total, 4);
  assert.equal(t.attended, 1);
  assert.equal(t.notAttended, 3);
  assert.equal(t.attended + t.notAttended, t.total, 'attended + notAttended must equal total');
  assert.equal(t.noShow + t.stillOpen, t.notAttended, 'the sub-labels must partition notAttended');
  assert.equal(t.unmatched, 1);
});

test('the rate denominator is TOTAL — an unmarked hire counts against the week', () => {
  assert.equal(attendanceRate({ total: 4, attended: 3 }), 75);
  assert.equal(attendanceRate({ total: 0, attended: 0 }), null);
});

test('weeks come back newest first', () => {
  const out = buildOrientationWeeks({
    hires: [
      hire({ personal_email: 'old@gmail.com' }),
      hire({ personal_email: 'new@gmail.com' }),
      hire({ personal_email: 'mid@gmail.com' }),
    ],
    checklistWeeksByEmail: weeks([
      ['old@gmail.com', ['2026-06-07']],
      ['new@gmail.com', ['2026-08-23']],
      ['mid@gmail.com', ['2026-07-12']],
    ]),
  });
  assert.deepEqual(out.weeks.map((w) => w.weekStart), ['2026-08-23', '2026-07-12', '2026-06-07']);
});
