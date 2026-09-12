/**
 * What the public gift-address page shows, and what the address is collected for.
 *
 * The property these protect: a milestone nobody has assessed is collected for
 * exactly like one recorded as missed, and NEVER treated as received. Coercing
 * an absence to "received" would hide a real debt from the one person who would
 * notice it — which is the whole reason this page exists.
 *
 * Run:  npx tsx --test src/lib/gift-address/owed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGiftAsk } from './owed';
import { addMonths } from '@/lib/gift-milestones';

const TODAY = new Date('2026-09-12T00:00:00');
/** 26 months back: milestones 1–4 are past, 5 is four months out. */
const START = addMonths(TODAY, -26);

function ask(
  receipts: Array<[number, boolean]> = [],
  submitted: number[] = [],
  start: Date | null = START,
) {
  return buildGiftAsk({
    start,
    today: TODAY,
    receiptsByIndex: new Map(receipts),
    submittedIndexes: new Set(submitted),
  });
}

test('every milestone reached since the start date is listed, oldest first', () => {
  const a = ask();
  assert.equal(a.milestones.length, 4);
  assert.deepEqual(a.milestones.map((m) => m.milestoneIndex), [1, 2, 3, 4]);
});

test('a milestone that has not arrived is not listed', () => {
  const a = ask();
  assert.equal(a.milestones.some((m) => m.milestoneIndex === 5), false);
});

test('NO receipt row means PENDING — never received', () => {
  // 239 active people were absent from the source sheet entirely. If their
  // absence read as "received", this page would quietly stop asking the people
  // most likely to be owed something.
  const a = ask();
  assert.equal(a.pendingCount, 4);
  assert.equal(a.receivedCount, 0);
  assert.deepEqual(a.collectFor, [1, 2, 3, 4]);
  assert.equal(a.milestones.every((m) => m.state === 'pending'), true);
});

test('a recorded miss and an unassessed milestone are presented identically', () => {
  // The difference is about OUR bookkeeping and the employee cannot act on it.
  const a = ask([[1, false]]);
  const recordedMiss = a.milestones.find((m) => m.milestoneIndex === 1)!;
  const neverAssessed = a.milestones.find((m) => m.milestoneIndex === 2)!;
  assert.equal(recordedMiss.state, neverAssessed.state);
  assert.equal(recordedMiss.state, 'pending');
});

test('a received gift is shown as received and is NOT collected for again', () => {
  const a = ask([[1, true], [2, true]]);
  assert.equal(a.receivedCount, 2);
  assert.equal(a.pendingCount, 2);
  assert.deepEqual(a.collectFor, [3, 4]);
});

test('everything received means nothing to collect — the page has nothing to ask', () => {
  const a = ask([[1, true], [2, true], [3, true], [4, true]]);
  assert.equal(a.pendingCount, 0);
  assert.deepEqual(a.collectFor, []);
  assert.equal(a.receivedCount, 4);
});

test('an address already on file is flagged but the milestone is still collected for', () => {
  // They may be correcting it — a submitted address is not a reason to stop asking.
  const a = ask([], [2]);
  assert.equal(a.milestones.find((m) => m.milestoneIndex === 2)!.hasAddress, true);
  assert.equal(a.milestones.find((m) => m.milestoneIndex === 1)!.hasAddress, false);
  assert.deepEqual(a.collectFor, [1, 2, 3, 4]);
});

test('no start date reaches nothing and asks for no address', () => {
  // A roster problem to fix upstream, never something to paper over by
  // inventing a milestone.
  const a = ask([], [], null);
  assert.deepEqual(a.milestones, []);
  assert.deepEqual(a.collectFor, []);
  assert.equal(a.pendingCount, 0);
});

test('a receipt beyond the reached milestones does not invent a row', () => {
  const a = ask([[9, true]]);
  assert.equal(a.milestones.length, 4);
});

test('labels are the shared ones — internal and celebratory both present', () => {
  const a = ask();
  const first = a.milestones[0];
  assert.equal(first.label, '6-month');
  assert.equal(first.tenure, '6 Months');
  assert.equal(a.milestones[1].tenure, '1 Year');
  assert.equal(a.milestones[3].tenure, '2 Years');
  assert.ok(first.message.length > 20, 'every milestone carries its thank-you copy');
});

test('a milestone past the source sheet ceiling still gets copy, never a blank', () => {
  // 18 people are already past the 48-month (index 8) gift.
  const old = addMonths(TODAY, -60); // 10 milestones reached
  const a = ask([], [], old);
  assert.ok(a.milestones.length >= 9);
  const tenth = a.milestones[9];
  assert.ok(tenth.message.length > 20);
  assert.equal(tenth.tenure, '5 Years');
});

test('the milestone date is a plain ISO day, with no timezone in it', () => {
  const a = ask();
  for (const m of a.milestones) assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
});
