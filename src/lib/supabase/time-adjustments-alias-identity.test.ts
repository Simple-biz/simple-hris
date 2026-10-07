/**
 * Time adjustments — a request filed under an ALTERNATE work email.
 *
 * 2026-10-07: both open requests were filed under alternates (chariseg@ → roster
 * chag@, shaylae@ → shaie@, Accounting Team). The team resolver matched the
 * primary "Work Email" column only, so it resolved nobody: the second-approver
 * picker came back empty, every manager decision was refused as "not in your
 * managed departments", and a non-elevated manager never saw the rows at all.
 * Fixing the team alone would have opened a worse hole — the pool excluded only
 * the filed address, so chag@ (Charise's own primary) would have been offered as
 * her countersigner.
 *
 * These pin the identity rule (`pickRosterIdentity`), the self-review rule over a
 * person's full address set (`reviewerIsFiler`), and — by source scan, there being
 * no Supabase or React in tests — that every reviewing path uses them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  pickRosterIdentity,
  reviewerIsFiler,
  selectTeamApproverCandidates,
} from './time-adjustments';

const ROSTER = [
  { department: 'Accounting Team', work_email: 'chag@simple.biz', alternate_work_email: 'chariseg@simple.biz' },
  { department: 'Accounting Team', work_email: 'shaie@simple.biz', alternate_work_email: 'shaylae@simple.biz' },
  { department: 'Accounting Team', work_email: 'juliar@simple.biz' },
  { department: 'Edit Team', work_email: 'ana@simple.biz', alternate_work_email_2: 'ana.r@simple.biz' },
];

// ─── pickRosterIdentity ─────────────────────────────────────────────────────

test('a request filed under an alternate resolves to that person’s team and every address', () => {
  assert.deepEqual(pickRosterIdentity(ROSTER, 'chariseg@simple.biz'), {
    department: 'Accounting Team',
    emails: ['chag@simple.biz', 'chariseg@simple.biz'],
  });
});

test('the second alternate column resolves too', () => {
  assert.equal(pickRosterIdentity(ROSTER, 'ana.r@simple.biz')?.department, 'Edit Team');
});

test('a primary address resolves exactly as it did before', () => {
  assert.deepEqual(pickRosterIdentity(ROSTER, 'juliar@simple.biz'), {
    department: 'Accounting Team',
    emails: ['juliar@simple.biz'],
  });
});

test('case and whitespace are not a second person', () => {
  assert.equal(pickRosterIdentity(ROSTER, '  ChariseG@Simple.biz ')?.department, 'Accounting Team');
});

test('an address nobody on the roster uses resolves to nobody — never to a guess', () => {
  assert.equal(pickRosterIdentity(ROSTER, 'stranger@simple.biz'), null);
  assert.equal(pickRosterIdentity(ROSTER, ''), null);
  assert.equal(pickRosterIdentity(ROSTER, null), null);
});

test('a PRIMARY match wins over another person’s alternate (a recycled address)', () => {
  const rows = [
    { department: 'Edit Team', work_email: 'sam@simple.biz' },
    { department: 'Sales', work_email: 'samuel@simple.biz', alternate_work_email: 'sam@simple.biz' },
  ];
  assert.deepEqual(pickRosterIdentity(rows, 'sam@simple.biz'), {
    department: 'Edit Team',
    emails: ['sam@simple.biz'],
  });
});

test('an alternate on two DIFFERENT people is ambiguity: nobody, never a union of both', () => {
  const rows = [
    { department: 'Accounting Team', work_email: 'one@simple.biz', alternate_work_email: 'shared@simple.biz' },
    { department: 'Accounting Team', work_email: 'two@simple.biz', alternate_work_email_2: 'shared@simple.biz' },
  ];
  assert.equal(pickRosterIdentity(rows, 'shared@simple.biz'), null);
});

test('duplicate rows of ONE person union their addresses; a team disagreement is no team', () => {
  const agree = [
    { department: 'Accounting Team', work_email: 'dup@simple.biz', alternate_work_email: 'dup.a@simple.biz' },
    { department: 'accounting team', work_email: 'dup@simple.biz', alternate_work_email_2: 'dup.b@simple.biz' },
  ];
  const resolved = pickRosterIdentity(agree, 'dup@simple.biz');
  assert.ok(resolved?.department);
  assert.deepEqual(resolved?.emails, ['dup.a@simple.biz', 'dup.b@simple.biz', 'dup@simple.biz']);

  const disagree = [
    { department: 'Accounting Team', work_email: 'dup@simple.biz' },
    { department: 'Edit Team', work_email: 'dup@simple.biz' },
  ];
  assert.equal(pickRosterIdentity(disagree, 'dup@simple.biz')?.department, null);
});

test('a blank department resolves the person but no team, which every caller refuses on', () => {
  const rows = [{ department: '  ', work_email: 'nodept@simple.biz', alternate_work_email: 'nd@simple.biz' }];
  assert.deepEqual(pickRosterIdentity(rows, 'nd@simple.biz'), {
    department: null,
    emails: ['nd@simple.biz', 'nodept@simple.biz'],
  });
});

test('the Sales / Sales-Assistant split applies to a filer resolved through an alternate', () => {
  const rows = [{ department: 'Sales', work_email: 'mar@simple.biz', alternate_work_email: 'marionne@simple.biz' }];
  assert.equal(pickRosterIdentity(rows, 'marionne@simple.biz')?.department, 'Sales Assistant');
});

// ─── The pool excludes EVERY address of the filer ───────────────────────────

test('the filer’s own primary is not offered as their countersigner', () => {
  const filer = pickRosterIdentity(ROSTER, 'chariseg@simple.biz');
  assert.ok(filer);
  const pool = selectTeamApproverCandidates(ROSTER, {
    department: filer.department ?? '',
    exclude: [...filer.emails, 'kaner@simple.biz'],
  });
  assert.deepEqual(pool, ['juliar@simple.biz', 'shaie@simple.biz']);
});

test('…which is exactly what excluding only the filed address got wrong', () => {
  const pool = selectTeamApproverCandidates(ROSTER, {
    department: 'Accounting Team',
    exclude: ['chariseg@simple.biz'],
  });
  assert.ok(pool.includes('chag@simple.biz'), 'the pre-fix exclusion let the filer through');
});

// ─── reviewerIsFiler over a person's full address set ──────────────────────

test('the filer reviewing under their PRIMARY a request filed under an alternate is refused', () => {
  assert.equal(reviewerIsFiler('chag@simple.biz', ['chag@simple.biz', 'chariseg@simple.biz']), true);
  assert.equal(reviewerIsFiler(' ChariseG@simple.biz', ['chag@simple.biz', 'chariseg@simple.biz']), true);
});

test('somebody else still passes against a full address set', () => {
  assert.equal(reviewerIsFiler('shaie@simple.biz', ['chag@simple.biz', 'chariseg@simple.biz']), false);
});

test('an empty set or blank entries never match — a missing address is not a self-review', () => {
  assert.equal(reviewerIsFiler('chag@simple.biz', []), false);
  assert.equal(reviewerIsFiler('chag@simple.biz', ['', null, undefined]), false);
  assert.equal(reviewerIsFiler('', ['chag@simple.biz']), false);
});

// ─── Every path uses the resolved set (source scan) ─────────────────────────

const libSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'supabase', 'time-adjustments.ts'), 'utf8');
const body = (name: string): string => {
  const start = libSrc.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = libSrc.indexOf('\nexport ', start + 1);
  return libSrc.slice(start, next < 0 ? undefined : next);
};

test('no reviewing path compares against the filed address alone', () => {
  assert.ok(!/reviewerIsFiler\([^)]*row\.work_email/.test(libSrc), 'a path still passes row.work_email');
  for (const fn of [
    'assignSecondApprover',
    'managerDecideTimeAdjustment',
    'secondDecideTimeAdjustment',
    'decideTimeAdjustment',
  ]) {
    assert.ok(body(fn).includes('reviewerIsFiler('), `${fn} does not check reviewer ≠ filer`);
    assert.ok(body(fn).includes('resolveAdjustmentFiler('), `${fn} does not resolve the filer’s addresses`);
  }
});

test('the pool and every manager-scoped write resolve the team through the same filer resolver', () => {
  for (const fn of [
    'listSecondApproverCandidatesForRequest',
    'assignSecondApprover',
    'managerDecideTimeAdjustment',
    'recallTimeAdjustment',
  ]) {
    assert.ok(body(fn).includes('resolveAdjustmentFiler('), `${fn} resolves the team some other way`);
  }
  assert.ok(!libSrc.includes('resolveAdjustmentDepartment('), 'the primary-only resolver is back');
});

test('the countersign read and write both match the caller’s own addresses', () => {
  assert.ok(body('listSecondApprovalsForApprover').includes('resolveReviewerEmails('));
  assert.ok(body('secondDecideTimeAdjustment').includes('resolveReviewerEmails('));
});

test('the manager list resolves teams with the same identity rule and fails loud', () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), 'app', 'api', 'manager', 'time-adjustments', 'route.ts'),
    'utf8',
  );
  assert.ok(route.includes('pickRosterIdentity('), 'the list resolves teams some other way');
  assert.ok(!route.includes(`.in('"Work Email"'`), 'the primary-only lookup is back');
  assert.ok(/rosterErr\) return NextResponse\.json\([^)]*status: 500/.test(route), 'an unreadable roster must 500');
});

test('the picker shows a refused pool read instead of calling the team empty', () => {
  const ui = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'manager', 'ManagerTimeAdjustments.tsx'),
    'utf8',
  );
  assert.ok(ui.includes('pool.error'), 'the picker no longer reads the pool error');
  assert.ok(/res\.ok \? null/.test(ui), 'a non-OK response is no longer treated as an error');
});
