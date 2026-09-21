/**
 * The two definitions of "active" must agree, forever.
 *
 * Until 2026-09-21 the HRIS held two: `active_employees` (unstamped AND on the
 * current upload) and the external API's (unstamped, full stop). They disagreed
 * by 508 rows and nothing anywhere noticed — that silence is the actual defect.
 * Kane: *"lets fix this data once and for all."*
 *
 * This is the "once and for all": a pure verdict the diagnostics panel runs on
 * every load, so the next divergence is visible the day it starts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeRosterDrift } from './roster-drift';

test('the two definitions agreeing is healthy', () => {
  const v = judgeRosterDrift({ activeRows: 1215, viewRows: 1215, unexplained: 0 });
  assert.equal(v.status, 'healthy');
  assert.match(v.summary, /1,215/);
});

test('any drift at all is reported — there is no acceptable gap', () => {
  // Not a threshold. One corpse is one person the external API is wrong about,
  // and the 508-row gap started as one.
  const v = judgeRosterDrift({ activeRows: 1216, viewRows: 1215, unexplained: 1 });
  assert.notEqual(v.status, 'healthy');
  assert.match(v.summary, /1 row/);
});

test('a large gap is critical, not a warning', () => {
  const v = judgeRosterDrift({ activeRows: 1723, viewRows: 1215, unexplained: 508 });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /508/);
});

test('the view can never exceed the active set — that means the reader is broken', () => {
  // active_employees is a strict subset of the unstamped rows by construction.
  // More rows in the subset than the superset means the read itself is wrong,
  // and reporting a tidy "no drift" would hide it.
  const v = judgeRosterDrift({ activeRows: 10, viewRows: 99, unexplained: 0 });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /impossible/i);
});

test('an empty roster is critical, never "no drift"', () => {
  // 0 === 0 is arithmetically no drift. It is also the exact shape of the
  // 2026-08-03 incident, where active_employees returned zero rows with HTTP
  // 200 and the wizard re-labelled 422 people "Unassigned".
  const v = judgeRosterDrift({ activeRows: 0, viewRows: 0, unexplained: 0 });
  assert.equal(v.status, 'critical');
  assert.match(v.summary, /no active/i);
});

test('the unexplained count is surfaced even when the totals happen to match', () => {
  // Totals can coincide while the sets differ. The people count is what the
  // probe is really asserting.
  const v = judgeRosterDrift({ activeRows: 1215, viewRows: 1215, unexplained: 3 });
  assert.notEqual(v.status, 'healthy');
});
