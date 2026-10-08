/** Run: node --import tsx --test src/lib/accounting-scoreboard/validate.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryAllowed,
  parseCollectionCreate,
  parseCustomSectionCreate,
  parseCustomSectionPatch,
  parseEntryWrite,
  parseMemberWrite,
  parseProblemCreate,
  parseProblemTypeArchive,
  parseProblemTypeCreate,
  parseRowCreate,
  parseRowPatch,
  parseSectionPatch,
  parseVerifyWrite,
} from './validate';

const TODAY = '2026-10-01';
const ROW = '3f2b8c1e-0d7a-4b6e-9a51-2c4d6e8f0a1b';

test('entries: a count, a cleared cell, a tick and a time', () => {
  assert.deepEqual(parseEntryWrite({ rowId: ROW, date: '2026-09-28', slot: 'am', value: 94 }, TODAY), {
    ok: true,
    value: { rowId: ROW, date: '2026-09-28', slot: 'am', value: 94 },
  });
  const cleared = parseEntryWrite({ rowId: ROW, date: '2026-09-28', slot: 'pm', value: null }, TODAY);
  assert.equal(cleared.ok && cleared.value.value, null);
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'mtg', value: 1 }, TODAY).ok, true);
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'start', value: 545 }, TODAY).ok, true);
});

test('entries: refused shapes', () => {
  const bad: unknown[] = [
    null,
    [],
    { rowId: 'nope', date: TODAY, slot: 'am', value: 1 },
    { rowId: ROW, date: '2026-10-02', slot: 'am', value: 1 }, // future
    { rowId: ROW, date: '2023-12-31', slot: 'am', value: 1 }, // before 2024
    { rowId: ROW, date: '2026-02-30', slot: 'am', value: 1 },
    { rowId: ROW, date: TODAY, slot: 'noon', value: 1 },
    { rowId: ROW, date: TODAY, slot: 'am', value: -1 },
    { rowId: ROW, date: TODAY, slot: 'am', value: 1.234 },
    { rowId: ROW, date: TODAY, slot: 'am', value: '5' },
    { rowId: ROW, date: TODAY, slot: 'mtg', value: 2 },
    { rowId: ROW, date: TODAY, slot: 'start', value: 1441 },
    { rowId: ROW, date: TODAY, slot: 'end', value: 600.5 },
  ];
  for (const b of bad) assert.equal(parseEntryWrite(b, TODAY).ok, false, JSON.stringify(b));
});

test("entryAllowed: the slot must be the section's and the day must be on its board", () => {
  assert.equal(entryAllowed('buckets', 'am', '2026-09-28').ok, true);
  assert.equal(entryAllowed('buckets', 'day', '2026-09-28').ok, false);
  assert.equal(entryAllowed('buckets', 'am', '2026-09-27').ok, false, 'no Sunday on the buckets board');
  assert.equal(entryAllowed('payroll_timing', 'start', '2026-09-29').ok, false, 'Payroll Timing fills itself from HRIS: nothing is typed');
  assert.equal(entryAllowed('payroll_timing', 'day', '2026-10-02').ok, false);
  assert.equal(entryAllowed('pm_buckets', 'mtg', '2026-09-28').ok, true);
  assert.equal(entryAllowed('collections', 'day', '2026-09-28').ok, false, 'collections come from the log only');
});

test('collections: a legal log line, cleaned', () => {
  const r = parseCollectionCreate(
    { rowId: ROW, date: '2026-09-29', businessName: '  Noragis   Homecare Agency Inc. ', points: 12, amountUsd: 89.3 },
    TODAY,
  );
  assert.deepEqual(r, {
    ok: true,
    value: { rowId: ROW, date: '2026-09-29', businessName: 'Noragis Homecare Agency Inc.', points: 12, amountUsd: 89.3 },
  });
  const noAmount = parseCollectionCreate({ rowId: ROW, date: '2026-09-29', businessName: 'X', points: 1, amountUsd: '' }, TODAY);
  assert.equal(noAmount.ok && noAmount.value.amountUsd, null);
});

test('each refusal names the real problem (the old message blamed decimals for a range error)', () => {
  const msg = (r: { ok: boolean; error?: string }) => (r.ok ? '' : r.error ?? '');
  const entry = (value: unknown) => parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'am', value }, TODAY);
  assert.match(msg(entry(-1)), /can't be negative/);
  assert.match(msg(entry(100_001)), /can't be more than 100,000/);
  assert.match(msg(entry(1.234)), /at most 2 decimals/);
  assert.equal(entry(100_000).ok, true, 'the limit itself is allowed');

  const coll = (over: Record<string, unknown>) =>
    parseCollectionCreate({ rowId: ROW, date: '2026-09-29', businessName: 'X', points: 1, ...over }, TODAY);
  assert.match(msg(coll({ points: 94.05 })), /whole number.*Amount \(USD\)/, 'a dollar figure in Points says where it belongs');
  assert.match(msg(coll({ points: 101 })), /0 to 100/);
  assert.match(msg(coll({ amountUsd: 144.144 })), /dollars and cents/);
  assert.match(msg(coll({ amountUsd: 20_000_000 })), /can't be more than 10,000,000/);
  assert.equal(coll({ points: 11, amountUsd: 657 }).ok, true);
});

test('collections: refused lines', () => {
  const base = { rowId: ROW, date: '2026-09-29', businessName: 'X', points: 1 };
  const bad: unknown[] = [
    { ...base, rowId: undefined },
    { ...base, date: '2026-09-27' }, // Sunday
    { ...base, date: '2026-10-03' }, // future Saturday
    { ...base, businessName: '   ' },
    { ...base, businessName: 'x'.repeat(201) },
    { ...base, points: -1 },
    { ...base, points: 101 },
    { ...base, points: 0.333 },
    { ...base, points: 1.5 }, // points are whole numbers
    { ...base, points: '1' },
    { ...base, amountUsd: -5 },
    { ...base, amountUsd: 'ten' },
  ];
  for (const b of bad) assert.equal(parseCollectionCreate(b, TODAY).ok, false, JSON.stringify(b));
});

test('rows: create a person row or a named row; patch label, order or archive', () => {
  assert.deepEqual(parseRowCreate({ sectionKey: 'inbox', label: ' Payroll  Simple.biz ' }), {
    ok: true,
    value: { sectionKey: 'inbox', customSectionId: null, label: 'Payroll Simple.biz', workEmail: null },
  });
  const person = parseRowCreate({ sectionKey: 'collections', label: 'April', workEmail: ' April@Simple.biz ' });
  assert.equal(person.ok && person.value.workEmail, 'april@simple.biz');
  assert.equal(parseRowCreate({ sectionKey: 'payroll', label: 'X' }).ok, false);
  assert.equal(parseRowCreate({ sectionKey: 'inbox', label: '' }).ok, false);
  assert.equal(parseRowCreate({ sectionKey: 'inbox', label: 'X', workEmail: 'not-an-email' }).ok, false);

  assert.equal(parseRowPatch({ id: ROW, label: 'Mary' }).ok, true);
  assert.equal(parseRowPatch({ id: ROW, sortOrder: 3 }).ok, true);
  assert.equal(parseRowPatch({ id: ROW, archived: true }).ok, true);
  assert.equal(parseRowPatch({ id: ROW, archived: false }).ok, false, 'rows are never un-archived');
  assert.equal(parseRowPatch({ id: ROW }).ok, false);
  assert.equal(parseRowPatch({ id: ROW, sortOrder: -1 }).ok, false);
});

test('members and section switches', () => {
  assert.deepEqual(parseMemberWrite({ workEmail: 'Ashlie@Simple.biz' }), { ok: true, value: { workEmail: 'ashlie@simple.biz' } });
  assert.equal(parseMemberWrite({ workEmail: '' }).ok, false);

  assert.deepEqual(parseSectionPatch({ sectionKey: 'inbox', enabled: false }), { ok: true, value: { sectionKey: 'inbox', enabled: false } });
  assert.deepEqual(parseSectionPatch({ sectionKey: 'collections', goal: 90 }), { ok: true, value: { sectionKey: 'collections', goal: 90 } });
  assert.deepEqual(parseSectionPatch({ sectionKey: 'collections', goal: null }), { ok: true, value: { sectionKey: 'collections', goal: null } });
  // Carla, 2026-10-07: a goal can be set on a section that has none, within its measure's range.
  assert.deepEqual(parseSectionPatch({ sectionKey: 'chargebacks', goal: 8 }), { ok: true, value: { sectionKey: 'chargebacks', goal: 8 } });
  assert.equal(parseSectionPatch({ sectionKey: 'chargebacks', goal: 11 }).ok, false, 'a score goal is 0–10');
  assert.equal(parseSectionPatch({ sectionKey: 'buckets', goal: 11 }).ok, false, 'a score goal is 0–10, sheet goal or not');
  assert.equal(parseSectionPatch({ sectionKey: 'chargeback_outcomes', goal: 50 }).ok, true);
  assert.equal(parseSectionPatch({ sectionKey: 'chargeback_outcomes', goal: 101 }).ok, false, 'a win ratio is 0–100%');
  assert.equal(parseSectionPatch({ sectionKey: 'pm_buckets', goal: 30 }).ok, true);
  assert.equal(parseSectionPatch({ sectionKey: 'onboarding', goal: 40 }).ok, true);
  assert.equal(parseSectionPatch({ sectionKey: 'onboarding', goal: -1 }).ok, false);
  assert.equal(parseSectionPatch({ sectionKey: 'payroll_timing', goal: 120 }).ok, false, 'a cycle score is 0–100%');
  assert.equal(parseSectionPatch({ sectionKey: 'inbox', enabled: 'no' }).ok, false);
  assert.equal(parseSectionPatch({ sectionKey: 'inbox' }).ok, false);
});

test('Show on Overview (Carla, 2026-10-07): a true/false on every built-in and custom section, anything else refused by name', () => {
  assert.deepEqual(parseSectionPatch({ sectionKey: 'onboarding', showOnOverview: false }), {
    ok: true,
    value: { sectionKey: 'onboarding', showOnOverview: false },
  });
  assert.deepEqual(parseSectionPatch({ sectionKey: 'chargeback_outcomes', showOnOverview: true }), {
    ok: true,
    value: { sectionKey: 'chargeback_outcomes', showOnOverview: true },
  });
  assert.deepEqual(parseCustomSectionPatch({ id: ROW, showOnOverview: false }), { ok: true, value: { id: ROW, showOnOverview: false } });
  for (const bad of ['no', 'false', 0, 1, null, [], {}]) {
    const builtIn = parseSectionPatch({ sectionKey: 'onboarding', showOnOverview: bad });
    assert.equal(builtIn.ok, false, JSON.stringify(bad));
    assert.match(builtIn.ok ? '' : builtIn.error, /showOnOverview/, 'the refusal names the field');
    const custom = parseCustomSectionPatch({ id: ROW, showOnOverview: bad });
    assert.equal(custom.ok, false, JSON.stringify(bad));
    assert.match(custom.ok ? '' : custom.error, /showOnOverview/);
  }
  // It is a change on its own, and it rides along with the other fields.
  assert.deepEqual(parseSectionPatch({ sectionKey: 'inbox', enabled: true, showOnOverview: false }), {
    ok: true,
    value: { sectionKey: 'inbox', enabled: true, showOnOverview: false },
  });
});

test('Chargeback Outcomes cells: dollars and cents in usd, a whole number in count, only on that section', () => {
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'usd', value: 99.5 }, TODAY).ok, true);
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'count', value: 1 }, TODAY).ok, true);
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'count', value: 1.5 }, TODAY).ok, false, 'a count is whole');
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'usd', value: 9.999 }, TODAY).ok, false);
  assert.equal(parseEntryWrite({ rowId: ROW, date: TODAY, slot: 'usd', value: 100001 }, TODAY).ok, false, 'the table ceiling');
  assert.equal(entryAllowed('chargeback_outcomes', 'usd', '2026-09-28').ok, true);
  assert.equal(entryAllowed('chargeback_outcomes', 'am', '2026-09-28').ok, false);
  assert.equal(entryAllowed('chargebacks', 'usd', '2026-09-28').ok, false);
  assert.equal(entryAllowed('payroll_problems', 'day', '2026-09-28').ok, false, 'Payroll Problems is a log now');
  const custom = { title: 'Refunds', kind: 'daily' as const, days: ['mon', 'tue', 'wed', 'thu', 'fri'] as const };
  assert.equal(entryAllowed(custom, 'day', '2026-09-28').ok, true);
  assert.equal(entryAllowed(custom, 'am', '2026-09-28').ok, false);
  assert.equal(entryAllowed(custom, 'day', '2026-09-27').ok, false, 'no Sunday');
});

test('rows: a custom row names its custom section; a bucket day and the due-soon flag patch', () => {
  const CUSTOM = '11111111-1111-4111-8111-111111111111';
  const c = parseRowCreate({ sectionKey: 'custom', customSectionId: CUSTOM, label: 'Line 1' });
  assert.equal(c.ok && c.value.customSectionId, CUSTOM);
  assert.equal(parseRowCreate({ sectionKey: 'custom', label: 'Line 1' }).ok, false, 'a custom row needs its section');
  assert.equal(parseRowCreate({ sectionKey: 'inbox', customSectionId: CUSTOM, label: 'X' }).ok, false);
  assert.deepEqual(parseRowPatch({ id: ROW, bucketDay: 'wed' }), { ok: true, value: { id: ROW, bucketDay: 'wed' } });
  assert.deepEqual(parseRowPatch({ id: ROW, bucketDay: null }), { ok: true, value: { id: ROW, bucketDay: null } });
  assert.equal(parseRowPatch({ id: ROW, bucketDay: 'sat' }).ok, false);
  assert.deepEqual(parseRowPatch({ id: ROW, dueSoon: true }), { ok: true, value: { id: ROW, dueSoon: true } });
  assert.equal(parseRowPatch({ id: ROW, dueSoon: 'yes' }).ok, false);
});

test('rows: a Chargeback Outcomes line counts as a win, a loss or neither (null)', () => {
  assert.deepEqual(parseRowPatch({ id: ROW, outcome: 'win' }), { ok: true, value: { id: ROW, outcome: 'win' } });
  assert.deepEqual(parseRowPatch({ id: ROW, outcome: null }), { ok: true, value: { id: ROW, outcome: null } }, 'null clears it, and counts as a change');
  for (const bad of ['Wins', 'won', 'pre_arb', '', 1, true]) assert.equal(parseRowPatch({ id: ROW, outcome: bad }).ok, false, String(bad));
});

test('Payment Verified: a collection id and a true/false', () => {
  assert.deepEqual(parseVerifyWrite({ collectionId: ROW, verified: true }), { ok: true, value: { collectionId: ROW, verified: true } });
  assert.equal(parseVerifyWrite({ collectionId: ROW, verified: 'yes' }).ok, false);
  assert.equal(parseVerifyWrite({ collectionId: 'x', verified: true }).ok, false);
});

test('Payroll Problems: a person, a weekday, a type and a whole count 0–1000 (default 1; 0 since 2026-10-07)', () => {
  const TYPE = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(parseProblemCreate({ rowId: ROW, date: '2026-09-29', typeId: TYPE }, TODAY), {
    ok: true,
    value: { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 1 },
  });
  assert.equal(parseProblemCreate({ rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 51 }, TODAY).ok, true);
  // Kane, 2026-10-07: "0 can count as 0 problems".
  assert.deepEqual(parseProblemCreate({ rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 0 }, TODAY), {
    ok: true,
    value: { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 0 },
  });
  const bad: unknown[] = [
    { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: -1 },
    { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: null },
    { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: '0' },
    { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 1.5 },
    { rowId: ROW, date: '2026-09-29', typeId: TYPE, count: 1001 },
    { rowId: ROW, date: '2026-09-27', typeId: TYPE }, // Sunday
    { rowId: ROW, date: '2026-10-02', typeId: TYPE }, // future
    { rowId: ROW, date: '2026-09-29' }, // no type
  ];
  for (const b of bad) assert.equal(parseProblemCreate(b, TODAY).ok, false, JSON.stringify(b));
  assert.deepEqual(parseProblemTypeCreate({ label: '  Bank   Error ' }), { ok: true, value: { label: 'Bank Error' } });
  assert.equal(parseProblemTypeCreate({ label: '' }).ok, false);
  assert.equal(parseProblemTypeArchive({ id: TYPE, archived: true }).ok, true);
  assert.equal(parseProblemTypeArchive({ id: TYPE, archived: false }).ok, false, 'a type is never brought back');
});

test('custom sections: a name, one of two kinds, and a goal that fits the kind', () => {
  assert.deepEqual(parseCustomSectionCreate({ title: ' Refunds ', kind: 'daily' }), {
    ok: true,
    value: { title: 'Refunds', kind: 'daily', goal: null, goalDirection: null, hostSectionKey: null },
  });
  assert.deepEqual(parseCustomSectionCreate({ title: 'Refunds', kind: 'daily', goal: 20, goalDirection: 'below' }), {
    ok: true,
    value: { title: 'Refunds', kind: 'daily', goal: 20, goalDirection: 'below', hostSectionKey: null },
  });
  assert.deepEqual(parseCustomSectionCreate({ title: 'Queue', kind: 'am_pm', goal: 8 }), {
    ok: true,
    value: { title: 'Queue', kind: 'am_pm', goal: 8, goalDirection: 'at_least', hostSectionKey: null },
  });
  assert.equal(parseCustomSectionCreate({ title: 'Queue', kind: 'am_pm', goal: 11 }).ok, false, 'a score goal is 0–10');
  assert.equal(parseCustomSectionCreate({ title: 'Queue', kind: 'am_pm', goal: 8, goalDirection: 'below' }).ok, false);
  assert.equal(parseCustomSectionCreate({ title: 'Refunds', kind: 'daily', goal: 20 }).ok, false, 'say at least or below');
  assert.equal(parseCustomSectionCreate({ title: 'Refunds', kind: 'time' }).ok, false);
  assert.equal(parseCustomSectionCreate({ title: '', kind: 'daily' }).ok, false);
  assert.equal(parseCustomSectionPatch({ id: ROW, enabled: false }).ok, true);
  assert.equal(parseCustomSectionPatch({ id: ROW, archived: false }).ok, false);
  assert.equal(parseCustomSectionPatch({ id: ROW }).ok, false);
});

test("custom sections: shown inside a built-in tab only when hostSectionKey says so, never by the section's name", () => {
  // Carla, 2026-10-07: "Sales - Projects Onboarded" under Sales Onboarding.
  const hosted = parseCustomSectionCreate({ title: 'Sales - Projects Onboarded', kind: 'daily', hostSectionKey: 'onboarding' });
  assert.equal(hosted.ok && hosted.value.hostSectionKey, 'onboarding');
  const named = parseCustomSectionCreate({ title: 'Sales Onboarding - Projects Onboarded', kind: 'daily' });
  assert.equal(named.ok && named.value.hostSectionKey, null, 'a name that starts with a tab label is still a tab of its own');
  assert.equal(parseCustomSectionCreate({ title: 'X', kind: 'daily', hostSectionKey: null }).ok, true);
  for (const bad of ['chargeback_outcomes', 'custom', 'Sales Onboarding', 'sales_onboarding', '', 7, true]) {
    assert.equal(parseCustomSectionCreate({ title: 'X', kind: 'daily', hostSectionKey: bad }).ok, false, String(bad));
    assert.equal(parseCustomSectionPatch({ id: ROW, hostSectionKey: bad }).ok, false, String(bad));
  }
  assert.deepEqual(parseCustomSectionPatch({ id: ROW, hostSectionKey: 'chargebacks' }), {
    ok: true,
    value: { id: ROW, hostSectionKey: 'chargebacks' },
  });
  assert.deepEqual(
    parseCustomSectionPatch({ id: ROW, hostSectionKey: null }),
    { ok: true, value: { id: ROW, hostSectionKey: null } },
    'null moves it back to a tab of its own, and counts as a change',
  );
});
