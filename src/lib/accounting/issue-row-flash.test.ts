/**
 * Accounting → Issues: the status-change flash. Failure direction first: each test names
 * the wrong behaviour it refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueFlashTone, noteIssueStatuses } from './issue-row-flash';

test('first read of the queue flashes nothing — a row seen for the first time did not "change"', () => {
  const known = new Map<string, string>();
  assert.deepEqual(noteIssueStatuses(known, [['d-1', 'pending'], ['ta-2', 'manager_approved']]), []);
});

test('a re-read with the same statuses flashes nothing', () => {
  const known = new Map<string, string>();
  noteIssueStatuses(known, [['d-1', 'pending']]);
  assert.deepEqual(noteIssueStatuses(known, [['d-1', 'pending']]), []);
});

test('a decision that lands on the next read flashes that row, in its outcome colour', () => {
  const known = new Map<string, string>();
  noteIssueStatuses(known, [['d-1', 'orphanage_manager_approved'], ['ta-2', 'manager_approved'], ['d-3', 'pending']]);
  assert.deepEqual(
    noteIssueStatuses(known, [['d-1', 'accounting_approved'], ['ta-2', 'denied'], ['d-3', 'pending']]),
    [['d-1', 'approved'], ['ta-2', 'denied']],
  );
});

test('switching to a filter slice that omits rows never forgets them, so switching back is not a "change"', () => {
  const known = new Map<string, string>();
  noteIssueStatuses(known, [['d-1', 'pending'], ['d-2', 'approved']]); // All
  assert.deepEqual(noteIssueStatuses(known, [['d-1', 'pending']]), []); // Pending slice
  assert.deepEqual(noteIssueStatuses(known, [['d-1', 'pending'], ['d-2', 'approved']]), []); // All again
});

test('dispute and time-adjustment keys never collide, even on the same id', () => {
  const known = new Map<string, string>();
  noteIssueStatuses(known, [['d-7', 'pending'], ['ta-7', 'manager_approved']]);
  assert.deepEqual(noteIssueStatuses(known, [['d-7', 'pending'], ['ta-7', 'manager_approved']]), []);
});

test('no denied status flashes green, and no approved status flashes red', () => {
  for (const s of ['denied', 'accounting_denied', 'orphanage_manager_denied', 'manager_denied']) {
    assert.equal(issueFlashTone(s), 'denied', s);
  }
  for (const s of ['approved', 'accounting_approved']) {
    assert.equal(issueFlashTone(s), 'approved', s);
  }
});

test('a hand-off between stages is neutral — only a final Accounting outcome is green', () => {
  for (const s of ['pending', 'pending_orphanage_manager', 'orphanage_manager_approved', 'awaiting_second_approval', 'manager_approved']) {
    assert.equal(issueFlashTone(s), 'moved', s);
  }
});
