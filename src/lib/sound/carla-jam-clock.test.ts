import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CARLA_JAM_ACTIVE_MS,
  CARLA_JAM_EMAIL,
  CARLA_JAM_IDLE_AFTER_MS,
  CARLA_JAM_MAX_TICK_MS,
  EMPTY_JAM_CLOCK,
  isCarlaJamEmail,
  isJamActiveMoment,
  isJamDue,
  parseStoredJam,
  reduceJamPhase,
  restoredJamPhase,
  tickJamClock,
  type JamClock,
  type JamEvent,
  type JamPhase,
} from './carla-jam-clock';

test('the gate is one literal email, trimmed and case-folded', () => {
  assert.equal(CARLA_JAM_EMAIL, 'carla@simple.biz');
  assert.equal(isCarlaJamEmail('carla@simple.biz'), true);
  assert.equal(isCarlaJamEmail('  Carla@Simple.biz '), true);
  assert.equal(isCarlaJamEmail('carlat@simple.biz'), false);
  assert.equal(isCarlaJamEmail('kaner@simple.biz'), false);
  assert.equal(isCarlaJamEmail(''), false);
  assert.equal(isCarlaJamEmail(null), false);
  assert.equal(isCarlaJamEmail(undefined), false);
});

test('the gate matches the sign-in song gate', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'sound', 'carla-song.ts'), 'utf8');
  assert.match(src, /CARLA_SONG_EMAIL = 'carla@simple\.biz'/);
});

test('the thresholds are 5 active minutes, a 60s idle window and a 2s tick cap', () => {
  assert.equal(CARLA_JAM_ACTIVE_MS, 300_000);
  assert.equal(CARLA_JAM_IDLE_AFTER_MS, 60_000);
  assert.equal(CARLA_JAM_MAX_TICK_MS, 2_000);
});

test('an active moment needs a visible tab and input inside the idle window', () => {
  const now = 1_000_000;
  assert.equal(isJamActiveMoment({ now, lastInputAt: now - 1_000, visible: true }), true);
  assert.equal(isJamActiveMoment({ now, lastInputAt: now - CARLA_JAM_IDLE_AFTER_MS, visible: true }), true);
  assert.equal(isJamActiveMoment({ now, lastInputAt: now - CARLA_JAM_IDLE_AFTER_MS - 1, visible: true }), false);
  assert.equal(isJamActiveMoment({ now, lastInputAt: now - 1_000, visible: false }), false);
  assert.equal(isJamActiveMoment({ now, lastInputAt: null, visible: true }), false);
});

test('the first tick sets the baseline and credits nothing', () => {
  const c = tickJamClock(EMPTY_JAM_CLOCK, { now: 5_000, lastInputAt: 5_000, visible: true });
  assert.deepEqual(c, { activeMs: 0, lastTickAt: 5_000 });
});

test('an active tick credits the interval since the previous tick', () => {
  const c = tickJamClock({ activeMs: 10_000, lastTickAt: 5_000 }, { now: 6_000, lastInputAt: 5_500, visible: true });
  assert.deepEqual(c, { activeMs: 11_000, lastTickAt: 6_000 });
});

test('an idle, hidden or input-less tick credits nothing but still moves the baseline', () => {
  const base: JamClock = { activeMs: 10_000, lastTickAt: 100_000 };
  const idle = tickJamClock(base, { now: 101_000, lastInputAt: 101_000 - CARLA_JAM_IDLE_AFTER_MS - 1, visible: true });
  const hidden = tickJamClock(base, { now: 101_000, lastInputAt: 100_900, visible: false });
  const none = tickJamClock(base, { now: 101_000, lastInputAt: null, visible: true });
  for (const c of [idle, hidden, none]) assert.deepEqual(c, { activeMs: 10_000, lastTickAt: 101_000 });
});

test('a late tick after a throttled or slept tab credits at most the cap', () => {
  // The tab slept for ten minutes; she touches it and the next tick fires.
  const c = tickJamClock({ activeMs: 0, lastTickAt: 0 }, { now: 600_000, lastInputAt: 600_000, visible: true });
  assert.equal(c.activeMs, CARLA_JAM_MAX_TICK_MS);
});

test('a clock that runs backwards credits nothing', () => {
  const c = tickJamClock({ activeMs: 4_000, lastTickAt: 10_000 }, { now: 9_000, lastInputAt: 9_000, visible: true });
  assert.equal(c.activeMs, 4_000);
});

test('five minutes of one-second active ticks makes the bubble due, one second earlier does not', () => {
  let c: JamClock = tickJamClock(EMPTY_JAM_CLOCK, { now: 0, lastInputAt: 0, visible: true });
  for (let s = 1; s < 300; s += 1) {
    c = tickJamClock(c, { now: s * 1_000, lastInputAt: s * 1_000, visible: true });
  }
  assert.equal(isJamDue(c), false);
  c = tickJamClock(c, { now: 300_000, lastInputAt: 300_000, visible: true });
  assert.equal(isJamDue(c), true);
});

test('reading without touching still counts, for one minute after the last input', () => {
  let c: JamClock = tickJamClock(EMPTY_JAM_CLOCK, { now: 0, lastInputAt: 0, visible: true });
  for (let s = 1; s <= 120; s += 1) {
    c = tickJamClock(c, { now: s * 1_000, lastInputAt: 0, visible: true });
  }
  assert.equal(c.activeMs, CARLA_JAM_IDLE_AFTER_MS);
});

test('the phase machine: offer → play → pause → play → ended', () => {
  let p: JamPhase = 'counting';
  p = reduceJamPhase(p, 'due');
  assert.equal(p, 'offer');
  p = reduceJamPhase(p, 'play');
  assert.equal(p, 'playing');
  p = reduceJamPhase(p, 'pause');
  assert.equal(p, 'paused');
  p = reduceJamPhase(p, 'play');
  assert.equal(p, 'playing');
  p = reduceJamPhase(p, 'ended');
  assert.equal(p, 'counting');
});

test('close and failed return every phase to counting', () => {
  for (const from of ['counting', 'offer', 'playing', 'paused'] as JamPhase[]) {
    assert.equal(reduceJamPhase(from, 'close'), 'counting');
    assert.equal(reduceJamPhase(from, 'failed'), 'counting');
  }
});

test('an event that does not apply leaves the phase alone', () => {
  const cases: [JamPhase, JamEvent][] = [
    ['counting', 'play'],
    ['counting', 'pause'],
    ['counting', 'ended'],
    ['offer', 'due'],
    ['offer', 'pause'],
    ['offer', 'ended'],
    ['playing', 'due'],
    ['playing', 'play'],
    ['paused', 'due'],
    ['paused', 'pause'],
    ['paused', 'ended'],
  ];
  for (const [from, ev] of cases) assert.equal(reduceJamPhase(from, ev), from, `${from} + ${ev}`);
});

test('the bubble never skips straight from counting to audio', () => {
  assert.equal(reduceJamPhase('counting', 'play'), 'counting');
});

test('parseStoredJam round-trips a good value', () => {
  assert.deepEqual(parseStoredJam(JSON.stringify({ activeMs: 12_000, phase: 'paused', positionSec: 41.5 })), {
    activeMs: 12_000,
    phase: 'paused',
    positionSec: 41.5,
  });
});

test('parseStoredJam rejects malformed values', () => {
  for (const raw of [
    null,
    undefined,
    '',
    'not json',
    'null',
    '42',
    '[]',
    JSON.stringify({ phase: 'offer' }),
    JSON.stringify({ activeMs: 'x', phase: 'offer' }),
    JSON.stringify({ activeMs: 1, phase: 'dancing' }),
    JSON.stringify({ activeMs: 1 }),
  ]) {
    assert.equal(parseStoredJam(raw), null, String(raw));
  }
});

test('parseStoredJam clamps the clock and zeroes a bad position', () => {
  assert.equal(parseStoredJam(JSON.stringify({ activeMs: 9e12, phase: 'counting' }))?.activeMs, CARLA_JAM_ACTIVE_MS);
  assert.equal(parseStoredJam(JSON.stringify({ activeMs: -5, phase: 'counting' }))?.activeMs, 0);
  assert.equal(parseStoredJam(JSON.stringify({ activeMs: 1, phase: 'paused', positionSec: -3 }))?.positionSec, 0);
  assert.equal(parseStoredJam(JSON.stringify({ activeMs: 1, phase: 'paused', positionSec: 'x' }))?.positionSec, 0);
});

test('a song that was playing comes back paused; every other phase comes back as it was', () => {
  assert.equal(restoredJamPhase({ activeMs: 0, phase: 'playing', positionSec: 30 }), 'paused');
  assert.equal(restoredJamPhase({ activeMs: 0, phase: 'paused', positionSec: 30 }), 'paused');
  assert.equal(restoredJamPhase({ activeMs: 0, phase: 'offer', positionSec: 0 }), 'offer');
  assert.equal(restoredJamPhase({ activeMs: 12, phase: 'counting', positionSec: 0 }), 'counting');
});

test('the bubble plays the shipped whole-song re-encode, and the engine never serves the raw track', () => {
  const engine = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'sound', 'carla-jam.ts'), 'utf8');
  assert.match(engine, /CARLA_JAM_SRC = '\/sounds\/jellyfish-jam\.mp3'/);
  assert.doesNotMatch(engine, /jellyfish jam\.mp3/);
  const bytes = fs.statSync(path.join(process.cwd(), 'public', 'sounds', 'jellyfish-jam.mp3')).size;
  assert.ok(bytes <= 1_500_000, `jellyfish-jam.mp3 is ${bytes} bytes`);
});

test('the engine only ever starts audio from playCarlaJam (a click), never from a tick or a restore', () => {
  const engine = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'sound', 'carla-jam.ts'), 'utf8');
  const plays = engine.match(/\.play\(\)/g) ?? [];
  assert.equal(plays.length, 1, 'exactly one .play() call site');
  const playFn = engine.slice(engine.indexOf('export function playCarlaJam'));
  assert.ok(playFn.indexOf('.play()') > 0 && playFn.indexOf('.play()') < playFn.indexOf('\nexport function', 1));
});
