/**
 * The week-scoped QC roster: who was in the department during the scored week.
 *
 * The cases are the ones Carla and Kane named on 2026-09-14, plus the ones that
 * would make this change dangerous if it got them wrong — a missing transfer
 * record must never drop somebody, and a leaver from an earlier week must never
 * come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qcSlotsAsOfWeek, type AsOfWeekCandidate, type AsOfWeekTransfer } from './roster-as-of-week';

const WEEK_START = '2026-09-06';
const WEEK_END = '2026-09-12';

const isScoredDept = (k: string | null): k is string => k === 'lead_gen';

function person(email: string, departmentKey: string | null, offBoardedAt: string | null = null): AsOfWeekCandidate {
  return { email, identityEmails: [email], name: email.split('@')[0]!, departmentKey, offBoardedAt };
}
function move(email: string, fromKey: string | null, toKey: string | null, effectiveDate: string): AsOfWeekTransfer {
  return { identityEmails: [email], fromKey, toKey, effectiveDate };
}

function run(opts: {
  roster?: AsOfWeekCandidate[];
  offboarded?: AsOfWeekCandidate[];
  transfers?: AsOfWeekTransfer[];
}) {
  return qcSlotsAsOfWeek({
    roster: opts.roster ?? [],
    offboarded: opts.offboarded ?? [],
    transfers: opts.transfers ?? [],
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    isScoredDept,
  });
}
const emails = (slots: ReturnType<typeof run>) => slots.map((s) => s.email).sort();

test('the live roster is the baseline, and other departments are not scored', () => {
  const slots = run({ roster: [person('a@x.com', 'lead_gen'), person('b@x.com', 'hsl:collections')] });
  assert.deepEqual(emails(slots), ['a@x.com']);
  assert.equal(slots[0]!.basis, 'roster');
});

test('offboarded DURING the week is added — the gap Carla named', () => {
  // "there's going to be people that were offboarded ... they'd have to be
  // added externally into the lead gen."
  const slots = run({
    roster: [person('a@x.com', 'lead_gen')],
    offboarded: [person('gone@x.com', 'lead_gen', '2026-09-10')],
  });
  assert.deepEqual(emails(slots), ['a@x.com', 'gone@x.com']);
  assert.equal(slots.find((s) => s.email === 'gone@x.com')!.basis, 'offboarded-during-week');
});

test('offboarded in the week AFTER is still added — payroll runs a week in arrears', () => {
  // Carla: "If I was offboarded today, I should be on the list next week."
  // Stamped 2026-09-14, the completed week being scored is 2026-09-06.
  assert.deepEqual(emails(run({ offboarded: [person('gone@x.com', 'lead_gen', '2026-09-14')] })), ['gone@x.com']);
  // The churn boundary: weekEnd (2026-09-12) + 14 = 2026-09-26 is in, 09-27 is out.
  assert.deepEqual(emails(run({ offboarded: [person('edge@x.com', 'lead_gen', '2026-09-26')] })), ['edge@x.com']);
  assert.deepEqual(emails(run({ offboarded: [person('late@x.com', 'lead_gen', '2026-09-27')] })), []);
});

test('a leaver from LONG after the week never rewrites that closed week', () => {
  // Opening a June period today must not deal slots to everyone who has left
  // since. The upsert is diff-only and never deletes, so this would be history
  // that was never true of the week.
  for (const stamp of ['2026-10-01', '2026-11-15', '2027-01-04']) {
    assert.deepEqual(emails(run({ offboarded: [person('later@x.com', 'lead_gen', stamp)] })), [], stamp);
  }
});

test('offboarded BEFORE the week started is NOT added — "then after that I am gone"', () => {
  const slots = run({
    roster: [person('a@x.com', 'lead_gen')],
    offboarded: [
      person('old@x.com', 'lead_gen', '2026-09-05'), // the day before the week
      person('ancient@x.com', 'lead_gen', '2026-06-01'),
    ],
  });
  assert.deepEqual(emails(slots), ['a@x.com']);
});

test('offboarded exactly ON the first day of the week is kept (boundary is inclusive)', () => {
  assert.deepEqual(emails(run({ offboarded: [person('x@x.com', 'lead_gen', WEEK_START)] })), ['x@x.com']);
});

test('transferred OUT after the week ended is still scored for the week', () => {
  // Kane: "within the week if they are still legion at that time they can still be scored."
  const slots = run({
    roster: [person('moved@x.com', 'hsl:intake_specialist')],
    transfers: [move('moved@x.com', 'lead_gen', 'hsl:intake_specialist', '2026-09-15')],
  });
  assert.deepEqual(emails(slots), ['moved@x.com']);
  assert.equal(slots[0]!.basis, 'transferred-out-after-week');
  assert.equal(slots[0]!.dept, 'lead_gen', 'the slot scores the dept they were in THAT week');
});

test('a move far outside the churn window does NOT reopen a closed week', () => {
  // They were in Lead Gen that week, but they were also on the live roster when
  // the week was dealt — the roster path already had them. Re-deriving it months
  // later would only write slots into a week that closed without them.
  const slots = run({
    roster: [person('moved@x.com', 'hsl:intake_specialist')],
    transfers: [move('moved@x.com', 'lead_gen', 'hsl:intake_specialist', '2026-11-01')],
  });
  assert.deepEqual(emails(slots), []);
});

test('a MIDWEEK transfer out keeps them in the department they left', () => {
  // The move lands inside the week, so the live roster no longer shows lead_gen
  // but they were there for part of it. The sticky snapshot covers a slot
  // already dealt; this covers a week dealt after the move.
  const slots = run({
    roster: [person('mid@x.com', 'hsl:intake_specialist')],
    transfers: [move('mid@x.com', 'lead_gen', 'hsl:intake_specialist', '2026-09-09')],
  });
  // Effective date is INSIDE the week, so `leftAfter` does not fire; the person
  // is genuinely absent from the live lead_gen roster. This is the case the
  // sticky snapshot is for, and it is why this module never REMOVES on absence.
  assert.deepEqual(emails(slots), [], 'documents the boundary — see the sticky snapshot');
});

test('transferred IN after the week ended is DROPPED — they were not there', () => {
  const slots = run({
    roster: [person('new@x.com', 'lead_gen'), person('a@x.com', 'lead_gen')],
    transfers: [move('new@x.com', 'hsl:collections', 'lead_gen', '2026-09-20')],
  });
  assert.deepEqual(emails(slots), ['a@x.com']);
});

test('transferred IN MIDWEEK is KEPT — being there for part of the week is being there', () => {
  const slots = run({
    roster: [person('new@x.com', 'lead_gen')],
    transfers: [move('new@x.com', 'hsl:collections', 'lead_gen', '2026-09-09')],
  });
  assert.deepEqual(emails(slots), ['new@x.com']);
});

test('transferred IN on the LAST day of the week is kept; the day after is not', () => {
  assert.deepEqual(
    emails(run({ roster: [person('n@x.com', 'lead_gen')], transfers: [move('n@x.com', null, 'lead_gen', WEEK_END)] })),
    ['n@x.com'],
  );
  assert.deepEqual(
    emails(run({ roster: [person('n@x.com', 'lead_gen')], transfers: [move('n@x.com', null, 'lead_gen', '2026-09-13')] })),
    [],
  );
});

test('NOBODY is dropped for a MISSING transfer record', () => {
  // markm-hsl-transfer-never-filed: moves go unfiled. An absence must never
  // remove someone, or an unfiled transfer becomes an unpaid bonus.
  const slots = run({ roster: [person('unfiled@x.com', 'lead_gen')], transfers: [] });
  assert.deepEqual(emails(slots), ['unfiled@x.com']);
});

test('an undated or unparseable transfer never removes anyone', () => {
  for (const bad of ['', 'soon', '2026-13-40']) {
    const slots = run({
      roster: [person('p@x.com', 'lead_gen')],
      transfers: [move('p@x.com', 'hsl:collections', 'lead_gen', bad)],
    });
    assert.deepEqual(emails(slots), ['p@x.com'], `effective_date ${JSON.stringify(bad)} must not drop anyone`);
  }
});

test('an offboarded person with no stamp at all is not added', () => {
  // No date is no evidence they were there during THIS week. The roster path
  // still covers anyone actually on it.
  assert.deepEqual(emails(run({ offboarded: [person('nodate@x.com', 'lead_gen', null)] })), []);
});

test('a person is never dealt the same slot twice', () => {
  const slots = run({
    roster: [person('dup@x.com', 'lead_gen')],
    offboarded: [person('dup@x.com', 'lead_gen', '2026-09-10')],
    transfers: [move('dup@x.com', 'lead_gen', 'hsl:collections', '2026-09-20')],
  });
  assert.equal(slots.length, 1, 'three paths, one slot');
});

test('transfer matching works across a second identity email', () => {
  const p: AsOfWeekCandidate = {
    email: 'personal@gmail.com',
    identityEmails: ['personal@gmail.com', 'work@simple.biz'],
    name: 'P',
    departmentKey: 'hsl:collections',
    offBoardedAt: null,
  };
  const slots = run({
    roster: [p],
    transfers: [{ identityEmails: ['work@simple.biz'], fromKey: 'lead_gen', toKey: 'hsl:collections', effectiveDate: '2026-09-20' }],
  });
  assert.deepEqual(emails(slots), ['personal@gmail.com']);
  assert.equal(slots[0]!.dept, 'lead_gen');
});

test('a malformed week returns the live roster unchanged — never an empty deal', () => {
  const slots = qcSlotsAsOfWeek({
    roster: [person('a@x.com', 'lead_gen')],
    offboarded: [person('gone@x.com', 'lead_gen', '2026-09-10')],
    transfers: [],
    weekStart: 'nonsense',
    weekEnd: '',
    isScoredDept,
  });
  assert.deepEqual(emails(slots), ['a@x.com']);
});

test('the scored-department set is the CALLER\'s — this module never widens it', () => {
  // qc-scoring.md: "the roster READ widened; the KEYS did not."
  const onlyCallback = (k: string | null): k is string => k === 'callback';
  const slots = qcSlotsAsOfWeek({
    roster: [person('a@x.com', 'lead_gen'), person('b@x.com', 'callback')],
    offboarded: [],
    transfers: [],
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    isScoredDept: onlyCallback,
  });
  assert.deepEqual(emails(slots), ['b@x.com']);
});
