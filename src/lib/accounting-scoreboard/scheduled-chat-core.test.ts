import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SENT_WITHOUT_CARD, anyPostFailed, postSlot, type ClaimOutcome, type SlotDeps } from './scheduled-chat-core';
import type { ChatSlot } from './chat-schedule';
import type { SendOutcome } from './chat-webhook';
import type { FrequencyProgress } from './tasks';

const DAILY: ChatSlot = { date: '2026-10-08', hour: 15, frequencies: ['daily'] };
const MORNING: ChatSlot = { date: '2026-10-30', hour: 9, frequencies: ['weekly', 'monthly'] };
const TEAM: FrequencyProgress[] = [
  { frequency: 'daily', total: 170, done: 98 },
  { frequency: 'weekly', total: 80, done: 13 },
  { frequency: 'biweekly', total: 10, done: 2 },
  { frequency: 'monthly', total: 40, done: 5 },
];

function fake(over: { claim?: ClaimOutcome; progress?: FrequencyProgress[] | string; send?: SendOutcome; finishOk?: boolean } = {}) {
  const calls: string[] = [];
  const sent: string[] = [];
  const stamps: Array<{ status: string; message?: string; detail?: string }> = [];
  const audits: Array<{ message: string; slot: string; card: boolean }> = [];
  const sentProgress: FrequencyProgress[][] = [];
  const deps: SlotDeps = {
    async claim() {
      calls.push('claim');
      return over.claim ?? { kind: 'claimed', id: 'row-1' };
    },
    async readProgress() {
      calls.push('read');
      const p = over.progress ?? TEAM;
      return typeof p === 'string' ? { ok: false, message: p } : { ok: true, progress: p };
    },
    async send({ message, progress }) {
      calls.push('send');
      sent.push(message);
      sentProgress.push(progress);
      return over.send ?? { status: 'posted', withCard: true };
    },
    async finish(_id, status, fields) {
      calls.push(`finish:${status}`);
      stamps.push({ status, message: fields.message, detail: fields.detail });
      return over.finishOk ?? true;
    },
    async audit(_id, f) {
      calls.push('audit');
      audits.push({ message: f.message, slot: f.slot, card: f.card });
    },
  };
  return { deps, calls, sent, sentProgress, stamps, audits };
}

test('the 3 PM post: claimed first, daily only, stamped posted, audited', async () => {
  const f = fake();
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim', 'read', 'send', 'finish:posted', 'audit']);
  assert.equal(
    f.sent[0],
    'Current progress: 98 of 170 daily tasks have been completed. As you complete your tasks, remember to check them off.',
  );
  assert.deepEqual(f.audits, [{ message: f.sent[0], slot: '2026-10-08 15:00 ET', card: true }]);
  // The card is drawn from the slot's frequencies only: the bars match the sentence.
  assert.deepEqual(f.sentProgress[0], [{ frequency: 'daily', total: 170, done: 98 }]);
  assert.ok(r.ok && r.value.status === 'posted' && r.value.recorded === true && r.value.detail === undefined);
});

test('the bars card refused, the sentence posted alone: stamped posted, says so, audited with card false', async () => {
  const f = fake({ send: { status: 'posted', withCard: false } });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim', 'read', 'send', 'finish:posted', 'audit']);
  assert.equal(f.stamps[0].detail, SENT_WITHOUT_CARD);
  assert.equal(f.audits[0].card, false);
  assert.ok(r.ok && r.value.status === 'posted' && r.value.detail === SENT_WITHOUT_CARD);
});

test('a morning that is weekly and monthly is one message with both, and nothing else (no bi-weekly)', async () => {
  const f = fake();
  await postSlot(MORNING, f.deps);
  assert.equal(
    f.sent[0],
    'Current progress: 13 of 80 weekly tasks and 5 of 40 monthly tasks have been completed. As you complete your tasks, remember to check them off.',
  );
});

test('a slot already claimed (duplicate delivery, the other DST entry) sends nothing and stamps nothing', async () => {
  const f = fake({ claim: { kind: 'taken' } });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim']);
  assert.ok(r.ok && r.value.status === 'already_claimed');
});

test('a claim that fails for any other reason stops the run: nothing read, nothing sent', async () => {
  const f = fake({ claim: { kind: 'error', status: 503, code: 'not_set_up', message: 'no table' } });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim']);
  assert.deepEqual(r, { ok: false, status: 503, code: 'not_set_up', message: 'no table' });
});

test('no tasks of the slot frequency: skipped, nothing sent, not audited', async () => {
  const f = fake({ progress: [{ frequency: 'quarterly', total: 3, done: 1 }] });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim', 'read', 'finish:skipped']);
  assert.ok(r.ok && r.value.status === 'skipped');
});

test('a failed read is stamped failed and sends nothing', async () => {
  const f = fake({ progress: 'Could not read the tasks' });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim', 'read', 'finish:failed']);
  assert.ok(r.ok && r.value.status === 'failed');
});

test('a timeout is stamped timed_out, sent once, never audited (it may have posted)', async () => {
  const f = fake({ send: { status: 'timed_out', detail: 'may or may not have posted' } });
  const r = await postSlot(DAILY, f.deps);
  assert.deepEqual(f.calls, ['claim', 'read', 'send', 'finish:timed_out']);
  assert.equal(f.sent.length, 1);
  assert.ok(r.ok && r.value.status === 'timed_out');
});

test('Google refusing is stamped refused with its reason, not audited', async () => {
  const f = fake({ send: { status: 'refused', httpStatus: 404, detail: 'Google Chat refused the post (HTTP 404).' } });
  await postSlot(DAILY, f.deps);
  assert.deepEqual(f.stamps, [
    {
      status: 'refused',
      message: 'Current progress: 98 of 170 daily tasks have been completed. As you complete your tasks, remember to check them off.',
      detail: 'Google Chat refused the post (HTTP 404).',
    },
  ]);
  assert.equal(f.audits.length, 0);
});

test('a post that went out but could not be stamped still counts as posted, and says it was not recorded', async () => {
  const f = fake({ finishOk: false });
  const r = await postSlot(DAILY, f.deps);
  assert.ok(r.ok && r.value.status === 'posted' && r.value.recorded === false);
  assert.deepEqual(f.calls, ['claim', 'read', 'send', 'finish:posted', 'audit']);
});

test('the route reports a failure when any due post did not go out', () => {
  const base = { slot: 's', frequencies: ['daily' as const] };
  assert.equal(anyPostFailed([]), false);
  assert.equal(anyPostFailed([{ ...base, status: 'posted' }, { ...base, status: 'already_claimed' }, { ...base, status: 'skipped' }]), false);
  for (const status of ['refused', 'unreachable', 'timed_out', 'failed'] as const) {
    assert.equal(anyPostFailed([{ ...base, status }]), true, status);
  }
});
