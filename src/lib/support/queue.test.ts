import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_UNRESOLVED,
  QUEUE_READ_FAILED,
  POSTGREST_MAX_ROWS,
  compareQueueRank,
  nextWaiter,
  queuePositionFor,
  sortQueue,
  type QueueRank,
} from './queue';

/** A line of `n` people, one second apart, oldest first. */
function line(n: number, startIso = '2026-09-19T14:00:00.000Z'): QueueRank[] {
  const start = Date.parse(startIso);
  return Array.from({ length: n }, (_, i) => ({
    id: `s-${String(i).padStart(5, '0')}`,
    queued_at: new Date(start + i * 1000).toISOString(),
  }));
}

const waiting = (id: string) => ({ id, status: 'waiting' as const });

test('longest-waiting first, whatever order the caller hands us', () => {
  const rows = line(4);
  const shuffled = [rows[2], rows[0], rows[3], rows[1]];

  // The ordering lives in the module, not in the caller's array. A component
  // that re-derived it differently is the bug this is here to make impossible.
  assert.deepEqual(
    sortQueue(shuffled).map((r) => r.id),
    rows.map((r) => r.id),
  );
  assert.equal(queuePositionFor(shuffled, waiting(rows[0].id)).position, 1);
  assert.equal(queuePositionFor(shuffled, waiting(rows[3].id)).position, 4);
});

test('"nobody is waiting" and "we cannot tell" are different states', () => {
  const emptyLine = queuePositionFor([], null);
  const unreadable = queuePositionFor(null, null);

  // The whole invariant, in one place (plan :91-92). An empty line is a COUNT;
  // an unreadable one is an absence of one. They may never agree on any field.
  assert.equal(emptyLine.waiting, 0);
  assert.equal(emptyLine.resolved, true);
  assert.equal(unreadable.waiting, null);
  assert.equal(unreadable.resolved, false);
  assert.equal(unreadable.reason, 'read_failed');
  assert.notEqual(emptyLine.waiting, unreadable.waiting);
  assert.notEqual(emptyLine.resolved, unreadable.resolved);
});

test('an unread queue never reports a position of 0', () => {
  // `0` as a position would render as a place in line. Nothing may produce it.
  for (const state of [
    queuePositionFor(null, null),
    queuePositionFor(null, waiting('s-00000')),
    queuePositionFor([], waiting('s-00000')),
    { ...QUEUE_UNRESOLVED },
    { ...QUEUE_READ_FAILED },
  ]) {
    assert.notEqual(state.position, 0);
    assert.ok(state.position === null || state.position >= 1);
  }
});

test('A POSITION NEVER RISES: an abandoned claim returns the original rank', () => {
  const rows = line(5);
  const mine = rows[2];

  assert.equal(queuePositionFor(rows, waiting(mine.id)).position, 3);

  // An agent claims it. The row leaves the waiting set and the status moves;
  // "not in the line" is a resolved answer, not an unknown one.
  const whileClaimed = rows.filter((r) => r.id !== mine.id);
  const claimed = queuePositionFor(whileClaimed, { id: mine.id, status: 'claimed' });
  assert.equal(claimed.position, null);
  assert.equal(claimed.resolved, true);
  assert.equal(claimed.waiting, 4);

  // The agent's browser dies. The release path sets status back to 'waiting'
  // and CANNOT move queued_at — the DB trigger raises on the attempt
  // (SQL :363-369) — so the row comes back with its original stamp, appended to
  // the end of whatever array the re-read produced.
  const afterRelease = queuePositionFor([...whileClaimed, mine], waiting(mine.id));
  assert.equal(afterRelease.position, 3, 'the employee never pays for an agent disconnect');

  // And somebody who joined during all that does not get ahead of them either.
  const latecomer: QueueRank = {
    id: 'z-latecomer',
    queued_at: new Date(Date.parse(rows[4].queued_at) + 60_000).toISOString(),
  };
  const withLatecomer = [latecomer, ...whileClaimed, mine];
  assert.equal(queuePositionFor(withLatecomer, waiting(mine.id)).position, 3);
  assert.equal(queuePositionFor(withLatecomer, waiting(latecomer.id)).position, 6);
});

test('a session that is not waiting has no position, and that is resolved', () => {
  const rows = line(3);
  for (const status of ['claimed', 'live', 'ended', 'abandoned'] as const) {
    const state = queuePositionFor(rows, { id: 'not-in-the-set', status });
    assert.equal(state.position, null, status);
    assert.equal(state.resolved, true, status);
    assert.equal(state.waiting, 3, status);
    assert.equal(state.reason, undefined, status);
  }
});

test('waiting but missing from the set we just read is UNKNOWN, not "you left"', () => {
  // An agent claimed it between the two reads. The line's size is still a fact;
  // this caller's own place is not, and the next poll settles it.
  const rows = line(3);
  const state = queuePositionFor(rows, waiting('s-99999'));
  assert.equal(state.waiting, 3);
  assert.equal(state.position, null);
  assert.equal(state.resolved, false);
  assert.equal(state.reason, 'not_in_set');
});

test('one unrankable stamp makes every position unknown, and the count survives', () => {
  const rows = line(4);
  const broken = [...rows.slice(0, 2), { id: 'b-bad', queued_at: 'whenever' }, ...rows.slice(2)];

  // If we cannot say whether that row is ahead of the caller, we cannot say how
  // many people are — so nobody gets a number, including the person at the very
  // front who "obviously" is first.
  const state = queuePositionFor(broken, waiting(rows[0].id));
  assert.equal(state.waiting, 5);
  assert.equal(state.position, null);
  assert.equal(state.resolved, false);
  assert.equal(state.reason, 'unrankable');
});

test('sub-millisecond stamps break on precision, not on uuid', () => {
  // Postgres keeps timestamptz to the microsecond; Date.parse truncates to the
  // millisecond. These two are 800µs apart and identical to JavaScript, and the
  // ids are deliberately in the opposite order — an id-only tiebreak would
  // reverse them and disagree with the server's own .order('queued_at').
  const earlier: QueueRank = { id: 'b', queued_at: '2026-09-19T14:00:00.000100+00:00' };
  const later: QueueRank = { id: 'a', queued_at: '2026-09-19T14:00:00.000900+00:00' };
  assert.equal(Date.parse(earlier.queued_at), Date.parse(later.queued_at));

  assert.deepEqual(
    sortQueue([later, earlier]).map((r) => r.id),
    ['b', 'a'],
  );
  assert.equal(queuePositionFor([later, earlier], waiting('b')).position, 1);
});

test('identical stamps break on id, stably', () => {
  const stamp = '2026-09-19T14:00:00.000Z';
  const rows: QueueRank[] = [
    { id: 'c', queued_at: stamp },
    { id: 'a', queued_at: stamp },
    { id: 'b', queued_at: stamp },
  ];
  assert.deepEqual(sortQueue(rows).map((r) => r.id), ['a', 'b', 'c']);
  // Stable across reads is the property that matters: the same set in a
  // different order must still produce the same position.
  assert.deepEqual(sortQueue([rows[1], rows[2], rows[0]]).map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(compareQueueRank(rows[0], rows[0]), 0);
});

test('sorting does not reorder the caller array', () => {
  const rows = line(3);
  const handed = [rows[2], rows[1], rows[0]];
  const before = handed.map((r) => r.id);
  sortQueue(handed);
  queuePositionFor(handed, waiting(rows[0].id));
  assert.deepEqual(handed.map((r) => r.id), before);
});

test('nextWaiter takes the longest-waiting, never a chosen one', () => {
  const rows = line(4);
  assert.equal(nextWaiter([rows[3], rows[1], rows[0], rows[2]])?.id, rows[0].id);
  // Empty and unreadable both mean "nobody to hand over" to THIS caller.
  assert.equal(nextWaiter([]), null);
  assert.equal(nextWaiter(null), null);
});

test('THE 1000-ROW BOUNDARY: an unpaged read is wrong and cannot be detected here', () => {
  // PostgREST caps a set at 1000 with no error, even with .range(0, 99999)
  // (select-all-paged.ts:4-11). This module is handed an array and has no way
  // to know the tail was cut off, which is why the caller MUST selectAllPaged.
  const full = line(1500);
  const mine = full[1200];

  const paged = queuePositionFor(full, waiting(mine.id));
  assert.equal(paged.waiting, 1500);
  assert.equal(paged.position, 1201, 'positions past the cap are ordinary arithmetic');
  assert.equal(paged.resolved, true);

  const truncated = full.slice(0, POSTGREST_MAX_ROWS);
  assert.equal(truncated.length, 1000);

  // Beyond the cap the damage is at least honest: the caller falls out of the
  // set entirely and gets a skeleton rather than a number.
  const beyond = queuePositionFor(truncated, waiting(mine.id));
  assert.equal(beyond.resolved, false);
  assert.equal(beyond.reason, 'not_in_set');

  // INSIDE the cap is the dangerous one: a correct-looking position attached to
  // a line that is 500 people longer than reported, with nothing to flag it.
  const early = full[499];
  const understated = queuePositionFor(truncated, waiting(early.id));
  assert.equal(understated.position, 500);
  assert.equal(understated.resolved, true);
  assert.equal(understated.waiting, 1000);
  assert.notEqual(understated.waiting, full.length);
});

test('exactly 1000 waiters is an ordinary line, not a suspected truncation', () => {
  // The module does not second-guess the cap. A set of exactly 1000 rows is a
  // legitimate paged result, and calling it unreadable would break a real queue
  // to catch a caller's mistake that selectAllPaged already prevents.
  const full = line(POSTGREST_MAX_ROWS);
  const state = queuePositionFor(full, waiting(full[999].id));
  assert.equal(state.waiting, 1000);
  assert.equal(state.position, 1000);
  assert.equal(state.resolved, true);
});

test('the shared unresolved constants cannot be mutated by one caller', () => {
  assert.equal(Object.isFrozen(QUEUE_UNRESOLVED), true);
  assert.equal(Object.isFrozen(QUEUE_READ_FAILED), true);
  assert.equal(QUEUE_UNRESOLVED.resolved, false);
  assert.equal(QUEUE_UNRESOLVED.waiting, null);
  assert.equal(QUEUE_UNRESOLVED.position, null);
  // The returned state is a copy, so a caller that mutates its own answer does
  // not poison the next request's.
  const state = queuePositionFor(null, null);
  state.waiting = 7;
  assert.equal(QUEUE_READ_FAILED.waiting, null);
});
