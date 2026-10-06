import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isoDayOfWeek, mesaContributesForWeek, mesaDepositDateFor } from './deposit-date';
import {
  MESA_SUSPENSION_REASON_MAX,
  checkResume,
  checkSuspend,
  checkSuspensionReason,
  firstAffectedWeek,
  indexMesaSuspensions,
  mesaSuspensionStatusOn,
  mesaSuspensionsFor,
  openMesaSuspension,
  type MesaSuspension,
} from './suspension';

function s(over: Partial<MesaSuspension> & { id: string }): MesaSuspension {
  return {
    accountNumber: '26-06-00027',
    email: 'dale@simple.biz',
    rosterEmail: 'dales@simple.biz',
    suspendedFrom: '2026-10-05',
    resumedOn: null,
    reason: null,
    suspendedBy: 'carla@simple.biz',
    suspendedAt: '2026-10-06T00:00:00Z',
    resumedBy: null,
    resumedAt: null,
    emails: ['dale@simple.biz', 'dales@simple.biz'],
    ...over,
  };
}

// ── Finding a member's windows ────────────────────────────────────────────────

test('a member is found by ANY of their addresses, case-insensitively', () => {
  const idx = indexMesaSuspensions([s({ id: 'a' })]);
  for (const e of ['dale@simple.biz', 'DALES@simple.biz', '  dales@simple.biz ']) {
    assert.deepEqual(mesaSuspensionsFor(idx, { emails: [e] }).map((x) => x.id), ['a'], e);
  }
  assert.deepEqual(mesaSuspensionsFor(idx, { emails: ['someone@simple.biz'] }), []);
});

test('a member is found by their rate row account number even when no address matches', () => {
  const idx = indexMesaSuspensions([s({ id: 'a' })]);
  assert.deepEqual(
    mesaSuspensionsFor(idx, { emails: ['new-address@simple.biz'], accountNumber: '26-06-00027' }).map((x) => x.id),
    ['a'],
  );
});

test('matching on address AND account returns each window once, oldest first', () => {
  const idx = indexMesaSuspensions([
    s({ id: 'late', suspendedFrom: '2026-11-02' }),
    s({ id: 'early', suspendedFrom: '2026-08-03', resumedOn: '2026-09-07' }),
  ]);
  const found = mesaSuspensionsFor(idx, { emails: ['dale@simple.biz', 'dales@simple.biz', null, undefined], accountNumber: '26-06-00027' });
  assert.deepEqual(found.map((x) => x.id), ['early', 'late']);
});

test('another member is never matched', () => {
  const idx = indexMesaSuspensions([s({ id: 'a' })]);
  assert.deepEqual(mesaSuspensionsFor(idx, { emails: ['jimg@simple.biz'], accountNumber: '26-06-00059' }), []);
});

test('openMesaSuspension finds the window with no resume', () => {
  assert.equal(openMesaSuspension([s({ id: 'x', resumedOn: '2026-10-10' })]), null);
  assert.equal(openMesaSuspension([s({ id: 'x', resumedOn: '2026-10-10' }), s({ id: 'y' })])?.id, 'y');
});

// ── Suspend validation ───────────────────────────────────────────────────────

const OPENED = '2026-06-22';

test('suspend: a real date on/after the account opening is accepted, not floored at today', () => {
  for (const from of [OPENED, '2026-07-01', '2026-10-06', '2027-01-04']) {
    const r = checkSuspend({ from, accountOpenedOn: OPENED, existing: [] });
    assert.deepEqual(r, { ok: true, from }, from);
  }
});

test('suspend: anything that is not a real calendar date is refused 400', () => {
  for (const from of [undefined, null, '', '2026-02-30', '2026-10-6', '06/10/2026', 20261006, '2026-10-06T00:00:00Z']) {
    const r = checkSuspend({ from, accountOpenedOn: OPENED, existing: [] });
    assert.equal(r.ok, false, String(from));
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test('suspend: before the account opened is refused 400', () => {
  const r = checkSuspend({ from: '2026-06-21', accountOpenedOn: OPENED, existing: [] });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
});

test('suspend: while another window is open is refused 409', () => {
  const r = checkSuspend({ from: '2026-12-01', accountOpenedOn: OPENED, existing: [{ suspendedFrom: '2026-10-05', resumedOn: null }] });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 409);
    assert.match(r.error, /2026-10-05/);
  }
});

test('suspend: inside a window that already ended is refused 409; on/after its resume is fine', () => {
  const existing = [{ suspendedFrom: '2026-08-03', resumedOn: '2026-09-07' }];
  const inside = checkSuspend({ from: '2026-09-06', accountOpenedOn: OPENED, existing });
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.equal(inside.status, 409);
  assert.equal(checkSuspend({ from: '2026-09-07', accountOpenedOn: OPENED, existing }).ok, true);
  assert.equal(checkSuspend({ from: '2026-10-05', accountOpenedOn: OPENED, existing }).ok, true);
});

// ── Resume validation ───────────────────────────────────────────────────────

test('resume: on or after the start is accepted; ON the start is a cancel', () => {
  const window = { suspendedFrom: '2026-10-05', resumedOn: null };
  assert.deepEqual(checkResume({ resumeOn: '2026-10-05', window }), { ok: true, resumeOn: '2026-10-05' });
  assert.deepEqual(checkResume({ resumeOn: '2026-11-02', window }), { ok: true, resumeOn: '2026-11-02' });
  // A cancel skips no week — proven against the gate itself.
  for (const weekEnd of ['2026-10-10', '2026-10-17', '2027-01-02']) {
    assert.equal(mesaContributesForWeek(null, weekEnd, [{ suspendedFrom: '2026-10-05', resumedOn: '2026-10-05' }]), true);
  }
});

test('resume: before the start is refused 400; an already-resumed window 409; a bad date 400', () => {
  const before = checkResume({ resumeOn: '2026-10-04', window: { suspendedFrom: '2026-10-05', resumedOn: null } });
  assert.equal(before.ok, false);
  if (!before.ok) assert.equal(before.status, 400);
  const twice = checkResume({ resumeOn: '2026-11-02', window: { suspendedFrom: '2026-10-05', resumedOn: '2026-10-20' } });
  assert.equal(twice.ok, false);
  if (!twice.ok) assert.equal(twice.status, 409);
  const bad = checkResume({ resumeOn: 'soon', window: { suspendedFrom: '2026-10-05', resumedOn: null } });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.status, 400);
});

// ── Reason ───────────────────────────────────────────────────────────────────

test('reason: optional, trimmed, at most 250 characters', () => {
  assert.deepEqual(checkSuspensionReason(undefined), { ok: true, reason: null });
  assert.deepEqual(checkSuspensionReason('   '), { ok: true, reason: null });
  assert.deepEqual(checkSuspensionReason('  Non-compliance: receipts  '), { ok: true, reason: 'Non-compliance: receipts' });
  assert.equal(checkSuspensionReason('x'.repeat(MESA_SUSPENSION_REASON_MAX)).ok, true);
  assert.equal(checkSuspensionReason('x'.repeat(MESA_SUSPENSION_REASON_MAX + 1)).ok, false);
  assert.equal(checkSuspensionReason(42).ok, false);
});

// ── The first affected week ──────────────────────────────────────────────────

test('firstAffectedWeek is the Sun–Sat week whose Friday is the first on/after the date', () => {
  // Mon 2026-10-05 → week Sun 10-04 … Sat 10-10, Friday 10-09.
  assert.deepEqual(firstAffectedWeek('2026-10-05'), { weekStart: '2026-10-04', weekEnd: '2026-10-10', deposit: '2026-10-09' });
  // Friday itself → that week.
  assert.deepEqual(firstAffectedWeek('2026-10-09'), { weekStart: '2026-10-04', weekEnd: '2026-10-10', deposit: '2026-10-09' });
  // Saturday → the FOLLOWING week.
  assert.deepEqual(firstAffectedWeek('2026-10-10'), { weekStart: '2026-10-11', weekEnd: '2026-10-17', deposit: '2026-10-16' });
});

test('firstAffectedWeek agrees with the gate for every date: it is the first week a suspension skips', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 400; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const w = firstAffectedWeek(date);
    assert.equal(isoDayOfWeek(w.weekStart), 0, date);
    assert.equal(isoDayOfWeek(w.weekEnd), 6, date);
    assert.equal(mesaDepositDateFor(w.weekEnd), w.deposit, date);
    const windows = [{ suspendedFrom: date, resumedOn: null }];
    assert.equal(mesaContributesForWeek(null, w.weekEnd, windows), false, `${date}: first week must be skipped`);
    const prevEnd = new Date(Date.parse(`${w.weekEnd}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(mesaContributesForWeek(null, prevEnd, windows), true, `${date}: the week before must be charged`);
  }
});

// ── Badge status ─────────────────────────────────────────────────────────────

test('status: suspended / scheduled / none, ignoring cancelled and ended windows', () => {
  const today = '2026-10-06';
  assert.equal(mesaSuspensionStatusOn([], today).kind, 'none');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-10-05', resumedOn: null }], today).kind, 'suspended');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-10-06', resumedOn: null }], today).kind, 'suspended');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-10-12', resumedOn: null }], today).kind, 'scheduled');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-10-01', resumedOn: '2026-10-20' }], today).kind, 'suspended');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-09-01', resumedOn: '2026-10-06' }], today).kind, 'none');
  assert.equal(mesaSuspensionStatusOn([{ suspendedFrom: '2026-10-12', resumedOn: '2026-10-12' }], today).kind, 'none');
});
