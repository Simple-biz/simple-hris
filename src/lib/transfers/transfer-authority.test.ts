/**
 * Who may raise and who may decide a department transfer (audit item 205,
 * Kane's (b), 2026-09-25). cjm@ manages Lead Gen AND the HSL teams she pulls
 * Lead Gen agents into; the old "never from a department you manage" rule hid
 * every Lead Gen agent from her picker and 403'd the POST. These pin the new
 * shape on both sides: she may raise it, she may not release it herself, and
 * the KPI calculators' external pickers still never see a manager's own team.
 *
 * Run:  npx tsx --test src/lib/transfers/transfer-authority.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatePool,
  initiateTransferDenial,
  transferDecisionDenial,
  transferNoOpDenial,
  withoutOwnRequests,
} from './transfer-authority';

const CJM = ['Lead Gen', 'HSL', 'hsl:intake_specialist', 'Client VA'];

test('a label-only move between two spellings of one department is refused (every role)', () => {
  assert.notEqual(transferNoOpDenial('Client - VA', 'Client VA'), null);
  assert.notEqual(transferNoOpDenial('Lead Gen', ' lead gen '), null);
  // A sub-team cell already satisfies its bare family — never a move "back" to it.
  assert.notEqual(transferNoOpDenial('hsl:intake_specialist', 'HSL'), null);
});

test('a real move — including into a namespaced sub-team — is not a no-op', () => {
  assert.equal(transferNoOpDenial('Lead Gen', 'hsl:intake_specialist'), null);
  assert.equal(transferNoOpDenial('hsl:intake_specialist', 'hsl:filing_specialist'), null);
  assert.equal(transferNoOpDenial('Lead Gen', 'Client VA'), null);
});

test('a manager of BOTH source and target may raise the transfer (the cjm@ case)', () => {
  assert.equal(
    initiateTransferDenial({ isAdmin: false, managedDepts: CJM, toDept: 'hsl:intake_specialist' }),
    null,
  );
});

test('the target must still be a department the manager manages', () => {
  assert.match(
    initiateTransferDenial({ isAdmin: false, managedDepts: CJM, toDept: 'Discovery' }) ?? '',
    /into a department you manage/,
  );
});

test('admins and unassigned (elevated) managers are unrestricted when raising', () => {
  assert.equal(initiateTransferDenial({ isAdmin: true, managedDepts: CJM, toDept: 'Discovery' }), null);
  assert.equal(initiateTransferDenial({ isAdmin: false, managedDepts: [], toDept: 'Discovery' }), null);
});

test('the requester can NOT release their own request, even as a source manager', () => {
  const denial = transferDecisionDenial({
    isAdmin: false,
    sessionEmail: 'cjm@simple.biz',
    requestedBy: 'CJM@simple.biz ',
    fromDept: 'Lead Gen',
    managedDepts: CJM,
  });
  assert.match(denial ?? '', /another manager of the current department/);
});

test('another source manager may release it', () => {
  assert.equal(
    transferDecisionDenial({
      isAdmin: false,
      sessionEmail: 'jackie@simple.biz',
      requestedBy: 'cjm@simple.biz',
      fromDept: 'Lead Gen',
      managedDepts: ['Lead Gen'],
    }),
    null,
  );
});

test('a non-source manager still may not decide', () => {
  assert.match(
    transferDecisionDenial({
      isAdmin: false,
      sessionEmail: 'someone@simple.biz',
      requestedBy: 'cjm@simple.biz',
      fromDept: 'Lead Gen',
      managedDepts: ['Discovery'],
    }) ?? '',
    /Only a manager of the current department/,
  );
  // An unassigned manager decides nothing — unchanged from before 2026-09-25.
  assert.notEqual(
    transferDecisionDenial({
      isAdmin: false,
      sessionEmail: 'someone@simple.biz',
      requestedBy: 'cjm@simple.biz',
      fromDept: 'Lead Gen',
      managedDepts: [],
    }),
    null,
  );
});

test('an admin may decide anything, including their own request', () => {
  assert.equal(
    transferDecisionDenial({
      isAdmin: true,
      sessionEmail: 'kaner@simple.biz',
      requestedBy: 'kaner@simple.biz',
      fromDept: 'Lead Gen',
      managedDepts: [],
    }),
    null,
  );
});

test("the Release queue drops the caller's own requests and keeps everyone else's", () => {
  const rows = [
    { id: 1, requested_by: 'cjm@simple.biz' },
    { id: 2, requested_by: 'carla@simple.biz' },
    { id: 3, requested_by: ' CJM@SIMPLE.BIZ' },
  ];
  assert.deepEqual(
    withoutOwnRequests(rows, 'cjm@simple.biz').map((r) => r.id),
    [2],
  );
});

const ROSTER = [
  { name: 'Myke', department: 'Lead Gen' },
  { name: 'Ann', department: 'hsl:intake_specialist' },
  { name: 'Dustin', department: 'AI/API Team' },
  { name: 'Nobody', department: null },
];

test("the transfer picker offers the manager's own departments", () => {
  const pool = candidatePool(ROSTER, { isAdmin: false, managedDepts: CJM, purpose: 'transfer' });
  assert.deepEqual(pool.map((p) => p.name), ['Myke', 'Ann', 'Dustin', 'Nobody']);
});

test("every OTHER caller still never sees the manager's own team (KPI external pickers)", () => {
  for (const purpose of [null, '', 'kpi', 'TRANSFER']) {
    const pool = candidatePool(ROSTER, { isAdmin: false, managedDepts: CJM, purpose });
    assert.deepEqual(pool.map((p) => p.name), ['Dustin', 'Nobody'], `purpose=${String(purpose)}`);
  }
});

test('admins and unassigned managers get everyone from every caller', () => {
  assert.equal(candidatePool(ROSTER, { isAdmin: true, managedDepts: CJM, purpose: null }).length, 4);
  assert.equal(candidatePool(ROSTER, { isAdmin: false, managedDepts: [], purpose: null }).length, 4);
});
