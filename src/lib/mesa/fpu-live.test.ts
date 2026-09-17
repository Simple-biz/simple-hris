import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FPU_LIVE_TOPIC, FPU_LIVE_EVENT, FPU_LIVE_POLL_MS } from './fpu-live';
import { DISPATCH_SYNC_TOPIC, PAID_TOAST_TOPIC } from '@/lib/payroll/dispatch-paid-toast';
import { START_PROCESSING_TOPIC } from '@/lib/payroll/start-processing-broadcast';

// realtime-js reuses one channel per topic per client. A page that already
// joined a topic and joins it again for a different contract collides with
// itself, so every live contract owns its topic (memory/start-processing-broadcast).
test('the FPU live topic is its own — never a dispatch, paid or start-processing topic', () => {
  for (const other of [DISPATCH_SYNC_TOPIC, PAID_TOAST_TOPIC, START_PROCESSING_TOPIC]) {
    assert.notEqual(FPU_LIVE_TOPIC, other);
  }
  assert.match(FPU_LIVE_TOPIC, /^fpu-/);
  assert.equal(FPU_LIVE_EVENT, 'changed');
});

test('the poll floor exists and is measured in seconds, not minutes', () => {
  assert.ok(FPU_LIVE_POLL_MS >= 5_000 && FPU_LIVE_POLL_MS <= 60_000);
});
