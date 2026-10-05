import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  NPD_ARRIVE,
  NPD_GLIDE,
  NPD_LOAD_CEILING,
  NPD_READ_ATTEMPTS,
  advanceLoadProgress,
  easeAt,
  glidePositionAt,
  loadLines,
  loadTitle,
  loadValueNow,
  receiveTarget,
  startLoadProgress,
  type NpdLoadEvent,
  type NpdLoadProgress,
} from './load-progress';

const run = (events: NpdLoadEvent[], t0 = 0, step = 100): NpdLoadProgress => {
  let p = startLoadProgress('hsl', '2026-09-20', t0);
  events.forEach((e, i) => {
    p = advanceLoadProgress(p, e, t0 + (i + 1) * step);
  });
  return p;
};

const FULL: NpdLoadEvent[] = [
  { kind: 'header', attempt: 1, rowCount: 613 },
  { kind: 'read', attempt: 1, rows: 613 },
  { kind: 'sheet', rows: 613 },
  { kind: 'rows', count: 50 },
  { kind: 'rows', count: 50 },
];

describe('the curve', () => {
  test('easeAt is the browser’s cubic-bezier: 0 → 0, 1 → 1, and it only rises', () => {
    for (const e of [NPD_GLIDE, NPD_ARRIVE]) {
      assert.equal(easeAt(e, 0), 0);
      assert.equal(easeAt(e, 1), 1);
      let last = 0;
      for (let x = 0.05; x < 1; x += 0.05) {
        const y = easeAt(e, x);
        assert.ok(y >= last - 1e-9, `rises at ${x}`);
        last = y;
      }
    }
    // Decelerating: by a quarter of the time it is well past a quarter of the way.
    assert.ok(easeAt(NPD_GLIDE, 0.25) > 0.6);
  });

  test('a glide is where its curve says at any moment, clamped at both ends', () => {
    const g = { from: 0.2, to: 0.6, startedAt: 1000, ms: 2000, easing: NPD_GLIDE };
    assert.equal(glidePositionAt(g, 0), 0.2);
    assert.equal(glidePositionAt(g, 5000), 0.6);
    const mid = glidePositionAt(g, 2000);
    assert.ok(mid > 0.2 && mid < 0.6);
  });
});

describe('the NPD loading bar', () => {
  test('only a finished load fills it: every step before `done` stops short of the end', () => {
    for (const c of [NPD_LOAD_CEILING.open, NPD_LOAD_CEILING.read, NPD_LOAD_CEILING.verify, NPD_LOAD_CEILING.receiveTo, NPD_LOAD_CEILING.layout]) {
      assert.ok(c < 1);
    }
    const all = run([...FULL, { kind: 'rows', count: 513 }, { kind: 'layout' }]);
    assert.ok(all.glide.to < 1, 'every row received and laid out is still not done');
    assert.equal(advanceLoadProgress(all, { kind: 'done' }, 10_000).glide.to, 1);
  });

  test('each step reaches further than the one before', () => {
    const c = NPD_LOAD_CEILING;
    assert.ok(c.open < c.read && c.read < c.verify && c.verify < c.receiveTo && c.receiveTo < c.layout && c.layout < c.done);
  });

  test('it never moves backwards, a retry included', () => {
    let p = startLoadProgress('all_departments', '2026-09-20', 0);
    let last = 0;
    const events: NpdLoadEvent[] = [
      { kind: 'header', attempt: 1, rowCount: 527 },
      { kind: 'read', attempt: 1, rows: 527 },
      { kind: 'retry', attempt: 2 },
      { kind: 'header', attempt: 2, rowCount: 530 },
      { kind: 'read', attempt: 2, rows: 530 },
      { kind: 'sheet', rows: 530 },
      { kind: 'rows', count: 50 },
      { kind: 'layout' },
      { kind: 'done' },
    ];
    let t = 0;
    for (const e of events) {
      t += 5000; // each step long enough to finish its glide
      p = advanceLoadProgress(p, e, t);
      assert.ok(p.glide.from >= last - 1e-9, `${e.kind} starts at or past where the bar was`);
      assert.ok(p.glide.to >= p.glide.from, `${e.kind} heads forward`);
      last = glidePositionAt(p.glide, t + 10_000);
    }
  });

  test('a new step glides on from wherever the bar is at that moment, so it never jumps', () => {
    const p0 = startLoadProgress('hsl', '2026-09-20', 0);
    const at = glidePositionAt(p0.glide, 300);
    const p1 = advanceLoadProgress(p0, { kind: 'header', attempt: 1, rowCount: 613 }, 300);
    assert.equal(p1.glide.from, at);
    assert.equal(p1.glide.startedAt, 300);
  });

  test('receiving moves by fact: rows received ÷ rows sent, never past the count', () => {
    assert.equal(receiveTarget(0, 613), NPD_LOAD_CEILING.verify);
    assert.equal(receiveTarget(613, 613), NPD_LOAD_CEILING.receiveTo);
    assert.equal(receiveTarget(0, 0), NPD_LOAD_CEILING.receiveTo, 'an empty sheet has nothing left to receive');
    const p = run(FULL);
    assert.equal(p.received, 100);
    assert.equal(p.glide.to, receiveTarget(100, 613));
    const over = advanceLoadProgress(p, { kind: 'rows', count: 9999 }, 9999);
    assert.equal(over.received, 613);
  });

  test('rows before the sheet line move nothing', () => {
    const p = run([{ kind: 'header', attempt: 1, rowCount: 10 }, { kind: 'rows', count: 5 }]);
    assert.equal(p.received, 0);
    assert.equal(p.step, 'read');
  });

  test('a failure stops the bar where it is, and an ended load never moves again', () => {
    const p = run([{ kind: 'header', attempt: 1, rowCount: 613 }]);
    const failed = advanceLoadProgress(p, { kind: 'failed', error: 'boom' }, 400);
    assert.equal(failed.step, 'failed');
    assert.equal(failed.failedAt, 'read');
    assert.equal(failed.glide.from, failed.glide.to);
    assert.equal(advanceLoadProgress(failed, { kind: 'done' }, 500), failed);
    const done = advanceLoadProgress(run(FULL), { kind: 'done' }, 900);
    assert.equal(advanceLoadProgress(done, { kind: 'failed', error: 'late' }, 1000), done);
  });

  test('every load is its own: a second load of the same sheet gets a new id', () => {
    assert.notEqual(startLoadProgress('hsl', '2026-09-20', 0).loadId, startLoadProgress('hsl', '2026-09-20', 0).loadId);
  });

  test('the value read to assistive tech is the step’s ceiling, never more', () => {
    const p = run([{ kind: 'header', attempt: 1, rowCount: 613 }]);
    assert.equal(loadValueNow(p), Math.round(NPD_LOAD_CEILING.read * 100));
    assert.equal(loadValueNow(null), 0);
  });
});

describe('the NPD loading card’s lines', () => {
  const states = (p: NpdLoadProgress | null) => loadLines(p).map((l) => `${l.state}:${l.text}`);

  test('before the server answers: finding the sheet, nothing claimed', () => {
    assert.deepEqual(states(startLoadProgress('hsl', '2026-09-20', 0)), [
      'current:Finding this week’s sheet',
      'todo:Reading the rows from the database',
      'todo:Checking nobody saved while it was read',
      'todo:Receiving the rows',
      'todo:Laying out the sheet',
    ]);
  });

  test('each line says what really happened, with the real counts', () => {
    assert.deepEqual(states(run(FULL)), [
      'done:Found it: 613 rows saved',
      'done:Read 613 rows from the database',
      'done:Nobody saved while it was read',
      'current:Receiving rows · 100 of 613',
      'todo:Laying out 613 rows',
    ]);
    const done = advanceLoadProgress(advanceLoadProgress(run([...FULL, { kind: 'rows', count: 513 }]), { kind: 'layout' }, 9000), { kind: 'done' }, 9100);
    assert.deepEqual(states(done), [
      'done:Found it: 613 rows saved',
      'done:Read 613 rows from the database',
      'done:Nobody saved while it was read',
      'done:Received 613 rows',
      'done:Laid out 613 rows',
    ]);
    assert.equal(loadTitle('hsl', done), 'Loaded HSL');
  });

  test('thousands are grouped, and one row is a row', () => {
    const p = run([{ kind: 'header', attempt: 1, rowCount: 1 }]);
    assert.equal(loadLines(p)[0]!.text, 'Found it: 1 row saved');
    const big = run([{ kind: 'header', attempt: 1, rowCount: 1500 }]);
    assert.equal(loadLines(big)[1]!.text, 'Reading 1,500 rows from the database');
  });

  test('a save landing mid-read says so, and which try this is', () => {
    const p = run([{ kind: 'header', attempt: 1, rowCount: 613 }, { kind: 'read', attempt: 1, rows: 613 }, { kind: 'retry', attempt: 2 }]);
    assert.equal(p.step, 'read');
    assert.equal(loadLines(p)[1]!.text, `Someone saved meanwhile · reading it again (try 2 of ${NPD_READ_ATTEMPTS})`);
  });

  test('a week with no saved sheet skips the steps the server skips too', () => {
    const p = advanceLoadProgress(run([{ kind: 'header', attempt: 1, rowCount: 0 }]), { kind: 'sheet', rows: 0 }, 900);
    assert.deepEqual(states(p), ['done:No sheet saved for this week yet', 'todo:Laying out the sheet']);
  });

  test('a failure marks the step it stopped on, and nothing after it is claimed', () => {
    const p = advanceLoadProgress(run([{ kind: 'header', attempt: 1, rowCount: 613 }]), { kind: 'failed', error: 'x' }, 500);
    assert.deepEqual(
      loadLines(p).map((l) => l.state),
      ['done', 'failed', 'todo', 'todo', 'todo'],
    );
    assert.equal(loadTitle('all_departments', p), 'All Departments could not be loaded');
  });
});
