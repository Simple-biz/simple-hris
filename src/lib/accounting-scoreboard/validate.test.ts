/** Run: node --import tsx --test src/lib/accounting-scoreboard/validate.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  entryAllowed,
  parseCollectionCreate,
  parseEntryWrite,
  parseMemberWrite,
  parseRowCreate,
  parseRowPatch,
  parseSectionPatch,
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
  assert.equal(entryAllowed('payroll_timing', 'start', '2026-09-27').ok, true, 'payroll runs on Sunday');
  assert.equal(entryAllowed('payroll_timing', 'start', '2026-10-02').ok, false, 'no Friday on payroll timing');
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
    { ...base, amountUsd: -5 },
    { ...base, amountUsd: 'ten' },
  ];
  for (const b of bad) assert.equal(parseCollectionCreate(b, TODAY).ok, false, JSON.stringify(b));
});

test('rows: create a person row or a named row; patch label, order or archive', () => {
  assert.deepEqual(parseRowCreate({ sectionKey: 'inbox', label: ' Payroll  Simple.biz ' }), {
    ok: true,
    value: { sectionKey: 'inbox', label: 'Payroll Simple.biz', workEmail: null },
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
  assert.equal(parseSectionPatch({ sectionKey: 'chargebacks', goal: 5 }).ok, false, 'no goal is invented for a goal-less section');
  assert.equal(parseSectionPatch({ sectionKey: 'inbox', enabled: 'no' }).ok, false);
  assert.equal(parseSectionPatch({ sectionKey: 'inbox' }).ok, false);
});
