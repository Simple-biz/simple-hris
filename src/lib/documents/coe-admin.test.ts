/**
 * The pure rules behind Accounting's "Generate COE" flow: candidate folding
 * (active-GML-only, work-email identity, newest-row display fields) and the
 * fail-closed active gate the preview/generate routes re-judge at request time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCoeActiveGate,
  foldCoeCandidates,
  type CoeCandidateObservation,
  type CoeGmlStatus,
} from './coe-admin';

const ACTIVE: CoeGmlStatus = { active: true, offBoardedAt: null, offBoardedReason: null };
const GONE: CoeGmlStatus = { active: false, offBoardedAt: '2026-05-01', offBoardedReason: 'resigned' };

function obs(partial: Partial<CoeCandidateObservation>): CoeCandidateObservation {
  return { workEmail: null, name: null, departmentRaw: null, uploadSeq: 0, ...partial };
}

// ─── foldCoeCandidates ──────────────────────────────────────────────────────

test('drops observations with no work email — a name or personal email only searches', () => {
  const out = foldCoeCandidates(
    [obs({ name: 'Cruz, Ana' })],
    new Map([['ana@simple.biz', ACTIVE]]),
  );
  assert.equal(out.length, 0);
});

test('only GML-active work emails survive; missing status also drops', () => {
  const out = foldCoeCandidates(
    [
      obs({ workEmail: 'active@simple.biz', name: 'A' }),
      obs({ workEmail: 'gone@simple.biz', name: 'B' }),
      obs({ workEmail: 'unknown@simple.biz', name: 'C' }),
    ],
    new Map([
      ['active@simple.biz', ACTIVE],
      ['gone@simple.biz', GONE],
    ]),
  );
  assert.deepEqual(out.map((c) => c.workEmail), ['active@simple.biz']);
});

test('one candidate per work email — newest uploadSeq supplies display fields', () => {
  const out = foldCoeCandidates(
    [
      obs({ workEmail: 'ana@simple.biz', name: 'Old Name', departmentRaw: 'Old Dept', uploadSeq: 1 }),
      obs({ workEmail: 'ANA@simple.biz', name: 'Cruz, Ana', departmentRaw: 'Sales', uploadSeq: 9 }),
    ],
    new Map([['ana@simple.biz', ACTIVE]]),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Cruz, Ana');
  assert.equal(out[0].department, 'Sales');
});

test('an older row only fills blanks the newer one left', () => {
  const out = foldCoeCandidates(
    [
      obs({ workEmail: 'ana@simple.biz', name: 'Cruz, Ana', departmentRaw: null, uploadSeq: 9 }),
      obs({ workEmail: 'ana@simple.biz', name: 'Stale', departmentRaw: 'Sales', uploadSeq: 1 }),
    ],
    new Map([['ana@simple.biz', ACTIVE]]),
  );
  assert.equal(out[0].name, 'Cruz, Ana');
  assert.equal(out[0].department, 'Sales');
});

test('a raw hsl:* department slug never reaches the candidate list', () => {
  const out = foldCoeCandidates(
    [obs({ workEmail: 'ana@simple.biz', departmentRaw: 'hsl:collections_team' })],
    new Map([['ana@simple.biz', ACTIVE]]),
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].department);
  assert.ok(!out[0].department!.toLowerCase().startsWith('hsl:'), out[0].department!);
  assert.ok(out[0].department!.startsWith('HSL — '), out[0].department!);
});

test('sorted by name, email as tiebreaker and fallback', () => {
  const status = new Map([
    ['b@simple.biz', ACTIVE],
    ['a@simple.biz', ACTIVE],
    ['c@simple.biz', ACTIVE],
  ]);
  const out = foldCoeCandidates(
    [
      obs({ workEmail: 'b@simple.biz', name: 'Zab, Z' }),
      obs({ workEmail: 'a@simple.biz', name: 'Cruz, Ana' }),
      obs({ workEmail: 'c@simple.biz' }), // no name → sorts by email
    ],
    status,
  );
  assert.deepEqual(out.map((c) => c.workEmail), ['c@simple.biz', 'a@simple.biz', 'b@simple.biz']);
});

// ─── decideCoeActiveGate ────────────────────────────────────────────────────

test('gate: a status-map read error refuses FIRST, even with a status present', () => {
  const r = decideCoeActiveGate({ status: ACTIVE, statusError: 'boom' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.code, 'roster_unavailable');
    assert.equal(r.rejection.status, 500);
  }
});

test('gate: absent from the map refuses — absence is never proof of activity', () => {
  const r = decideCoeActiveGate({ status: undefined, statusError: null });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.code, 'not_on_gml');
    assert.equal(r.rejection.status, 422);
  }
});

test('gate: a stamped person refuses and the message names the departure', () => {
  const r = decideCoeActiveGate({ status: GONE, statusError: null });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.rejection.code, 'not_active');
    assert.equal(r.rejection.status, 422);
    assert.ok(r.rejection.message.includes('2026-05-01'));
    assert.ok(r.rejection.message.includes('resigned'));
  }
});

test('gate: active passes', () => {
  assert.deepEqual(decideCoeActiveGate({ status: ACTIVE, statusError: null }), { ok: true });
});
