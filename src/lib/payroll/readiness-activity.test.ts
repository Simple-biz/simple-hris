import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_MAX_LINES,
  ACTIVITY_WINDOW_MS,
  buildActivityLines,
  latestKpiSubmissionByDept,
  type ActivityAuditRow,
} from './readiness-activity';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function row(overrides: Partial<ActivityAuditRow>): ActivityAuditRow {
  return {
    action: 'payroll.rate.set',
    user_name: 'Carla',
    created_at: new Date(NOW - 60_000).toISOString(),
    details: null,
    ...overrides,
  };
}

test('lines inside the window map with actor + surface, newest first', () => {
  const lines = buildActivityLines(
    [
      row({ action: 'bank_update.saved', created_at: new Date(NOW - 120_000).toISOString() }),
      row({ action: 'payroll.rate.set', created_at: new Date(NOW - 30_000).toISOString() }),
    ],
    NOW,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].surface, 'rates'); // newer first
  assert.equal(lines[1].surface, 'bank');
  assert.equal(lines[0].actor, 'Carla');
});

test('rows older than the window, unknown actions, and bad timestamps are dropped', () => {
  const lines = buildActivityLines(
    [
      row({ created_at: new Date(NOW - ACTIVITY_WINDOW_MS - 1000).toISOString() }),
      row({ action: 'announcement.posted' }),
      row({ created_at: 'not-a-date' }),
    ],
    NOW,
  );
  assert.equal(lines.length, 0);
});

test('the feed caps at ACTIVITY_MAX_LINES, keeping the newest', () => {
  const rows = Array.from({ length: ACTIVITY_MAX_LINES + 5 }, (_, i) =>
    row({ created_at: new Date(NOW - (i + 1) * 1000).toISOString() }),
  );
  const lines = buildActivityLines(rows, NOW);
  assert.equal(lines.length, ACTIVITY_MAX_LINES);
  assert.equal(lines[0].at, new Date(NOW - 1000).toISOString());
});

test('labels are templates — raw details never leak into the feed', () => {
  const lines = buildActivityLines(
    [
      row({
        action: 'payroll.rate.set',
        details: { regular_rate: 225, account_number: '1234567890' },
      }),
      row({
        action: 'bank_update.saved',
        details: { bank_name: 'BDO', account_number: '999' },
      }),
    ],
    NOW,
  );
  for (const line of lines) {
    assert.ok(!line.label.includes('225'), `amount leaked: ${line.label}`);
    assert.ok(!/\d{3,}/.test(line.label), `details leaked: ${line.label}`);
  }
});

test('KPI lines name the department via the display-name map, key as fallback', () => {
  const details = { department: 'callback', period_start: '2026-08-09' };
  const named = buildActivityLines(
    [row({ action: 'payroll.kpi.marked_ready', details })],
    NOW,
    new Map([['callback', 'Callback Team']]),
  );
  assert.equal(named[0].label, "marked Callback Team's KPI scores ready");
  const bare = buildActivityLines([row({ action: 'payroll.kpi.locked', details })], NOW);
  assert.equal(bare[0].label, "locked callback's KPI scores");
});

test('latestKpiSubmissionByDept keeps the newest event per dept, period-matched', () => {
  const mk = (dept: string, period: string, at: number, by: string, action = 'payroll.kpi.marked_ready') =>
    row({
      action,
      user_name: by,
      created_at: new Date(at).toISOString(),
      details: { department: dept, period_start: period, source_label: 'Manager KPI tab' },
    });
  const map = latestKpiSubmissionByDept(
    [
      mk('callback', '2026-08-09', NOW - 5000, 'Old Manager'),
      mk('callback', '2026-08-09', NOW - 1000, 'New Manager', 'payroll.kpi.locked'),
      mk('callback', '2026-08-02', NOW - 500, 'Wrong Week'), // different period
      mk('qc', '2026-08-09', NOW - 2000, 'QC Lead'),
      row({ action: 'payroll.rate.set' }), // not a KPI action
    ],
    '2026-08-09',
  );
  assert.equal(map.size, 2);
  assert.equal(map.get('callback')?.by, 'New Manager');
  assert.equal(map.get('callback')?.via, 'Manager KPI tab');
  assert.equal(map.get('qc')?.by, 'QC Lead');
});

test('a dateless or dept-less KPI row attributes nothing', () => {
  const map = latestKpiSubmissionByDept(
    [
      row({ action: 'payroll.kpi.marked_ready', details: { period_start: '2026-08-09' } }),
      row({ action: 'payroll.kpi.marked_ready', details: { department: 'qc' } }),
    ],
    '2026-08-09',
  );
  assert.equal(map.size, 0);
});
