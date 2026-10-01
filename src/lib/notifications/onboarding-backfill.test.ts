import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { submissionsAlreadyNotified } from './onboarding-backfill';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `sub-${i}`);

// 2026-10-01: 1,328 notified submissions, but the old unpaged read saw 306 of
// them. Asked one by one, every notified submission is found, however many
// rows exist for it.
test('every notified submission is found, past any row cap', async () => {
  const all = ids(1328);
  const r = await submissionsAlreadyNotified(all, async () => ({ data: [{ id: 'x' }], error: null }));
  assert.ok(r.ok);
  assert.equal(r.notified.size, 1328);
});

test('only submissions with no row come back as new', async () => {
  const notifiedIds = new Set(['sub-0', 'sub-2']);
  const r = await submissionsAlreadyNotified(ids(4), async (id) => ({
    data: notifiedIds.has(id) ? [{ id: 'x' }] : [],
    error: null,
  }));
  assert.ok(r.ok);
  assert.deepEqual([...r.notified].sort(), ['sub-0', 'sub-2']);
});

// An uncertain dedupe on a write path inserts duplicates, so one failed probe
// fails the whole answer and the caller inserts nothing.
test('one failed probe fails the answer', async () => {
  const r = await submissionsAlreadyNotified(ids(25), async (id) =>
    id === 'sub-17' ? { data: null, error: { message: 'timeout' } } : { data: [{ id: 'x' }], error: null },
  );
  assert.deepEqual(r, { ok: false, error: 'timeout' });
});

test('probes run at most `concurrency` at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  await submissionsAlreadyNotified(
    ids(35),
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { data: [], error: null };
    },
    10,
  );
  assert.equal(peak, 10);
});

// The route must ask per submission, never rebuild the set from one read of
// every onboarding.submitted row — that read is what stopped at 1000.
test('the backfill route asks per submission', () => {
  const src = readFileSync(
    join(process.cwd(), 'app/api/hr/backfill-onboarding-notifications/route.ts'),
    'utf8',
  );
  assert.match(src, /submissionsAlreadyNotified\(/);
  assert.doesNotMatch(src, /\.select\(\s*["']details["']\s*\)/);
  assert.match(src, /selectAllPaged/);
});
