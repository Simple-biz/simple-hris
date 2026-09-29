import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  START_PROCESSING_TOPIC,
  START_CUE_WINDOW_MS,
  START_MODAL_MAX_MS,
  parseFullName,
  parseStartPayload,
  shouldAnnounceStart,
  shouldCloseStartModal,
  startedByLine,
  startProcessingHeadline,
  type StartProcessingAnnouncement,
} from './start-processing-broadcast';
import { DISPATCH_SYNC_TOPIC, PAID_TOAST_TOPIC } from './dispatch-paid-toast';
import {
  STAGE_PREPPED_FADE_OUT_SECONDS,
  STAGE_PREPPED_MAX_SECONDS,
  STAGE_PREPPED_MIN_SECONDS,
  stagePreppedFadeSeconds,
  stagePreppedRunSeconds,
} from '@/lib/sound/ping-chime';

const NOW = 1_800_000_000_000;
const msg = (over: Partial<StartProcessingAnnouncement> = {}): StartProcessingAnnouncement => ({
  by: 'carla@simple.biz',
  byLabel: 'Carla',
  byName: 'Carla Santos',
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
  assert.deepEqual(parsed, { by: 'carla@simple.biz', byLabel: 'carla', byName: null, at: NOW, surface: 'dispatch' });
});

test('a parsed payload flows straight into shouldAnnounceStart', () => {
  const parsed = parseStartPayload({ by: 'carla@simple.biz', byLabel: 'Carla', at: NOW, surface: 'wizard' });
  assert.equal(shouldAnnounceStart(parsed, 'kane@simple.biz', NOW), true);
  assert.equal(startProcessingHeadline(parsed!), 'Carla is starting payroll');
});

test('the stale cutoff stays 12s although the song is 2:31 — a late tab stays silent', () => {
  // Kane 2026-09-15: "if they are late they shouldnt hear it." Until 2026-09-25
  // this constant also had to equal the cue length; when the whole song was
  // ruled in, the two were SPLIT. Stretching the cutoff to the song would let
  // a tab reconnecting minutes late start the song from the top.
  assert.equal(START_CUE_WINDOW_MS, 12_000);
});

test('the peer modal never closes mid-song and never sits in front of silence', () => {
  // Kane 2026-09-25: "play the whole song unless the modal is being closed."
  assert.equal(shouldCloseStartModal({ windowElapsed: false, cueActive: true }), false, 'song playing');
  assert.equal(shouldCloseStartModal({ windowElapsed: true, cueActive: true }), false, 'song still playing past 12s');
  assert.equal(shouldCloseStartModal({ windowElapsed: false, cueActive: false }), false, 'minimum window not up');
  assert.equal(shouldCloseStartModal({ windowElapsed: true, cueActive: false }), true, 'window up AND song over');
});

test('the modal hard ceiling outlasts the longest possible run, and is finite', () => {
  // The latest a run can start is the end of the window; it lasts at most the
  // ceiling. A lost ended event must still never strand the modal.
  assert.ok(START_MODAL_MAX_MS > START_CUE_WINDOW_MS + STAGE_PREPPED_MAX_SECONDS * 1000);
  assert.ok(Number.isFinite(START_MODAL_MAX_MS));
  assert.ok(START_MODAL_MAX_MS <= 5 * 60 * 1000, 'the modal can never become a five-minute overlay');
});

test('a run is one minute — looped up to the floor, faded out at the ceiling', () => {
  // Kane 2026-09-29: "should just be 1 minute please and fade it out."
  assert.equal(STAGE_PREPPED_MAX_SECONDS, 60);
  // The installed track is 2:31, so it is cut at exactly one minute.
  assert.equal(stagePreppedRunSeconds(151.51), 60);
  // A re-trimmed clip can never drop below the >= 10s Kane asked for 2026-09-15.
  assert.ok(STAGE_PREPPED_MIN_SECONDS >= 10);
  assert.equal(stagePreppedRunSeconds(5), STAGE_PREPPED_MIN_SECONDS);
  // A clip that fits inside the bounds plays whole.
  assert.equal(stagePreppedRunSeconds(45), 45);
  // A swapped-in ten-minute file is still bounded — "held" never means "unbounded".
  assert.equal(stagePreppedRunSeconds(600), STAGE_PREPPED_MAX_SECONDS);
  // An unreadable duration gets the floor, not zero and not infinity.
  assert.equal(stagePreppedRunSeconds(Number.NaN), STAGE_PREPPED_MIN_SECONDS);
  assert.equal(stagePreppedRunSeconds(0), STAGE_PREPPED_MIN_SECONDS);
  assert.equal(stagePreppedRunSeconds(Number.POSITIVE_INFINITY), STAGE_PREPPED_MIN_SECONDS);
});

test('the ceiling cut FADES OUT; a clip ending on its own is never faded', () => {
  // The installed song fades out over the last 5s of its minute (55s → 60s).
  assert.equal(stagePreppedFadeSeconds(151.51), STAGE_PREPPED_FADE_OUT_SECONDS);
  assert.ok(STAGE_PREPPED_FADE_OUT_SECONDS >= 3, 'a fade-out is audible, not a click-guard');
  assert.ok(STAGE_PREPPED_FADE_OUT_SECONDS <= STAGE_PREPPED_MAX_SECONDS / 2);
  assert.equal(stagePreppedFadeSeconds(600), STAGE_PREPPED_FADE_OUT_SECONDS);
  // A clip inside the bounds keeps its real ending.
  assert.equal(stagePreppedFadeSeconds(45), 0);
  assert.equal(stagePreppedFadeSeconds(STAGE_PREPPED_MAX_SECONDS), 0);
  // A looping clip gets a short ramp, never more than half the run.
  const loopFade = stagePreppedFadeSeconds(5);
  assert.ok(loopFade > 0 && loopFade <= STAGE_PREPPED_MIN_SECONDS / 2);
  assert.ok(Number.isFinite(stagePreppedFadeSeconds(Number.NaN)));
});

test('the served song stays small — the engine needs every byte before it can play', () => {
  // The raw 3.6MB track would leave the first press of the day silent while it
  // downloaded. The served file is a small re-encode (1.21MB on 2026-09-25).
  const bytes = fs.statSync(path.join(process.cwd(), 'public', 'sounds', 'jellyfish-jam.mp3')).size;
  assert.ok(bytes <= 1_500_000, `jellyfish-jam.mp3 is ${bytes} bytes`);
});

test('the modal names who started it — full name AND account', () => {
  // Kane 2026-09-25: "the modal should also show the person who started it."
  assert.equal(startedByLine(msg()), 'Carla Santos · carla@simple.biz');
  // An older sender (no full name) still gets named, never a blank.
  assert.equal(startedByLine(msg({ byName: null })), 'Carla · carla@simple.biz');
});

test('a full name off the wire is untrusted: emails rejected, whitespace collapsed, length capped', () => {
  assert.equal(parseFullName('  Carla   Santos '), 'Carla Santos');
  assert.equal(parseFullName('kaner@simple.biz'), null, 'impersonation sessions set name = email');
  assert.equal(parseFullName(''), null);
  assert.equal(parseFullName(42), null);
  assert.equal(parseFullName(undefined), null);
  assert.equal(parseFullName('x'.repeat(500))!.length, 80);
  const parsed = parseStartPayload({ by: 'carla@simple.biz', byName: 'Carla Santos', at: NOW, surface: 'wizard' });
  assert.equal(parsed!.byName, 'Carla Santos');
});
