import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgressMessage } from './chat-summary';

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
