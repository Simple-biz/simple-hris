import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffBonusFields,
  diffAssignment,
  normalizeEmailList,
  parseEffectiveDate,
  todayIso,
  bonusEffectiveFrom,
} from './history';
import type { BonusAssignment, BonusDef } from './types';

const base: BonusDef = {
  id: 'b1',
  name: 'Tickets',
  description: 'per ticket',
  kind: 'flat',
  amount: 500,
  currency: 'PHP',
  cadence: 'weekly',
};

test('diffBonusFields: identical definitions produce no version', () => {
  assert.deepEqual(diffBonusFields(base, { ...base }), []);
});

test('diffBonusFields: representation-only differences are NOT changes', () => {
  // Legacy row: no currency, no cadence, undefined description; incoming has explicit defaults.
  const legacy: BonusDef = { id: 'b1', name: 'Tickets ', kind: 'flat', amount: 500 };
  const incoming: BonusDef = { ...legacy, name: 'Tickets', description: '', currency: 'PHP', cadence: 'weekly' };
  assert.deepEqual(diffBonusFields(legacy, incoming), []);
  // Amount as a numeric string vs number.
  assert.deepEqual(diffBonusFields(base, { ...base, amount: '500' as unknown as number }), []);
});

test('diffBonusFields: a star toggle is not tracked', () => {
  const starredOnly: BonusDef = { ...base, starred: true };
  assert.deepEqual(diffBonusFields(base, starredOnly), []);
});

test('diffBonusFields: amount / currency / cadence / name changes are reported by field', () => {
  assert.deepEqual(diffBonusFields(base, { ...base, amount: 750 }), ['amount']);
  assert.deepEqual(diffBonusFields(base, { ...base, currency: 'USD' }), ['currency']);
  assert.deepEqual(diffBonusFields(base, { ...base, cadence: 'monthly' }), ['cadence']);
  assert.deepEqual(diffBonusFields(base, { ...base, name: 'Tickets Completed', amount: 600 }), ['name', 'amount']);
});

test('diffBonusFields: flat -> formula reports kind + amount + formula', () => {
  const next: BonusDef = { ...base, kind: 'formula', amount: undefined, formula: 'tickets * 50' };
  assert.deepEqual(diffBonusFields(base, next), ['kind', 'amount', 'formula']);
});

test('diffBonusFields: a stale amount left on a formula bonus does not count', () => {
  const f1: BonusDef = { ...base, kind: 'formula', formula: 'x*2', amount: 500 };
  const f2: BonusDef = { ...base, kind: 'formula', formula: 'x*2', amount: undefined };
  assert.deepEqual(diffBonusFields(f1, f2), []);
});

test('diffBonusFields: brand-new bonus lists what it was created with', () => {
  assert.deepEqual(diffBonusFields(null, base), ['name', 'description', 'kind', 'amount', 'currency', 'cadence']);
  const f: BonusDef = { id: 'x', name: 'F', kind: 'formula', formula: 'a+b' };
  assert.deepEqual(diffBonusFields(null, f), ['name', 'kind', 'formula', 'currency', 'cadence']);
});

const common: BonusAssignment = {
  id: 'a1',
  bonusId: 'b1',
  scope: 'department',
  departmentKey: 'lead_gen',
  excludedEmails: ['A@simple.biz', 'b@simple.biz'],
  sharedTeam: false,
};

test('diffAssignment: new assignment is added', () => {
  assert.deepEqual(diffAssignment(null, common), ['added']);
});

test('diffAssignment: exclusion list compared by membership, not order or case', () => {
  const reordered = { ...common, excludedEmails: ['b@simple.biz', 'a@SIMPLE.biz'] };
  assert.deepEqual(diffAssignment(common, reordered), []);
  const grown = { ...common, excludedEmails: [...(common.excludedEmails ?? []), 'c@simple.biz'] };
  assert.deepEqual(diffAssignment(common, grown), ['exclusions_changed']);
});

test('diffAssignment: shared-team flip is its own event; both can fire at once', () => {
  assert.deepEqual(diffAssignment(common, { ...common, sharedTeam: true }), ['shared_team_changed']);
  assert.deepEqual(diffAssignment(common, { ...common, sharedTeam: true, excludedEmails: [] }), [
    'exclusions_changed',
    'shared_team_changed',
  ]);
});

test('diffAssignment: employee-scope re-save yields nothing', () => {
  const emp: BonusAssignment = {
    id: 'a2',
    bonusId: 'b1',
    scope: 'employee',
    departmentKey: 'lead_gen',
    employeeEmail: 'x@simple.biz',
  };
  assert.deepEqual(diffAssignment(emp, { ...emp, employeeName: 'X' }), []);
});

test('normalizeEmailList: trims, lowercases, dedupes, sorts, drops blanks', () => {
  assert.deepEqual(normalizeEmailList([' B@x.com', 'a@x.com', 'b@X.com', '', null as unknown as string]), [
    'a@x.com',
    'b@x.com',
  ]);
});

test('parseEffectiveDate: absent -> today (local), valid passes, junk rejected', () => {
  const now = new Date(2026, 8, 8, 23, 30); // 2026-09-08 late evening local
  assert.deepEqual(parseEffectiveDate(undefined, now), { ok: true, iso: '2026-09-08' });
  assert.deepEqual(parseEffectiveDate('', now), { ok: true, iso: '2026-09-08' });
  assert.deepEqual(parseEffectiveDate('2026-09-14', now), { ok: true, iso: '2026-09-14' });
  assert.equal(parseEffectiveDate('2026-02-30', now).ok, false);
  assert.equal(parseEffectiveDate('09/14/2026', now).ok, false);
  assert.equal(parseEffectiveDate(20260914, now).ok, false);
  assert.equal(parseEffectiveDate('2026-09-14T00:00:00Z', now).ok, false);
});

test('todayIso is the LOCAL calendar date', () => {
  assert.equal(todayIso(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});

test('bonusEffectiveFrom: stored date wins, else created_at day, else null', () => {
  assert.equal(bonusEffectiveFrom({ effectiveFrom: '2026-09-14', createdAt: '2026-01-01T00:00:00Z' }), '2026-09-14');
  const created = new Date(2026, 5, 16, 9, 0).toISOString();
  assert.equal(bonusEffectiveFrom({ effectiveFrom: null, createdAt: created }), '2026-06-16');
  assert.equal(bonusEffectiveFrom({ effectiveFrom: null, createdAt: null }), null);
  assert.equal(bonusEffectiveFrom({ effectiveFrom: null, createdAt: 'garbage' }), null);
});
