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
  HOST_SECTION_KEYS,
  OUTCOMES,
  MON_FRI,
  ROW_SECTION_KEYS,
  SECTIONS,
  SECTION_KEYS,
  SLOTS,
  SLOTS_BY_KIND,
  WEEKDAYS,
  boardSections,
  customBoardSection,
  hiddenFromOverview,
  hostedSections,
  isRowSectionKey,
  goalMax,
  goalShapeOf,
  isHostSectionKey,
  isOutcome,
  isSectionKey,
  overviewSections,
  resolveSections,
  rowSectionId,
  sectionDef,
  sectionLabel,
  slotsFor,
  tabIdFor,
  tabSections,
  type CustomSection,
} from './sections';
import { MAX_PROBLEMS_PER_LINE, MIN_PROBLEMS_PER_LINE } from './validate';

const read = (file: string) => readFileSync(path.join(process.cwd(), 'references/sql/create', file), 'utf8');
/** The 2026-10-01 tables, and round 3 (2026-10-06), which re-declares the section and slot CHECKs. */
const BASE_SQL = read('2026-10-01_accounting_scoreboard.sql');
const ROUND3_SQL = read('2026-10-06_accounting_scoreboard_round3.sql');
/** 2026-10-07: where a custom section is shown (accounting_scoreboard_custom_sections.host_section_key). */
const HOST_SQL = read('2026-10-07_accounting_scoreboard_custom_section_host.sql');
/** 2026-10-07: rows.outcome (the win ratio) and the Payroll Problems count, 0–1000. */
const OUTCOMES_SQL = read('2026-10-07_accounting_scoreboard_outcomes_and_zero_problems.sql');
/** 2026-10-07: rows.outcome may be 'pre_arb' (Carla: "it's still considered a loss"; item 392). The outcome CHECK in force. */
const PRE_ARB_SQL = read('2026-10-07_accounting_scoreboard_pre_arb_flag.sql');
/** 2026-10-07: show_on_overview on both section tables (Carla: "I don't want this one on the overview"). */
const VISIBILITY_SQL = read('2026-10-07_accounting_scoreboard_overview_visibility.sql');

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
  // Carla's own defaults, 2026-10-07: PM Buckets "less than 30 avg", Outcomes "a win ratio of 50% or higher".
  assert.deepEqual(g('pm_buckets'), { value: 30, direction: 'below', measure: 'average', unit: 'avg' });
  assert.deepEqual(g('chargeback_outcomes'), { value: 50, direction: 'at_least', measure: 'ratio', unit: '%' });
  // No default goal (none on the sheet, none from Carla): a manager can set one (§ Setup goals).
  for (const k of ['chargebacks', 'onboarding', 'cancellations'] as const) {
    assert.equal(g(k), undefined, k);
    assert.ok(sectionDef(k).goalShape, `${k} can take a goal`);
  }
});

test('every built-in section can carry a goal (Carla, 2026-10-07), and never has a default goal AND a shape', () => {
  for (const def of SECTIONS) {
    assert.ok(goalShapeOf(def), `${def.key} has something to judge a goal on`);
    assert.ok(!(def.goal && def.goalShape), `${def.key}: a default goal already says its shape`);
  }
  assert.deepEqual(goalShapeOf(sectionDef('chargebacks')), { direction: 'at_least', measure: 'score', unit: 'score' });
  assert.equal(goalMax({ measure: 'score' }), 10);
  assert.equal(goalMax({ measure: 'ratio' }), 100);
  assert.equal(goalMax({ measure: 'team_week' }), 100000);
});

test('Open Disputes is scored like Buckets (Carla, 2026-10-07); Outcomes is judged on its win ratio', () => {
  assert.equal(sectionDef('chargebacks').score, 'cleared');
  assert.equal(sectionDef('chargeback_outcomes').goal?.measure, 'ratio');
  // Pre-arb is a flag of its own since 2026-10-07 (item 392): its dollars count minus in the Net.
  assert.ok(isOutcome('win') && isOutcome('loss') && isOutcome('pre_arb'));
  assert.ok(!isOutcome('Wins') && !isOutcome('Pre-arb') && !isOutcome('draw') && !isOutcome(null) && !isOutcome(undefined), 'a label is never a flag');
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
    { sectionKey: 'inbox', enabled: false, goal: null, showOnOverview: true },
    { sectionKey: 'collections', enabled: true, goal: 90, showOnOverview: true },
    { sectionKey: 'chargebacks', enabled: true, goal: 5, showOnOverview: true },
    { sectionKey: 'onboarding', enabled: true, goal: null, showOnOverview: true },
  ]);
  assert.equal(set.find((s) => s.key === 'inbox')?.enabled, false);
  assert.equal(set.find((s) => s.key === 'inbox')?.goal?.value, 9, 'a null goal keeps the sheet goal');
  assert.equal(set.find((s) => s.key === 'collections')?.goal?.value, 90);
  assert.equal(set.find((s) => s.key === 'collections')?.goal?.direction, 'at_least');
  // Since 2026-10-07 a section with no default goal takes the one a manager set, on its shape...
  assert.deepEqual(set.find((s) => s.key === 'chargebacks')?.goal, { direction: 'at_least', measure: 'score', unit: 'score', value: 5 });
  // ...and none is ever invented: no number set = no goal.
  assert.equal(set.find((s) => s.key === 'onboarding')?.goal, undefined, 'no goal is invented for a section with no default');
  assert.equal(plain.find((s) => s.key === 'cancellations')?.goal, undefined);
  assert.equal(plain.find((s) => s.key === 'pm_buckets')?.goal?.value, 30, "Carla's default");
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
  showOnOverview: true,
  sortOrder: 0,
  hostSectionKey: null,
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

  const hostOff = boardSections([{ sectionKey: 'chargebacks', enabled: false, goal: null, showOnOverview: true }], []);
  assert.ok(tabSections(hostOff).some((s) => s.id === 'chargeback_outcomes'), 'never hidden silently');
  const bothOff = boardSections(
    [
      { sectionKey: 'chargebacks', enabled: true, goal: null, showOnOverview: true },
      { sectionKey: 'chargeback_outcomes', enabled: false, goal: null, showOnOverview: true },
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

test('hosts: the CHECK lists exactly HOST_SECTION_KEYS = every built-in with a tab of its own (not Outcomes)', () => {
  assert.deepEqual([...checkList(HOST_SQL, 'acct_sb_custom_host_valid')].sort(), [...HOST_SECTION_KEYS].sort());
  assert.deepEqual(
    [...HOST_SECTION_KEYS].sort(),
    SECTIONS.filter((s) => s.hostTab === undefined)
      .map((s) => s.key)
      .sort(),
  );
  assert.ok(!isHostSectionKey('chargeback_outcomes'), 'a section shown inside another tab hosts nothing');
  assert.ok(!isHostSectionKey('custom'));
  assert.ok(isHostSectionKey('onboarding'));
});

test('Sales Onboarding (Carla, 2026-10-07): the built-in is Sales — Payments; Projects Onboarded is a custom section shown under it', () => {
  assert.equal(sectionDef('onboarding').title, 'Sales — Payments');
  assert.equal(sectionDef('onboarding').tab, 'Sales Onboarding', 'the tab keeps its name');

  const projects: CustomSection = {
    ...CUSTOM,
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Sales - Projects Onboarded',
    kind: 'daily',
    goal: null,
    goalDirection: null,
    hostSectionKey: 'onboarding',
  };
  const all = boardSections([], [CUSTOM, projects]);
  const p = all.find((s) => s.customId === projects.id)!;
  const host = all.find((s) => s.id === 'onboarding')!;

  assert.ok(!tabSections(all).some((s) => s.id === p.id), 'no tab of its own while Sales Onboarding is on');
  assert.deepEqual(hostedSections(all, host).map((s) => s.id), [p.id], 'its grid sits under Sales — Payments');
  assert.equal(tabIdFor(all, p), 'onboarding', 'its Overview card opens the Sales Onboarding tab');
  assert.equal(tabIdFor(all, host), 'onboarding');
  assert.equal(sectionLabel(p), 'Sales Onboarding — Sales - Projects Onboarded');
  assert.equal(sectionLabel(all.find((s) => s.id === 'chargeback_outcomes')!), 'Chargebacks — Outcomes', 'unchanged for Outcomes');

  // Its card follows its host's. Outcomes has its own card since 2026-10-07: the win ratio is its number.
  const cards = overviewSections(all).map((s) => s.id);
  assert.equal(cards[cards.indexOf('onboarding') + 1], p.id);
  assert.equal(cards[cards.indexOf('chargebacks') + 1], 'chargeback_outcomes');
  assert.ok(cards.includes(`custom:${CUSTOM.id}`), 'a custom section with its own tab keeps its card');

  // Never disappears silently: with Sales Onboarding off, it takes a tab of its own.
  const hostOff = boardSections([{ sectionKey: 'onboarding', enabled: false, goal: null, showOnOverview: true }], [projects]);
  const alone = hostOff.find((s) => s.customId === projects.id)!;
  assert.ok(tabSections(hostOff).some((s) => s.id === alone.id));
  assert.equal(tabIdFor(hostOff, alone), alone.id);
  assert.equal(overviewSections(hostOff).filter((s) => s.id === alone.id).length, 1, 'one card, never two');

  // Switched off itself: no grid, no card.
  const off = boardSections([], [{ ...projects, enabled: false }]);
  assert.deepEqual(hostedSections(off, off.find((s) => s.id === 'onboarding')!), []);
  assert.ok(!overviewSections(off).some((s) => s.customId === projects.id));
});

test('hosted sections: the built-in ones first, then custom ones newest first', () => {
  const a: CustomSection = { ...CUSTOM, id: '66666666-6666-4666-8666-666666666666', title: 'Older', sortOrder: 0, hostSectionKey: 'chargebacks' };
  const b: CustomSection = { ...CUSTOM, id: '77777777-7777-4777-8777-777777777777', title: 'Newer', sortOrder: -1, hostSectionKey: 'chargebacks' };
  const all = boardSections([], [a, b]);
  const host = all.find((s) => s.id === 'chargebacks')!;
  assert.deepEqual(hostedSections(all, host).map((s) => s.title), ['Outcomes', 'Newer', 'Older']);
});

test('the outcome CHECK in force lists exactly OUTCOMES; the problem-count CHECK is MIN–MAX_PROBLEMS_PER_LINE (2026-10-07)', () => {
  const inForce = checkList(PRE_ARB_SQL, 'acct_sb_rows_outcome_valid').filter((v) => v !== 'chargeback_outcomes');
  assert.deepEqual([...inForce].sort(), [...OUTCOMES].sort());
  // The Pre-arb flag only ADDS a value: win and loss keep their meaning, and still only on an Outcomes line.
  const before = checkList(OUTCOMES_SQL, 'acct_sb_rows_outcome_valid').filter((v) => v !== 'chargeback_outcomes');
  assert.deepEqual([...inForce].filter((v) => !before.includes(v)), ['pre_arb']);
  assert.ok(before.every((v) => inForce.includes(v)));
  assert.match(PRE_ARB_SQL, /section_key = 'chargeback_outcomes' and outcome in \('win', 'loss', 'pre_arb'\)/);
  const at = OUTCOMES_SQL.indexOf('add constraint acct_sb_prob_count_range');
  assert.ok(at >= 0);
  const m = /between (\d+) and (\d+)/.exec(OUTCOMES_SQL.slice(at));
  assert.deepEqual([Number(m?.[1]), Number(m?.[2])], [MIN_PROBLEMS_PER_LINE, MAX_PROBLEMS_PER_LINE]);
  assert.equal(MIN_PROBLEMS_PER_LINE, 0, 'Kane, 2026-10-07: "0 can count as 0 problems"');
});

// ---------------------------------------------------------------------------
// Hidden from the Overview (Carla, 2026-10-07: "I don't want this one on the overview, but I don't have a
// hide option"; Kane: "setup will have an option to hide it from the overview"; Carla: "Under sections")
// ---------------------------------------------------------------------------

const PROJECTS: CustomSection = {
  ...CUSTOM,
  id: '88888888-8888-4888-8888-888888888888',
  title: 'Sales - Projects Onboarded',
  kind: 'daily',
  goal: null,
  goalDirection: null,
  hostSectionKey: 'onboarding',
};

test('a built-in section hidden from the Overview loses its card and keeps its tab', () => {
  const all = boardSections([{ sectionKey: 'compliance', enabled: true, goal: null, showOnOverview: false }], []);
  const compliance = all.find((s) => s.id === 'compliance')!;
  assert.equal(compliance.showOnOverview, false);
  assert.ok(!overviewSections(all).some((s) => s.id === 'compliance'), 'no card');
  assert.ok(tabSections(all).some((s) => s.id === 'compliance'), 'its tab stays');
  assert.equal(tabIdFor(all, compliance), 'compliance');
  assert.deepEqual(hiddenFromOverview(all).map((s) => s.id), ['compliance'], 'the Overview names it');
  assert.deepEqual(hiddenFromOverview(boardSections([], [])), [], 'nothing hidden by default');
  // Every other card is untouched, in order.
  assert.deepEqual(
    overviewSections(all).map((s) => s.id),
    overviewSections(boardSections([], [])).map((s) => s.id).filter((id) => id !== 'compliance'),
  );
});

test('a hosted custom section hidden from the Overview loses its card; its grid stays inside the host tab', () => {
  const all = boardSections([], [{ ...PROJECTS, showOnOverview: false }]);
  const p = all.find((s) => s.customId === PROJECTS.id)!;
  const host = all.find((s) => s.id === 'onboarding')!;
  assert.ok(!overviewSections(all).some((s) => s.id === p.id), 'no card');
  assert.ok(overviewSections(all).some((s) => s.id === 'onboarding'), "its host's card stays");
  assert.deepEqual(hostedSections(all, host).map((s) => s.id), [p.id], 'its grid still sits under Sales — Payments');
  assert.equal(tabIdFor(all, p), 'onboarding');
  // With its host switched off it takes a tab of its own (never disappears silently), and still no card.
  const hostOff = boardSections([{ sectionKey: 'onboarding', enabled: false, goal: null, showOnOverview: true }], [{ ...PROJECTS, showOnOverview: false }]);
  assert.ok(tabSections(hostOff).some((s) => s.customId === PROJECTS.id));
  assert.ok(!overviewSections(hostOff).some((s) => s.customId === PROJECTS.id));
});

test("a host hidden from the Overview never takes its hosted sections' cards with it", () => {
  // Chargebacks: Open Disputes hidden, Outcomes (its own switch) keeps its card.
  const all = boardSections([{ sectionKey: 'chargebacks', enabled: true, goal: null, showOnOverview: false }], []);
  const cards = overviewSections(all).map((s) => s.id);
  assert.ok(!cards.includes('chargebacks'));
  assert.ok(cards.includes('chargeback_outcomes'));
  // Outcomes' grid is still inside the Chargebacks tab, so its Team Score group is still Chargebacks.
  assert.equal(tabIdFor(all, all.find((s) => s.id === 'chargeback_outcomes')!), 'chargebacks');
});

test('a section switched OFF stays off the Overview whatever its Overview switch says', () => {
  const all = boardSections([{ sectionKey: 'inbox', enabled: false, goal: null, showOnOverview: true }], [{ ...PROJECTS, enabled: false }]);
  assert.ok(!overviewSections(all).some((s) => s.id === 'inbox'));
  assert.ok(!overviewSections(all).some((s) => s.customId === PROJECTS.id));
  // Off AND hidden: it shows nowhere, so the Overview's "Not on the Overview" line does not name it.
  const offHidden = boardSections([{ sectionKey: 'inbox', enabled: false, goal: null, showOnOverview: false }], []);
  assert.deepEqual(hiddenFromOverview(offHidden), []);
});

test('Review Focus 1: a board cached before the deploy (no showOnOverview at all) paints every card as shown', () => {
  // Exactly what an old sessionStorage blob holds: settings and custom sections without the key.
  const oldSettings = [{ sectionKey: 'inbox', enabled: true, goal: 9.5, showOnOverview: true }] as unknown as Parameters<typeof boardSections>[0];
  const { showOnOverview: _drop, ...oldCustom } = PROJECTS;
  void _drop;
  const all = boardSections(oldSettings, [oldCustom as CustomSection]);
  assert.ok(all.every((s) => s.showOnOverview === true), 'resolved to shown, never undefined');
  assert.deepEqual(
    overviewSections(all).map((s) => s.id),
    overviewSections(boardSections([], [PROJECTS])).map((s) => s.id),
    'the same cards as a board that says shown everywhere',
  );
  // And a BoardSection built without the key (any other path) is shown too.
  const bare = { ...all.find((s) => s.id === 'inbox')! } as Partial<(typeof all)[number]>;
  delete bare.showOnOverview;
  assert.ok(overviewSections([bare as (typeof all)[number]]).some((s) => s.id === 'inbox'));
});

test('the visibility SQL: both tables get show_on_overview NOT NULL DEFAULT true (absent = shown)', () => {
  for (const table of ['accounting_scoreboard_sections', 'accounting_scoreboard_custom_sections']) {
    const re = new RegExp(`alter table public\\.${table}\\s+add column if not exists show_on_overview boolean not null default true`);
    assert.ok(re.test(VISIBILITY_SQL), table);
  }
  assert.ok(!/\bupdate\b/i.test(VISIBILITY_SQL.replace(/--.*$/gm, '')), 'no data step: every existing row reads the default');
});
