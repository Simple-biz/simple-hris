import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { glidePositionAt } from '@/lib/npd/load-progress';
import {
  DEFAULT_APPLIED_LABEL,
  DEFAULT_APPLY_LABEL,
  REFRESH_IN_FLIGHT_SHARE,
  applyRefresh,
  beginStep,
  completeStep,
  countOf,
  failRefresh,
  finishRefresh,
  refreshAnnouncement,
  refreshCurrentText,
  refreshLines,
  refreshTarget,
  refreshTitle,
  refreshValueNow,
  startRefresh,
  type RefreshPlan,
  type RefreshProgress,
} from './refresh-progress';

const ONE: RefreshPlan = { subject: 'leave requests', steps: [{ id: 'leaves', label: 'Reading leave requests' }] };
const TWO: RefreshPlan = {
  subject: 'transfers',
  steps: [
    { id: 'requests', label: 'Reading transfer requests' },
    { id: 'people', label: 'Reading the roster', doneLabel: 'Read the roster' },
  ],
};

/** Where the fill is drawn at `t`, and the furthest it is allowed to go. */
const at = (p: RefreshProgress, t: number) => glidePositionAt(p.glide, t);

describe('starting', () => {
  test('nothing is filled before a read is sent, and every line waits', () => {
    const p = startRefresh(ONE, 0);
    assert.equal(p.phase, 'running');
    assert.equal(at(p, 10_000), 0);
    assert.deepEqual(
      refreshLines(p).map((l) => [l.state, l.text]),
      [
        ['todo', 'Reading leave requests'],
        ['todo', DEFAULT_APPLY_LABEL],
      ],
    );
    assert.equal(refreshTitle(p), 'Refreshing leave requests');
  });

  test('a plan with no reads, a repeated id or the reserved id is refused', () => {
    assert.throws(() => startRefresh({ subject: 'x', steps: [] }, 0));
    assert.throws(() => startRefresh({ subject: 'x', steps: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, 0));
    assert.throws(() => startRefresh({ subject: 'x', steps: [{ id: '__apply__', label: 'A' }] }, 0));
  });

  test('each run is its own run', () => {
    assert.notEqual(startRefresh(ONE, 0).runId, startRefresh(ONE, 0).runId);
  });
});

describe('the bar follows steps, never time', () => {
  test('a read in flight glides toward most of its share and never reaches it, however long it takes', () => {
    const p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    const ceiling = REFRESH_IN_FLIGHT_SHARE / 2; // one read + the apply line
    assert.equal(p.glide.to, ceiling);
    for (const t of [100, 1_000, 6_000, 60_000, 3_600_000]) {
      assert.ok(at(p, t) <= ceiling + 1e-12, `at ${t}ms the fill passed its ceiling`);
    }
    assert.ok(at(p, 60_000) < 0.5, 'a slow read never looks finished');
  });

  test('only a finished read moves the bar past its share; only done fills it', () => {
    let p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    p = completeStep(p, 'leaves', 'Read 42 leave requests', 500);
    assert.ok(p.glide.to >= 0.5, 'the read finished: its whole share is earned');
    assert.ok(p.glide.to < 1);
    p = applyRefresh(p, 600);
    assert.ok(p.glide.to < 1, 'applying is not done');
    p = finishRefresh(p, 700);
    assert.equal(p.glide.to, 1);
    assert.equal(at(p, 10_000), 1);
  });

  test('it never moves backwards, whatever order the events come in', () => {
    const events: Array<(p: RefreshProgress, t: number) => RefreshProgress> = [
      (p, t) => beginStep(p, 'requests', t),
      (p, t) => beginStep(p, 'people', t),
      (p, t) => completeStep(p, 'people', null, t),
      (p, t) => completeStep(p, 'requests', 'Read 7 transfer requests', t),
      (p, t) => applyRefresh(p, t),
      (p, t) => finishRefresh(p, t),
    ];
    let p = startRefresh(TWO, 0);
    let last = 0;
    let t = 0;
    for (const e of events) {
      for (let k = 0; k < 5; k += 1) {
        t += 37;
        const pos = at(p, t);
        assert.ok(pos + 1e-12 >= last, `went back at ${t}ms: ${pos} < ${last}`);
        last = pos;
      }
      p = e(p, t);
      assert.ok(p.glide.from + 1e-12 >= last, 'a new glide starts where the bar is');
    }
    assert.equal(at(p, t + 10_000), 1);
  });

  test('two reads side by side: each one finishing is its own move', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = beginStep(p, 'people', 0);
    const both = refreshTarget(p);
    p = completeStep(p, 'people', null, 100);
    const one = refreshTarget(p);
    assert.ok(one > both);
    p = completeStep(p, 'requests', null, 200);
    assert.ok(refreshTarget(p) > one);
    assert.ok(refreshTarget(p) < 1);
  });
});

describe('the lines say what happened', () => {
  test('a finished read says what came back; a read without a count falls back to its done label', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = beginStep(p, 'people', 0);
    p = completeStep(p, 'requests', 'Read 7 transfer requests', 10);
    p = completeStep(p, 'people', null, 20);
    assert.deepEqual(
      refreshLines(p).map((l) => [l.state, l.text]),
      [
        ['done', 'Read 7 transfer requests'],
        ['done', 'Read the roster'],
        ['todo', DEFAULT_APPLY_LABEL],
      ],
    );
    p = applyRefresh(p, 30);
    assert.equal(refreshLines(p).at(-1)!.state, 'current');
    p = finishRefresh(p, 40);
    assert.deepEqual(refreshLines(p).at(-1), { id: '__apply__', state: 'done', text: DEFAULT_APPLIED_LABEL });
    assert.equal(refreshTitle(p), 'Refreshed transfers');
  });

  test('a read the surface never sent is dropped, never shown done', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = completeStep(p, 'requests', null, 10);
    p = applyRefresh(p, 20);
    assert.deepEqual(
      refreshLines(p).map((l) => l.id),
      ['requests', '__apply__'],
    );
    assert.ok(!refreshLines(p).some((l) => l.text === 'Read the roster'));
  });

  test('custom apply lines are used', () => {
    let p = startRefresh({ ...ONE, applyLabel: 'Laying out the queue', appliedLabel: 'Queue updated' }, 0);
    p = beginStep(p, 'leaves', 0);
    p = completeStep(p, 'leaves', null, 1);
    p = applyRefresh(p, 2);
    assert.equal(refreshLines(p).at(-1)!.text, 'Laying out the queue');
    p = finishRefresh(p, 3);
    assert.equal(refreshLines(p).at(-1)!.text, 'Queue updated');
  });

  test('the bar’s value text is the line happening now, and its value never claims more than the ceiling', () => {
    let p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    assert.equal(refreshCurrentText(p), 'Reading leave requests');
    assert.equal(refreshValueNow(p), Math.round(REFRESH_IN_FLIGHT_SHARE * 50));
    assert.equal(refreshAnnouncement(p), 'Refreshing leave requests: Reading leave requests');
    p = finishRefresh(applyRefresh(completeStep(p, 'leaves', 'Read 3 leave requests', 1), 2), 3);
    assert.equal(refreshValueNow(p), 100);
    assert.equal(refreshAnnouncement(p), 'Refreshed leave requests.');
  });
});

describe('failure', () => {
  test('the read in flight fails, the bar holds where it stopped, and the sentence is kept', () => {
    let p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    const where = at(p, 1_000);
    p = failRefresh(p, 'Supabase is unreachable', 1_000);
    assert.equal(p.phase, 'failed');
    assert.equal(p.error, 'Supabase is unreachable');
    assert.ok(Math.abs(at(p, 50_000) - where) < 1e-12, 'it stops, it does not glide on');
    assert.deepEqual(
      refreshLines(p).map((l) => l.state),
      ['failed', 'todo'],
    );
    assert.equal(refreshTitle(p), "Couldn't refresh leave requests");
    assert.equal(refreshAnnouncement(p), "Couldn't refresh leave requests: Supabase is unreachable");
    assert.equal(refreshCurrentText(p), 'Reading leave requests');
  });

  test('a failure between reads blames the next read; after every read, it blames the apply line', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = completeStep(p, 'requests', null, 1);
    const between = failRefresh(p, 'boom', 2);
    assert.deepEqual(
      refreshLines(between).map((l) => l.state),
      ['done', 'failed', 'todo'],
    );
    p = beginStep(p, 'people', 3);
    p = completeStep(p, 'people', null, 4);
    const after = failRefresh(p, 'The answer could not be read', 5);
    assert.deepEqual(
      refreshLines(after).map((l) => l.state),
      ['done', 'done', 'failed'],
    );
  });

  test('a failed read blames only itself: a read in flight beside it goes back to unfinished', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = beginStep(p, 'people', 0);
    p = failRefresh(p, 'HTTP 500', 10, 'people');
    assert.deepEqual(
      refreshLines(p).map((l) => [l.id, l.state]),
      [
        ['requests', 'todo'],
        ['people', 'failed'],
        ['__apply__', 'todo'],
      ],
    );
    assert.equal(refreshCurrentText(p), 'Reading the roster');
    // The sibling answering afterwards changes nothing: the run has ended.
    assert.equal(completeStep(p, 'requests', 'Read 7 transfer requests', 20), p);
  });

  test('a failure the surface reported itself (no read named) stops every read in flight', () => {
    let p = startRefresh(TWO, 0);
    p = beginStep(p, 'requests', 0);
    p = beginStep(p, 'people', 0);
    p = failRefresh(p, 'The answer could not be used', 10);
    assert.deepEqual(
      refreshLines(p).map((l) => l.state),
      ['failed', 'failed', 'todo'],
    );
  });

  test('an ended run never moves again', () => {
    let p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    p = failRefresh(p, 'x', 1);
    assert.equal(completeStep(p, 'leaves', null, 2), p);
    assert.equal(applyRefresh(p, 2), p);
    assert.equal(finishRefresh(p, 2), p);
    assert.equal(failRefresh(p, 'y', 2), p);
    let q = finishRefresh(applyRefresh(completeStep(beginStep(startRefresh(ONE, 0), 'leaves', 0), 'leaves', null, 1), 2), 3);
    assert.equal(failRefresh(q, 'late', 4), q);
    assert.equal(beginStep(q, 'leaves', 4), q);
    q = applyRefresh(q, 5);
    assert.equal(q.phase, 'done');
  });

  test('finish only follows apply: a run cannot jump from reading to full', () => {
    const p = beginStep(startRefresh(ONE, 0), 'leaves', 0);
    assert.equal(finishRefresh(p, 1), p);
  });

  test('an unknown read id changes nothing (the hook refuses it loudly)', () => {
    const p = startRefresh(ONE, 0);
    assert.equal(beginStep(p, 'nope', 1), p);
    assert.equal(completeStep(p, 'nope', null, 1), p);
  });
});

describe('countOf', () => {
  test('singular, plural and thousands', () => {
    assert.equal(countOf(1, 'transfer'), '1 transfer');
    assert.equal(countOf(0, 'transfer'), '0 transfers');
    assert.equal(countOf(1234, 'person', 'people'), '1,234 people');
  });
});
