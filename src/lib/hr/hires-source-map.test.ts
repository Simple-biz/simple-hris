import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readHiresSourceConfig, type HiresSourceConfig } from './hires-source-config';
import {
  canonicalizeHireValues,
  contentHash,
  currentManilaSunday,
  decidePlacement,
  deferredToWeek,
  interviewCalendarDate,
  INTERVIEW_TIME_ZONE,
  mapSourceRow,
  mergeSourceIntoRow,
  sourceAheadOfApplied,
  sundayOfDate,
  targetWeekFor,
  type ChecklistIndexRow,
  type HireValues,
} from './hires-source-map';

const cfgResult = readHiresSourceConfig({
  HRIS_HIRES_SUPABASE_URL: 'https://hires-ref.supabase.co',
  HRIS_HIRES_SUPABASE_KEY: 'k',
  HRIS_HIRES_TABLE: 'hires',
});
assert.ok(cfgResult.ok);
const cfg = (cfgResult as { ok: true; config: HiresSourceConfig }).config;

/** Kane's two example rows (2026-10-08), as the source returns them. */
const LORAINE = {
  id: 'h-1',
  name: 'Loraine Aquino',
  personalEmail: 'Loraine.Aquino@example.com',
  location: 'Butuan, Caraga',
  phoneNumber: '+63 917 555 0142',
  dateOfInterview: '2026-08-14T07:30:00.000Z',
  hiringSource: 'Referral',
  referredBy: 'Reigner Kevin Barillo',
  hiredBy: 'Carla Mendoza',
  department: 'AI/API',
  country: 'Philippines',
};
const JOSEL = {
  id: 'h-2',
  name: 'Josel Manalo',
  personalEmail: 'josel.manalo@example.com',
  location: 'Cebu City, Central Visayas',
  phoneNumber: '+63 917 555 0198',
  dateOfInterview: '2026-08-20T02:00:00.000Z',
  hiringSource: 'Careers site',
  referredBy: null,
  hiredBy: 'Carla Mendoza',
  department: 'AI/API',
  country: 'Philippines',
};

function values(over: Partial<HireValues> = {}): HireValues {
  return {
    name: 'Ana Cruz',
    personal_email: 'ana@example.com',
    location: null,
    phone_number: null,
    date_of_interview: '2026-10-07',
    source: null,
    referred_by: null,
    hired_by: null,
    department: 'Lead Gen',
    country: 'Philippines',
    ...over,
  };
}

test('interview dates are US EASTERN calendar dates — the date HR writes (measured 20/23 vs Manila 11/23)', () => {
  assert.equal(INTERVIEW_TIME_ZONE, 'America/New_York');
  // Real portal times (13:00–18:30Z = 9 AM–2:30 PM New York). HR typed 2026-10-05
  // for this one; Manila would have said the 6th.
  assert.deepEqual(interviewCalendarDate('2026-10-05T18:00:00+00:00'), {
    date: '2026-10-05',
    at: '2026-10-05T18:00:00.000Z',
  });
  assert.equal(interviewCalendarDate('2026-09-24 14:00:00+00').date, '2026-09-24');
  assert.equal(interviewCalendarDate('2026-09-29T16:30:00Z').date, '2026-09-29');
  // Late evening New York is still that day (Manila is already tomorrow).
  assert.equal(interviewCalendarDate('2026-08-20T02:00:00.000Z').date, '2026-08-19');
  // DST: in November New York is UTC-5, so 04:00Z is 11 PM the day before.
  assert.equal(interviewCalendarDate('2026-12-01T04:00:00Z').date, '2026-11-30');
  assert.equal(interviewCalendarDate('2026-12-01T05:00:00Z').date, '2026-12-01');
});

test('a Saturday-afternoon New York interview stays in ITS week (Manila would push it a week late)', () => {
  const sat = interviewCalendarDate('2026-09-26T18:00:00Z').date!; // Sat 2 PM New York, Sun 2 AM Manila
  assert.equal(sat, '2026-09-26');
  assert.equal(targetWeekFor(sat), '2026-09-27');
});

test('a plain date is taken as written; M/D/YYYY is month-first; junk has no date', () => {
  assert.deepEqual(interviewCalendarDate('2026-09-18'), { date: '2026-09-18', at: null });
  assert.equal(interviewCalendarDate('6/4/2026').date, '2026-06-04');
  assert.equal(interviewCalendarDate('7/7/26').date, '2026-07-07');
  assert.equal(interviewCalendarDate('2/30/2026').date, null);
  assert.equal(interviewCalendarDate('next tuesday').date, null);
  assert.equal(interviewCalendarDate(null).date, null);
  assert.equal(interviewCalendarDate('   ').date, null);
});

test('target week = the Sunday AFTER the interview week (the measured 94% rule)', () => {
  assert.equal(sundayOfDate('2026-08-14'), '2026-08-09'); // Fri → its Sunday
  assert.equal(sundayOfDate('2026-08-09'), '2026-08-09'); // a Sunday is its own week
  assert.equal(targetWeekFor('2026-08-14'), '2026-08-16');
  assert.equal(targetWeekFor('2026-08-20'), '2026-08-23');
  assert.equal(targetWeekFor('2026-08-15'), '2026-08-16'); // Saturday → next day
  assert.equal(targetWeekFor('2026-08-16'), '2026-08-23'); // Sunday → a full week on
});

test('the current week is the Manila Sunday, not the server zone', () => {
  // Sat 2026-10-10 20:00Z is already Sun 2026-10-11 04:00 in Manila.
  assert.equal(currentManilaSunday(Date.parse('2026-10-10T20:00:00Z')), '2026-10-11');
  assert.equal(currentManilaSunday(Date.parse('2026-10-10T10:00:00Z')), '2026-10-04');
});

test("mapSourceRow maps Kane's columns, lower-cases the email, keeps a null referrer", () => {
  const m = mapSourceRow(LORAINE, cfg);
  assert.ok(m);
  assert.equal(m.sourceKey, 'h-1');
  assert.deepEqual(m.values, {
    name: 'Loraine Aquino',
    personal_email: 'loraine.aquino@example.com',
    location: 'Butuan, Caraga',
    phone_number: '+63 917 555 0142',
    date_of_interview: '2026-08-14',
    source: 'Referral',
    referred_by: 'Reigner Kevin Barillo',
    hired_by: 'Carla Mendoza',
    department: 'AI/API',
    country: 'Philippines',
  });
  assert.equal(m.interviewAt, '2026-08-14T07:30:00.000Z');
  assert.equal(mapSourceRow(JOSEL, cfg)!.values.referred_by, null);
});

test('a row with no id is never guessed at (cannot be de-duplicated)', () => {
  assert.equal(mapSourceRow({ ...LORAINE, id: null }, cfg), null);
  assert.equal(mapSourceRow({ ...LORAINE, id: '  ' }, cfg), null);
  assert.equal(mapSourceRow({ ...LORAINE, id: 42 }, cfg)!.sourceKey, '42');
});

test('an unparseable interview cell is kept as written', () => {
  const m = mapSourceRow({ ...LORAINE, dateOfInterview: 'Aug 14-ish' }, cfg)!;
  assert.equal(m.values.date_of_interview, 'Aug 14-ish');
  assert.equal(m.interviewAt, null);
});

test('content hash moves when any cell moves, and only then', () => {
  const a = contentHash(values());
  assert.equal(a, contentHash(values()));
  assert.notEqual(a, contentHash(values({ department: 'HSL' })));
  assert.notEqual(a, contentHash(values({ phone_number: '1' })));
});

test('canonicalize snaps department casing, country alias, source spelling; keeps the unknown', () => {
  const out = canonicalizeHireValues(
    values({ department: 'lead gen', country: 'USA', source: 'onlinejobs ph' }),
    { departments: ['Lead Gen', 'HSL'], sources: [] },
  );
  assert.equal(out.department, 'Lead Gen');
  assert.equal(out.country, 'United States');
  assert.equal(out.source, 'OnlineJobs.ph');
  const kept = canonicalizeHireValues(values({ department: 'AI/API', source: 'Careers site' }), {
    departments: ['Lead Gen'],
    sources: [],
  });
  assert.equal(kept.department, 'AI/API');
  assert.equal(kept.source, 'Careers site');
});

const CURRENT = '2026-10-04';
/** The default hire (interview 10-07) belongs on 10-11: the week after its interview week. */
const NEXT = '2026-10-11';
const open = () => false;

// Kane, 2026-10-08: "align the date of interview to the week selector … that we can only sync that data for that
// specific week period", ruled "(b) Only the week on screen". It REPLACED that day's "automatically added to this
// week" ("A"): a pass places a hire only into the week on the selector, and only when that is the hire's own week.

test('PLACE: a hire interviewed this week goes to next week, when next week is the one selected', () => {
  const d = decidePlacement({ values: values(), selectedWeek: NEXT, currentSunday: CURRENT, isWeekLocked: open, checklist: [] });
  assert.deepEqual(d, { kind: 'place', period: NEXT });
});

test('PLACE into the CURRENT week is allowed (interviewed last week, this week selected)', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: '2026-09-30' }),
    selectedWeek: CURRENT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'place', period: CURRENT });
});

test("DEFER: another week's hire is never placed (or linked) while a different week is on the selector", () => {
  const d = decidePlacement({ values: values(), selectedWeek: CURRENT, currentSunday: CURRENT, isWeekLocked: open, checklist: [] });
  assert.deepEqual(d, { kind: 'defer', period: NEXT });
  const typed = decidePlacement({
    values: values(),
    selectedWeek: '2026-10-18',
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [{ id: 'typed', period_start: CURRENT, personal_email: 'ana@example.com', name: 'Ana Cruz' }],
  });
  assert.deepEqual(typed, { kind: 'defer', period: NEXT }, 'decided when its own week is selected, not before');
  assert.equal(deferredToWeek('2026-10-07', CURRENT, CURRENT), NEXT);
  assert.equal(deferredToWeek('2026-10-07', NEXT, CURRENT), null, 'its own week is selected: this pass decides it');
  assert.equal(deferredToWeek('2026-08-14', CURRENT, CURRENT), null, 'a past week is decided (held), never waited for');
  assert.equal(deferredToWeek(null, CURRENT, CURRENT), null);
});

test('ONE WEEK: nothing is ever placed outside the selected week (every date × every selected week)', () => {
  for (let s = -3; s <= 5; s++) {
    const selected = new Date(Date.UTC(2026, 9, 4 + 7 * s)).toISOString().slice(0, 10);
    for (let i = -40; i <= 60; i++) {
      const date = new Date(Date.UTC(2026, 9, 4 + i)).toISOString().slice(0, 10);
      for (const locked of [(_week: string) => false, (_week: string) => true]) {
        const d = decidePlacement({
          values: values({ date_of_interview: date }),
          selectedWeek: selected,
          currentSunday: CURRENT,
          isWeekLocked: locked,
          checklist: [],
        });
        if (d.kind === 'place') {
          assert.equal(d.period, selected, `${date} placed on ${d.period} with ${selected} selected`);
          assert.equal(targetWeekFor(date), selected, 'only into its own week');
          assert.ok(selected >= CURRENT, 'never a past week');
          assert.equal(locked(selected), false, 'never a locked week');
        }
      }
    }
  }
});

test('HOLD: no usable interview date belongs to no week, so it waits for HR (never put in this week on its own)', () => {
  for (const date of [null, 'Aug 14-ish']) {
    for (const selectedWeek of [CURRENT, NEXT]) {
      const d = decidePlacement({
        values: values({ date_of_interview: date }),
        selectedWeek,
        currentSunday: CURRENT,
        isWeekLocked: open,
        checklist: [],
      });
      assert.deepEqual(d, { kind: 'hold', period: null, reason: 'no_interview_date' });
    }
  }
});

test('HOLD: an old interview (its week already past) is never written into any week on its own', () => {
  for (const selectedWeek of [CURRENT, '2026-08-16']) {
    const d = decidePlacement({
      values: values({ date_of_interview: '2026-08-14' }),
      selectedWeek, // even with its own (past) week on the selector
      currentSunday: CURRENT,
      isWeekLocked: open,
      checklist: [],
    });
    assert.deepEqual(d, { kind: 'hold', period: '2026-08-16', reason: 'past_week' });
  }
});

test('HOLD: its week selected but locked (the 2026-10-08 case) waits; it never walks to another week', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: '2026-09-30' }),
    selectedWeek: CURRENT,
    currentSunday: CURRENT,
    isWeekLocked: (p) => p === CURRENT,
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'hold', period: CURRENT, reason: 'week_locked' });
});

test('an UNDATED hire already typed in LINKS (measured 2026-10-08: all 10 undated portal hires were)', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: null }),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    // within 4 weeks of this week
    checklist: [{ id: 'typed', period_start: '2026-09-27', personal_email: 'ana@example.com', name: 'Ana Cruz' }],
  });
  assert.deepEqual(d, { kind: 'link', period: '2026-09-27', rowId: 'typed' });
});

const row = (over: Partial<ChecklistIndexRow>): ChecklistIndexRow => ({
  id: 'r1',
  period_start: '2026-10-11',
  personal_email: 'ana@example.com',
  name: 'Ana Cruz',
  ...over,
});

test('LINK: the same email already typed in, case-insensitive, beats every week check', () => {
  const d = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: () => true, // even a locked week: she IS on the checklist
    checklist: [row({ personal_email: 'ANA@example.com ' })],
  });
  assert.deepEqual(d, { kind: 'link', period: '2026-10-11', rowId: 'r1' });
});

test('LINK window: up to 4 weeks before the target week, or any week after', () => {
  const four = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'old', period_start: '2026-09-13' })],
  });
  assert.equal(four.kind, 'link');
  const five = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'older', period_start: '2026-09-06' })], // a re-hire, 5 weeks back
  });
  assert.deepEqual(five, { kind: 'place', period: '2026-10-11' });
  const later = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'later', period_start: '2026-10-25' })],
  });
  assert.deepEqual(later, { kind: 'link', period: '2026-10-25', rowId: 'later' });
});

test('LINK prefers the target week, then the latest', () => {
  const d = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [
      row({ id: 'a', period_start: '2026-10-04' }),
      row({ id: 'b', period_start: '2026-10-18' }),
      row({ id: 'target', period_start: '2026-10-11' }),
    ],
  });
  assert.equal(d.kind === 'link' && d.rowId, 'target');
  const noTarget = decidePlacement({
    values: values(),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'a', period_start: '2026-10-04' }), row({ id: 'b', period_start: '2026-10-18' })],
  });
  assert.equal(noTarget.kind === 'link' && noTarget.rowId, 'b');
});

test('with NO email, only the exact name in the target week links', () => {
  const v = values({ personal_email: null, name: '  ana   CRUZ ' });
  const hit = decidePlacement({ values: v, selectedWeek: NEXT, currentSunday: CURRENT, isWeekLocked: open, checklist: [row({})] });
  assert.equal(hit.kind, 'link');
  const otherWeek = decidePlacement({
    values: v,
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ period_start: '2026-10-04' })],
  });
  assert.equal(otherWeek.kind, 'place');
});

test('an email on the source never links by name alone (two people can share a name)', () => {
  const d = decidePlacement({
    values: values({ personal_email: 'other@example.com' }),
    selectedWeek: NEXT,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({})],
  });
  assert.equal(d.kind, 'place');
});

test('MERGE: fills a blank cell, and records it as the sync’s', () => {
  const r = mergeSourceIntoRow({
    current: { name: 'Ana Cruz', location: null },
    applied: null,
    incoming: values({ location: 'Cebu' }),
  });
  assert.equal(r.updates.location, 'Cebu');
  assert.equal(r.nextApplied.location, 'Cebu');
  assert.equal(r.updates.name, undefined, 'equal cells are not rewritten');
});

test('MERGE: never overwrites a cell HR typed (no applied value for it)', () => {
  const r = mergeSourceIntoRow({
    current: values({ department: 'Lead Gen' }),
    applied: null,
    incoming: values({ department: 'HSL' }),
  });
  assert.equal(r.updates.department, undefined);
});

test('MERGE: a source change reaches a cell the sync wrote and HR has not touched', () => {
  const r = mergeSourceIntoRow({
    current: values({ department: 'AI/API' }),
    applied: { department: 'AI/API' },
    incoming: values({ department: 'Lead Gen' }),
  });
  assert.equal(r.updates.department, 'Lead Gen');
  assert.equal(r.nextApplied.department, 'Lead Gen');
});

test('MERGE: once HR changes a synced cell, HR wins for good', () => {
  const r = mergeSourceIntoRow({
    current: values({ department: 'Lead Gen' }), // HR corrected it
    applied: { department: 'AI/API' }, // what the sync last wrote
    incoming: values({ department: 'Sales' }),
  });
  assert.equal(r.updates.department, undefined);
  assert.equal(r.nextApplied.department, 'AI/API');
});

test('MERGE: the sync never blanks a cell', () => {
  const r = mergeSourceIntoRow({
    current: values({ phone_number: '+63 917' }),
    applied: { phone_number: '+63 917' },
    incoming: values({ phone_number: null }),
  });
  assert.equal(r.updates.phone_number, undefined);
  assert.deepEqual(Object.keys(r.updates), []);
});

test('MERGE: a cell the sync filled and HR then CLEARED stays clear (HR wins for good; the week is merged every pass)', () => {
  const r = mergeSourceIntoRow({
    current: values({ location: null }), // HR cleared it
    applied: { location: 'Cebu' }, // what the sync wrote
    incoming: values({ location: 'Cebu' }),
  });
  assert.equal(r.updates.location, undefined);
  const moved = mergeSourceIntoRow({
    current: values({ location: null }),
    applied: { location: 'Cebu' },
    incoming: values({ location: 'Davao' }), // even when the source moves on
  });
  assert.equal(moved.updates.location, undefined);
});

test('SOURCE AHEAD: only a value the sync has not applied yet asks for a merge', () => {
  const v = values({ location: 'Cebu', department: 'Lead Gen' });
  const applied = { name: 'Ana Cruz', personal_email: 'ana@example.com', date_of_interview: '2026-10-07', department: 'Lead Gen', country: 'Philippines', location: 'Cebu' };
  assert.equal(sourceAheadOfApplied(v, applied), false, 'everything applied: no read, no write');
  assert.equal(sourceAheadOfApplied(values({ location: 'Davao', department: 'Lead Gen' }), applied), true, 'the source moved');
  assert.equal(sourceAheadOfApplied(values({ location: null, department: 'Lead Gen' }), applied), false, 'a value removed at the source never asks (the sync never blanks)');
  assert.equal(sourceAheadOfApplied(v, null), true, 'a linked row the sync never wrote');
});
