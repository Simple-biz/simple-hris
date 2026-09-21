import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COUNTS_UNRESOLVED,
  compareBoard,
  isOpenTicket,
  isSupportPriority,
  partitionStages,
  sortBoard,
  stageOf,
  supportCounts,
  supportDayIso,
  type TriageRow,
} from './triage';

const row = (over: Partial<TriageRow> = {}): TriageRow => ({
  status: 'open',
  priority: null,
  created_at: '2026-09-21T12:00:00.000+00:00',
  first_response_at: null,
  ...over,
});

describe('the two stages are derived from priority alone', () => {
  it('null is the line, anything else is the board', () => {
    assert.equal(stageOf(row({ priority: null })), 'line');
    for (const p of ['low', 'medium', 'high', 'urgent'] as const) {
      assert.equal(stageOf(row({ priority: p })), 'board');
    }
  });

  it('isOpenTicket matches the SQL partial index predicate', () => {
    // open + claimed. If this drifts from the index the read silently stops
    // using it.
    assert.ok(isOpenTicket(row({ status: 'open' })));
    assert.ok(isOpenTicket(row({ status: 'claimed' })));
    assert.ok(!isOpenTicket(row({ status: 'answered' })));
    assert.ok(!isOpenTicket(row({ status: 'closed' })));
  });

  it('isSupportPriority refuses anything outside the four shared values', () => {
    for (const p of ['low', 'medium', 'high', 'urgent']) assert.ok(isSupportPriority(p));
    for (const bad of ['critical', 'none', '', 'URGENT', null, undefined, 3]) {
      assert.ok(!isSupportPriority(bad), String(bad));
    }
  });
});

describe('the sort: urgency first, then Carla longest-waiting rule underneath', () => {
  it('urgency outranks age', () => {
    const old = row({ priority: 'low', created_at: '2026-01-01T00:00:00.000+00:00' });
    const fresh = row({ priority: 'urgent', created_at: '2026-09-21T23:00:00.000+00:00' });
    assert.deepEqual(sortBoard([old, fresh]), [fresh, old]);
  });

  it('inside a band, the longest-waiting is on top — not the newest', () => {
    // This is the half Carla signed, and the half the v1 plan once recorded
    // backwards ("newest first within it").
    const older = row({ priority: 'high', created_at: '2026-09-20T09:00:00.000+00:00' });
    const newer = row({ priority: 'high', created_at: '2026-09-21T09:00:00.000+00:00' });
    assert.deepEqual(sortBoard([newer, older]), [older, newer]);
  });

  it('age is measured from FILING, so time spent un-triaged still counts', () => {
    // A ticket that sat in the line for a week and was then ranked medium must
    // still outrank one filed today and ranked medium immediately.
    const languished = row({ priority: 'medium', created_at: '2026-09-14T09:00:00.000+00:00' });
    const promptlyRanked = row({ priority: 'medium', created_at: '2026-09-21T09:00:00.000+00:00' });
    assert.deepEqual(sortBoard([promptlyRanked, languished]), [languished, promptlyRanked]);
  });

  it('un-ranked sorts below every ranked ticket', () => {
    const unranked = row({ priority: null, created_at: '2026-01-01T00:00:00.000+00:00' });
    const ranked = row({ priority: 'low', created_at: '2026-09-21T00:00:00.000+00:00' });
    assert.deepEqual(sortBoard([unranked, ranked]), [ranked, unranked]);
  });

  it('two stamps that parse to the same millisecond keep a stable order', () => {
    // Postgres holds timestamptz to the microsecond; Date.parse truncates to
    // the millisecond. Without the raw-string tiebreak these two would swap
    // between reads and move under somebody cursor.
    const a = row({ priority: 'high', created_at: '2026-09-21T09:00:00.000100+00:00' });
    const b = row({ priority: 'high', created_at: '2026-09-21T09:00:00.000900+00:00' });
    assert.equal(Date.parse(a.created_at), Date.parse(b.created_at));
    assert.deepEqual(sortBoard([b, a]), [a, b]);
    assert.deepEqual(sortBoard([a, b]), [a, b]);
  });

  it('an unparseable stamp sorts last instead of throwing', () => {
    const good = row({ priority: 'high', created_at: '2026-09-21T09:00:00.000+00:00' });
    const bad = row({ priority: 'high', created_at: 'not a date' });
    assert.deepEqual(sortBoard([bad, good]), [good, bad]);
  });

  it('sortBoard does not mutate its input', () => {
    const a = row({ priority: 'low' });
    const b = row({ priority: 'urgent' });
    const input = [a, b];
    sortBoard(input);
    assert.deepEqual(input, [a, b]);
  });

  it('compareBoard is consistent both ways', () => {
    const a = row({ priority: 'urgent' });
    const b = row({ priority: 'low' });
    assert.ok(compareBoard(a, b) < 0);
    assert.ok(compareBoard(b, a) > 0);
    assert.equal(compareBoard(a, a), 0);
  });
});

describe('partitionStages', () => {
  it('splits open tickets and drops the shut ones', () => {
    const lineRow = row({ priority: null });
    const boardRow = row({ priority: 'high' });
    const closed = row({ status: 'closed', priority: 'high' });
    const answered = row({ status: 'answered' });
    const out = partitionStages([lineRow, boardRow, closed, answered]);
    assert.equal(out.line.length, 1);
    assert.equal(out.board.length, 1);
  });

  it('the line is ordered longest-waiting first, same comparator as the board', () => {
    const older = row({ created_at: '2026-09-19T00:00:00.000+00:00' });
    const newer = row({ created_at: '2026-09-21T00:00:00.000+00:00' });
    assert.deepEqual(partitionStages([newer, older]).line, [older, newer]);
  });
});

describe('the counts Carla signed', () => {
  const now = new Date('2026-09-21T20:00:00.000-04:00');

  it('a failed read is UNRESOLVED, never zeroes', () => {
    const out = supportCounts(null, now);
    assert.equal(out.resolved, false);
    assert.equal(out.needsReply, null);
    assert.equal(out.answeredToday, null);
    assert.equal(out.inLine, null);
  });

  it('COUNTS_UNRESOLVED is frozen', () => {
    assert.ok(Object.isFrozen(COUNTS_UNRESOLVED));
  });

  it('an empty set resolves to real zeroes', () => {
    const out = supportCounts([], now);
    assert.equal(out.resolved, true);
    assert.equal(out.needsReply, 0);
  });

  it('needsReply spans BOTH stages — the split must not hide work', () => {
    const inLine = row({ priority: null });
    const onBoard = row({ priority: 'high' });
    assert.equal(supportCounts([inLine, onBoard], now).needsReply, 2);
  });

  it('a ticket that already had a staff reply does not need one', () => {
    const replied = row({ first_response_at: '2026-09-21T10:00:00.000-04:00' });
    assert.equal(supportCounts([replied], now).needsReply, 0);
  });

  it('a closed ticket never needs a reply', () => {
    assert.equal(supportCounts([row({ status: 'closed' })], now).needsReply, 0);
  });

  it('inLine counts only un-triaged OPEN tickets — starvation made visible', () => {
    const rows = [
      row({ priority: null }),
      row({ priority: null }),
      row({ priority: 'low' }),
      row({ status: 'closed', priority: null }),
    ];
    assert.equal(supportCounts(rows, now).inLine, 2);
  });
});

describe('"today" is the SUPPORT zone, not Manila', () => {
  // 8pm Eastern on the 21st is 8am Manila on the 22nd. The answerers read this
  // number during their own working day, so it has to roll at THEIR midnight —
  // a Manila day would reset it around noon their time, mid-shift, wiping the
  // morning's answers out of a number somebody is using to judge their own
  // backlog.
  const now = new Date('2026-09-21T20:00:00.000-04:00');

  it('the support day is the Eastern calendar day', () => {
    assert.equal(supportDayIso(now), '2026-09-21');
    assert.notEqual(
      supportDayIso(now),
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(now),
    );
  });

  it('a reply at 8pm Eastern counts for today, though Manila calls it tomorrow', () => {
    const replied = row({ first_response_at: '2026-09-21T20:00:00.000-04:00' });
    assert.equal(supportCounts([replied], now).answeredToday, 1);
  });

  it('yesterday does not count', () => {
    const replied = row({ first_response_at: '2026-09-20T20:00:00.000-04:00' });
    assert.equal(supportCounts([replied], now).answeredToday, 0);
  });

  it('an unparseable reply stamp is not today, and does not crash the count', () => {
    const rows = [row({ first_response_at: 'nonsense' }), row({ first_response_at: '2026-09-21T09:00:00.000-04:00' })];
    assert.equal(supportCounts(rows, now).answeredToday, 1);
  });
});
