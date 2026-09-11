/**
 * Tenure-gift fulfilment state.
 *
 * The property every one of these exists to protect: NO ROW MEANS UNKNOWN.
 * 239 people on the active roster were absent from the 2026-09-11 source sheet,
 * so a reader that coerces "no assertion" to "not received" invents a 239-person
 * backlog, and one that coerces it to "received" hides a real one. `unknown` is
 * a state, not a gap to fill in.
 *
 * Run:  npx tsx --test src/lib/gift-tracker/receipts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersonReceiptSummary,
  isEarlyReceipt,
  isMilestoneDue,
  milestoneDateFor,
  milestoneLabel,
  receiptStateFor,
  type GiftReceiptState,
} from './receipts';
import { addMonths, diffDays, MONTHS_PER_MILESTONE } from '@/lib/gift-milestones';

const TODAY = new Date('2026-09-11T00:00:00');

/**
 * Every start date here is DERIVED from TODAY through the shared helpers, never
 * written as a literal.
 *
 * `parseStartDate` reads a date-only string as UTC midnight, which is a day
 * earlier in local time anywhere west of UTC, while `new Date('…T00:00:00')` is
 * local. Mixing the two makes a milestone land a day off and the suite pass in
 * Manila and fail in the US — the precise trap
 * docs/features/gift-tracker-shipping-export.md warns about. Deriving sidesteps it.
 *
 * 26 months back puts milestones 1–4 in the past and 5 four months out.
 */
const START = addMonths(TODAY, -26);

function state(received: boolean | undefined, milestoneIndex = 1, start: Date | null = START): GiftReceiptState {
  return receiptStateFor({ start, milestoneIndex, today: TODAY, received });
}

// ── Absence is unknown ───────────────────────────────────────────────────────

test('a due milestone with NO assertion is unknown — never owed', () => {
  assert.equal(state(undefined, 1), 'unknown');
  assert.notEqual(state(undefined, 1), 'owed');
});

test('a due milestone asserted false is owed', () => {
  assert.equal(state(false, 1), 'owed');
});

test('a milestone that has not arrived is not_due, with or without an assertion', () => {
  assert.equal(state(undefined, 6), 'not_due');
  assert.equal(state(false, 6), 'not_due');
});

test('received wins everywhere, including before the milestone arrives', () => {
  assert.equal(state(true, 1), 'received');
  assert.equal(state(true, 6), 'received');
});

test('no start date makes every milestone unknown, never not_due', () => {
  assert.equal(state(undefined, 1, null), 'unknown');
  assert.equal(state(false, 1, null), 'unknown');
  // A stated receipt survives a missing start date.
  assert.equal(state(true, 1, null), 'received');
});

// ── Due-ness ─────────────────────────────────────────────────────────────────

test('a milestone falling exactly today is due', () => {
  const start = addMonths(TODAY, -MONTHS_PER_MILESTONE);
  assert.equal(diffDays(milestoneDateFor(start, 1), TODAY), 0);
  assert.equal(isMilestoneDue(start, 1, TODAY), true);
  assert.equal(receiptStateFor({ start, milestoneIndex: 1, today: TODAY, received: false }), 'owed');
});

test('a milestone falling tomorrow is not due', () => {
  const tomorrow = new Date(TODAY.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  const start = addMonths(tomorrow, -MONTHS_PER_MILESTONE);
  assert.equal(diffDays(milestoneDateFor(start, 1), TODAY), 1);
  assert.equal(isMilestoneDue(start, 1, TODAY), false);
  assert.equal(receiptStateFor({ start, milestoneIndex: 1, today: TODAY, received: false }), 'not_due');
});

test('isMilestoneDue is total on a null start and answers false', () => {
  assert.equal(isMilestoneDue(null, 1, TODAY), false);
});

test('milestone labels come from the shared helper', () => {
  assert.equal(milestoneLabel(1), '6-month');
  assert.equal(milestoneLabel(4), '24-month');
  assert.equal(milestoneLabel(8), '48-month');
});

// ── Early receipts are flagged, not swallowed ────────────────────────────────

test('a receipt recorded before its milestone is flagged early', () => {
  assert.equal(isEarlyReceipt({ start: START, milestoneIndex: 6, today: TODAY, received: true }), true);
  assert.equal(isEarlyReceipt({ start: START, milestoneIndex: 1, today: TODAY, received: true }), false);
  assert.equal(isEarlyReceipt({ start: START, milestoneIndex: 6, today: TODAY, received: false }), false);
});

// ── Person summary ───────────────────────────────────────────────────────────

test('summary counts received, owed and unknown separately and never nets them', () => {
  const summary = buildPersonReceiptSummary({
    start: START,
    today: TODAY,
    receiptsByIndex: new Map([
      [1, true],
      [2, false],
      // 3 and 4 are due with nothing on record.
    ]),
  });
  assert.equal(summary.dueCount, 4);
  assert.equal(summary.receivedCount, 1);
  assert.equal(summary.owedCount, 1);
  assert.equal(summary.unknownCount, 2);
  assert.equal(summary.milestones.length, 4);
  assert.deepEqual(
    summary.milestones.map((m) => m.state),
    ['received', 'owed', 'unknown', 'unknown'],
  );
});

test('oldestOwed is the lowest-indexed owed milestone', () => {
  const summary = buildPersonReceiptSummary({
    start: START,
    today: TODAY,
    receiptsByIndex: new Map([
      [1, true],
      [2, false],
      [3, false],
      [4, true],
    ]),
  });
  assert.equal(summary.oldestOwed?.milestoneIndex, 2);
  assert.equal(summary.oldestOwed?.label, '12-month');
  assert.equal(summary.owedCount, 2);
});

test('a person with no receipts at all is entirely unknown, and owes nothing yet stated', () => {
  const summary = buildPersonReceiptSummary({
    start: START,
    today: TODAY,
    receiptsByIndex: new Map(),
  });
  assert.equal(summary.dueCount, 4);
  assert.equal(summary.unknownCount, 4);
  assert.equal(summary.owedCount, 0);
  assert.equal(summary.oldestOwed, null);
});

test('a person with no start date and no receipts yields an empty walk, not a fabricated one', () => {
  const summary = buildPersonReceiptSummary({
    start: null,
    today: TODAY,
    receiptsByIndex: new Map(),
  });
  assert.deepEqual(summary.milestones, []);
  assert.equal(summary.dueCount, 0);
  assert.equal(summary.owedCount, 0);
});

test('an assertion beyond the last due milestone still appears in the walk', () => {
  const summary = buildPersonReceiptSummary({
    start: START,
    today: TODAY,
    receiptsByIndex: new Map([[6, true]]),
  });
  assert.equal(summary.milestones.length, 6);
  assert.equal(summary.milestones[5].state, 'received');
  assert.equal(summary.milestones[5].early, true);
  // The four due milestones with nothing on record stay unknown.
  assert.equal(summary.unknownCount, 4);
  assert.equal(summary.milestones[4].state, 'not_due');
});

test('a person with receipts but no start date gets dates of null, not today', () => {
  const summary = buildPersonReceiptSummary({
    start: null,
    today: TODAY,
    receiptsByIndex: new Map([[1, true]]),
  });
  assert.equal(summary.milestones.length, 1);
  assert.equal(summary.milestones[0].date, null);
  assert.equal(summary.milestones[0].state, 'received');
});
