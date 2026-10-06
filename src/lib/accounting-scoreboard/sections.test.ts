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
  CUSTOM_KINDS,
  MON_FRI,
  ROW_SECTION_KEYS,
  SECTIONS,
  SECTION_KEYS,
  SLOTS,
  SLOTS_BY_KIND,
  WEEKDAYS,
  boardSections,
  customBoardSection,
  hostedSections,
  isRowSectionKey,
  isSectionKey,
  resolveSections,
  rowSectionId,
  sectionDef,
  slotsFor,
  tabSections,
  type CustomSection,
} from './sections';

const read = (file: string) => readFileSync(path.join(process.cwd(), 'references/sql/create', file), 'utf8');
/** The 2026-10-01 tables, and round 3 (2026-10-06), which re-declares the section and slot CHECKs. */
const BASE_SQL = read('2026-10-01_accounting_scoreboard.sql');
const ROUND3_SQL = read('2026-10-06_accounting_scoreboard_round3.sql');

/** The quoted values of the CHECK declared as `<declared> <name> check (… in (…))`. */
function checkList(sql: string, constraint: string, declared = 'add constraint'): string[] {
  const at = sql.indexOf(`${declared} ${constraint}`);
  assert.ok(at >= 0, `${declared} ${constraint} is in the SQL`);
  const inner = sql.slice(at, sql.indexOf(')', sql.indexOf('in (', at)));
  return [...inner.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

test('the section-key CHECKs in force list exactly the code: rows = SECTION_KEYS + custom, switches = SECTION_KEYS', () => {
  assert.deepEqual([...checkList(ROUND3_SQL, 'acct_sb_rows_section_valid')].sort(), [...ROW_SECTION_KEYS].sort());
  assert.deepEqual([...checkList(ROUND3_SQL, 'acct_sb_sections_key_valid')].sort(), [...SECTION_KEYS].sort());
});

test('the slot CHECK in force lists exactly SLOTS; custom kinds match their CHECK', () => {
  assert.deepEqual([...checkList(ROUND3_SQL, 'acct_sb_entries_slot_valid')].sort(), [...SLOTS].sort());
  assert.deepEqual([...checkList(ROUND3_SQL, 'acct_sb_custom_kind_valid', 'constraint')].sort(), [...CUSTOM_KINDS].sort());
});

test('round 3 only ADDS to the 2026-10-01 lists: no section or slot is dropped', () => {
  for (const k of checkList(BASE_SQL, 'acct_sb_rows_section_valid', 'constraint')) assert.ok(isRowSectionKey(k), k);
  for (const k of checkList(BASE_SQL, 'acct_sb_sections_key_valid', 'constraint')) assert.ok(isSectionKey(k), k);
  for (const slot of checkList(BASE_SQL, 'acct_sb_entries_slot_valid', 'constraint')) {
    assert.ok((SLOTS as readonly string[]).includes(slot), slot);
  }
});

test('every key has exactly one section, in tab order, and nothing extra', () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.key).sort(),
    [...SECTION_KEYS].sort(),
  );
  assert.equal(new Set(SECTIONS.map((s) => s.key)).size, SECTIONS.length);
});

test('every section keeps real weekdays and never a weekend; Payroll Timing keeps its two deadline days', () => {
  for (const s of SECTIONS) {
    assert.ok(s.days.length > 0, s.key);
    for (const d of s.days) assert.ok(WEEKDAYS.includes(d), `${s.key}:${d}`);
    assert.ok(!s.days.includes('sat') && !s.days.includes('sun'), s.key);
  }
  assert.deepEqual(sectionDef('payroll_timing').days, ['tue', 'fri']);
});

test('Payroll Timing is typed by nobody: it has no slots, so every write to it is refused', () => {
  assert.equal(sectionDef('payroll_timing').kind, 'payroll_cycle');
  assert.deepEqual(slotsFor('payroll_timing'), []);
});

test('the sheet goals are kept: buckets ≥ 8, inbox ≥ 9, collections ≥ 85, compliance ≥ 30, problems < 20, a full cycle score', () => {
  const g = (k: (typeof SECTION_KEYS)[number]) => sectionDef(k).goal;
  assert.deepEqual([g('buckets')?.value, g('buckets')?.direction, g('buckets')?.measure], [8, 'at_least', 'score']);
  assert.deepEqual([g('inbox')?.value, g('inbox')?.direction, g('inbox')?.measure], [9, 'at_least', 'score']);
  assert.deepEqual([g('collections')?.value, g('collections')?.direction], [85, 'at_least']);
  assert.deepEqual([g('compliance')?.value, g('compliance')?.direction], [30, 'at_least']);
  assert.deepEqual([g('payroll_timing')?.value, g('payroll_timing')?.direction, g('payroll_timing')?.measure], [100, 'at_least', 'cycle_score']);
  assert.deepEqual([g('payroll_problems')?.value, g('payroll_problems')?.direction], [20, 'below']);
  for (const k of ['chargebacks', 'chargeback_outcomes', 'pm_buckets', 'onboarding', 'cancellations'] as const) assert.equal(g(k), undefined, k);
});

test('slots follow the kind; collections has no grid slot', () => {
  assert.deepEqual(slotsFor('buckets'), ['am', 'pm']);
  assert.deepEqual(slotsFor('inbox'), ['am', 'pm']);
  assert.deepEqual(slotsFor('pm_buckets'), ['day', 'mtg']);
  assert.deepEqual(SLOTS_BY_KIND.time_span, ['start', 'end'], 'kept for the SQL slot contract');
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

test('Payroll Problems is a log now: its grid takes no writes; Outcomes takes $ and #', () => {
  assert.equal(sectionDef('payroll_problems').kind, 'problem_log');
  assert.deepEqual(slotsFor('payroll_problems'), []);
  assert.deepEqual(slotsFor('chargeback_outcomes'), ['usd', 'count']);
  assert.equal(sectionDef('chargeback_outcomes').hostTab, 'chargebacks');
  assert.equal(sectionDef('buckets').score, 'cleared', "Carla's 2026-10-02 rule replaced the sheet's tiers");
});

const CUSTOM: CustomSection = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Refund Requests',
  kind: 'am_pm',
  goal: 7,
  goalDirection: 'at_least',
  enabled: true,
  sortOrder: 0,
};

test('a custom section renders like a built-in one: its own id, Mon–Fri, its kind and its goal', () => {
  const s = customBoardSection(CUSTOM);
  assert.equal(s.id, `custom:${CUSTOM.id}`);
  assert.equal(s.key, 'custom');
  assert.equal(s.customId, CUSTOM.id);
  assert.deepEqual(s.days, MON_FRI);
  assert.equal(s.score, 'cleared', 'an AM/PM custom section is scored like Buckets');
  assert.deepEqual(s.goal, { value: 7, direction: 'at_least', measure: 'score', unit: 'score' });
  const daily = customBoardSection({ ...CUSTOM, kind: 'daily', goal: 20, goalDirection: 'below' });
  assert.equal(daily.score, undefined);
  assert.deepEqual(daily.goal, { value: 20, direction: 'below', measure: 'team_week', unit: 'total' });
  assert.equal(customBoardSection({ ...CUSTOM, goal: null, goalDirection: null }).goal, undefined, 'no goal is invented');
  assert.equal(rowSectionId({ sectionKey: 'custom', customSectionId: CUSTOM.id }), s.id);
  assert.equal(rowSectionId({ sectionKey: 'inbox', customSectionId: null }), 'inbox');
});

test('tabs: Outcomes sits inside Chargebacks while it is on, and takes its own tab when Chargebacks is off', () => {
  const all = boardSections([], [CUSTOM]);
  assert.deepEqual(all.map((s) => s.id).slice(-1), [`custom:${CUSTOM.id}`], 'custom sections come after the built-ins');
  const tabs = tabSections(all).map((s) => s.id);
  assert.ok(!tabs.includes('chargeback_outcomes'));
  assert.ok(tabs.includes(`custom:${CUSTOM.id}`));
  const host = all.find((s) => s.id === 'chargebacks')!;
  assert.deepEqual(hostedSections(all, host).map((s) => s.id), ['chargeback_outcomes']);

  const hostOff = boardSections([{ sectionKey: 'chargebacks', enabled: false, goal: null }], []);
  assert.ok(tabSections(hostOff).some((s) => s.id === 'chargeback_outcomes'), 'never hidden silently');
  const bothOff = boardSections(
    [
      { sectionKey: 'chargebacks', enabled: true, goal: null },
      { sectionKey: 'chargeback_outcomes', enabled: false, goal: null },
    ],
    [],
  );
  assert.deepEqual(hostedSections(bothOff, bothOff.find((s) => s.id === 'chargebacks')!), []);
  assert.ok(!tabSections(boardSections([], [{ ...CUSTOM, enabled: false }])).some((s) => s.key === 'custom'));
});

test('custom sections: the newest (lowest sort order, given by createCustomSection) comes first', () => {
  const older = { ...CUSTOM, id: '33333333-3333-4333-8333-333333333333', title: 'Older', sortOrder: 0 };
  const newer = { ...CUSTOM, id: '44444444-4444-4444-8444-444444444444', title: 'Newer', sortOrder: -1 };
  const custom = boardSections([], [older, newer]).filter((s) => s.key === 'custom');
  assert.deepEqual(custom.map((s) => s.title), ['Newer', 'Older']);
});
