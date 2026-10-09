import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_SIGNAL_GOOD_MS, DB_SIGNAL_SLOW_MS, judgeDbPing, signalForFailedRoute } from './db-signal';

const at = '2026-10-09T13:00:00Z';
const ok = (ms: number) => judgeDbPing({ ok: true, ms, checkedAt: at });

test('under 500 ms: 3 green bars (the 3rd blinks in the UI)', () => {
  assert.deepEqual([ok(0).bars, ok(0).tone], [3, 'green']);
  assert.deepEqual([ok(42).bars, ok(42).tone, ok(42).ms], [3, 'green', 42]);
  assert.deepEqual([ok(DB_SIGNAL_GOOD_MS - 1).bars, ok(DB_SIGNAL_GOOD_MS - 1).tone], [3, 'green']);
});

test('500 to 2000 ms: 2 orange bars', () => {
  assert.deepEqual([ok(DB_SIGNAL_GOOD_MS).bars, ok(DB_SIGNAL_GOOD_MS).tone], [2, 'orange']);
  assert.deepEqual([ok(DB_SIGNAL_SLOW_MS).bars, ok(DB_SIGNAL_SLOW_MS).tone], [2, 'orange']);
});

test('over 2000 ms, a timeout or a failure: 1 red bar', () => {
  assert.deepEqual([ok(DB_SIGNAL_SLOW_MS + 1).bars, ok(DB_SIGNAL_SLOW_MS + 1).tone], [1, 'red']);
  const timedOut = judgeDbPing({ ok: false, timedOut: true, ms: 3000, checkedAt: at });
  assert.deepEqual([timedOut.bars, timedOut.tone, timedOut.ms], [1, 'red', null], 'a timeout prints no ms');
  const failed = judgeDbPing({ ok: false, timedOut: false, ms: 12, checkedAt: at });
  assert.deepEqual([failed.bars, failed.tone, failed.word], [1, 'red', 'Unreachable']);
  assert.deepEqual([signalForFailedRoute(503).bars, signalForFailedRoute(503).tone], [1, 'red']);
  assert.match(signalForFailedRoute(0).sentence, /server/);
});

test('ms is a whole number, never negative', () => {
  assert.equal(ok(41.6).ms, 42);
  assert.equal(ok(-3).ms, 0);
});

test("the lines are Admin → Diagnostics' own for the same kind of read", () => {
  const doc = readFileSync(join(process.cwd(), 'docs', 'features', 'system-diagnostics.md'), 'utf8');
  assert.match(doc, /`healthy` < 500ms, `warning` 500–2000ms/);
  assert.equal(DB_SIGNAL_GOOD_MS, 500);
  assert.equal(DB_SIGNAL_SLOW_MS, 2000);
});

test('the ping route lets anyone on the board in, and never writes', () => {
  const route = readFileSync(join(process.cwd(), 'app', 'api', 'accounting-scoreboard', 'ping', 'route.ts'), 'utf8');
  assert.match(route, /resolveAccess\(\)/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});
