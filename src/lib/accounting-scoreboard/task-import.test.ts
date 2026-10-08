import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskTab } from './task-import';

const HEAD = ['Daily', '', 'Weekly', '', 'Bi-Weekly', '', 'Monthly', '', 'Bi-Monthly', '', 'Quarterly', '', 'Annually', '', 'As Needed', ''];

test('the common layout: a title column per frequency with its checkbox beside it', () => {
  const grid = [
    HEAD,
    ['Clear the inbox', 'FALSE', 'Tuesday: Send Higlobe', 'TRUE', '', '', 'Monthly audit', 'FALSE', '', '', '', '', '', '', 'Update the rate sheet', 'FALSE'],
    ['Sort payments', 'TRUE', '', '', '', '', '', '', '', '', 'File the quarterly', 'FALSE'],
  ];
  const r = parseTaskTab(grid);
  assert.equal(r.headerRow, 0);
  assert.deepEqual(r.frequencies, ['daily', 'weekly', 'biweekly', 'monthly', 'bimonthly', 'quarterly', 'annually', 'as_needed']);
  assert.deepEqual(
    r.tasks.map((t) => [t.frequency, t.title, t.cell]),
    [
      ['daily', 'Clear the inbox', 'A2'],
      ['daily', 'Sort payments', 'A3'],
      ['weekly', 'Tuesday: Send Higlobe', 'C2'],
      ['monthly', 'Monthly audit', 'G2'],
      ['quarterly', 'File the quarterly', 'K3'],
      ['as_needed', 'Update the rate sheet', 'O2'],
    ],
  );
  assert.deepEqual(r.skipped, []);
});

test('the Florida layout: a weekday column inside the weekly block becomes a title prefix', () => {
  const grid = [
    ['Daily', '', 'Weekly', '', '', 'Monthly', '', 'As Needed', ''],
    ['Check voicemail', 'FALSE', 'Send the report', 'Mon', 'FALSE', 'Close the books', 'FALSE', 'Order supplies', 'FALSE'],
    ['', '', 'Thursday: Already named', 'Thurs', 'TRUE'],
  ];
  const r = parseTaskTab(grid);
  assert.deepEqual(
    r.tasks.map((t) => [t.frequency, t.title]),
    [
      ['daily', 'Check voicemail'],
      ['weekly', 'Mon: Send the report'],
      ['weekly', 'Thursday: Already named'],
      ['monthly', 'Close the books'],
      ['as_needed', 'Order supplies'],
    ],
  );
});

test('a header on row 2 is found; a title without a checkbox is a heading or note, skipped and reported', () => {
  const grid = [
    ['Tieg'],
    ['', '', 'Weekly', '', '', 'As Needed', ''],
    ['', '', 'Compliance Tasks', '', '', 'Mark Tasks as Done on the OBS', ''],
    ['', '', 'Send the count', 'Fri', 'FALSE', 'Fix a payout', 'FALSE'],
  ];
  const r = parseTaskTab(grid);
  assert.equal(r.headerRow, 1);
  assert.deepEqual(r.tasks.map((t) => t.title), ['Fri: Send the count', 'Fix a payout']);
  assert.deepEqual(
    r.skipped.map((s) => [s.cell, s.reason]),
    [
      ['C3', 'no_checkbox'],
      ['F3', 'no_checkbox'],
    ],
  );
});

test('a tab with no frequency header is not a task tab', () => {
  assert.deepEqual(parseTaskTab([['Week of', 'Points'], ['10/5', '12']]), { headerRow: null, frequencies: [], tasks: [], skipped: [] });
});

test('the same title twice under one frequency is imported once; real booleans count as checkboxes', () => {
  const grid = [HEAD, ['Clear the inbox', false], ['Clear  the inbox', true]];
  assert.deepEqual(parseTaskTab(grid).tasks.map((t) => t.title), ['Clear the inbox']);
});
