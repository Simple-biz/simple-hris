import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLoadFence } from './load-fence';

/**
 * Pins the stale-load fence that useDispatchQueue.load() wraps every state
 * write in (2026-09-03). The failure it closes: an earlier-started, slower load
 * resolving AFTER a Mark Paid and repainting the paid person into Pending.
 */

test('the newest ticket is current, every earlier one is stale', () => {
  const fence = createLoadFence();
  const first = fence.start();
  assert.equal(fence.isCurrent(first), true);
  const second = fence.start();
  assert.equal(fence.isCurrent(first), false);
  assert.equal(fence.isCurrent(second), true);
});

test('the race: a slow early load must not overwrite a later one', async () => {
  const fence = createLoadFence();
  const painted: string[] = [];

  const load = async (label: string, delayMs: number) => {
    const ticket = fence.start();
    await new Promise((r) => setTimeout(r, delayMs));
    if (!fence.isCurrent(ticket)) return; // stale — drop it
    painted.push(label);
  };

  // The poll-triggered load starts first but is slow; the post-Mark-Paid
  // refresh starts later and is fast.
  await Promise.all([load('stale-poll (still lists cobb@)', 30), load('refresh (cobb@ paid)', 5)]);
  assert.deepEqual(painted, ['refresh (cobb@ paid)']);
});

test('a ticket handed out before any later start stays current until then', () => {
  const fence = createLoadFence();
  const t = fence.start();
  assert.equal(fence.isCurrent(t), true);
  assert.equal(fence.isCurrent(t), true); // idempotent read
  assert.equal(fence.isCurrent(0), false); // never-issued ticket is never current
});
