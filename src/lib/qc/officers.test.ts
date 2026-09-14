import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  QC_OFFICER_DEPT_KEY,
  officerKey,
  officersFromRoster,
  freezeOfficers,
  currentDeptByEmail,
  classifySlot,
  type QcRosterPerson,
} from './officers';

const person = (
  work: string | null,
  department: string | null,
  personal: string | null = null,
): QcRosterPerson => ({ work_email: work, personal_email: personal, department });

/** The live shape, measured 2026-09-14: 9 people in the QC department, and
 *  jeromer@ holding the `qc` ROLE from Callback Team while dealt 34 Lead Gen slots. */
const LIVE = [
  person('perryb@simple.biz', 'QC'),
  person('ivyd@simple.biz', 'QC'),
  person('samb@simple.biz', 'QC'),
  person('jeromer@simple.biz', 'Callback Team'),
  person('someone@simple.biz', 'Lead Gen'),
  person('hsl1@simple.biz', 'hsl:intake_specialist'),
];

test('officers are the QC department, not an admin grant', () => {
  assert.deepEqual(officersFromRoster(LIVE), [
    'ivyd@simple.biz',
    'perryb@simple.biz',
    'samb@simple.biz',
  ]);
});

test('the Jerome case: a former QC person is no longer an officer', () => {
  // He holds the `qc` role and 34 Lead Gen slots; his department is Callback Team.
  // Deriving from the roster is the whole point of the change.
  assert.ok(!officersFromRoster(LIVE).includes('jeromer@simple.biz'));
});

test('a Lead Gen person is never enrolled as an officer', () => {
  // QC_OFFICER_DEPT_KEY is where scorers sit; QC_DEPT_KEYS is who gets scored.
  // Conflating them would have officers scoring themselves.
  assert.ok(!officersFromRoster(LIVE).includes('someone@simple.biz'));
  assert.equal(QC_OFFICER_DEPT_KEY, 'qc');
});

test('officer order is deterministic — the seeded deal depends on it', () => {
  const shuffled = [...LIVE].reverse();
  assert.deepEqual(officersFromRoster(LIVE), officersFromRoster(shuffled));
});

test('department label variants resolve to the same officer set', () => {
  assert.deepEqual(
    officersFromRoster([person('a@x.com', 'QC')]),
    officersFromRoster([person('a@x.com', 'Quality Control')]),
  );
});

test('officerKey prefers the work email, falls back to personal', () => {
  assert.equal(officerKey(person('w@x.com', 'QC', 'p@x.com')), 'w@x.com');
  assert.equal(officerKey(person(null, 'QC', 'p@x.com')), 'p@x.com');
  assert.equal(officerKey(person('  W@X.COM ', 'QC')), 'w@x.com');
});

test('a person with no email at all is not an officer', () => {
  assert.deepEqual(officersFromRoster([person(null, 'QC', null)]), []);
});

test('an empty QC department yields no officers rather than everyone', () => {
  // Fail closed: the caller already surfaces existing rows when officers is empty.
  assert.deepEqual(officersFromRoster([person('a@x.com', 'Lead Gen')]), []);
});

// ── the freeze ──────────────────────────────────────────────────────────────────

test('a dealt week is FROZEN to the officers already on its slots', () => {
  const { officers, frozen } = freezeOfficers(['a@x.com', 'b@x.com'], ['b@x.com', 'c@x.com']);
  assert.equal(frozen, true);
  assert.deepEqual(officers, ['a@x.com', 'b@x.com']);
});

test('an undealt week uses the live officer set', () => {
  const { officers, frozen } = freezeOfficers([], ['b@x.com', 'c@x.com']);
  assert.equal(frozen, false);
  assert.deepEqual(officers, ['b@x.com', 'c@x.com']);
});

test('roster churn cannot re-deal a week in progress', () => {
  // The guard that makes a roster-derived officer list safe. A transfer, an offboard
  // or a master-sheet clobber changes the live set; a week already dealt must not move.
  const dealt = ['a@x.com', 'b@x.com', 'c@x.com'];
  for (const churn of [[], ['a@x.com'], ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']]) {
    assert.deepEqual(freezeOfficers(dealt, churn).officers, dealt);
  }
});

test('the freeze normalises and dedupes what it reads back off the slots', () => {
  const { officers } = freezeOfficers([' A@X.com ', 'a@x.com', 'b@x.com', ''], []);
  assert.deepEqual(officers, ['a@x.com', 'b@x.com']);
});

// ── current department + classification ─────────────────────────────────────────

test('currentDeptByEmail sees departments OUTSIDE the scored set', () => {
  // The narrowing this replaces is exactly why `transferred` was unreachable.
  const map = currentDeptByEmail(LIVE);
  assert.equal(map.get('hsl1@simple.biz'), 'hogan_smith_law');
  assert.equal(map.get('jeromer@simple.biz'), 'callback');
});

test('currentDeptByEmail indexes both emails', () => {
  const map = currentDeptByEmail([person('w@x.com', 'QC', 'p@x.com')]);
  assert.equal(map.get('w@x.com'), 'qc');
  assert.equal(map.get('p@x.com'), 'qc');
});

test('a live slot is active and keeps its own department', () => {
  const c = classifySlot(true, 'lead_gen', 'lead_gen');
  assert.deepEqual(c, { status: 'active', currentDepartment: 'lead_gen' });
});

test('the midweek transfer Kane described: Lead Gen Monday, HSL Tuesday', () => {
  // Previously impossible — this read as `removed` with a null department, which is
  // also what quitting looks like, and left the "Transferred to <Dept>" sticker with
  // nothing to render.
  const c = classifySlot(false, 'lead_gen', 'hogan_smith_law');
  assert.equal(c.status, 'transferred');
  assert.equal(c.currentDepartment, 'hogan_smith_law');
});

test('someone who left the company is removed, not transferred', () => {
  const c = classifySlot(false, 'lead_gen', null);
  assert.deepEqual(c, { status: 'removed', currentDepartment: null });
});

test('transferred and removed are distinguishable — the whole point', () => {
  const moved = classifySlot(false, 'lead_gen', 'qc');
  const quit = classifySlot(false, 'lead_gen', null);
  assert.notEqual(moved.status, quit.status);
  assert.ok(moved.currentDepartment);
  assert.equal(quit.currentDepartment, null);
});

test('a blank current department is treated as gone, never as a transfer to nowhere', () => {
  for (const blank of ['', '   ', null, undefined]) {
    assert.equal(classifySlot(false, 'lead_gen', blank).status, 'removed');
  }
});

test('the officer list is never filtered by roster_status — leavers stay scorable', () => {
  // Kane, 2026-09-14: "we still need to score people who quit by the way like
  // offboarded people." Status labels a person; it must never gate whether they can
  // be scored for work they already did. The control is that `myRows` — the officer's
  // own slots — filters on officer email and nothing else, so this source-scans it
  // rather than asserting a tautology about the union type.
  const src = readFileSync(
    join(process.cwd(), 'app/api/qc/assignments/route.ts'),
    'utf8',
  );
  const myRows = src.split('\n').find((l) => l.includes('const myRows'));
  assert.ok(myRows, 'myRows must still exist in the assignments route');
  assert.ok(
    !/roster_status/.test(myRows),
    `the officer's slot list must not filter on roster_status — found: ${myRows.trim()}`,
  );
});
