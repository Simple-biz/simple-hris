import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POST_TEMPLATE, TEMPLATE_MAX_LENGTH, renderPostTemplate, templateProblem } from './chat-template';
import { buildProgressMessage } from './chat-summary';
import type { FrequencyProgress } from './tasks';

const CASES: FrequencyProgress[][] = [
  [{ frequency: 'weekly', total: 97, done: 49 }],
  [
    { frequency: 'daily', total: 170, done: 98 },
    { frequency: 'weekly', total: 80, done: 13 },
  ],
  [
    { frequency: 'daily', total: 3, done: 0 },
    { frequency: 'weekly', total: 2, done: 2 },
    { frequency: 'monthly', total: 40, done: 5 },
  ],
];

test("the seeded template renders exactly the sentence the schedule posted before templates (and the click's)", () => {
  for (const progress of CASES) assert.equal(renderPostTemplate(DEFAULT_POST_TEMPLATE, progress), buildProgressMessage(progress));
  assert.equal(
    renderPostTemplate(DEFAULT_POST_TEMPLATE, CASES[0]),
    'Current progress: 49 of 97 weekly tasks have been completed. As you complete your tasks, remember to check them off.',
  );
});

test('{progress} becomes the counts in words, everywhere it appears; the rest is kept as written', () => {
  assert.equal(
    renderPostTemplate('Happy Friday! {progress} done.\nKeep going: {progress}.', CASES[0]),
    'Happy Friday! 49 of 97 weekly tasks done.\nKeep going: 49 of 97 weekly tasks.',
  );
  assert.equal(renderPostTemplate('Tick your tasks before you log off.', CASES[1]), 'Tick your tasks before you log off.');
});

test('only {progress} is a placeholder: a typo is refused before it can reach the Chat', () => {
  assert.equal(templateProblem(DEFAULT_POST_TEMPLATE), null);
  assert.equal(templateProblem('No placeholder at all.'), null);
  assert.equal(templateProblem('{progres} done'), "{progres} isn't a placeholder. The only one is {progress}.");
  assert.equal(templateProblem('{Progress}'), "{Progress} isn't a placeholder. The only one is {progress}.");
  assert.equal(templateProblem('{name} {date} {name}'), "{name}, {date} aren't placeholders. The only one is {progress}.");
  assert.equal(templateProblem('{}'), "{} isn't a placeholder. The only one is {progress}.");
});

test('blank or too long is refused', () => {
  assert.equal(templateProblem(''), 'Write the message.');
  assert.equal(templateProblem('   \n '), 'Write the message.');
  assert.equal(templateProblem('x'.repeat(TEMPLATE_MAX_LENGTH)), null);
  assert.equal(templateProblem('x'.repeat(TEMPLATE_MAX_LENGTH + 1)), 'Keep the message to 1,000 characters.');
});
