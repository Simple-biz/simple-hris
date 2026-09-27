import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WizardSetup, WizardSetupStep } from './wizard-setup-steps';
import { AWAITING_CSV_KEY, buildCycleGreeting, parseStepNo } from './cycle-greeting';

const FILE = 'simple-biz_daily_report_2026-09-13_to_2026-09-19.csv';

function setup(
  overrides: Partial<Record<WizardSetupStep['key'], [WizardSetupStep['status'], string?]>> = {},
  extra: Partial<WizardSetup> = {},
): WizardSetup {
  const base: Array<Pick<WizardSetupStep, 'key' | 'stepNo' | 'label'>> = [
    { key: 'csv', stepNo: '1', label: 'Hubstaff CSV' },
    { key: 'fx', stepNo: '2', label: 'USD rate confirmed' },
    { key: 'orphanage', stepNo: '3', label: 'Orphanage hours' },
    { key: 'kpi', stepNo: '5', label: 'KPI bonuses' },
    { key: 'notes', stepNo: '5', label: 'Notes adjustments' },
    { key: 'contractors', stepNo: '6', label: 'Contractor invoices' },
    { key: 'dispatch', stepNo: '8', label: 'Sent to dispatch' },
  ];
  const steps = base.map((b) => {
    const [status, detail] = overrides[b.key] ?? ['done'];
    return { ...b, status, detail: detail ?? `${b.label} ok` } as WizardSetupStep;
  });
  return {
    expectedWeekStart: '2026-09-13',
    weekLabel: 'Sep 13 – Sep 19',
    matchedSourceFile: FILE,
    awaitingWeekStart: null,
    awaitingWeekLabel: null,
    steps,
    doneCount: steps.filter((s) => s.status === 'done').length,
    totalCount: steps.length,
    ...extra,
  };
}

test('every step done and nothing awaiting → the modal does not open (Q4)', () => {
  const g = buildCycleGreeting(setup());
  assert.equal(g.shouldOpen, false);
  assert.deepEqual(g.items, []);
  assert.equal(g.nextUp, null);
  assert.equal(g.done.length, 7);
});

test('USD rates and orphanage are called out by name, with the server detail verbatim', () => {
  const g = buildCycleGreeting(setup({
    fx: ['attention', 'PHP still 0 — Step 2'],
    orphanage: ['attention', 'Paste hours or confirm none on Step 3'],
  }));
  assert.equal(g.shouldOpen, true);
  assert.deepEqual(
    g.items.map((i) => [i.key, i.headline, i.detail, i.jumpStep]),
    [
      ['fx', 'Update the USD → PHP / COP conversion rates', 'PHP still 0 — Step 2', 2],
      ['orphanage', 'Sync the orphanage hours', 'Paste hours or confirm none on Step 3', 3],
    ],
  );
  assert.ok(g.items.every((i) => i.jumpSourceFile === FILE));
});

test('items run most severe first; "next up" is the first open step in RAIL order', () => {
  const g = buildCycleGreeting(setup({
    dispatch: ['pending', 'Not sent yet'],
    contractors: ['attention', '2 awaiting approval'],
    csv: ['blocked', 'Not uploaded yet'],
  }));
  assert.deepEqual(g.items.map((i) => i.key), ['csv', 'contractors', 'dispatch']);
  assert.deepEqual(g.nextUp, { stepNo: '1', label: 'Hubstaff CSV', jumpStep: 1 });
});

test('a pending row keeps its plain label — no imperative it may not deserve', () => {
  const g = buildCycleGreeting(setup({ fx: ['pending', "Couldn't read the cycle rates"] }));
  assert.equal(g.items[0].headline, 'USD rate confirmed');
  assert.equal(g.items[0].status, 'pending');
  assert.ok(!g.done.some((s) => s.key === 'fx'), 'a failed read is never recapped as done');
});

test('an unparseable CSV name reads "check", not "upload"', () => {
  const g = buildCycleGreeting(setup({ csv: ['attention', "Can't tell — the newest upload's name has no week range"] }));
  assert.equal(g.items[0].headline, "Check this week's Hubstaff CSV upload");
});

test('a closed week with no CSV leads the list and points at Step 1 with no file (Q5)', () => {
  const g = buildCycleGreeting(setup({ dispatch: ['pending', 'Not sent yet'] }, { awaitingWeekStart: '2026-09-20', awaitingWeekLabel: 'Sep 20 – Sep 26' }));
  assert.equal(g.items[0].key, AWAITING_CSV_KEY);
  assert.equal(g.items[0].headline, 'Upload the Sep 20 – Sep 26 Hubstaff CSV');
  assert.equal(g.items[0].jumpStep, 1);
  assert.equal(g.items[0].jumpSourceFile, null);
  // The cycle in view still has an open step, so that is where "we are".
  assert.deepEqual(g.nextUp, { stepNo: '8', label: 'Sent to dispatch', jumpStep: 8 });
});

test('a fully done cycle with a closed week waiting still opens, and next up is the new CSV', () => {
  const g = buildCycleGreeting(setup({}, { awaitingWeekStart: '2026-09-20', awaitingWeekLabel: 'Sep 20 – Sep 26' }));
  assert.equal(g.shouldOpen, true);
  assert.equal(g.items.length, 1);
  assert.deepEqual(g.nextUp, { stepNo: '1', label: 'Hubstaff CSV for Sep 20 – Sep 26', jumpStep: 1 });
});

test('no CSV matched yet → jumps carry no file', () => {
  const g = buildCycleGreeting(setup({ csv: ['blocked', 'Not uploaded yet'] }, { matchedSourceFile: null }));
  assert.equal(g.items[0].jumpSourceFile, null);
});

test('parseStepNo accepts only positive whole step numbers', () => {
  assert.equal(parseStepNo('5'), 5);
  assert.equal(parseStepNo(' 8 '), 8);
  assert.equal(parseStepNo('0'), null);
  assert.equal(parseStepNo('4–5'), null);
  assert.equal(parseStepNo(''), null);
});
