import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LIVE_BLOCKED_RETRY_MS,
  LIVE_DEBOUNCE_MS,
  LIVE_MIN_GAP_MS,
  LIVE_SPREAD_MS,
  SCOREBOARD_LIVE_TOPIC,
  SCOREBOARD_TAB_HEADER,
  createLiveScheduler,
  isOwnEcho,
  parseScoreboardLivePayload,
  parseTabId,
} from './live';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── The topic ────────────────────────────────────────────────────────────────

test('the scoreboard topic is its own: no other file in src/ or app/ names it', () => {
  // realtime-js keeps ONE channel per topic per client: sharing a topic lets either side's teardown kill the
  // other's channel. Scanned, not listed, so a topic added later is checked too.
  const literal = `'${SCOREBOARD_LIVE_TOPIC}'`;
  const own = path.join(ROOT, 'src/lib/accounting-scoreboard/live.ts');
  const hits = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'app'))].filter(
    (f) => f !== own && fs.readFileSync(f, 'utf8').includes(literal),
  );
  assert.deepEqual(hits, []);
});

// ── The payload ──────────────────────────────────────────────────────────────

test('a payload parses with its kind, origin and time', () => {
  assert.deepEqual(parseScoreboardLivePayload({ kind: 'cells', origin: 'b7c1a3f0-1111-4222-8333-944455556666', ts: 5 }), {
    kind: 'cells',
    origin: 'b7c1a3f0-1111-4222-8333-944455556666',
    ts: 5,
  });
});

test('an unknown kind or a non-object is null: still a re-read signal, never a value', () => {
  assert.equal(parseScoreboardLivePayload({ kind: 'entries', origin: null, ts: 1 }), null);
  assert.equal(parseScoreboardLivePayload('cells'), null);
  assert.equal(parseScoreboardLivePayload(null), null);
});

test('a bad origin is dropped, never echoed; a missing time is now', () => {
  const p = parseScoreboardLivePayload({ kind: 'setup', origin: 'x"; drop', ts: 'soon' });
  assert.equal(p?.origin, null);
  assert.equal(typeof p?.ts, 'number');
});

test('a tab id is 8–64 letters, digits and dashes, nothing else', () => {
  assert.equal(parseTabId('b7c1a3f0-1111-4222-8333-944455556666'), 'b7c1a3f0-1111-4222-8333-944455556666');
  assert.equal(parseTabId('lq2x1-8f3k2j9d0a'), 'lq2x1-8f3k2j9d0a');
  assert.equal(parseTabId('short'), null);
  assert.equal(parseTabId('a'.repeat(65)), null);
  assert.equal(parseTabId('abc def ghi'), null);
  assert.equal(parseTabId('<script>alert(1)</script>'), null);
  assert.equal(parseTabId(null), null);
});

test('only a message from this very tab is its own echo', () => {
  const me = 'b7c1a3f0-1111-4222-8333-944455556666';
  assert.equal(isOwnEcho({ kind: 'cells', origin: me, ts: 1 }, me), true);
  assert.equal(isOwnEcho({ kind: 'cells', origin: 'another-tab-0001', ts: 1 }, me), false);
  assert.equal(isOwnEcho({ kind: 'cells', origin: null, ts: 1 }, me), false);
  assert.equal(isOwnEcho(null, me), false);
});

// ── The scheduler ────────────────────────────────────────────────────────────

function harness(opts: { blocked?: () => boolean; random?: number } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const runs: number[] = [];
  const s = createLiveScheduler({
    run: () => runs.push(now),
    blocked: opts.blocked ?? (() => false),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h) => timers.delete(h as number),
    random: () => opts.random ?? 0,
  });
  /** Advance the clock to `to`, firing every timer due on the way, in order. */
  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const t of timers) if (t[1].at <= to && (!due || t[1].at < due[1].at)) due = t;
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = to;
  };
  return { s, runs, advance, timers, at: () => now };
}

test('a burst of saves becomes ONE re-read, after the debounce', () => {
  const h = harness();
  for (let i = 0; i < 50; i++) h.s.signal();
  h.advance(LIVE_DEBOUNCE_MS - 1);
  assert.equal(h.runs.length, 0);
  h.advance(1);
  assert.equal(h.runs.length, 1);
  h.advance(60_000);
  assert.equal(h.runs.length, 1, 'nothing more without a new message');
});

test('the spread delays a tab by at most LIVE_SPREAD_MS', () => {
  const h = harness({ random: 0.999 });
  h.s.signal();
  h.advance(LIVE_DEBOUNCE_MS + LIVE_SPREAD_MS);
  assert.equal(h.runs.length, 1);
});

test('a flood (a message every 50 ms for a minute) is bounded to one re-read per LIVE_MIN_GAP_MS, and never starves', () => {
  const h = harness();
  const start = h.at();
  for (let t = 0; t < 60_000; t += 50) {
    h.s.signal();
    h.advance(50);
  }
  assert.ok(h.runs.length >= 1 && h.runs[0] - start <= LIVE_DEBOUNCE_MS + LIVE_SPREAD_MS, 'the first re-read is not starved');
  for (let i = 1; i < h.runs.length; i++) assert.ok(h.runs[i] - h.runs[i - 1] >= LIVE_MIN_GAP_MS, `re-reads ${i - 1}→${i} too close`);
  assert.ok(h.runs.length <= Math.ceil(60_000 / LIVE_MIN_GAP_MS) + 1, `${h.runs.length} re-reads in a minute`);
});

test('a change that lands during the gap is still read, once the gap is over', () => {
  const h = harness();
  h.s.signal();
  h.advance(LIVE_DEBOUNCE_MS);
  assert.equal(h.runs.length, 1);
  h.advance(100);
  h.s.signal();
  h.advance(LIVE_MIN_GAP_MS);
  assert.equal(h.runs.length, 2);
  assert.ok(h.runs[1] - h.runs[0] >= LIVE_MIN_GAP_MS);
});

test('nothing runs while blocked (a cell being edited); the change waits and runs once the block clears', () => {
  let blocked = true;
  const h = harness({ blocked: () => blocked });
  h.s.signal();
  h.advance(30_000);
  assert.equal(h.runs.length, 0, 'never while a cell is being edited');
  blocked = false;
  h.advance(LIVE_BLOCKED_RETRY_MS);
  assert.equal(h.runs.length, 1, 'read right after, not on the 45 s tick');
  h.advance(30_000);
  assert.equal(h.runs.length, 1);
});

test('the reconnect catch-up is a plain signal: it re-reads once', () => {
  const h = harness();
  h.s.signal();
  h.advance(LIVE_DEBOUNCE_MS + LIVE_SPREAD_MS);
  assert.equal(h.runs.length, 1);
});

test('after dispose nothing runs and no timer is left', () => {
  const h = harness();
  h.s.signal();
  h.s.dispose();
  h.advance(60_000);
  assert.equal(h.runs.length, 0);
  assert.equal(h.timers.size, 0);
  h.s.signal();
  assert.equal(h.timers.size, 0);
});

// ── Every board write announces, and only after it succeeded ─────────────────

const API = 'app/api/accounting-scoreboard';
/** What each write route announces. Every mutating handler of these files must announce, through after(). */
const WRITERS: Record<string, string> = {
  'entries/route.ts': 'cells',
  'collections/route.ts': 'collections',
  'collections/verify/route.ts': 'verified',
  'problems/route.ts': 'problems',
  'problem-types/route.ts': 'setup',
  'custom-sections/route.ts': 'setup',
  'rows/route.ts': 'setup',
  'sections/route.ts': 'setup',
  'members/route.ts': 'members',
  'roles/route.ts': 'roles',
};
/** Routes under the board's API that change nothing the board GET reads. Each needs its reason. */
const NOT_THE_BOARD: Record<string, string> = {
  'tasks/': 'the task boards are their own read (GET /tasks, plan Task 7), not the board payload',
};

function routeFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...routeFiles(dir, rel));
    else if (e.name === 'route.ts') out.push(rel);
  }
  return out;
}

const MUTATING = /export async function (POST|PUT|PATCH|DELETE)\b/g;

test('every mutating route under the board API is a listed writer, or names why it is not', () => {
  for (const rel of routeFiles(API)) {
    const src = read(`${API}/${rel}`);
    if (!(src.match(MUTATING) ?? []).length) continue;
    const exempt = Object.keys(NOT_THE_BOARD).some((p) => rel.startsWith(p));
    assert.ok(rel in WRITERS || exempt, `${rel} writes but neither announces on the live channel nor says why not`);
  }
});

for (const [rel, kind] of Object.entries(WRITERS)) {
  test(`${rel}: every write announces '${kind}' through after(), and only once it succeeded`, () => {
    const src = read(`${API}/${rel}`);
    const handlers = src
      .split(/(?=export async function )/)
      .filter((c) => /^export async function (POST|PUT|PATCH|DELETE)\b/.test(c));
    assert.ok(handlers.length > 0, `${rel} has no write handler`);
    for (const h of handlers) {
      const name = h.slice(0, 40);
      const calls = h.match(/after\(\s*announceScoreboardChange\(/g) ?? [];
      assert.equal(calls.length, 1, `${name}…: one after(announceScoreboardChange(…))`);
      assert.ok(h.includes(`after(announceScoreboardChange('${kind}', req));`), `${name}…: announces '${kind}'`);
      // On the success path only: right after the failure return, right before the ok answer.
      assert.match(
        h,
        /if \(!result\.ok\) return failureResponse\(result\);\s*after\(announceScoreboardChange\('[a-z]+', req\)\);\s*return okResponse\(/,
        `${name}…: announces only after the write succeeded`,
      );
    }
    assert.ok(!/void\s+announceScoreboardChange\(/.test(src), 'a void-ed announce can be frozen with the function');
  });
}

// ── The listener ─────────────────────────────────────────────────────────────

test('the board listens through onScoreboardSnapshot, under the tick rules (never mid-edit, never over a foreground load)', () => {
  const app = read('src/components/accounting-scoreboard/ScoreboardApp.tsx');
  assert.match(app, /onScoreboardSnapshot\(\(\) => void load\(week, true\)/, 'a SILENT re-read, never the loading modal');
  assert.ok(app.includes('editing.current > 0'), 'blocked while a cell is being edited');
  assert.ok(app.includes('foreground.current !== null'), 'blocked while a foreground load runs');
  assert.ok(!/postgres_changes/.test(app), 'postgres_changes never reaches the anon client here');
});

test("every board call names its tab, so a tab skips its own write's echo", () => {
  const shared = read('src/components/accounting-scoreboard/shared.tsx');
  assert.ok(shared.includes('[SCOREBOARD_TAB_HEADER]: getScoreboardTabId()'));
  assert.equal(SCOREBOARD_TAB_HEADER, SCOREBOARD_TAB_HEADER.toLowerCase(), 'headers are read lower-case');
});

test('the server half sends a signal, never board values', () => {
  const server = read('src/lib/accounting-scoreboard/live-server.ts');
  const payload = server.slice(server.indexOf('const payload'), server.indexOf('await broadcastFromServer'));
  assert.deepEqual(
    [...payload.matchAll(/^\s{4}(\w+)[:,]/gm)].map((m) => m[1]),
    ['kind', 'origin', 'ts'],
    'the payload carries kind, origin and ts only',
  );
});
