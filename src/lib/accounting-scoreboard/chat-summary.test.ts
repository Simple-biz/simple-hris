import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAR_CELLS,
  barCells,
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

test('a bar is green when all done, amber when some, grey track for the rest, always 20 cells', () => {
  const some = progressBarHtml({ done: 98, total: 170 });
  assert.equal(cellsIn(some, '#d97706'), 12);
  assert.equal(cellsIn(some, '#d1d5db'), 8);
  const all = progressBarHtml({ done: 5, total: 5 });
  assert.equal(cellsIn(all, '#059669'), BAR_CELLS);
  assert.ok(!all.includes('#d1d5db'));
  const none = progressBarHtml({ done: 0, total: 5 });
  assert.equal(cellsIn(none, '#d1d5db'), BAR_CELLS);
  assert.ok(!none.includes('#d97706') && !none.includes('#059669'));
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
