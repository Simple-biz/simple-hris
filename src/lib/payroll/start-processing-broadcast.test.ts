import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  START_PROCESSING_TOPIC,
  START_CUE_WINDOW_MS,
  parseStartPayload,
  shouldAnnounceStart,
  startProcessingHeadline,
  type StartProcessingAnnouncement,
} from './start-processing-broadcast';
import { DISPATCH_SYNC_TOPIC, PAID_TOAST_TOPIC } from './dispatch-paid-toast';
import { STAGE_PREPPED_RUN_SECONDS } from '@/lib/sound/ping-chime';

const NOW = 1_800_000_000_000;
const msg = (over: Partial<StartProcessingAnnouncement> = {}): StartProcessingAnnouncement => ({
  by: 'carla@simple.biz',
  byLabel: 'Carla',
  at: NOW,
  surface: 'wizard',
  ...over,
});

test('the topic is its OWN — sharing one would tear down another hook\'s channel', () => {
  // realtime-js `channel()` returns the EXISTING channel per topic, so this
  // hook's removeChannel would kill the queue's live sync or the follow mode.
  assert.notEqual(START_PROCESSING_TOPIC, DISPATCH_SYNC_TOPIC);
  assert.notEqual(START_PROCESSING_TOPIC, PAID_TOAST_TOPIC);
  assert.notEqual(START_PROCESSING_TOPIC, 'payroll-wizard-follow');
});

test('a LATE arrival never hears it — Kane 2026-09-15', () => {
  // The transport does not replay to a late joiner, but a reconnecting or
  // backgrounded tab can be handed a message after the fact.
  assert.equal(shouldAnnounceStart(msg({ at: NOW - START_CUE_WINDOW_MS - 1 }), 'kane@simple.biz', NOW), false);
});

test('a message just inside the window still announces', () => {
  assert.equal(shouldAnnounceStart(msg({ at: NOW - START_CUE_WINDOW_MS + 1 }), 'kane@simple.biz', NOW), true);
});

test('you never hear your own start, even from a second tab', () => {
  assert.equal(shouldAnnounceStart(msg(), 'carla@simple.biz', NOW), false);
  assert.equal(shouldAnnounceStart(msg(), 'CARLA@Simple.biz ', NOW), false);
});

test('a message with no timestamp cannot be judged stale, so it is dropped', () => {
  assert.equal(shouldAnnounceStart(msg({ at: 0 }), 'kane@simple.biz', NOW), false);
});

test('a clock skewed into the future reads as fresh, not infinitely stale', () => {
  assert.equal(shouldAnnounceStart(msg({ at: NOW + 5_000 }), 'kane@simple.biz', NOW), true);
});

test('malformed payloads off the wire parse to null and are never rendered', () => {
  assert.equal(parseStartPayload(null), null);
  assert.equal(parseStartPayload('start'), null);
  assert.equal(parseStartPayload({}), null);
  assert.equal(parseStartPayload({ by: 'a@b.c', at: NOW }), null, 'no surface');
  assert.equal(parseStartPayload({ by: 'a@b.c', surface: 'wizard' }), null, 'no timestamp');
  assert.equal(parseStartPayload({ by: '', at: NOW, surface: 'wizard' }), null, 'no sender');
  assert.equal(parseStartPayload({ by: 'a@b.c', at: NOW, surface: 'elsewhere' }), null, 'unknown surface');
});

test('parse lowercases the sender and falls back to the email local part', () => {
  const parsed = parseStartPayload({ by: ' Carla@Simple.Biz ', at: NOW, surface: 'dispatch' });
  assert.deepEqual(parsed, { by: 'carla@simple.biz', byLabel: 'carla', at: NOW, surface: 'dispatch' });
});

test('a parsed payload flows straight into shouldAnnounceStart', () => {
  const parsed = parseStartPayload({ by: 'carla@simple.biz', byLabel: 'Carla', at: NOW, surface: 'wizard' });
  assert.equal(shouldAnnounceStart(parsed, 'kane@simple.biz', NOW), true);
  assert.equal(startProcessingHeadline(parsed!), 'Carla is starting payroll');
});

test('the stale cutoff IS the cue length — they must never drift apart', () => {
  // The modal auto-dismisses at START_CUE_WINDOW_MS and the cue fades at
  // STAGE_PREPPED_RUN_SECONDS. If someone lengthens one, a peer either sits in
  // front of a silent modal or loses the tail of the song.
  assert.equal(START_CUE_WINDOW_MS, STAGE_PREPPED_RUN_SECONDS * 1000);
});
