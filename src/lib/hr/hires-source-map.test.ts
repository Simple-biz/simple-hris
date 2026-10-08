import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { readHiresSourceConfig, type HiresSourceConfig } from './hires-source-config';
import {
  canonicalizeHireValues,
  contentHash,
  currentManilaSunday,
  decidePlacement,
  FALLBACK_WEEKS_AHEAD,
  interviewCalendarDate,
  INTERVIEW_TIME_ZONE,
  mapSourceRow,
  mergeSourceIntoRow,
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
const open = () => false;

test('PLACE: a fresh hire interviewed this week goes to next week', () => {
  const d = decidePlacement({ values: values(), currentSunday: CURRENT, isWeekLocked: open, checklist: [] });
  assert.deepEqual(d, { kind: 'place', period: '2026-10-11', fallback: null });
});

test('PLACE into the CURRENT week is allowed (interviewed last week)', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: '2026-09-30' }),
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'place', period: '2026-10-04', fallback: null });
});

// Kane, 2026-10-08: "Lets make this automatically added to this week", then "A":
// the unusable-week cases go to THIS week, else the next open one — never a locked
// week, never a past week.

test('THIS WEEK: an old interview (target week already past) goes to this week, never the past week', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: '2026-08-14' }),
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'place', period: CURRENT, fallback: 'past_week' });
});

test('THIS WEEK: no usable interview date goes to this week', () => {
  for (const date of [null, 'Aug 14-ish']) {
    const d = decidePlacement({
      values: values({ date_of_interview: date }),
      currentSunday: CURRENT,
      isWeekLocked: open,
      checklist: [],
    });
    assert.deepEqual(d, { kind: 'place', period: CURRENT, fallback: 'no_interview_date' });
  }
});

test('NEXT OPEN WEEK: this week locked (the 2026-10-08 case) → the first open week after it', () => {
  const locked = new Set(['2026-10-04']);
  for (const date of [null, '2026-08-14']) {
    const d = decidePlacement({
      values: values({ date_of_interview: date }),
      currentSunday: CURRENT,
      isWeekLocked: (p) => locked.has(p),
      checklist: [],
    });
    assert.equal(d.kind === 'place' && d.period, '2026-10-11');
  }
  // Interviewed last week → target = this week, which is locked → next week.
  const t = decidePlacement({
    values: values({ date_of_interview: '2026-09-30' }),
    currentSunday: CURRENT,
    isWeekLocked: (p) => locked.has(p),
    checklist: [],
  });
  assert.deepEqual(t, { kind: 'place', period: '2026-10-11', fallback: 'week_locked' });
});

test('a LOCKED FUTURE target walks forward from AFTER the target — never earlier than the interview week', () => {
  const d = decidePlacement({
    values: values(), // interview 10-07 → target 10-11
    currentSunday: CURRENT, // this week (10-04) is OPEN, but it is before the target
    isWeekLocked: (p) => p === '2026-10-11',
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'place', period: '2026-10-18', fallback: 'week_locked' });
});

test('HOLD only when every week in the window is locked — a locked week is never written', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: null }),
    currentSunday: CURRENT,
    isWeekLocked: () => true,
    checklist: [],
  });
  assert.deepEqual(d, { kind: 'hold', period: CURRENT, reason: 'week_locked' });
  // The walk is bounded: 8 weeks, then hold.
  const seen: string[] = [];
  decidePlacement({
    values: values({ date_of_interview: null }),
    currentSunday: CURRENT,
    isWeekLocked: (p) => (seen.push(p), true),
    checklist: [],
  });
  assert.equal(seen.length, FALLBACK_WEEKS_AHEAD);
});

test('an UNDATED hire already typed in LINKS (measured 2026-10-08: all 10 undated portal hires were)', () => {
  const d = decidePlacement({
    values: values({ date_of_interview: null }),
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
    currentSunday: CURRENT,
    isWeekLocked: () => true, // even a locked week: she IS on the checklist
    checklist: [row({ personal_email: 'ANA@example.com ' })],
  });
  assert.deepEqual(d, { kind: 'link', period: '2026-10-11', rowId: 'r1' });
});

test('LINK window: up to 4 weeks before the target week, or any week after', () => {
  const four = decidePlacement({
    values: values(),
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'old', period_start: '2026-09-13' })],
  });
  assert.equal(four.kind, 'link');
  const five = decidePlacement({
    values: values(),
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'older', period_start: '2026-09-06' })], // a re-hire, 5 weeks back
  });
  assert.deepEqual(five, { kind: 'place', period: '2026-10-11', fallback: null });
  const later = decidePlacement({
    values: values(),
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'later', period_start: '2026-10-25' })],
  });
  assert.deepEqual(later, { kind: 'link', period: '2026-10-25', rowId: 'later' });
});

test('LINK prefers the target week, then the latest', () => {
  const d = decidePlacement({
    values: values(),
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
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ id: 'a', period_start: '2026-10-04' }), row({ id: 'b', period_start: '2026-10-18' })],
  });
  assert.equal(noTarget.kind === 'link' && noTarget.rowId, 'b');
});

test('with NO email, only the exact name in the target week links', () => {
  const v = values({ personal_email: null, name: '  ana   CRUZ ' });
  const hit = decidePlacement({ values: v, currentSunday: CURRENT, isWeekLocked: open, checklist: [row({})] });
  assert.equal(hit.kind, 'link');
  const otherWeek = decidePlacement({
    values: v,
    currentSunday: CURRENT,
    isWeekLocked: open,
    checklist: [row({ period_start: '2026-10-04' })],
  });
  assert.equal(otherWeek.kind, 'place');
});

test('an email on the source never links by name alone (two people can share a name)', () => {
  const d = decidePlacement({
    values: values({ personal_email: 'other@example.com' }),
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
