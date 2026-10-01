/**
 * Run: node --import tsx --test src/lib/accounting-scoreboard/sections.test.ts
 *
 * Pins the section list to the SQL CHECKs. A section added in code without its SQL (or the other
 * way round) fails here, before a write is refused in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SECTIONS,
  SECTION_KEYS,
  SLOTS,
  SLOTS_BY_KIND,
  WEEKDAYS,
  isSectionKey,
  resolveSections,
  sectionDef,
  slotsFor,
} from './sections';

const SQL = readFileSync(
  path.join(process.cwd(), 'references/sql/create/2026-10-01_accounting_scoreboard.sql'),
  'utf8',
);

function checkList(constraint: string): string[] {
  const at = SQL.indexOf(constraint);
  assert.ok(at >= 0, `${constraint} is in the SQL`);
  const inner = SQL.slice(at, SQL.indexOf(')', SQL.indexOf('in (', at)));
  return [...inner.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('both section-key CHECKs in the SQL list exactly SECTION_KEYS', () => {
  assert.deepEqual([...checkList('acct_sb_rows_section_valid')].sort(), [...SECTION_KEYS].sort());
  assert.deepEqual([...checkList('acct_sb_sections_key_valid')].sort(), [...SECTION_KEYS].sort());
});

test('the slot CHECK in the SQL lists exactly SLOTS', () => {
  assert.deepEqual([...checkList('acct_sb_entries_slot_valid')].sort(), [...SLOTS].sort());
});

test('every key has exactly one section, in tab order, and nothing extra', () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.key).sort(),
    [...SECTION_KEYS].sort(),
  );
  assert.equal(new Set(SECTIONS.map((s) => s.key)).size, SECTIONS.length);
});

test('every section keeps real weekdays, and only Payroll Timing keeps a Sunday', () => {
  for (const s of SECTIONS) {
    assert.ok(s.days.length > 0, s.key);
    for (const d of s.days) assert.ok(WEEKDAYS.includes(d), `${s.key}:${d}`);
    assert.equal(s.days.includes('sun'), s.key === 'payroll_timing', s.key);
    assert.ok(!s.days.includes('sat'), s.key);
  }
});

test('the sheet goals are kept: buckets ≥ 8, inbox ≥ 9, collections ≥ 85, compliance ≥ 30, payroll < 20', () => {
  const g = (k: (typeof SECTION_KEYS)[number]) => sectionDef(k).goal;
  assert.deepEqual([g('buckets')?.value, g('buckets')?.direction, g('buckets')?.measure], [8, 'at_least', 'avg_score']);
  assert.deepEqual([g('inbox')?.value, g('inbox')?.direction, g('inbox')?.measure], [9, 'at_least', 'avg_score']);
  assert.deepEqual([g('collections')?.value, g('collections')?.direction], [85, 'at_least']);
  assert.deepEqual([g('compliance')?.value, g('compliance')?.direction], [30, 'at_least']);
  assert.deepEqual([g('payroll_timing')?.value, g('payroll_timing')?.direction], [20, 'below']);
  assert.deepEqual([g('payroll_problems')?.value, g('payroll_problems')?.direction], [20, 'below']);
  for (const k of ['chargebacks', 'pm_buckets', 'onboarding', 'cancellations'] as const) assert.equal(g(k), undefined, k);
});

test('slots follow the kind; collections has no grid slot', () => {
  assert.deepEqual(slotsFor('buckets'), ['am', 'pm']);
  assert.deepEqual(slotsFor('inbox'), ['am', 'pm']);
  assert.deepEqual(slotsFor('pm_buckets'), ['day', 'mtg']);
  assert.deepEqual(slotsFor('payroll_timing'), ['start', 'end']);
  assert.deepEqual(slotsFor('collections'), []);
  const used = new Set(Object.values(SLOTS_BY_KIND).flat());
  assert.deepEqual([...used].sort(), [...SLOTS].sort(), 'every SQL slot is used by some kind');
});

test('isSectionKey refuses anything else', () => {
  assert.equal(isSectionKey('inbox'), true);
  assert.equal(isSectionKey('payroll'), false);
  assert.equal(isSectionKey(undefined), false);
});

test('resolveSections: missing switch = on with the sheet goal; a switch turns off and overrides', () => {
  const plain = resolveSections([]);
  assert.equal(plain.every((s) => s.enabled), true);
  assert.equal(plain.find((s) => s.key === 'collections')?.goal?.value, 85);

  const set = resolveSections([
    { sectionKey: 'inbox', enabled: false, goal: null },
    { sectionKey: 'collections', enabled: true, goal: 90 },
    { sectionKey: 'chargebacks', enabled: true, goal: 5 },
  ]);
  assert.equal(set.find((s) => s.key === 'inbox')?.enabled, false);
  assert.equal(set.find((s) => s.key === 'inbox')?.goal?.value, 9, 'a null goal keeps the sheet goal');
  assert.equal(set.find((s) => s.key === 'collections')?.goal?.value, 90);
  assert.equal(set.find((s) => s.key === 'collections')?.goal?.direction, 'at_least');
  assert.equal(set.find((s) => s.key === 'chargebacks')?.goal, undefined, 'no goal is invented for a goal-less section');
  assert.deepEqual(set.map((s) => s.key), SECTIONS.map((s) => s.key), 'tab order is kept');
});
