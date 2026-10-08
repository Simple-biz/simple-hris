import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_CELLS,
  barCells,
  barTier,
  buildProgressMessage,
  buildProgressPost,
  percentDone,
  progressBarHtml,
  progressHeading,
} from './chat-summary';

test("the team chat's message, in its own words", () => {
  assert.equal(
    buildProgressMessage([
      { frequency: 'daily', total: 170, done: 98 },
      { frequency: 'weekly', total: 80, done: 13 },
    ]),
    'Current progress: 98 of 170 daily tasks and 13 of 80 weekly tasks have been completed. ' +
      'As you complete your tasks, remember to check them off.',
  );
});

test('three or more frequencies are a list', () => {
  assert.match(
    buildProgressMessage([
      { frequency: 'daily', total: 2, done: 1 },
      { frequency: 'weekly', total: 2, done: 2 },
      { frequency: 'monthly', total: 1, done: 0 },
    ]),
    /^Current progress: 1 of 2 daily tasks, 2 of 2 weekly tasks and 0 of 1 monthly tasks have been completed\./,
  );
});

test('one frequency, and the annual word', () => {
  assert.match(buildProgressMessage([{ frequency: 'annually', total: 3, done: 1 }]), /^Current progress: 1 of 3 annual tasks have been completed\./);
});

test('no tasks', () => {
  assert.equal(buildProgressMessage([]), 'No tasks on the board yet.');
});

// The Chat post's bars card (Kane, 2026-10-08: "Can we send a progress bar?").

const cellsIn = (html: string, color: string) => (html.match(new RegExp(`<font color="${color}">(█*)</font>`))?.[1] ?? '').length;

test('a bar is full only when everything is done, and some done always shows a cell', () => {
  assert.equal(barCells(0, 170), 0);
  assert.equal(barCells(1, 170), 1); // rounds to 0, shown as 1
  assert.equal(barCells(98, 170), 12);
  assert.equal(barCells(169, 170), BAR_CELLS - 1); // rounds to 20, held at 19
  assert.equal(barCells(170, 170), BAR_CELLS);
  assert.equal(barCells(0, 0), 0);
});

test('the percent rounds down, so 100% means everything', () => {
  assert.equal(percentDone(98, 170), 57);
  assert.equal(percentDone(169, 170), 99);
  assert.equal(percentDone(170, 170), 100);
  assert.equal(percentDone(0, 0), 0);
});

// Kane, 2026-10-08: "as we are reaching the goal we are like red orange green".
test('red under 50%, orange from 50%, green from 90%, by the printed percent', () => {
  assert.equal(barTier(0, 170), 'red');
  assert.equal(barTier(1, 170), 'red');
  assert.equal(barTier(84, 170), 'red'); // 49%
  assert.equal(barTier(85, 170), 'orange'); // 50%
  assert.equal(barTier(98, 170), 'orange'); // 57%
  assert.equal(barTier(152, 170), 'orange'); // 89%
  assert.equal(barTier(153, 170), 'green'); // 90%
  assert.equal(barTier(169, 170), 'green'); // 99%
  assert.equal(barTier(170, 170), 'green');
  // The colour follows the number shown: 89.9% prints 89% and stays orange.
  assert.equal(percentDone(899, 1000), 89);
  assert.equal(barTier(899, 1000), 'orange');
});

const RED = '#dc2626';
const ORANGE = '#ea580c';
const GREEN = '#059669';
const GREY = '#d1d5db';

test('the done cells take their tier colour, the rest is grey, always 20 cells', () => {
  const low = progressBarHtml({ done: 40, total: 170 }); // 23%: 5 cells
  assert.equal(cellsIn(low, RED), 5);
  assert.equal(cellsIn(low, GREY), 15);
  const mid = progressBarHtml({ done: 98, total: 170 }); // 57%: 12 cells
  assert.equal(cellsIn(mid, ORANGE), 12);
  assert.equal(cellsIn(mid, GREY), 8);
  const near = progressBarHtml({ done: 169, total: 170 }); // 99%: green, but not full
  assert.equal(cellsIn(near, GREEN), BAR_CELLS - 1);
  assert.equal(cellsIn(near, GREY), 1);
  const all = progressBarHtml({ done: 5, total: 5 });
  assert.equal(cellsIn(all, GREEN), BAR_CELLS);
  assert.ok(!all.includes(GREY));
  const none = progressBarHtml({ done: 0, total: 5 });
  assert.equal(cellsIn(none, GREY), BAR_CELLS);
  assert.ok(![RED, ORANGE, GREEN].some((c) => none.includes(c)));
  // Only one tier colour ever appears in one bar.
  for (const html of [low, mid, near, all]) {
    assert.equal([RED, ORANGE, GREEN].filter((c) => html.includes(c)).length, 1);
  }
});

test('the heading is the Eastern day and time the counts were read', () => {
  assert.equal(progressHeading(new Date('2026-10-08T19:00:00Z')), 'Thu, Oct 8 · 3:00 PM ET');
  assert.equal(progressHeading(new Date('2026-12-09T14:05:00Z')), 'Wed, Dec 9 · 9:05 AM ET');
});

test('the post keeps the sentence as its text and adds one bar per frequency', () => {
  const post = buildProgressPost(
    [
      { frequency: 'daily', total: 170, done: 98 },
      { frequency: 'weekly', total: 80, done: 13 },
    ],
    new Date('2026-10-08T19:00:00Z'),
  );
  assert.equal(
    post.text,
    'Current progress: 98 of 170 daily tasks and 13 of 80 weekly tasks have been completed. ' +
      'As you complete your tasks, remember to check them off.',
  );
  const card = post.cardsV2?.[0]?.card;
  assert.ok(card);
  assert.deepEqual(card.header, { title: 'Task progress', subtitle: 'Thu, Oct 8 · 3:00 PM ET' });
  const rows = card.sections[0].widgets.map((w) => [w.decoratedText.topLabel, w.decoratedText.bottomLabel]);
  assert.deepEqual(rows, [
    ['Daily', '98 of 170 done · 57%'],
    ['Weekly', '13 of 80 done · 16%'],
  ]);
});

test('no tasks: the sentence alone, no card', () => {
  assert.deepEqual(buildProgressPost([], new Date('2026-10-08T19:00:00Z')), { text: 'No tasks on the board yet.' });
});
