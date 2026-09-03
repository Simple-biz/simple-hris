import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_BUTTON_LOCKED_LABEL,
  DISPATCH_BUTTON_READY_LABEL,
  formatLockedStamp,
  resolveDispatchButtonState,
  type DispatchButtonInput,
} from './dispatch-button-state';

const READY: DispatchButtonInput = {
  isDispatching: false,
  isReplay: false,
  lockLoading: false,
  locked: false,
  usdToPhpRate: 57.2,
  usdToCopRate: 4100,
};

test('ready: every gate clear → enabled with the Lock-in label', () => {
  assert.deepEqual(resolveDispatchButtonState(READY), {
    disabled: false,
    label: DISPATCH_BUTTON_READY_LABEL,
    reason: 'ready',
  });
});

test('locked: an already-sent cycle greys the button out — Unlock is the only re-stage path', () => {
  const s = resolveDispatchButtonState({ ...READY, locked: true });
  assert.equal(s.disabled, true);
  assert.equal(s.reason, 'locked');
  assert.equal(s.label, DISPATCH_BUTTON_LOCKED_LABEL);
});

test('locked beats the FX gate: a locked cycle never asks for Step 2 rates', () => {
  const s = resolveDispatchButtonState({ ...READY, locked: true, usdToPhpRate: 0 });
  assert.equal(s.reason, 'locked');
});

test('lock-loading: unknown lock state is disabled, never enabled by default', () => {
  const s = resolveDispatchButtonState({ ...READY, lockLoading: true });
  assert.equal(s.disabled, true);
  assert.equal(s.reason, 'lock-loading');
});

test('fx-missing: either rate at 0 disables with the Step 2 label', () => {
  assert.equal(resolveDispatchButtonState({ ...READY, usdToPhpRate: 0 }).reason, 'fx-missing');
  assert.equal(resolveDispatchButtonState({ ...READY, usdToCopRate: 0 }).reason, 'fx-missing');
  assert.equal(resolveDispatchButtonState({ ...READY, usdToCopRate: -1 }).reason, 'fx-missing');
  assert.equal(resolveDispatchButtonState({ ...READY, usdToPhpRate: NaN }).reason, 'fx-missing');
  assert.equal(resolveDispatchButtonState({ ...READY, usdToPhpRate: 0 }).label, 'Set Step 2 rates first');
});

test('replay outranks locked and FX: a past period is view-only whatever its lock says', () => {
  const s = resolveDispatchButtonState({ ...READY, isReplay: true, locked: true, usdToPhpRate: 0 });
  assert.equal(s.reason, 'replay');
  assert.equal(s.disabled, true);
});

test('dispatching outranks everything while the POST is in flight', () => {
  const s = resolveDispatchButtonState({
    ...READY,
    isDispatching: true,
    isReplay: true,
    locked: true,
    lockLoading: true,
  });
  assert.equal(s.reason, 'dispatching');
  assert.equal(s.label, 'Sending to Dispatch…');
});

test('every non-ready reason is disabled; only ready is enabled', () => {
  const variants: DispatchButtonInput[] = [
    { ...READY, isDispatching: true },
    { ...READY, isReplay: true },
    { ...READY, lockLoading: true },
    { ...READY, locked: true },
    { ...READY, usdToPhpRate: 0 },
  ];
  for (const v of variants) {
    const s = resolveDispatchButtonState(v);
    assert.equal(s.disabled, s.reason !== 'ready', JSON.stringify(v));
  }
});

test('formatLockedStamp: absent / legacy / garbage stamps yield null, never "Invalid Date"', () => {
  assert.equal(formatLockedStamp(null), null);
  assert.equal(formatLockedStamp(undefined), null);
  assert.equal(formatLockedStamp(''), null);
  assert.equal(formatLockedStamp('not-a-date'), null);
});

test('formatLockedStamp: a real ISO stamp renders a date and a time', () => {
  const now = new Date('2026-09-03T12:00:00Z');
  const s = formatLockedStamp('2026-09-03T08:12:00Z', now);
  assert.ok(s, 'renders');
  assert.match(s, /Sep/);
  assert.match(s, /\d{1,2}:\d{2}/);
  // Different year → the year is spelled out so the operator can't mistake a
  // stale lock for this week's.
  const old = formatLockedStamp('2025-09-03T08:12:00Z', now);
  assert.ok(old);
  assert.match(old, /2025/);
});
