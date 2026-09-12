import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AMOUNT_EPSILON,
  classifyIssue,
  formatIssueDate,
  issueChipText,
  issueNote,
  nextIssueNo,
  resolveIssueForDisplay,
  shouldPromptBeforeSend,
  type PaystubIssue,
} from './paystub-issue';

/**
 * Pins the reissue vocabulary and the prompt rule.
 *
 * Context measured in production 2026-09-12 (14,033 `paystub_dispatch_queue`
 * rows): send_count 0 → 6,551 · 1 → 7,363 · 2 → 116 · 3 → 1. So 117 statements
 * reached a real employee more than once with NO per-issue history behind them.
 *
 * The failure classes closed here:
 *  1. the word "attempt" never reaches a pay document;
 *  2. an unknown previous total is never reported as "Reissued" (which would
 *     assert the figures matched when nobody compared them);
 *  3. an original statement never gets a badge saying it is normal;
 *  4. the first send is never prompted — only a genuine re-send is;
 *  5. a failed send is not a reissue (no `sent_at` ⇒ no prompt);
 *  6. the 117 pre-existing repeats still render as "Issue N".
 */

const issue = (over: Partial<PaystubIssue> = {}): PaystubIssue => ({
  cycleSourceFile: 'simple-biz_daily_report_2026-09-01_to_2026-09-07.csv',
  recipientEmail: 'someone@simple.biz',
  issueNo: 1,
  issuedAt: '2026-09-08T02:00:00.000Z',
  issuedBy: 'lenny@simple.biz',
  kind: 'original',
  amountPhp: 23_500,
  amountUsd: 420.5,
  previousAmountPhp: null,
  source: 'mark_paid',
  reason: null,
  ...over,
});

// ── 1. The vocabulary ────────────────────────────────────────────────────────

test('the word "attempt" appears nowhere in any employee-facing string', () => {
  const strings = [
    issueChipText('reissued', 2),
    issueChipText('amended', 2),
    issueChipText('unrecorded', 2),
    issueNote({ kind: 'reissued', issueNo: 2, previousIssuedAt: '2026-07-04T10:25:55.972Z' }),
    issueNote({ kind: 'amended', issueNo: 2, previousIssuedAt: null }),
    issueNote({ kind: 'unrecorded', issueNo: 2, previousIssuedAt: null }),
  ].filter(Boolean) as string[];
  assert.ok(strings.length > 0, 'nothing was checked');
  for (const s of strings) {
    assert.doesNotMatch(s, /attempt/i, `"${s}" must not say attempt`);
  }
});

test('unchanged figures are Reissued; moved figures are Amended', () => {
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 23_500, newAmountPhp: 23_500 }),
    'reissued',
  );
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 23_500, newAmountPhp: 24_000 }),
    'amended',
  );
});

test('a centavo below the epsilon is unchanged; at the epsilon it has moved', () => {
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 100, newAmountPhp: 100 + AMOUNT_EPSILON / 2 }),
    'reissued',
  );
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 100, newAmountPhp: 100 + AMOUNT_EPSILON }),
    'amended',
  );
});

test('the first issue is original whatever the amounts say', () => {
  assert.equal(classifyIssue({ issueNo: 1, previousAmountPhp: 1, newAmountPhp: 999 }), 'original');
  assert.equal(classifyIssue({ issueNo: 0, previousAmountPhp: null, newAmountPhp: 5 }), 'original');
});

test('an unknown previous total is UNRECORDED, never Reissued', () => {
  // Reissued asserts the figures matched. Nobody compared them here.
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: null, newAmountPhp: 23_500 }),
    'unrecorded',
  );
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 23_500, newAmountPhp: null }),
    'unrecorded',
  );
});

test('NaN and Infinity are treated as unknown, not as a comparison', () => {
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: NaN, newAmountPhp: 100 }),
    'unrecorded',
  );
  assert.equal(
    classifyIssue({ issueNo: 2, previousAmountPhp: 100, newAmountPhp: Infinity }),
    'unrecorded',
  );
});

// ── 2. Chips ─────────────────────────────────────────────────────────────────

test('an original statement carries NO chip', () => {
  assert.equal(issueChipText('original', 1), null);
  // Defensive: a kind that disagrees with the number still yields no badge on 1.
  assert.equal(issueChipText('reissued', 1), null);
});

test('chips name the word and the number', () => {
  assert.equal(issueChipText('amended', 2), 'Amended · Issue 2');
  assert.equal(issueChipText('reissued', 3), 'Reissued · Issue 3');
});

test('an unrecorded repeat gets the NUMBER ONLY — no word it has not earned', () => {
  assert.equal(issueChipText('unrecorded', 2), 'Issue 2');
});

// ── 3. The note ──────────────────────────────────────────────────────────────

test('an original has no note', () => {
  assert.equal(issueNote({ kind: 'original', issueNo: 1 }), null);
});

test('"replaces the copy sent …" appears ONLY when that date is known', () => {
  const withDate = issueNote({
    kind: 'amended',
    issueNo: 2,
    previousIssuedAt: '2026-07-04T10:25:55.972Z',
  });
  assert.match(withDate!, /replaces the copy sent/);
  const withoutDate = issueNote({ kind: 'amended', issueNo: 2, previousIssuedAt: null });
  assert.doesNotMatch(withoutDate!, /replaces the copy sent/);
});

test('the amended note tells the employee the figures moved', () => {
  const note = issueNote({ kind: 'amended', issueNo: 2, previousIssuedAt: null })!;
  assert.match(note, /figures.*changed/i);
});

test('the reissued note says explicitly that nothing changed', () => {
  const note = issueNote({ kind: 'reissued', issueNo: 2, previousIssuedAt: null })!;
  assert.match(note, /unchanged/i);
});

test('the unrecorded note claims nothing about the figures', () => {
  const note = issueNote({ kind: 'unrecorded', issueNo: 2, previousIssuedAt: null })!;
  assert.doesNotMatch(note, /unchanged/i);
  assert.doesNotMatch(note, /changed/i);
  assert.match(note, /not recorded in detail/i);
});

test('a bad date string never becomes "Invalid Date" on a pay document', () => {
  assert.equal(formatIssueDate('not-a-date'), null);
  assert.equal(formatIssueDate(null), null);
  assert.equal(formatIssueDate(''), null);
});

// ── 4. Issue numbering ───────────────────────────────────────────────────────

test('the first send is issue 1, never 0 and never 2', () => {
  assert.equal(nextIssueNo(0), 1);
  assert.equal(nextIssueNo(null), 1);
  assert.equal(nextIssueNo(undefined), 1);
});

test('a send after one previous send is issue 2', () => {
  assert.equal(nextIssueNo(1), 2);
  assert.equal(nextIssueNo(18), 19);
});

test('a negative or fractional count cannot produce a nonsense issue number', () => {
  assert.equal(nextIssueNo(-5), 1);
  assert.equal(nextIssueNo(2.7), 3);
});

// ── 5. The prompt rule (Q1) ──────────────────────────────────────────────────

test('a FIRST send is never prompted — the common case keeps its single click', () => {
  assert.equal(shouldPromptBeforeSend({ sentAt: null, sendCount: 0 }), false);
});

test('a statement that already went DOES prompt', () => {
  assert.equal(shouldPromptBeforeSend({ sentAt: '2026-09-08T02:00:00.000Z', sendCount: 1 }), true);
});

test('a FAILED earlier send is not a reissue and is not prompted', () => {
  // markPaystubSendError leaves last_error and no sent_at. Re-sending after a
  // failure is still the first delivery, so it must not be gated behind a
  // "you already sent this" prompt.
  assert.equal(shouldPromptBeforeSend({ sentAt: null, sendCount: 1 }), false);
});

// ── 6. Display resolution, including the 117 legacy repeats ──────────────────

test('a statement with no history and one send reads as an original', () => {
  const r = resolveIssueForDisplay({ issues: [], sendCount: 1 });
  assert.equal(r.kind, 'original');
  assert.equal(r.issueNo, 1);
  assert.equal(r.chip, null);
});

test('a statement never sent at all still reads as issue 1, never issue 0', () => {
  const r = resolveIssueForDisplay({ issues: [], sendCount: 0 });
  assert.equal(r.issueNo, 1);
  assert.equal(r.chip, null);
});

test('the 117 legacy repeats render as "Issue 2" with no word attached', () => {
  // send_count is real; the per-issue totals were never recorded.
  const r = resolveIssueForDisplay({ issues: [], sendCount: 2 });
  assert.equal(r.kind, 'unrecorded');
  assert.equal(r.issueNo, 2);
  assert.equal(r.chip, 'Issue 2');
  assert.doesNotMatch(r.note!, /Reissued|Amended/);
});

test('recorded history WINS over the bare counter', () => {
  const r = resolveIssueForDisplay({
    issues: [
      issue({ issueNo: 1, kind: 'original', issuedAt: '2026-09-08T02:00:00.000Z' }),
      issue({
        issueNo: 2,
        kind: 'amended',
        amountPhp: 24_000,
        previousAmountPhp: 23_500,
        issuedAt: '2026-09-09T02:00:00.000Z',
      }),
    ],
    sendCount: 99,
  });
  assert.equal(r.kind, 'amended');
  assert.equal(r.issueNo, 2, 'the recorded issue number beats a stale counter');
  assert.equal(r.chip, 'Amended · Issue 2');
  assert.match(r.note!, /replaces the copy sent/);
});

test('the note dates from the PREVIOUS issue, not the current one', () => {
  const r = resolveIssueForDisplay({
    issues: [
      issue({ issueNo: 1, issuedAt: '2026-07-04T10:25:55.972Z' }),
      issue({ issueNo: 2, kind: 'reissued', issuedAt: '2026-09-09T02:00:00.000Z' }),
    ],
    sendCount: 2,
  });
  // Asserted via formatIssueDate rather than a hard-coded string: the point of
  // this test is WHICH issue supplies the date, not how a locale orders it.
  const prevDate = formatIssueDate('2026-07-04T10:25:55.972Z')!;
  const curDate = formatIssueDate('2026-09-09T02:00:00.000Z')!;
  assert.notEqual(prevDate, curDate, 'the two dates must differ for this to prove anything');
  assert.ok(r.note!.includes(prevDate), `note should carry the PREVIOUS date ${prevDate}`);
  assert.ok(!r.note!.includes(curDate), 'note must not carry the current issue date');
});

test('issues arriving out of order still resolve to the newest', () => {
  const r = resolveIssueForDisplay({
    issues: [
      issue({ issueNo: 2, kind: 'reissued', issuedAt: '2026-09-09T02:00:00.000Z' }),
      issue({ issueNo: 1, issuedAt: '2026-09-08T02:00:00.000Z' }),
    ],
    sendCount: 2,
  });
  assert.equal(r.issueNo, 2);
  assert.equal(r.kind, 'reissued');
});
